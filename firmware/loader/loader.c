// Eplop Keep Alive update loader, CH32X035F8U6.
//
// Sits at the start of flash and runs first at every power-up. It starts the
// firmware straight away unless
//   - the firmware asked for update mode (BOOT command: a word in RAM), or
//   - the PRESET button is held at power-up, or
//   - there is no valid firmware installed.
// In update mode it appears as the same USB serial port as the firmware, so
// the web page can install new firmware over Web Serial with no driver on any
// system. Firmware is accepted only if it carries a valid Ed25519 signature
// from one of the keys in keys.h. See ../../PROTOCOL.md ("Update loader").
#include <string.h>
#include "ch32fun.h"
#include "fsusb.h"
#include "image.h"
#include "ed25519.h"
#include "keys.h"

#define LOADER_VERSION  "1.1.0"
#define PIN_PRESET      PB1
#define PIN_LED         PB12
#define LINE_MAX        300
#define TX_SIZE         512
#define PAGE            256u
#define HOST_WAIT_MS    60000u   // with valid firmware: give up on a host after this

enum { E_UNKNOWN = 1, E_ARG = 2, E_RANGE = 3, E_FLASH = 4, E_STATE = 5, E_SIG = 6, E_NOAPP = 7 };

static const img_header_t *const installed = (const img_header_t *)IMG_HDR_OFF;

// ---------------------------------------------------------------- time
static uint32_t millis(void)
{
	uint32_t h, l;
	do { h = SysTick->CNTH; l = SysTick->CNTL; } while (h != SysTick->CNTH);
	// 1024 ticks x 47 = 1.003 ms at 48 MHz; avoids pulling in a 64-bit divide.
	return (uint32_t)((((uint64_t)h << 32) | l) >> 10) / 47;
}

static void reset(void) { PFIC->SCTLR = 1u << 31; for (;;); }

// ---------------------------------------------------------------- image checks
static uint32_t crc32(const uint8_t *p, uint32_t n)
{
	static const uint32_t t[16] = {
		0x00000000, 0x1db71064, 0x3b6e20c8, 0x26d930ac, 0x76dc4190, 0x6b6b51f4, 0x4db26158, 0x5005713c,
		0xedb88320, 0xf00f9344, 0xd6d6a3e8, 0xcb61b38c, 0x9b64c2b0, 0x86d3d2d4, 0xa00ae278, 0xbdbdf21c,
	};
	uint32_t c = 0xffffffffu;
	while (n--) {
		c ^= *p++;
		c = (c >> 4) ^ t[c & 15];
		c = (c >> 4) ^ t[c & 15];
	}
	return ~c;
}

static int header_sane(const img_header_t *h)
{
	return h->magic == IMG_MAGIC && h->hdr_version == IMG_HDR_VERSION && h->load_off == APP_OFF
	    && h->length && h->length <= APP_MAX && !(h->length & 3) && h->key_id < NKEYS
	    && memchr(h->version, 0, sizeof h->version);
}

// The header page is only written after the signature checked out, so a sane
// header with a matching CRC means a complete, genuine image.
static int app_valid(void)
{
	return header_sane(installed) && crc32((const uint8_t *)APP_OFF, installed->length) == installed->crc32;
}

static void jump_app(void)
{
	__disable_irq();
	((void (*)(void))APP_OFF)();   // the firmware's own start-up resets sp, gp and mtvec
}

// ---------------------------------------------------------------- flash (fast page mode, as store.c)
#define FL_PAGE_PG   0x00010000u
#define FL_PAGE_ER   0x00020000u
#define FL_BUF_LOAD  0x00040000u
#define FL_BUF_RST   0x00080000u
#define FL_STRT      0x00000040u
#define FL_LOCK      0x00000080u
#define FL_FLOCK     0x00008000u
#define FL_CLR_ER    (~(0x00000020u | FL_PAGE_ER))
#define FL_BSY       0x00000001u
#define FL_WRPRTERR  0x00000010u

static inline void wait_busy(void) { while (FLASH->STATR & FL_BSY); }

