// USB CDC link: host detection, line input, buffered line output.
#include <string.h>
#include "ch32fun.h"
#include "fsusb.h"
#include "app.h"
#include "usbio.h"

#define RX_LINE_MAX  130
#define TX_SIZE      1024
#define ENUM_WAIT_MS 1500

static char     rx_line[RX_LINE_MAX];
static uint16_t rx_len;
static uint8_t  rx_overflow;

static char     tx[TX_SIZE];
static volatile uint16_t tx_head, tx_tail;

static volatile uint8_t dtr;
static uint8_t  attached;

// CDC line coding (ignored, but hosts expect to read it back).
static uint8_t line_coding[7] = { 0x00, 0xC2, 0x01, 0x00, 0x00, 0x00, 0x08 }; // 115200 8N1

// Override of ch32fun's weak handler: answer CDC class requests and track DTR,
// which Web Serial raises when the page opens the port and drops on close.
int HandleSetupCustom(struct _USBState *ctx, int setup_code)
{
	if (!(ctx->USBFS_SetupReqType & USB_REQ_TYP_CLASS)) return 0;  // stall
	switch (setup_code) {
	case CDC_SET_LINE_CTLSTE:
		dtr = (uint8_t)(ctx->USBFS_IndexValue & 1);
		return -1;                                    // zero-length ACK
	case CDC_GET_LINE_CODING:
		ctx->pCtrlPayloadPtr = line_coding;
		return ctx->USBFS_SetupReqLen < 7 ? ctx->USBFS_SetupReqLen : 7;
	case CDC_SET_LINE_CODING:
	case CDC_SEND_BREAK:
		return ctx->USBFS_SetupReqLen ? ctx->USBFS_SetupReqLen : -1;
	default:
		return 0;
	}
}

// Called from poll_input() with whatever arrived since the last poll.
void HandleUSBInput(int n, uint8_t *data)
{
	for (int i = 0; i < n; i++) {
		char c = (char)data[i];
		if (c == '\n') {
			rx_line[rx_len] = 0;
			if (rx_overflow) out_line("ERR 2 line too long");
			else proto_line(rx_line);
			rx_len = 0;
			rx_overflow = 0;
		} else if (rx_len < RX_LINE_MAX - 1) {
			rx_line[rx_len++] = c;
		} else {
			rx_overflow = 1;
		}
	}
}

static uint16_t tx_free(void) { return (uint16_t)(TX_SIZE - 1 - ((tx_head - tx_tail) & (TX_SIZE - 1))); }

void out_line(const char *s)
{
	if (!attached || !dtr) return;
	uint16_t n = (uint16_t)strlen(s);
	if (n + 1 > tx_free()) return;   // drop rather than block
	for (uint16_t i = 0; i < n; i++) { tx[tx_head] = s[i]; tx_head = (tx_head + 1) & (TX_SIZE - 1); }
	tx[tx_head] = '\n';
	tx_head = (tx_head + 1) & (TX_SIZE - 1);
}

uint8_t usbio_tx_empty(void) { return tx_head == tx_tail; }
uint8_t usbio_port_open(void) { return attached && dtr; }

static void tx_pump(void)
{
	static uint8_t pkt[63];   // < 64 so every packet is short: no zero-length packets needed
	if (tx_head == tx_tail) return;
	if (USBFSCTX.endpoints[3].busy) return;
	uint16_t n = 0, t = tx_tail;
	while (t != tx_head && n < sizeof pkt) { pkt[n++] = (uint8_t)tx[t]; t = (t + 1) & (TX_SIZE - 1); }
	if (USBFS_SendEndpointNEW(3, pkt, n, 1) == 0) tx_tail = t;
}

void usbio_poll(void)
{
	static uint8_t was_open;
	if (!attached) return;
	poll_input();
	if (!dtr) {
		tx_tail = tx_head;          // nobody listening: discard
		if (was_open) app.stream_ms = 0;
	}
	was_open = dtr;
	tx_pump();
}

// PC16/PC17 sit in the extended GPIOC registers (CFGXR), which the ch32fun
// pin helpers don't cover.
static void pc_mode(int pin, uint32_t mode)
{
	int sh = (pin - 16) * 4;
	GPIOC->CFGXR = (GPIOC->CFGXR & ~(0xFu << sh)) | (mode << sh);
}

static void detach(void)
{
	NVIC_DisableIRQ(USB_IRQn);
	USBFS->BASE_CTRL = USBFS_UC_RESET_SIE | USBFS_UC_CLR_ALL;
	USBFS->BASE_CTRL = 0;
	AFIO->CTLR &= ~(UDP_PUE_MASK | UDM_PUE_MASK | USB_IOEN);
	RCC->AHBPCENR &= ~RCC_USBFS;
	// D+/D- back to plain floating inputs so the passthrough is undisturbed.
	pc_mode(16, GPIO_CFGLR_IN_FLOAT);
	pc_mode(17, GPIO_CFGLR_IN_FLOAT);
	attached = 0;
	dtr = 0;
}

// Decide between "plugged into a computer" and "plugged into a power bank".
// 1. With weak pull-downs on D+/D-, anything already pulling a line high
//    (Apple-style divider, a device on the output socket) means not a bare
//    host port: stay off the bus.
// 2. Otherwise connect our D+ pull-up and see whether a host enumerates us
//    within ENUM_WAIT_MS. A power bank never will; then disconnect again.
uint8_t usbio_detect_and_attach(uint32_t (*millis)(void))
{
	RCC->APB2PCENR |= RCC_APB2Periph_GPIOC | RCC_APB2Periph_AFIO;
	GPIOC->OUTDR &= ~((1u << 16) | (1u << 17));   // pull direction: down
	pc_mode(16, GPIO_CFGLR_IN_PUPD);
	pc_mode(17, GPIO_CFGLR_IN_PUPD);
	Delay_Ms(5);
	uint8_t high = (GPIOC->INDR & ((1u << 16) | (1u << 17))) != 0;
	pc_mode(16, GPIO_CFGLR_IN_FLOAT);
	pc_mode(17, GPIO_CFGLR_IN_FLOAT);
	if (high) return 0;

	USBFSSetup();
	attached = 1;
	uint32_t t0 = millis();
	while (millis() - t0 < ENUM_WAIT_MS) {
		if (USBFSCTX.USBFS_DevEnumStatus) return 1;
	}
	detach();
	return 0;
}
