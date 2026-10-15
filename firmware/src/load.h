// Switched resistor load: three legs on TIM2 PWM, current regulated from the
// shunt. ADC sampling and the control loop run in the TIM3 interrupt (4 kHz).
#ifndef LOAD_H
#define LOAD_H
#include <stdint.h>

void     load_init(void);
void     load_zero_cal(void);          // all legs off: measure shunt offset
void     load_set_target(uint16_t ma); // 0 = all legs off
uint16_t load_ma(void);                // live measured current
uint16_t load_vbus_mv(void);
uint16_t load_vdd_mv(void);

void     load_pulse_begin(void);       // start averaging for the !E off report
uint16_t load_pulse_end(void);         // average mA over the pulse (after settling)

// Flags set by the ISR, cleared by reading.
#define LOAD_F_OVERCURRENT 0x01
#define LOAD_F_SATURATED   0x02        // at maximum and still short of target
uint8_t  load_take_flags(void);

void     load_suspend(void);           // before deep sleep: legs off, ADC/timers stopped
void     load_resume(void);            // after wake: restart sampling, refresh VBUS
#endif