// Erases the 256-byte page at offset off and, unless words is NULL, programs it.
static int page_write(uint32_t off, const uint32_t *words)
{
	uint32_t addr = FLASH_BASE_ADDR + off;
	__disable_irq();
	FLASH->KEYR = FLASH_KEY1;
	FLASH->KEYR = FLASH_KEY2;
	FLASH->MODEKEYR = FLASH_KEY1;
	FLASH->MODEKEYR = FLASH_KEY2;
	FLASH->STATR = FL_WRPRTERR;

	FLASH->CTLR &= FL_CLR_ER;
	FLASH->CTLR |= FL_PAGE_ER;
	FLASH->ADDR = addr;
	FLASH->CTLR |= FL_STRT;
	wait_busy();
	FLASH->CTLR &= ~FL_PAGE_ER;

	if (words) {
		FLASH->CTLR &= FL_CLR_ER;
		FLASH->CTLR |= FL_PAGE_PG;
		FLASH->CTLR |= FL_BUF_RST;
		wait_busy();
		FLASH->CTLR &= ~FL_PAGE_PG;
		for (unsigned i = 0; i < PAGE / 4; i++) {
			FLASH->CTLR &= FL_CLR_ER;
			FLASH->CTLR |= FL_PAGE_PG;
			*(volatile uint32_t *)(addr + 4 * i) = words[i];
			FLASH->CTLR |= FL_BUF_LOAD;
			wait_busy();
			FLASH->CTLR &= ~FL_PAGE_PG;
		}
		FLASH->CTLR &= FL_CLR_ER;
		FLASH->CTLR |= FL_PAGE_PG;
		FLASH->ADDR = addr;
		FLASH->CTLR |= FL_STRT;
		wait_busy();
		FLASH->CTLR &= ~FL_PAGE_PG;
	}
	int err = (FLASH->STATR & FL_WRPRTERR) != 0;
	FLASH->CTLR |= FL_FLOCK;
	FLASH->CTLR |= FL_LOCK;
	__enable_irq();

	if (err) return -1;
	const uint32_t *f = (const uint32_t *)off;
	for (unsigned i = 0; i < PAGE / 4; i++)
		if (f[i] != (words ? words[i] : 0xffffffffu)) return -1;
	return 0;
}

// ---------------------------------------------------------------- USB serial
uint8_t usb_serial_desc[18] = { 18, 3 };
static volatile uint8_t dtr;
static char tx[TX_SIZE];
static volatile uint16_t tx_head, tx_tail;
static uint8_t line_coding[7] = { 0x00, 0xC2, 0x01, 0x00, 0x00, 0x00, 0x08 };

static uint32_t chip_uid(void) { return ESIG->UID0 ^ ESIG->UID1; }

static void usb_serial_init(void)
{
	uint32_t u = chip_uid();
	for (int i = 0; i < 8; i++) {
		uint8_t d = (u >> (28 - 4 * i)) & 15;
		usb_serial_desc[2 + 2 * i] = d < 10 ? '0' + d : 'A' + d - 10;
		usb_serial_desc[3 + 2 * i] = 0;
	}
}

