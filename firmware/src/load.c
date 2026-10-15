#include "ch32fun.h"
#include "board.h"
#include "load.h"

// ---- PWM ----
// TIM2 at 48 MHz / 2000 = 24 kHz. Control variable u = combo * PWM_STEPS + frac:
// legs common to combos k and k+1 stay on, a leg being added is on for frac
// counts (PWM1), a leg being removed is off for the same counts (PWM2), so the
// load alternates between the two adjacent combinations and never drops to 0.
#define PWM_STEPS   2000u
#define U_MAX       (7u * PWM_STEPS)

// OCxM codes
#define OC_FORCE_LOW  4
#define OC_FORCE_HIGH 5
#define OC_PWM1       6
#define OC_PWM2       7

// Leg resistances in milliohms (A = bit 0, B = bit 1, C = bit 2) and the shunt.
static const uint32_t leg_mohm[3] = { 100000, 47000, 23500 };
#define SHUNT_MOHM  1000u

// ---- Sampling ----
// 4 kHz ISR; slot pattern of 8: six current samples, one VBUS, and every 8th
// round the VBUS slot reads the internal reference instead.
#define CTRL_SAMPLES   8      // samples per control step (2 ms)
#define SETTLE_STEPS   3      // control steps ignored at pulse start for the average

static volatile uint16_t target_ma;
static volatile uint16_t live_ma, vbus_mv, vdd_mv = 3300;
static volatile uint8_t  flags;
static volatile uint32_t pulse_sum, pulse_n;
static volatile uint8_t  pulse_steps;

static uint16_t zero_raw;           // shunt offset in ADC counts x16
static uint32_t ref_raw16 = 1489 * 16; // 1.2 V at 3.3 V VDD, x16 filtered
static uint32_t vbus_raw16;
static uint8_t  slot, round_;
static uint8_t  cur_ch = ADC_CH_ISENSE;
static uint32_t i_acc;
static uint8_t  i_n;
static uint32_t u;                  // control variable
static uint16_t last_target;
static uint16_t est_ma[8];          // estimated current for each leg combination
static uint8_t  oc_count;

static inline void set_mode(int ch, uint32_t mode)
{
	switch (ch) {
	case 0: TIM2->CHCTLR1 = (TIM2->CHCTLR1 & ~(7u << 4))  | (mode << 4);  break;
	case 1: TIM2->CHCTLR1 = (TIM2->CHCTLR1 & ~(7u << 12)) | (mode << 12); break;
	case 2: TIM2->CHCTLR2 = (TIM2->CHCTLR2 & ~(7u << 4))  | (mode << 4);  break;
	}
}

static void apply_u(uint32_t v)
{
	if (v > U_MAX) v = U_MAX;
	uint32_t k = v / PWM_STEPS, frac = v % PWM_STEPS;
	if (k >= 7) { k = 7; frac = 0; }
	TIM2->CH1CVR = frac;
	TIM2->CH2CVR = frac;
	TIM2->CH3CVR = frac;
	for (int i = 0; i < 3; i++) {
		int a = (k >> i) & 1;
		int b = k < 7 ? (int)(((k + 1) >> i) & 1) : a;
		uint32_t m;
		if (frac == 0) m = a ? OC_FORCE_HIGH : OC_FORCE_LOW;
		else if (a && b) m = OC_FORCE_HIGH;
		else if (!a && !b) m = OC_FORCE_LOW;
		else if (b) m = OC_PWM1;   // being added: on for frac counts
		else m = OC_PWM2;          // being removed: off for frac counts
		set_mode(i, m);
	}
}

static void all_off(void)
{
	set_mode(0, OC_FORCE_LOW);
	set_mode(1, OC_FORCE_LOW);
	set_mode(2, OC_FORCE_LOW);
}

