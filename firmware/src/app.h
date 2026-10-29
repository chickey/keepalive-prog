// Shared application state and the interfaces between modules.
// proto.c and sched.c only use what is declared here, so they can be built
// and unit-tested on a PC (see test/).
#ifndef APP_H
#define APP_H

#include <stdint.h>
#include "board.h"

typedef struct {
	uint16_t ma;    // 0 = preset disabled
	uint32_t on;    // ms
	uint32_t off;   // ms, 0 = continuous
	uint8_t  en;    // 0 = disabled: skipped by the button, can't be selected
} preset_t;

// Light in keep-alive mode (button presses, power-up and faults always show).
enum { LED_MODE_OFF, LED_MODE_PULSE, LED_MODE_REMIND };

typedef struct {
	preset_t presets[NPRESETS];
	uint8_t  active;      // 1-based
	uint8_t  run;         // pulsing enabled
	uint8_t  host;        // enumerated by a USB host (config mode)
	uint8_t  led;         // keep-alive mode light: LED_MODE_*
	uint16_t stream_ms;   // 0 = off
} app_t;

extern app_t app;

enum { ST_IDLE, ST_OFF, ST_ON, ST_FAULT };

typedef struct {
	uint16_t vbus_mv;
	uint16_t ma;      // live measured
	uint16_t set;     // current target (0 between pulses)
	uint8_t  state;   // ST_*
} status_t;

// Factory presets
void app_defaults(void);
// Next enabled preset after n (wrapping); n itself if it is the only one.
uint8_t app_next_enabled(uint8_t n);
// Checks a preset against the limits; NULL if fine, else what's wrong.
const char *preset_check(const preset_t *p);
// Pulls a preset into the limits (for presets saved by older firmware).
void preset_clamp(preset_t *p);

// ---- Scheduler (sched.c) ----
void     sched_restart(uint32_t now);                        // schedule changed: end pulse, restart cycle
int      sched_test(uint32_t now, uint16_t ma, uint32_t ms); // one-off pulse
uint16_t sched_update(uint32_t now);                         // target mA right now; fires edge callbacks
uint32_t sched_ms_to_next_edge(uint32_t now);                // UINT32_MAX if nothing scheduled
uint8_t  sched_testing(void);

// Edge callbacks, implemented by the application (main.c / test).
void on_pulse_start(uint32_t t, uint16_t set);
void on_pulse_end(uint32_t t, uint32_t dur, uint8_t was_test);

// ---- Protocol (proto.c) ----
void proto_line(char *line);              // handle one received command line
void proto_event(const char *fmt, ...);   // send an unsolicited "!..." line (only while streaming)

// ---- Services the protocol needs (implemented in main.c / test) ----
uint32_t hal_millis(void);
void     hal_status(status_t *s);
int      hal_save(void);                  // 0 = ok
void     hal_request_bootloader(void);    // reboot after the reply is sent
uint32_t hal_uid(void);
uint32_t hal_awu_tick_us(void);           // measured standby wake-up tick
void     out_line(const char *s);         // send s + "\n" to the host

#endif
