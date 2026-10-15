// Eplop Keep Alive firmware, CH32X035F8U6.
//
// At power-up the board decides whether it is plugged into a computer
// (config mode: enumerates as a USB serial port, pulsing paused until the
// page starts a trial) or into a power bank (keep-alive mode: runs the active
// preset, sleeps between pulses). See PROTOCOL.md and HARDWARE.md.
#include "ch32fun.h"
#include "app.h"
#include "load.h"
#include "store.h"
#include "ui.h"
#include "usbio.h"
#include "power.h"

void proto_stream_status(void);

#define DEEP_SLEEP      1        // 0 = light sleep only (bring-up aid)
#define REMIND_MS       10000u   // keep-alive mode: blink the preset number this often
#define BOOT_DELAY_MS   200u

// ---------------------------------------------------------------- time
#define TICKS_PER_MS (FUNCONF_SYSTEM_CORE_CLOCK / 1000)
static volatile uint32_t ms;

void SysTick_Handler(void) __attribute__((interrupt));
void SysTick_Handler(void)
{
	SysTick->CMP += TICKS_PER_MS;
	SysTick->SR = 0;
	ms++;
}

static void systick_start(void)
{
	SysTick->CTLR = 0;
	SysTick->CMP = SysTick->CNT + TICKS_PER_MS;
	SysTick->SR = 0;
	SysTick->CTLR = SYSTICK_CTLR_STE | SYSTICK_CTLR_STIE | SYSTICK_CTLR_STCLK;
	NVIC_EnableIRQ(SysTick_IRQn);
}

uint32_t hal_millis(void) { return ms; }

// ---------------------------------------------------------------- faults
enum { F_OV = 1, F_UV = 2, F_OC = 4 };
static uint8_t  faults;
static uint32_t oc_clear_at;
static uint8_t  noreg_pulse, noreg_shown;
static uint16_t cur_set;

static void fault_event(void)
{
	uint16_t v = load_vbus_mv();
	if (!faults) { proto_event("!F CLEAR"); return; }
	const char *why = (faults & F_OV) ? "OVERVOLT" : (faults & F_UV) ? "UNDERVOLT" : "OVERCURRENT";
	proto_event("!F %s vbus=%u", why, v);
}

static void fault_poll(uint32_t now)
{
	uint8_t old = faults;
	uint16_t v = load_vbus_mv();
	uint8_t f = load_take_flags();

	if (v > VBUS_OV_MV) faults |= F_OV;
	else if (v < VBUS_OV_CLR_MV) faults &= ~F_OV;
	if (v < VBUS_UV_MV) faults |= F_UV;
	else if (v > VBUS_UV_CLR_MV) faults &= ~F_UV;
	if (f & LOAD_F_OVERCURRENT) { faults |= F_OC; oc_clear_at = now + 2000; }
	else if ((faults & F_OC) && (int32_t)(now - oc_clear_at) >= 0) faults &= ~F_OC;
	if (f & LOAD_F_SATURATED) noreg_pulse = 1;

	if (faults != old) {
		fault_event();
		ui_set_base(faults ? LED_BASE_FAULT : (app.host ? LED_BASE_ON : LED_BASE_OFF));
	}
}

// ---------------------------------------------------------------- services for proto.c
void hal_status(status_t *s)
{
	s->vbus_mv = load_vbus_mv();
	s->ma = load_ma();
	s->set = cur_set;
	if (faults) s->state = ST_FAULT;
	else if (cur_set) s->state = ST_ON;
	else if (sched_testing() || (app.run && app.presets[app.active - 1].ma)) s->state = ST_OFF;
	else s->state = ST_IDLE;
}

int hal_save(void) { return store_save(); }

static uint8_t  boot_pending;
static uint32_t boot_at;
void hal_request_bootloader(void) { boot_pending = 1; boot_at = ms + BOOT_DELAY_MS; }

uint32_t hal_uid(void) { return ESIG->UID0 ^ ESIG->UID1; }

// ---------------------------------------------------------------- pulse edges
void on_pulse_start(uint32_t t, uint16_t set)
{
	load_pulse_begin();
	noreg_pulse = 0;
	proto_event("!E on t=%lu set=%u", (unsigned long)t, set);
}

void on_pulse_end(uint32_t t, uint32_t dur, uint8_t was_test)
{
	uint16_t avg = load_pulse_end();
	proto_event("!E off t=%lu ma=%u dur=%lu", (unsigned long)t, avg, (unsigned long)dur);
	if (was_test) proto_event("!T done ma=%u", avg);
	if (noreg_pulse && !noreg_shown) { proto_event("!F NOREG vbus=%u", load_vbus_mv()); noreg_shown = 1; }
	else if (!noreg_pulse && noreg_shown && !faults) { proto_event("!F CLEAR"); noreg_shown = 0; }
}

// Unused pins as pulled-up inputs so they don't float (and draw current) in sleep.
static void unused_pins_init(void)
{
	const uint32_t pins[] = { PA3, PA5, PA7, PB0, PB3, PB11, PC14, PC15 };
	for (unsigned i = 0; i < sizeof pins / sizeof pins[0]; i++) {
		funPinMode(pins[i], GPIO_CFGLR_IN_PUPD);
		funDigitalWrite(pins[i], FUN_HIGH);
	}
}

// ---------------------------------------------------------------- main
int main(void)
{
	SystemInit();
	systick_start();
	funGpioInitAll();
	unused_pins_init();

	ui_init();
	load_init();
	store_load();
	load_zero_cal();
	power_init();

	app.host = usbio_detect_and_attach(hal_millis);
	app.run = !app.host;            // paused while connected to a computer
	ui_set_base(app.host ? LED_BASE_ON : LED_BASE_OFF);
	ui_blink(app.active);
	sched_restart(ms);

	uint32_t last_stream = ms, last_remind = ms;

	for (;;) {
		uint32_t now = ms;

		usbio_poll();

		int ev = ui_poll(now);
		if (ev == UI_SHORT) {
			app.active = (uint8_t)(app.active % NPRESETS + 1);
			sched_restart(now);
			store_save();
			ui_blink(app.active);
			proto_event("!P active=%u", app.active);
			last_remind = now;
		} else if (ev == UI_LONG) {
			ui_blink(app.active);
		}

		fault_poll(now);
		cur_set = sched_update(now);
		load_set_target(faults ? 0 : cur_set);

		if (app.stream_ms && now - last_stream >= app.stream_ms) {
			last_stream = now;
			proto_stream_status();
		}

		if (!app.host && !cur_set && now - last_remind >= REMIND_MS) {
			last_remind = now;
			ui_blink(app.active);
		}

		if (boot_pending && (usbio_tx_empty() || (int32_t)(now - boot_at) >= 0)) {
			Delay_Ms(20);
			funRebootToBootloader();
		}

		// Keep-alive mode: deep sleep until the next thing needs doing.
		if (DEEP_SLEEP && !app.host && !cur_set && !faults && !ui_busy()) {
			uint32_t d = sched_ms_to_next_edge(now);
			uint32_t r = REMIND_MS - (now - last_remind);
			if (r < d) d = r;
			if (d != UINT32_MAX && d > power_min_sleep_ms()) {
				uint8_t by_button;
				load_suspend();
				uint32_t slept = power_deep_sleep(d - 5, &by_button);
				systick_start();
				ms += slept;
				load_resume();
				continue;
			}
		}
		__WFI();   // SysTick wakes us every millisecond
	}
}