// Expected current for each combination at the present bus voltage.
static void estimate_table(void)
{
	uint32_t v = vbus_mv ? vbus_mv : 5000;
	est_ma[0] = 0;
	for (int k = 1; k < 8; k++) {
		// parallel conductance in micro-siemens
		uint32_t g = 0;
		for (int i = 0; i < 3; i++)
			if (k & (1 << i)) g += 1000000000u / leg_mohm[i];
		uint32_t r_mohm = 1000000000u / g + SHUNT_MOHM;
		est_ma[k] = (uint16_t)(v * 1000u / r_mohm);
	}
}

static uint32_t feedforward(uint16_t ma)
{
	for (int k = 0; k < 7; k++) {
		if (ma <= est_ma[k + 1]) {
			uint32_t span = est_ma[k + 1] - est_ma[k];
			uint32_t frac = span ? (uint32_t)(ma - est_ma[k]) * PWM_STEPS / span : 0;
			return k * PWM_STEPS + frac;
		}
	}
	return U_MAX;
}

static inline uint16_t raw_to_mv(uint32_t raw16)
{
	// raw / ref = V / 1.2 V  ->  mV = raw * 1200 / ref (both x16)
	return (uint16_t)(raw16 * VREFINT_MV / (ref_raw16 ? ref_raw16 : 1));
}

static void control_step(uint32_t i_raw16)
{
	int32_t z = (int32_t)i_raw16 - (int32_t)zero_raw;
	if (z < 0) z = 0;
	uint16_t ma = raw_to_mv((uint32_t)z);   // 1 R shunt: mV == mA
	live_ma = (uint16_t)((live_ma * 3u + ma) / 4u);

	uint16_t tgt = target_ma;
	if (tgt == 0) {
		if (last_target) { all_off(); last_target = 0; }
		oc_count = 0;
		return;
	}
	if (tgt != last_target) {
		if (last_target == 0) estimate_table();
		u = feedforward(tgt);
		last_target = tgt;
		pulse_steps = 0;
		apply_u(u);
		return;
	}

	// Integral control: step u by the error scaled by the local slope.
	uint32_t k = u / PWM_STEPS;
	if (k > 6) k = 6;
	int32_t slope = est_ma[k + 1] - est_ma[k];         // mA per PWM_STEPS
	if (slope < 10) slope = 10;
	int32_t err = (int32_t)tgt - (int32_t)ma;
	int32_t du = err * (int32_t)PWM_STEPS / slope / 2;  // half gain for stability
	int32_t nu = (int32_t)u + du;
	if (nu < 0) nu = 0;
	if (nu > (int32_t)U_MAX) nu = U_MAX;
	u = (uint32_t)nu;
	apply_u(u);

	if (pulse_steps < 255) pulse_steps++;
	if (pulse_steps > SETTLE_STEPS) { pulse_sum += ma; pulse_n++; }
	if (u == U_MAX && err > 10 && pulse_steps > 10) flags |= LOAD_F_SATURATED;
	if (ma > OVERCURRENT_MA) {
		if (++oc_count >= 2) { flags |= LOAD_F_OVERCURRENT; all_off(); target_ma = 0; last_target = 0; }
	} else oc_count = 0;
}

void TIM3_IRQHandler(void) __attribute__((interrupt));
void TIM3_IRQHandler(void)
{
	TIM3->INTFR = 0;
	uint32_t r = ADC1->RDATAR;

	if (cur_ch == ADC_CH_ISENSE) {
		i_acc += r; i_n++;
		if (i_n >= 6) { control_step(i_acc * 16 / i_n); i_acc = 0; i_n = 0; }
	} else if (cur_ch == ADC_CH_VSENSE) {
		vbus_raw16 = vbus_raw16 ? (vbus_raw16 * 7 + r * 16) / 8 : r * 16;
		vbus_mv = (uint16_t)((uint32_t)raw_to_mv(vbus_raw16) * VSENSE_NUM / VSENSE_DEN);
	} else {
		ref_raw16 = (ref_raw16 * 7 + r * 16) / 8;
		vdd_mv = (uint16_t)(VREFINT_MV * 4095u * 16u / ref_raw16);
	}

	slot = (slot + 1) & 7;
	if (slot == 7) {
		round_ = (round_ + 1) & 7;
		cur_ch = round_ == 0 ? ADC_CH_VREF : ADC_CH_VSENSE;
	} else cur_ch = ADC_CH_ISENSE;
	ADC1->RSQR3 = cur_ch;
	ADC1->CTLR2 |= ADC_SWSTART;
}

