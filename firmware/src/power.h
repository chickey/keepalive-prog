#ifndef POWER_H
#define POWER_H
#include <stdint.h>
void     power_init(void);
uint32_t power_min_sleep_ms(void);
uint32_t power_deep_sleep(uint32_t ms, uint8_t *by_button);
#endif
