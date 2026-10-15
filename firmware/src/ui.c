#include "ch32fun.h"
#include "board.h"
#include "ui.h"

#define DEBOUNCE_MS   30
#define LONG_MS       1500
#define BLINK_ON_MS   150
#define BLINK_OFF_MS  250
#define FAULT_HALF_MS 125

static uint8_t  raw_prev, stable, long_fired;
static uint32_t raw_since, press_t;
static uint8_t  blinks_left, led_on, base;
static uint32_t next_led;
static uint8_t  kick;

static inline void led(uint8_t on) { funDigitalWrite(PIN_LED, on ? FUN_HIGH : FUN_LOW); }

void ui_init(void)
{
	funPinMode(PIN_LED, GPIO_CFGLR_OUT_10Mhz_PP);
	led(0);
	funPinMode(PIN_PRESET, GPIO_CFGLR_IN_PUPD);
	funDigitalWrite(PIN_PRESET, FUN_HIGH);   // pull-up
}

uint8_t ui_button_down(void) { return !funDigitalRead(PIN_PRESET); }

int ui_poll(uint32_t now)
{
	int ev = UI_NONE;
	uint8_t raw = ui_button_down();
	if (raw != raw_prev) { raw_prev = raw; raw_since = now; }
	if (raw != stable && now - raw_since >= DEBOUNCE_MS) {
		stable = raw;
		if (stable) { press_t = now; long_fired = 0; }
		else if (!long_fired) ev = UI_SHORT;
	}
	if (stable && !long_fired && now - press_t >= LONG_MS) { long_fired = 1; ev = UI_LONG; }

	// LED pattern
	if (kick || (int32_t)(now - next_led) >= 0) {
		kick = 0;
		if (blinks_left || led_on) {
			if (led_on) { led_on = 0; led(0); next_led = now + BLINK_OFF_MS; if (blinks_left == 0) next_led = now + 400; }
			else if (blinks_left) { blinks_left--; led_on = 1; led(1); next_led = now + BLINK_ON_MS; }
		} else if (base == LED_BASE_FAULT) {
			static uint8_t ph;
			ph ^= 1; led(ph); next_led = now + FAULT_HALF_MS;
		} else {
			led(base == LED_BASE_ON);
			next_led = now + 50;
		}
	}
	return ev;
}

void ui_blink(uint8_t n)
{
	led(0);
	led_on = 0;
	blinks_left = n;
	kick = 1;
}

void ui_set_base(uint8_t mode) { base = mode; }

uint8_t ui_busy(void) { return blinks_left || led_on || stable || raw_prev || base == LED_BASE_FAULT; }

uint32_t ui_ms_to_next(uint32_t now)
{
	if (ui_busy()) return 0;
	(void)now;
	return UINT32_MAX;
}
