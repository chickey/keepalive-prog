#ifndef USBIO_H
#define USBIO_H
#include <stdint.h>
enum { USB_NONE, USB_WAITING, USB_HOST };
void    usbio_detect_and_attach(uint32_t now);  // attach if a host might be there
int     usbio_host_poll(uint32_t now);          // USB_* ; gives up after a while
void    usbio_poll(void);
uint8_t usbio_tx_empty(void);
uint8_t usbio_port_open(void);
#endif
