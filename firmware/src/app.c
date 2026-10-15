#include "app.h"

app_t app;

// Factory presets: 50 / 125 / 200 mA, 0.5 s on, 4.5 s off.
static const preset_t factory[NPRESETS] = {
	{  50, 500, 4500 },
	{ 125, 500, 4500 },
	{ 200, 500, 4500 },
};

void app_defaults(void)
{
	for (int i = 0; i < NPRESETS; i++) app.presets[i] = factory[i];
}
