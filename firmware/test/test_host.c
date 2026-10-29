// Host-side tests for the protocol and scheduler (no hardware needed).
//   cc -Wall -Wextra -I../src -o test_host test_host.c ../src/proto.c ../src/sched.c ../src/app.c && ./test_host
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "app.h"

static uint32_t now_ms = 1000;
static char last[256];
static char log_buf[8192];
static int fails = 0, checks = 0;
static int saved = 0, boot_req = 0;
static int edges_on = 0, edges_off = 0;
static uint32_t last_on_t, last_off_t, last_dur;

uint32_t hal_millis(void) { return now_ms; }
void hal_status(status_t *s) { s->vbus_mv = 5010; s->ma = 0; s->set = 0; s->state = ST_IDLE; }
int hal_save(void) { saved++; return 0; }
void hal_request_bootloader(void) { boot_req = 1; }
uint32_t hal_uid(void) { return 0x1A2B3C4D; }
uint32_t hal_awu_tick_us(void) { return 16000; }
void out_line(const char *s)
{
	snprintf(last, sizeof last, "%s", s);
	strncat(log_buf, s, sizeof log_buf - strlen(log_buf) - 2);
	strcat(log_buf, "\n");
}
void on_pulse_start(uint32_t t, uint16_t set) { edges_on++; last_on_t = t; (void)set; }
void on_pulse_end(uint32_t t, uint32_t dur, uint8_t was_test) { edges_off++; last_off_t = t; last_dur = dur; (void)was_test; }

static void cmd(const char *c)
{
	char b[160];
	snprintf(b, sizeof b, "%s", c);
	proto_line(b);
}

#define EXPECT(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FAIL %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)
#define EXPECT_REPLY(c, want) do { cmd(c); EXPECT(strcmp(last, want) == 0, "%s -> '%s' (want '%s')", c, last, want); } while (0)
#define EXPECT_PREFIX(c, want) do { cmd(c); EXPECT(strncmp(last, want, strlen(want)) == 0, "%s -> '%s' (want prefix '%s')", c, last, want); } while (0)

static void run_until(uint32_t t_end, uint32_t step)
{
	while ((int32_t)(t_end - now_ms) > 0) {
		now_ms += step;
		sched_update(now_ms);
	}
}

