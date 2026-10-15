// PRESET button and status LED.
#ifndef UI_H
#define UI_H
#include <stdint.h>

enum { UI_NONE, UI_SHORT, UI_LONG };

void     ui_init(void);
int      ui_poll(uint32_t now);         // returns UI_SHORT / UI_LONG on a press
void     ui_blink(uint8_t n);           // blink n times (preset number)
void     ui_set_base(uint8_t mode);     // LED when no pattern is playing
uint8_t  ui_busy(void);                 // pattern playing or button held
uint32_t ui_ms_to_next(uint32_t now);   // until the LED/button logic next needs to run
uint8_t  ui_button_down(void);

enum { LED_BASE_OFF, LED_BASE_ON, LED_BASE_FAULT };
#endif
