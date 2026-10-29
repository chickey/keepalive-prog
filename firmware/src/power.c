// Low-power sleep between pulses when running from a power bank.
// Uses standby with the auto-wake-up (AWU) timer, as in WCH's X035
// Standby_Mode example; the PRESET button can also wake it via EXTI line 1.
#include "ch32fun.h"
#include "board.h"
#include "power.h"

// AWU registers (AWU_BASE): CSR, WR, PSC
typedef struct { volatile uint32_t CSR, WR, PSC; } awu_t;
#define AWU_REG       ((awu_t *)AWU_BASE)
#define AWU_PSC_1024  0x0B
#define EXTI_AWU_LINE (1u << 27)
#define EXTI_BTN_LINE (1u << 1)     // PB1

// AWU timing. A programmed window of W ticks gives a period of W + 1 ticks
// (measured: 8 -> 196.6 ms, 4 -> 109.2 ms, so 21.84 ms per tick while awake).
// power_calibrate() measures the tick against SysTick at power-up.
#define AWU_TICK_US_DEFAULT 21845u
#define AWU_MAX_TICKS       63u
#define CAL_TICKS           4u          // AWU period while calibrating
#define TICKS_PER_US        (FUNCONF_SYSTEM_CORE_CLOCK / 1000000)

static uint32_t awu_tick_us = AWU_TICK_US_DEFAULT;
static volatile uint8_t woke_by_button;
static volatile uint32_t awu_events;

void AWU_IRQHandler(void) __attribute__((interrupt));
void AWU_IRQHandler(void)
{
	EXTI->INTFR = EXTI_AWU_LINE;
	awu_events++;
}

void EXTI7_0_IRQHandler(void) __attribute__((interrupt));
void EXTI7_0_IRQHandler(void)
{
	EXTI->INTFR = EXTI_BTN_LINE;
	woke_by_button = 1;
}

void power_init(void)
{
	RCC->APB1PCENR |= RCC_APB1Periph_PWR;
	RCC->APB2PCENR |= RCC_APB2Periph_AFIO;
	// PB1 -> EXTI line 1 (2 bits per line on X035: 0=A, 1=B, 2=C)
	AFIO->EXTICR1 = (AFIO->EXTICR1 & ~(3u << 2)) | (1u << 2);
	EXTI->FTENR |= EXTI_BTN_LINE | EXTI_AWU_LINE;
	EXTI->INTENR |= EXTI_BTN_LINE | EXTI_AWU_LINE;
	EXTI->INTFR = EXTI_BTN_LINE | EXTI_AWU_LINE;
	NVIC_EnableIRQ(AWU_IRQn);
	NVIC_EnableIRQ(EXTI7_0_IRQn);
}

static void awu_start(uint32_t ticks)
{
	AWU_REG->CSR &= ~(1u << 1);
	AWU_REG->PSC = (AWU_REG->PSC & ~0xFu) | AWU_PSC_1024;
	AWU_REG->WR = (AWU_REG->WR & ~0x3Fu) | ticks;
	EXTI->INTFR = EXTI_AWU_LINE;
	AWU_REG->CSR |= (1u << 1);
}

// Time CAL_TICKS-tick AWU periods with SysTick (48 MHz HSI, about 1%) while
// awake, skipping the first period. Takes about 0.4 s.
void power_calibrate(void)
{
	uint32_t t[3], start = SysTick->CNTL;
	awu_events = 0;
	awu_start(CAL_TICKS);
	for (uint32_t n = 1; n <= 3; n++) {
		while (awu_events < n) {
			if (SysTick->CNTL - start > 2000000u * TICKS_PER_US) goto done;   // 2 s: AWU not running
		}
		t[n - 1] = SysTick->CNTL;
	}
	uint32_t us = (t[2] - t[0]) / TICKS_PER_US / (2 * (CAL_TICKS + 1));
	if (us >= 5000u && us <= 80000u) awu_tick_us = us;
done:
	AWU_REG->CSR &= ~(1u << 1);
}

uint32_t power_awu_tick_us(void) { return awu_tick_us; }

uint32_t power_min_sleep_ms(void) { return (2 * awu_tick_us) / 1000 + 5; }

// Sleep for about ms (rounded down to whole AWU ticks). Returns the time
// actually slept, in ms, so the caller can advance its clock. A button
// press ends the sleep early; then the elapsed time is unknown and 0 is
// returned (the caller restarts its schedule on a button press anyway).
uint32_t power_deep_sleep(uint32_t ms, uint8_t *by_button)
{
	uint32_t ticks = ms * 1000u / awu_tick_us;
	if (ticks > AWU_MAX_TICKS) ticks = AWU_MAX_TICKS;
	*by_button = 0;
	if (ticks < 2) return 0;

	woke_by_button = 0;
	awu_start(ticks - 1);            // W gives W + 1 ticks
	EXTI->INTFR = EXTI_BTN_LINE;

	NVIC_DisableIRQ(SysTick_IRQn);
	PWR->CTLR |= PWR_CTLR_PDDS;
	PFIC->SCTLR |= (1u << 2);        // SLEEPDEEP
	__WFI();
	PFIC->SCTLR &= ~(1u << 2);
	PWR->CTLR &= ~PWR_CTLR_PDDS;
	AWU_REG->CSR &= ~(1u << 1);

	SystemInit();                    // HSI back to 48 MHz
	*by_button = woke_by_button;
	return woke_by_button ? 0 : ticks * awu_tick_us / 1000u;
}
