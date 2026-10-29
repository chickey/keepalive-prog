// Board definition for the Keep Alive Rev A (CH32X035F8U6, QFN-20).
// See HARDWARE.md for the schematic-level description.
#ifndef BOARD_H
#define BOARD_H

#define FW_VERSION      "1.0.5"
#define HW_REV          "A"
#define PROTO_VERSION   1

// ---- Pins (port names; QFN-20 pin numbers in comments) ----
#define PIN_GATE_A      PA0     // pin 2,  TIM2_CH1, leg A 100 R
#define PIN_GATE_B      PA1     // pin 3,  TIM2_CH2, leg B 47 R
#define PIN_GATE_C      PA2     // pin 4,  TIM2_CH3, leg C 2x47 R
#define PIN_VSENSE      PA4     // pin 6,  ADC ch 4, VBUS via 1M/150k
#define PIN_ISENSE      PA6     // pin 8,  ADC ch 6, 1R shunt via 1k/100n
#define PIN_PRESET      PB1     // pin 11, button to GND
#define PIN_LED         PB12    // pin 15, active high
// USB: PC16 = D-, PC17 = D+ (pins 17/18). SDI: PC18/PC19.

#define ADC_CH_VSENSE   4
#define ADC_CH_ISENSE   6
#define ADC_CH_VREF     15      // internal 1.2 V reference

// ---- Analogue scaling ----
#define VREFINT_MV      1200
#define VSENSE_NUM      1150    // (1M + 150k) / 150k
#define VSENSE_DEN      150
// Shunt is 1 R, so millivolts across it == milliamps.

// ---- Protocol limits (reported by LIMITS) ----
#define NPRESETS        3
#define MA_MAX          325
// Hard limits to protect the board and the user: pulses up to 30 s, at
// least as much time off as on (50% duty, so no continuous load), and a
// whole cycle of at most an hour.
#define ON_MIN_MS       10
#define ON_MAX_MS       30000u
#define PERIOD_MAX_MS   3600000u
#define DUTY_MAX_PCT    50
#define OFF_MAX_MS      (PERIOD_MAX_MS - ON_MIN_MS)
#define STREAM_MIN_MS   100
#define STREAM_MAX_MS   60000u

// ---- Protection ----
#define VBUS_OV_MV      6000    // fast charge raised the bus: load off
#define VBUS_OV_CLR_MV  5600
#define VBUS_UV_MV      4200
#define VBUS_UV_CLR_MV  4400
#define OVERCURRENT_MA  (MA_MAX + 60)
#define NOREG_MARGIN_MA 10      // NOREG if the pulse average is short by more than this

#endif
