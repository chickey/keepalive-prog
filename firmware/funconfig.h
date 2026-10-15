#ifndef _FUNCONFIG_H
#define _FUNCONFIG_H

// CH32X035 on 3.3 V from the HT7533, 48 MHz internal oscillator (USB capable).
#define FUNCONF_USE_HSI            1
#define FUNCONF_USE_5V_VDD         0
#define FUNCONF_SYSTEM_CORE_CLOCK  48000000
#define FUNCONF_SYSTICK_USE_HCLK   1

// USB CDC "printf" plumbing from ch32fun gives us the CDC input buffer and
// class-request handling. We don't use printf itself.
#define FUNCONF_USE_DEBUGPRINTF    0
#define FUNCONF_USE_USBPRINTF      1
#define FUNCONF_ENABLE_HPE         0
#define FUNCONF_DEBUG_HARDFAULT    0

#endif
