#ifndef USBIO_H
#define USBIO_H
#include <stdint.h>
uint8_t usbio_detect_and_attach(uint32_t (*millis)(void)); // 1 = enumerated by a host
void    usbio_poll(void);
uint8_t usbio_tx_empty(void);
uint8_t usbio_port_open(void);
#endif
