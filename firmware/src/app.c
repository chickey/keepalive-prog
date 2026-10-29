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