int main(void)
{
	app_defaults();
	app.active = 1;
	app.host = 1;
	sched_restart(now_ms);

	// Identification and limits
	EXPECT_REPLY("HELLO", "OK KA-PROG fw=" FW_VERSION " proto=1 hw=A uid=1A2B3C4D");
	EXPECT_REPLY("hello", "OK KA-PROG fw=" FW_VERSION " proto=1 hw=A uid=1A2B3C4D");
	EXPECT_REPLY("LIMITS", "OK presets=3 ma_max=325 on_min=10 on_max=30000 off_max=3599990 period_max=3600000 duty_max=50 stream_min=100 stream_max=60000");

	// Presets
	EXPECT_REPLY("GET 1", "OK p=1 ma=50 on=500 off=4500 en=1");
	EXPECT_REPLY("GET 3", "OK p=3 ma=200 on=500 off=4500 en=1");
	EXPECT_REPLY("GET", "OK p=1 ma=50 on=500 off=4500 en=1 | p=2 ma=125 on=500 off=4500 en=1 | p=3 ma=200 on=500 off=4500 en=1");
	EXPECT_PREFIX("GET 4", "ERR 3");
	EXPECT_PREFIX("GET x", "ERR 2");
	EXPECT_REPLY("SET 2 ma=140", "OK p=2 ma=140 on=500 off=4500 en=1");
	EXPECT_REPLY("SET 2 on=250 off=250", "OK p=2 ma=140 on=250 off=250 en=1");   // 50% duty is the limit
	EXPECT_PREFIX("SET 2 ma=326", "ERR 3");
	EXPECT_PREFIX("SET 2 on=9", "ERR 3");
	EXPECT_PREFIX("SET 2 off=0", "ERR 3 off must be at least on");        // no continuous load
	EXPECT_PREFIX("SET 2 off=249", "ERR 3");                               // just over 50% duty
	EXPECT_PREFIX("SET 2 on=30001 off=40000", "ERR 3 on must be");         // pulse over 30 s
	EXPECT_REPLY("SET 2 on=30000 off=30000", "OK p=2 ma=140 on=30000 off=30000 en=1");
	EXPECT_PREFIX("SET 2 off=3570001", "ERR 3 on + off must be at most 1 hour");
	EXPECT_REPLY("SET 2 off=3570000", "OK p=2 ma=140 on=30000 off=3570000 en=1");
	EXPECT_PREFIX("SET 2 off=3600001", "ERR 3");
	EXPECT_REPLY("SET 2 on=250 off=250", "OK p=2 ma=140 on=250 off=250 en=1");
	EXPECT_PREFIX("SET 2 foo=1", "ERR 2");
	EXPECT_PREFIX("SET 2 ma=-5", "ERR 2");
	EXPECT_PREFIX("SET 2 ma=1234567890", "ERR 2");
	EXPECT_PREFIX("SET", "ERR 2");
	EXPECT_REPLY("GET 2", "OK p=2 ma=140 on=250 off=250 en=1"); // failed SETs changed nothing
	EXPECT_REPLY("DEFAULTS", "OK defaults");
	EXPECT_REPLY("GET 2", "OK p=2 ma=125 on=500 off=4500 en=1");
	EXPECT_REPLY("SELECT 3", "OK active=3");
	EXPECT_PREFIX("SELECT 0", "ERR 3");

	// Enable / disable
	EXPECT_REPLY("SET 1 en=0", "OK p=1 ma=50 on=500 off=4500 en=0");
	EXPECT_PREFIX("SET 3 en=0", "ERR 5");          // active preset can't be disabled
	EXPECT_REPLY("GET 3", "OK p=3 ma=200 on=500 off=4500 en=1");
	EXPECT_PREFIX("SET 2 en=2", "ERR 3");
	EXPECT_PREFIX("SELECT 1", "ERR 5");            // disabled preset can't be selected
	EXPECT(app_next_enabled(3) == 2, "next after 3 with 1 disabled: %d", app_next_enabled(3));
	EXPECT(app_next_enabled(2) == 3, "next after 2 with 1 disabled: %d", app_next_enabled(2));
	EXPECT_REPLY("SET 2 en=0", "OK p=2 ma=125 on=500 off=4500 en=0");
	EXPECT(app_next_enabled(3) == 3, "only 3 enabled: %d", app_next_enabled(3));
	EXPECT_REPLY("SET 1 en=1", "OK p=1 ma=50 on=500 off=4500 en=1");
	EXPECT(app_next_enabled(3) == 1, "next after 3 with 2 disabled: %d", app_next_enabled(3));
	// Options
	app.led = LED_MODE_REMIND;
	EXPECT_REPLY("OPTS", "OK led=2");
	EXPECT_REPLY("OPTS led=0", "OK led=0");
	EXPECT_REPLY("opts", "OK led=0");
	EXPECT_REPLY("OPTS led=1", "OK led=1");
	EXPECT_PREFIX("OPTS led=3", "ERR 3");
	EXPECT_PREFIX("OPTS remind=1", "ERR 2");
	EXPECT_REPLY("OPTS led=2", "OK led=2");
	EXPECT_REPLY("DIAG", "OK awu_us=16000");
	EXPECT_REPLY("DEFAULTS", "OK defaults");          // re-enables everything
	EXPECT_REPLY("GET 2", "OK p=2 ma=125 on=500 off=4500 en=1");
	EXPECT_REPLY("SAVE", "OK saved");
	EXPECT(saved == 1, "save called");

	// Misc
	EXPECT_REPLY("STREAM 250", "OK stream=250");
	EXPECT_PREFIX("STREAM 50", "ERR 3");
	EXPECT_PREFIX("RUN 2", "ERR 2");
	EXPECT_PREFIX("FOO", "ERR 1");
	EXPECT_PREFIX("STATUS", "OK active=3 run=0 state=IDLE vbus=5010");
	EXPECT_PREFIX("TEST ma=0 ms=100", "ERR 3");
	EXPECT_PREFIX("TEST ma=100", "ERR 2");

	// Schedule: preset 1 = 50 mA, 500 on / 4500 off, run at 1 ms steps for 20 s.
	EXPECT_REPLY("SELECT 1", "OK active=1");
	edges_on = edges_off = 0;
	EXPECT_REPLY("RUN 1", "OK run=1");
	uint32_t t0 = now_ms;
	run_until(t0 + 20000, 1);
	EXPECT(edges_on == 4 || edges_on == 5, "pulses in 20 s: %d", edges_on);
	EXPECT(last_dur == 500, "pulse width %u", (unsigned)last_dur);
	EXPECT((last_on_t - t0) % 5000 == 0, "pulse aligned to cycle (%u)", (unsigned)(last_on_t - t0));

	// Same schedule with coarse, irregular steps (like waking from sleep): edges keep exact times.
	EXPECT_REPLY("RUN 0", "OK run=0");
	EXPECT_REPLY("RUN 1", "OK run=1");
	t0 = now_ms;
	edges_on = edges_off = 0;
	uint32_t steps[] = { 7, 333, 1200, 90, 3001, 17, 600 };
	for (int i = 0; now_ms - t0 < 30000; i++) { now_ms += steps[i % 7]; sched_update(now_ms); }
	EXPECT(edges_on == (int)((now_ms - t0) / 5000) + 1, "coarse steps pulses %d", edges_on);
	EXPECT((last_on_t - t0) % 5000 == 0, "coarse: on edge exact (%u)", (unsigned)(last_on_t - t0));
	EXPECT(last_dur == 500, "coarse: width exact %u", (unsigned)last_dur);

	// Changing the active preset mid-pulse ends the pulse immediately.
	EXPECT_REPLY("RUN 1", "OK run=1");
	now_ms += 100; sched_update(now_ms);
	edges_off = 0;
	EXPECT_REPLY("SET 1 ma=60", "OK p=1 ma=60 on=500 off=4500 en=1");
	EXPECT(edges_off == 1 && last_dur == 100, "mid-pulse edit closes pulse (%d, %u)", edges_off, (unsigned)last_dur);

	// Test pulse: 300 mA for 2 s, then the cycle restarts.
	EXPECT_REPLY("TEST ma=300 ms=2000", "OK test");
	EXPECT(sched_update(now_ms + 1) == 300, "test current");
	uint32_t tstart = now_ms;
	run_until(tstart + 2500, 1);
	EXPECT(last_dur == 2000, "test width %u", (unsigned)last_dur);
	EXPECT(!sched_testing(), "test finished");

	// Clamping presets saved by older firmware
	{
		preset_t q = { 60, 600000, 0, 1 };        // 10 min continuous-ish
		preset_clamp(&q);
		EXPECT(q.on == 30000 && q.off == 30000, "clamp long/continuous -> %lu/%lu", (unsigned long)q.on, (unsigned long)q.off);
		preset_t r = { 60, 20000, 3600000, 1 };   // over an hour per cycle
		preset_clamp(&r);
		EXPECT(r.on == 20000 && r.off == 3580000, "clamp period -> %lu/%lu", (unsigned long)r.on, (unsigned long)r.off);
		preset_t ok = { 50, 500, 4500, 1 };
		preset_clamp(&ok);
		EXPECT(ok.on == 500 && ok.off == 4500 && !preset_check(&ok), "valid preset unchanged");
	}

	// No-load preset draws nothing
	EXPECT_REPLY("SET 1 ma=0", "OK p=1 ma=0 on=500 off=4500 en=1");
	EXPECT(sched_update(now_ms + 1) == 0, "disabled preset off");

	// Next-edge calculation
	EXPECT_REPLY("SET 1 ma=50 on=500 off=4500", "OK p=1 ma=50 on=500 off=4500 en=1");
	now_ms += 1; sched_update(now_ms);
	EXPECT(sched_ms_to_next_edge(now_ms) == 499, "next edge %u", (unsigned)sched_ms_to_next_edge(now_ms));
	now_ms += 600; sched_update(now_ms);
	EXPECT(sched_ms_to_next_edge(now_ms) == 4399, "next edge after pulse %u", (unsigned)sched_ms_to_next_edge(now_ms));

	// Events only while streaming
	log_buf[0] = 0;
	app.stream_ms = 0;
	proto_event("!X hidden");
	app.stream_ms = 250;
	proto_event("!X shown");
	EXPECT(strstr(log_buf, "hidden") == NULL && strstr(log_buf, "shown"), "events gated by STREAM");

	// Wrap-around of the ms counter
	now_ms = 0xFFFFF000u;
	EXPECT_REPLY("RUN 1", "OK run=1");
	t0 = now_ms;
	edges_on = 0;
	run_until(t0 + 12000, 1);
	EXPECT(edges_on == 3, "pulses across wrap %d", edges_on);
	EXPECT(last_dur == 500, "width across wrap %u", (unsigned)last_dur);

	EXPECT_REPLY("BOOT", "OK bootloader");
	EXPECT(boot_req, "boot requested");

	printf("%d checks, %d failures\n", checks, fails);
	return fails ? 1 : 0;
}