int HandleSetupCustom(struct _USBState *ctx, int setup_code)
{
	if (!(ctx->USBFS_SetupReqType & USB_REQ_TYP_CLASS)) return 0;
	switch (setup_code) {
	case CDC_SET_LINE_CTLSTE:
		dtr = (uint8_t)(ctx->USBFS_IndexValue & 1);
		return -1;
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

static void out(const char *s)
{
	if (!dtr) return;
	while (*s) {
		uint16_t next = (tx_head + 1) & (TX_SIZE - 1);
		if (next == tx_tail) return;
		tx[tx_head] = *s++;
		tx_head = next;
	}
}

static void tx_pump(void)
{
	static uint32_t pktw[16];
	uint8_t *pkt = (uint8_t *)pktw;
	if (!dtr) { tx_tail = tx_head; return; }
	if (tx_head == tx_tail || USBFSCTX.endpoints[3].busy) return;
	uint16_t n = 0, t = tx_tail;
	while (t != tx_head && n < 63) { pkt[n++] = (uint8_t)tx[t]; t = (t + 1) & (TX_SIZE - 1); }
	if (USBFS_SendEndpointNEW(3, pkt, n, 0) == 0) tx_tail = t;
}

static void flush_tx(void)
{
	uint32_t t0 = millis();
	while (tx_head != tx_tail && millis() - t0 < 200) tx_pump();
	t0 = millis();
	while (millis() - t0 < 20) tx_pump();   // let the last packet go out
}

// ---------------------------------------------------------------- replies
static char rbuf[160];
static unsigned rlen;

static void r_str(const char *s) { while (*s && rlen < sizeof rbuf - 2) rbuf[rlen++] = *s++; }
static void r_hex(uint32_t v, int digits)
{
	while (digits--) { uint8_t d = (v >> (4 * digits)) & 15; r_str((char[2]){ d < 10 ? '0' + d : 'a' + d - 10, 0 }); }
}
static void r_dec(uint32_t v)
{
	char b[11]; int i = 10; b[i] = 0;
	do { b[--i] = '0' + v % 10; v /= 10; } while (v);
	r_str(b + i);
}
static void r_begin(const char *s) { rlen = 0; r_str(s); }
static void r_end(void) { rbuf[rlen++] = '\n'; rbuf[rlen] = 0; out(rbuf); }
static void ok(void) { r_begin("OK"); r_end(); }
static void err(int code, const char *msg) { r_begin("ERR "); r_dec(code); r_str(" "); r_str(msg); r_end(); }

// ---------------------------------------------------------------- update state
static img_header_t hdr;      // of the image being received
static uint8_t  receiving;
static uint32_t received;     // bytes of the image so far
static uint32_t pagebuf[PAGE / 4];

static int hexval(char c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

// Decodes hex into out; returns the byte count, or -1 on bad input.
static int unhex(const char *s, uint8_t *o, int max)
{
	int n = 0;
	while (*s) {
		int a = hexval(s[0]), b = a < 0 ? -1 : hexval(s[1]);
		if (b < 0 || n >= max) return -1;
		o[n++] = (uint8_t)(a << 4 | b);
		s += 2;
	}
	return n;
}

static int parse_dec(const char *s, uint32_t *v)
{
	uint32_t x = 0; int n = 0;
	for (; *s; s++, n++) { if (*s < '0' || *s > '9' || n >= 9) return -1; x = x * 10 + (uint32_t)(*s - '0'); }
	if (!n) return -1;
	*v = x;
	return 0;
}

static int ieq(const char *a, const char *b)
{
	for (; *a && *b; a++, b++) {
		char x = *a, y = *b;
		if (x >= 'a' && x <= 'z') x -= 32;
		if (y >= 'a' && y <= 'z') y -= 32;
		if (x != y) return 0;
	}
	return *a == *b;
}

static void cmd_hello(void)
{
	r_begin("OK KA-LOADER ldr=" LOADER_VERSION " proto=1 chip=CH32X035F8U6 uid=");
	r_hex(chip_uid(), 8);
	r_str(" sn=");
	r_hex(ESIG->UID0, 8); r_hex(ESIG->UID1, 8); r_hex(ESIG->UID2, 8);
	r_str(" app=");
	r_str(app_valid() ? installed->version : "none");
	r_str(" max="); r_dec(APP_MAX);
	r_str(" keys="); r_dec(NKEYS);
	r_end();
}

static void cmd_begin(const char *hex)
{
	img_header_t h;
	if (!hex || unhex(hex, (uint8_t *)&h, sizeof h) != (int)sizeof h) { err(E_ARG, "header"); return; }
	if (!header_sane(&h)) { err(E_RANGE, "not a Keep Alive firmware image"); return; }
	if (app_valid() && h.sec_level < installed->sec_level) { err(E_RANGE, "older than allowed"); return; }
	// From here the old firmware no longer counts as installed.
	if (page_write(IMG_HDR_OFF, NULL)) { err(E_FLASH, "erase failed"); receiving = 0; return; }
	hdr = h;
	received = 0;
	receiving = 1;
	ok();
}

static int write_page_at(uint32_t pos)
{
	return page_write(APP_OFF + (pos & ~(PAGE - 1)), pagebuf);
}

static void cmd_data(const char *off_s, const char *hex)
{
	static uint8_t chunk[128];
	uint32_t off;
	if (!receiving) { err(E_STATE, "no BEGIN"); return; }
	if (!off_s || !hex || parse_dec(off_s, &off)) { err(E_ARG, "DATA offset hex"); return; }
	if (off != received) { err(E_STATE, "expected offset"); return; }
	int n = unhex(hex, chunk, sizeof chunk);
	if (n <= 0 || received + (uint32_t)n > hdr.length) { err(E_ARG, "data"); return; }
	for (int i = 0; i < n; i++) {
		uint32_t in_page = received & (PAGE - 1);
		if (in_page == 0) memset(pagebuf, 0xff, sizeof pagebuf);
		((uint8_t *)pagebuf)[in_page] = chunk[i];
		received++;
		if ((received & (PAGE - 1)) == 0 && write_page_at(received - 1)) {
			receiving = 0;
			err(E_FLASH, "write failed");
			return;
		}
	}
	funDigitalWrite(PIN_LED, (received >> 10) & 1);
	r_begin("OK "); r_dec(received); r_end();
}

static void cmd_end(void)
{
	if (!receiving) { err(E_STATE, "no BEGIN"); return; }
	receiving = 0;
	if (received != hdr.length) { err(E_STATE, "image incomplete"); return; }
	if ((received & (PAGE - 1)) && write_page_at(received)) { err(E_FLASH, "write failed"); return; }

	const uint8_t *img = (const uint8_t *)APP_OFF;
	if (crc32(img, hdr.length) != hdr.crc32) { err(E_SIG, "image damaged in transfer"); return; }

	static ed25519_verify_ctx v;
	ed25519_verify_start(&v, hdr.sig, pubkeys[hdr.key_id]);
	ed25519_verify_update(&v, &hdr, IMG_HDR_SIGNED);
	ed25519_verify_update(&v, img, hdr.length);
	if (!ed25519_verify_finish(&v)) { err(E_SIG, "not signed by Eplop"); return; }

	memset(pagebuf, 0xff, sizeof pagebuf);
	memcpy(pagebuf, &hdr, sizeof hdr);
	if (page_write(IMG_HDR_OFF, pagebuf) || !app_valid()) { err(E_FLASH, "write failed"); return; }
	r_begin("OK verified app="); r_str(hdr.version); r_end();
}

static void cmd_run(void)
{
	if (!app_valid()) { err(E_NOAPP, "no firmware installed"); return; }
	ok();
	flush_tx();
	reset();
}

// Removes the installed firmware (it stops counting as installed). For testing
// and the factory rig; presets are kept.
static void cmd_clear(void)
{
	receiving = 0;
	if (page_write(IMG_HDR_OFF, NULL)) err(E_FLASH, "erase failed");
	else ok();
}

static void handle_line(char *line)
{
	char *tok[3] = { 0 };
	int n = 0;
	for (char *p = line; *p && n < 3;) {
		while (*p == ' ') *p++ = 0;
		if (!*p) break;
		tok[n++] = p;
		while (*p && *p != ' ') p++;
	}
	if (!n) return;
	if (ieq(tok[0], "HELLO")) cmd_hello();
	else if (ieq(tok[0], "BEGIN")) cmd_begin(tok[1]);
	else if (ieq(tok[0], "DATA")) cmd_data(tok[1], tok[2]);
	else if (ieq(tok[0], "END")) cmd_end();
	else if (ieq(tok[0], "RUN")) cmd_run();
	else if (ieq(tok[0], "CLEAR")) cmd_clear();
	else if (ieq(tok[0], "ABORT")) { receiving = 0; ok(); }
	else err(E_UNKNOWN, "unknown command");
}

static char rx_line[LINE_MAX];
static uint16_t rx_len;
static uint8_t rx_overflow;
static uint32_t last_rx;

void HandleUSBInput(int n, uint8_t *data)
{
	last_rx = millis();
	for (int i = 0; i < n; i++) {
		char c = (char)data[i];
		if (c == '\r') continue;
		if (c == '\n') {
			rx_line[rx_len] = 0;
			if (rx_overflow) err(E_ARG, "line too long");
			else handle_line(rx_line);
			rx_len = 0;
			rx_overflow = 0;
		} else if (rx_len < LINE_MAX - 1) {
			rx_line[rx_len++] = c;
		} else {
			rx_overflow = 1;
		}
	}
}

// ---------------------------------------------------------------- start-up
static int boot_requested(void)
{
	volatile uint32_t *w = (volatile uint32_t *)BOOT_REQ_ADDR;
	int req = w[0] == BOOT_REQ_MAGIC && w[1] == ~BOOT_REQ_MAGIC;
	w[0] = w[1] = 0;
	return req;
}

static int preset_held(void)
{
	funPinMode(PIN_PRESET, GPIO_CFGLR_IN_PUPD);
	funDigitalWrite(PIN_PRESET, FUN_HIGH);    // pull-up; the button pulls to GND
	Delay_Ms(2);
	if (funDigitalRead(PIN_PRESET)) return 0;
	Delay_Ms(30);                             // still down: not a glitch
	return !funDigitalRead(PIN_PRESET);
}

int main(void)
{
	SystemInit();
	funGpioInitAll();

	int app = app_valid();
	int req = boot_requested();
	if (app && !req && !preset_held()) jump_app();

	// Update mode.
	funPinMode(PIN_LED, GPIO_CFGLR_OUT_10Mhz_PP);
	usb_serial_init();
	USBFSSetup();

	for (;;) {
		uint32_t now = millis();
		poll_input();
		tx_pump();
		if (!receiving) funDigitalWrite(PIN_LED, now % 1000 < 100);   // short blink: update mode
		// Plugged into a power bank by mistake with the button held: carry on as normal.
		if (app && !USBFSCTX.USBFS_DevEnumStatus && now > HOST_WAIT_MS) reset();
		// A BEGIN that the page never finished leaves no firmware; a fresh one restarts it.
		if (receiving && now - last_rx > 30000u) receiving = 0;
	}
}