static uint16_t adc_read_blocking(int ch)
{
	ADC1->RSQR3 = ch;
	ADC1->CTLR2 |= ADC_SWSTART;
	while (!(ADC1->STATR & ADC_EOC));
	return (uint16_t)ADC1->RDATAR;
}

static void adc_init(void)
{
	RCC->APB2PCENR |= RCC_APB2Periph_ADC1;
	RCC->APB2PRSTR |= RCC_APB2Periph_ADC1;
	RCC->APB2PRSTR &= ~RCC_APB2Periph_ADC1;
	ADC1->CTLR3 = (ADC1->CTLR3 & ~0x7Fu) | 0x37;   // ADC_CLK_Div8: 6 MHz
	// Longest sample time (11 cycles) on the channels we use.
	ADC1->SAMPTR2 = (7u << (3 * ADC_CH_VSENSE)) | (7u << (3 * ADC_CH_ISENSE));
	ADC1->SAMPTR1 = (7u << (3 * (ADC_CH_VREF - 10)));
	ADC1->CTLR2 |= ADC_ADON | ADC_EXTSEL | ADC_TSVREFE;
	ADC1->CTLR2 |= CTLR2_RSTCAL_Set;
	while (ADC1->CTLR2 & CTLR2_RSTCAL_Set);
	ADC1->CTLR2 |= CTLR2_CAL_Set;
	while (ADC1->CTLR2 & CTLR2_CAL_Set);
}

static void tim3_start(void)
{
	TIM3->CNT = 0;
	TIM3->INTFR = 0;
	TIM3->DMAINTENR = TIM_UIE;
	TIM3->CTLR1 = TIM_CEN;
	NVIC_EnableIRQ(TIM3_IRQn);
}

void load_init(void)
{
	// Gates: hold low as plain outputs until the timer owns them.
	funPinMode(PIN_GATE_A, GPIO_CFGLR_OUT_10Mhz_PP);
	funPinMode(PIN_GATE_B, GPIO_CFGLR_OUT_10Mhz_PP);
	funPinMode(PIN_GATE_C, GPIO_CFGLR_OUT_10Mhz_PP);
	funDigitalWrite(PIN_GATE_A, FUN_LOW);
	funDigitalWrite(PIN_GATE_B, FUN_LOW);
	funDigitalWrite(PIN_GATE_C, FUN_LOW);
	funPinMode(PIN_VSENSE, GPIO_CFGLR_IN_ANALOG);
	funPinMode(PIN_ISENSE, GPIO_CFGLR_IN_ANALOG);

	// TIM2: 24 kHz PWM on CH1-3, all forced low to start.
	RCC->APB1PCENR |= RCC_APB1Periph_TIM2;
	TIM2->PSC = 0;
	TIM2->ATRLR = PWM_STEPS - 1;
	TIM2->CHCTLR1 = TIM_OC1PE | TIM_OC2PE;
	TIM2->CHCTLR2 = TIM_OC3PE;
	all_off();
	TIM2->CCER = TIM_CC1E | TIM_CC2E | TIM_CC3E;
	TIM2->BDTR |= TIM_MOE;
	TIM2->CTLR1 = TIM_ARPE;
	TIM2->SWEVGR = TIM_UG;
	TIM2->CTLR1 |= TIM_CEN;
	funPinMode(PIN_GATE_A, GPIO_CFGLR_OUT_10Mhz_AF_PP);
	funPinMode(PIN_GATE_B, GPIO_CFGLR_OUT_10Mhz_AF_PP);
	funPinMode(PIN_GATE_C, GPIO_CFGLR_OUT_10Mhz_AF_PP);

	adc_init();

	// Reference and bus voltage before anything else.
	uint32_t s = 0;
	for (int i = 0; i < 16; i++) s += adc_read_blocking(ADC_CH_VREF);
	ref_raw16 = s;
	s = 0;
	for (int i = 0; i < 16; i++) s += adc_read_blocking(ADC_CH_VSENSE);
	vbus_raw16 = s;
	vbus_mv = (uint16_t)((uint32_t)raw_to_mv(vbus_raw16) * VSENSE_NUM / VSENSE_DEN);
	vdd_mv = (uint16_t)(VREFINT_MV * 4095u * 16u / ref_raw16);

	// TIM3: 1 MHz tick, 4 kHz update interrupt drives sampling and control.
	RCC->APB1PCENR |= RCC_APB1Periph_TIM3;
	TIM3->PSC = 48 - 1;
	TIM3->ATRLR = 250 - 1;
	ADC1->RSQR3 = cur_ch;
	ADC1->CTLR2 |= ADC_SWSTART;
	tim3_start();
}

