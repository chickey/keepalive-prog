#include "app.h"

app_t app;

// Factory presets: 50 / 125 / 200 mA, 0.5 s on, 4.5 s off.
static const preset_t factory[NPRESETS] = {
	{  50, 500, 4500, 1 },
	{ 125, 500, 4500, 1 },
	{ 200, 500, 4500, 1 },
};

void app_defaults(void)
{
	for (int i = 0; i < NPRESETS; i++) app.presets[i] = factory[i];
}

uint8_t app_next_enabled(uint8_t n)
{
	for (int i = 1; i <= NPRESETS; i++) {
		uint8_t m = (uint8_t)((n - 1 + i) % NPRESETS + 1);
		if (app.presets[m - 1].en) return m;
	}
	return n;
}

const char *preset_check(const preset_t *p)
{
	if (p->ma > MA_MAX) return "ma out of range";
	if (p->on < ON_MIN_MS || p->on > ON_MAX_MS) return "on must be 10-30000 ms";
	if (p->off < p->on) return "off must be at least on (max 50% duty)";
	if (p->on + p->off > PERIOD_MAX_MS) return "on + off must be at most 1 hour";
	return 0;
}

void preset_clamp(preset_t *p)
{
	if (p->ma > MA_MAX) p->ma = MA_MAX;
	if (p->on < ON_MIN_MS) p->on = ON_MIN_MS;
	if (p->on > ON_MAX_MS) p->on = ON_MAX_MS;
	if (p->off < p->on) p->off = p->on;
	if (p->on + p->off > PERIOD_MAX_MS) p->off = PERIOD_MAX_MS - p->on;
}
