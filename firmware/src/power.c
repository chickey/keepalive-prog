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

// AWU clock = HSI/1024 = 46.875 kHz; with /1024 prescale one tick = 21.845 ms.
#define AWU_TICK_US   21845u
#define AWU_MAX_TICKS 63u

static volatile uint8_t woke_by_button;

void AWU_IRQHandler(void) __attribute__((interrupt));
void AWU_IRQHandler(void)
{
	EXTI->INTFR = EXTI_AWU_LINE;
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

uint32_t power_min_sleep_ms(void) { return (2 * AWU_TICK_US) / 1000 + 5; }

// Sleep for about ms (rounded down to whole AWU ticks). Returns the time
// actually slept, in ms, so the caller can advance its clock. A button
// press ends the sleep early; then the elapsed time is unknown and 0 is
// returned (the caller restarts its schedule on a button press anyway).
uint32_t power_deep_sleep(uint32_t ms, uint8_t *by_button)
{
	uint32_t ticks = ms * 1000u / AWU_TICK_US;
	if (ticks > AWU_MAX_TICKS) ticks = AWU_MAX_TICKS;
	*by_button = 0;
	if (ticks < 2) return 0;

	woke_by_button = 0;
	AWU_REG->CSR &= ~(1u << 1);
	AWU_REG->PSC = (AWU_REG->PSC & ~0xFu) | AWU_PSC_1024;
	AWU_REG->WR = (AWU_REG->WR & ~0x3Fu) | ticks;
	EXTI->INTFR = EXTI_AWU_LINE | EXTI_BTN_LINE;
	AWU_REG->CSR |= (1u << 1);

	NVIC_DisableIRQ(SysTick_IRQn);
	PWR->CTLR |= PWR_CTLR_PDDS;
	PFIC->SCTLR |= (1u << 2);        // SLEEPDEEP
	__WFI();
	PFIC->SCTLR &= ~(1u << 2);
	PWR->CTLR &= ~PWR_CTLR_PDDS;
	AWU_REG->CSR &= ~(1u << 1);

	SystemInit();                    // HSI back to 48 MHz
	*by_button = woke_by_button;
	return woke_by_button ? 0 : ticks * AWU_TICK_US / 1000u;
}
