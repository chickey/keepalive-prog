// Pulse scheduler. Pure logic: given the time, works out whether the load
// should be on and at what current, and reports each pulse edge at its exact
// scheduled time (not the time it was noticed), so edges stay accurate even
// if the main loop runs late, e.g. after waking from sleep.
#include <stdint.h>
#include "app.h"

static uint32_t run_start;   // start of the current cycle
static uint32_t last_t;      // time already processed
static uint8_t  open;        // a pulse is in progress
static uint32_t open_t;
static uint16_t open_set;
static uint8_t  open_test;

static struct { uint8_t active; uint16_t ma; uint32_t start, end; } test;

// Signed difference for wrap-safe comparisons of uint32 ms.
static inline int32_t tdiff(uint32_t a, uint32_t b) { return (int32_t)(a - b); }
// a in (from, to]
static inline int in_window(uint32_t a, uint32_t from, uint32_t to)
{
	return tdiff(a, from) > 0 && tdiff(a, to) <= 0;
}

static void edge_on(uint32_t t, uint16_t set, uint8_t is_test)
{
	if (open) {
		uint32_t dur = t - open_t;
		open = 0;
		on_pulse_end(t, dur, open_test);
	}
	open = 1; open_t = t; open_set = set; open_test = is_test;
	on_pulse_start(t, set);
}

static void edge_off(uint32_t t)
{
	if (!open) return;
	open = 0;
	on_pulse_end(t, t - open_t, open_test);
}

void sched_restart(uint32_t now)
{
	edge_off(now);
	run_start = now;
	last_t = now - 1;
}

int sched_test(uint32_t now, uint16_t ma, uint32_t ms)
{
	sched_restart(now);
	test.active = 1;
	test.ma = ma;
	test.start = now;
	test.end = now + ms;
	return 0;
}

uint8_t sched_testing(void) { return test.active; }

static const preset_t *cur(void) { return &app.presets[app.active - 1]; }

uint16_t sched_update(uint32_t now)
{
	uint32_t from = last_t;
	last_t = now;

	if (test.active) {
		if (in_window(test.start, from, now)) edge_on(test.start, test.ma, 1);
		if (tdiff(now, test.end) >= 0) {
			edge_off(test.end);
			test.active = 0;
			run_start = test.end;   // trial cycle restarts after the test
			last_t = now;
		}
	} else if (app.run) {
		const preset_t *p = cur();
		if (p->ma == 0) {
			edge_off(now);
		} else if (p->off == 0) {
			if (!open) edge_on(tdiff(run_start, from) > 0 ? run_start : now, p->ma, 0);
		} else {
			uint32_t per = p->on + p->off;
			int32_t a = tdiff(from, run_start);
			uint32_t k0 = a > 0 ? (uint32_t)a / per : 0;
			uint32_t k1 = (uint32_t)tdiff(now, run_start) / per;
			// After a long gap (e.g. deep sleep overshoot) only replay the last cycle.
			if (k1 > k0 + 1) k0 = k1 - 1;
			for (uint32_t k = k0; k <= k1; k++) {
				uint32_t t_on = run_start + k * per;
				uint32_t t_off = t_on + p->on;
				if (in_window(t_on, from, now)) edge_on(t_on, p->ma, 0);
				if (in_window(t_off, from, now)) edge_off(t_off);
			}
		}
	} else {
		edge_off(now);
	}
	return open ? open_set : 0;
}

uint32_t sched_ms_to_next_edge(uint32_t now)
{
	if (test.active) {
		int32_t d = tdiff(open ? test.end : test.start, now);
		return d > 0 ? (uint32_t)d : 0;
	}
	if (!app.run) return UINT32_MAX;
	const preset_t *p = cur();
	if (p->ma == 0) return UINT32_MAX;
	if (p->off == 0) return open ? UINT32_MAX : 0;
	uint32_t per = p->on + p->off;
	uint32_t ph = (uint32_t)tdiff(now, run_start) % per;
	return ph < p->on ? p->on - ph : per - ph;
}
