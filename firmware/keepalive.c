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
// Time is read from the 64-bit SysTick counter, not counted in the interrupt.
// 1.0.1 did ms++ and CMP += 1 ms in the interrupt; once a tick was serviced
// late the compare fell behind the counter, the interrupt stopped and time
// froze, leaving a pulse (and the LED) on for good. The interrupt now only
// wakes the main loop from WFI once a millisecond.
#define TICKS_PER_MS (FUNCONF_SYSTEM_CORE_CLOCK / 1000)
static uint64_t cnt0;      // counter value when the clock read ms_base
static uint32_t ms_base;

static uint64_t systick_cnt(void)
{
	uint32_t h, l;
	do { h = SysTick->CNTH; l = SysTick->CNTL; } while (h != SysTick->CNTH);
	return (uint64_t)h << 32 | l;
}

void SysTick_Handler(void) __attribute__((interrupt));
void SysTick_Handler(void)
{
	SysTick->CMP = systick_cnt() + TICKS_PER_MS;
	SysTick->SR = 0;
}

// (Re)start the clock reading now_ms, e.g. after standby stopped the counter.
static void systick_start(uint32_t now_ms)
{
	SysTick->CTLR = SYSTICK_CTLR_STE | SYSTICK_CTLR_STIE | SYSTICK_CTLR_STCLK;
	cnt0 = systick_cnt();
	ms_base = now_ms;
	SysTick->CMP = cnt0 + TICKS_PER_MS;
	SysTick->SR = 0;
	NVIC_EnableIRQ(SysTick_IRQn);
}

uint32_t hal_millis(void) { return ms_base + (uint32_t)((systick_cnt() - cnt0) / TICKS_PER_MS); }

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
void hal_request_bootloader(void) { boot_pending = 1; boot_at = hal_millis() + BOOT_DELAY_MS; }

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
	RCC->AHBPCENR |= RCC_AHBPeriph_SRAM;   // keep SRAM clocked in sleep
	systick_start(0);
	funGpioInitAll();
	unused_pins_init();

	ui_init();
	load_init();
	store_load();
	load_zero_cal();
	power_init();

	// Pulse from the start, as in keep-alive mode, while waiting to see
	// whether a computer enumerates us; pause once one does.
	usbio_detect_and_attach(hal_millis());
	int usb = usbio_host_poll(hal_millis());
	app.host = 0;
	app.run = 1;
	ui_set_base(LED_BASE_OFF);
	ui_blink(app.active);
	sched_restart(hal_millis());

	uint32_t last_stream = hal_millis(), last_remind = last_stream;

	for (;;) {
		uint32_t now = hal_millis();

		if (usb == USB_WAITING) {
			usb = usbio_host_poll(now);
			if (usb == USB_HOST) {
				app.host = 1;
				app.run = 0;            // paused while connected to a computer
				sched_restart(now);
				if (!faults) ui_set_base(LED_BASE_ON);
			}
		}
		usbio_poll();

		int ev = ui_poll(now);
		if (ev == UI_SHORT) {
			app.active = app_next_enabled(app.active);
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
		// Not while waiting for a host: deep sleep would stop USB.
		if (DEEP_SLEEP && usb == USB_NONE && !cur_set && !faults && !ui_busy()) {
			uint32_t d = sched_ms_to_next_edge(now);
			uint32_t r = REMIND_MS - (now - last_remind);
			if (r < d) d = r;
			if (d != UINT32_MAX && d > power_min_sleep_ms()) {
				uint8_t by_button;
				load_suspend();
				uint32_t slept = power_deep_sleep(d - 5, &by_button);
				systick_start(now + slept);
				load_resume();
				continue;
			}
		}
		// No WFI while on USB: with the core asleep, about 1 packet in 20
		// reached the host with a 4-byte word zeroed (seen on 1.0.1).
		if (usb == USB_NONE) __WFI();   // SysTick wakes us every millisecond
	}
}
