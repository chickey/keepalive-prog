// Command protocol (see PROTOCOL.md). One line in, one "OK"/"ERR" line out.
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "app.h"

#if defined(CH32X03x)
// ch32fun provides a small printf family; map vsnprintf onto it.
int mini_vsnprintf(char *buffer, unsigned int buffer_len, const char *fmt, va_list va);
#define vsnprintf(b, n, f, a) mini_vsnprintf((b), (n), (f), (a))
#endif

#define MAX_TOK 8

enum { E_UNKNOWN = 1, E_ARG = 2, E_RANGE = 3, E_FLASH = 4, E_STATE = 5 };

static char buf[200];

static void reply(const char *fmt, ...)
{
	int n = snprintf(buf, sizeof buf, "OK");
	if (fmt && *fmt) {
		buf[n++] = ' ';
		va_list ap;
		va_start(ap, fmt);
		vsnprintf(buf + n, sizeof buf - n, fmt, ap);
		va_end(ap);
	}
	out_line(buf);
}

static void error(int code, const char *msg)
{
	snprintf(buf, sizeof buf, "ERR %d %s", code, msg);
	out_line(buf);
}

void proto_event(const char *fmt, ...)
{
	if (!app.host || !app.stream_ms) return;
	char ev[96];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(ev, sizeof ev, fmt, ap);
	va_end(ap);
	out_line(ev);
}

static int ieq(const char *a, const char *b)
{
	while (*a && *b) {
		char x = *a++, y = *b++;
		if (x >= 'a' && x <= 'z') x -= 32;
		if (y >= 'a' && y <= 'z') y -= 32;
		if (x != y) return 0;
	}
	return *a == *b;
}

// Unsigned decimal, at most 9 digits. Returns 0 on success.
static int parse_u32(const char *s, uint32_t *out)
{
	uint32_t v = 0;
	int n = 0;
	if (!*s) return -1;
	for (; *s; s++, n++) {
		if (*s < '0' || *s > '9' || n >= 9) return -1;
		v = v * 10 + (uint32_t)(*s - '0');
	}
	*out = v;
	return 0;
}

static int parse_preset(const char *s, int *n)
{
	uint32_t v;
	if (!s || parse_u32(s, &v)) return -E_ARG;
	if (v < 1 || v > NPRESETS) return -E_RANGE;
	*n = (int)v;
	return 0;
}

static int fmt_preset(char *dst, int len, int n)
{
	const preset_t *p = &app.presets[n - 1];
	return snprintf(dst, len, "p=%d ma=%u on=%lu off=%lu en=%u", n, p->ma,
	                (unsigned long)p->on, (unsigned long)p->off, p->en);
}

static const char *state_name(uint8_t s)
{
	switch (s) {
	case ST_ON: return "ON";
	case ST_OFF: return "OFF";
	case ST_FAULT: return "FAULT";
	default: return "IDLE";
	}
}

static void cmd_status(void)
{
	status_t s;
	hal_status(&s);
	reply("active=%u run=%u state=%s vbus=%u ma=%u set=%u t=%lu", app.active, app.run,
	      state_name(s.state), s.vbus_mv, s.ma, s.set, (unsigned long)hal_millis());
}

// Shared by STATUS and the periodic !S event.
void proto_stream_status(void)
{
	status_t s;
	hal_status(&s);
	proto_event("!S active=%u run=%u state=%s vbus=%u ma=%u set=%u t=%lu", app.active, app.run,
	            state_name(s.state), s.vbus_mv, s.ma, s.set, (unsigned long)hal_millis());
}

static void cmd_set(char **tok, int nt)
{
	int n, r = parse_preset(nt > 1 ? tok[1] : 0, &n);
	if (r) { error(-r, r == -E_ARG ? "preset number required" : "preset must be 1-3"); return; }
	preset_t p = app.presets[n - 1];
	for (int i = 2; i < nt; i++) {
		char *eq = strchr(tok[i], '=');
		uint32_t v;
		if (!eq) { error(E_ARG, "expected key=value"); return; }
		*eq = 0;
		if (parse_u32(eq + 1, &v)) { error(E_ARG, "bad number"); return; }
		if (ieq(tok[i], "ma")) {
			if (v > MA_MAX) { error(E_RANGE, "ma out of range"); return; }
			p.ma = (uint16_t)v;
		} else if (ieq(tok[i], "on")) {
			if (v < ON_MIN_MS || v > ON_MAX_MS) { error(E_RANGE, "on out of range"); return; }
			p.on = v;
		} else if (ieq(tok[i], "off")) {
			if (v > OFF_MAX_MS) { error(E_RANGE, "off out of range"); return; }
			p.off = v;
		} else if (ieq(tok[i], "en")) {
			if (v > 1) { error(E_RANGE, "en must be 0 or 1"); return; }
			p.en = (uint8_t)v;
		} else { error(E_ARG, "unknown key"); return; }
	}
	// The active preset always stays enabled, so at least one always is.
	if (!p.en && n == app.active) { error(E_STATE, "select another preset first"); return; }
	app.presets[n - 1] = p;
	if (n == app.active) sched_restart(hal_millis());
	char tmp[64];
	fmt_preset(tmp, sizeof tmp, n);
	reply("%s", tmp);
}