void load_zero_cal(void)
{
	// Legs are off; the ISR is running, so read directly between its conversions.
	NVIC_DisableIRQ(TIM3_IRQn);
	Delay_Ms(2);
	uint32_t s = 0;
	for (int i = 0; i < 64; i++) s += adc_read_blocking(ADC_CH_ISENSE);
	zero_raw = (uint16_t)(s / 4);   // x16 scale
	ADC1->RSQR3 = cur_ch;
	ADC1->CTLR2 |= ADC_SWSTART;
	NVIC_EnableIRQ(TIM3_IRQn);
}

void load_set_target(uint16_t ma)
{
	if (ma > MA_MAX) ma = MA_MAX;
	target_ma = ma;
}

uint16_t load_ma(void) { return target_ma || last_target ? live_ma : 0; }
uint16_t load_vbus_mv(void) { return vbus_mv; }
uint16_t load_vdd_mv(void) { return vdd_mv; }

void load_pulse_begin(void)
{
	NVIC_DisableIRQ(TIM3_IRQn);
	pulse_sum = 0; pulse_n = 0;
	NVIC_EnableIRQ(TIM3_IRQn);
}

uint16_t load_pulse_end(void)
{
	NVIC_DisableIRQ(TIM3_IRQn);
	uint32_t s = pulse_sum, n = pulse_n;
	NVIC_EnableIRQ(TIM3_IRQn);
	if (!n) return live_ma;
	return (uint16_t)((s + n / 2) / n);
}

uint8_t load_take_flags(void)
{
	NVIC_DisableIRQ(TIM3_IRQn);
	uint8_t f = flags;
	flags = 0;
	NVIC_EnableIRQ(TIM3_IRQn);
	return f;
}

void load_suspend(void)
{
	target_ma = 0;
	NVIC_DisableIRQ(TIM3_IRQn);
	all_off();
	last_target = 0;
	TIM3->CTLR1 = 0;
	ADC1->CTLR2 &= ~ADC_ADON;
}

void load_resume(void)
{
	ADC1->CTLR2 |= ADC_ADON;
	Delay_Us(20);
	uint32_t s = 0;
	for (int i = 0; i < 8; i++) s += adc_read_blocking(ADC_CH_VSENSE);
	vbus_raw16 = s * 2;
	vbus_mv = (uint16_t)((uint32_t)raw_to_mv(vbus_raw16) * VSENSE_NUM / VSENSE_DEN);
	ADC1->RSQR3 = cur_ch;
	ADC1->CTLR2 |= ADC_SWSTART;
	tim3_start();
}