static void cmd_test(char **tok, int nt)
{
	uint32_t ma = 0, ms = 0;
	int have_ma = 0, have_ms = 0;
	for (int i = 1; i < nt; i++) {
		char *eq = strchr(tok[i], '=');
		uint32_t v;
		if (!eq) { error(E_ARG, "expected key=value"); return; }
		*eq = 0;
		if (parse_u32(eq + 1, &v)) { error(E_ARG, "bad number"); return; }
		if (ieq(tok[i], "ma")) { ma = v; have_ma = 1; }
		else if (ieq(tok[i], "ms")) { ms = v; have_ms = 1; }
		else { error(E_ARG, "unknown key"); return; }
	}
	if (!have_ma || !have_ms) { error(E_ARG, "TEST ma=<mA> ms=<ms>"); return; }
	if (ma < 1 || ma > MA_MAX) { error(E_RANGE, "ma out of range"); return; }
	if (ms < 1 || ms > ON_MAX_MS) { error(E_RANGE, "ms out of range"); return; }
	status_t s;
	hal_status(&s);
	if (s.state == ST_FAULT) { error(E_STATE, "fault active"); return; }
	sched_test(hal_millis(), (uint16_t)ma, ms);
	reply("test");
}

void proto_line(char *line)
{
	char *tok[MAX_TOK];
	int nt = 0;
	for (char *p = line; *p && nt < MAX_TOK;) {
		while (*p == ' ' || *p == '\t' || *p == '\r') *p++ = 0;
		if (!*p) break;
		tok[nt++] = p;
		while (*p && *p != ' ' && *p != '\t' && *p != '\r') p++;
	}
	if (!nt) return;
	const char *c = tok[0];
	uint32_t v;
	int n, r;

	if (ieq(c, "HELLO")) {
		reply("KA-PROG fw=%s proto=%d hw=%s uid=%08lX", FW_VERSION, PROTO_VERSION, HW_REV,
		      (unsigned long)hal_uid());
	} else if (ieq(c, "LIMITS")) {
		reply("presets=%d ma_max=%d on_min=%d on_max=%lu off_max=%lu stream_min=%d stream_max=%lu",
		      NPRESETS, MA_MAX, ON_MIN_MS, (unsigned long)ON_MAX_MS, (unsigned long)OFF_MAX_MS,
		      STREAM_MIN_MS, (unsigned long)STREAM_MAX_MS);
	} else if (ieq(c, "GET")) {
		if (nt < 2) {
			char all[160];
			int len = 0;
			for (int i = 1; i <= NPRESETS; i++) {
				if (i > 1) len += snprintf(all + len, sizeof all - len, " | ");
				len += fmt_preset(all + len, sizeof all - len, i);
			}
			reply("%s", all);
		} else if ((r = parse_preset(tok[1], &n))) {
			error(-r, "preset must be 1-3");
		} else {
			char tmp[64];
			fmt_preset(tmp, sizeof tmp, n);
			reply("%s", tmp);
		}
	} else if (ieq(c, "SET")) {
		cmd_set(tok, nt);
	} else if (ieq(c, "SELECT")) {
		if ((r = parse_preset(nt > 1 ? tok[1] : 0, &n))) { error(-r, "preset must be 1-3"); return; }
		if (!app.presets[n - 1].en) { error(E_STATE, "preset is disabled"); return; }
		app.active = (uint8_t)n;
		sched_restart(hal_millis());
		reply("active=%d", n);
	} else if (ieq(c, "SAVE")) {
		if (hal_save()) error(E_FLASH, "flash write failed");
		else reply("saved");
	} else if (ieq(c, "DEFAULTS")) {
		app_defaults();
		sched_restart(hal_millis());
		reply("defaults");
	} else if (ieq(c, "OPTS")) {
		for (int i = 1; i < nt; i++) {
			char *eq = strchr(tok[i], '=');
			if (!eq) { error(E_ARG, "expected key=value"); return; }
			*eq = 0;
			if (parse_u32(eq + 1, &v)) { error(E_ARG, "bad number"); return; }
			if (!ieq(tok[i], "led")) { error(E_ARG, "unknown key"); return; }
			if (v > LED_MODE_REMIND) { error(E_RANGE, "led must be 0, 1 or 2"); return; }
			app.led = (uint8_t)v;
		}
		reply("led=%u", app.led);
	} else if (ieq(c, "STATUS")) {
		cmd_status();
	} else if (ieq(c, "STREAM")) {
		if (nt < 2 || parse_u32(tok[1], &v)) { error(E_ARG, "STREAM <ms>"); return; }
		if (v != 0 && (v < STREAM_MIN_MS || v > STREAM_MAX_MS)) { error(E_RANGE, "interval out of range"); return; }
		app.stream_ms = (uint16_t)v;
		reply("stream=%lu", (unsigned long)v);
	} else if (ieq(c, "RUN")) {
		if (nt < 2 || parse_u32(tok[1], &v) || v > 1) { error(E_ARG, "RUN 0 or RUN 1"); return; }
		app.run = (uint8_t)v;
		sched_restart(hal_millis());
		reply("run=%lu", (unsigned long)v);
	} else if (ieq(c, "TEST")) {
		cmd_test(tok, nt);
	} else if (ieq(c, "BOOT")) {
		reply("bootloader");
		hal_request_bootloader();
	} else {
		error(E_UNKNOWN, "unknown command");
	}
}
