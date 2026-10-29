// Presets and the active selection, kept in the last 256-byte flash page.
// Uses the CH32X035 fast page erase/program sequence from WCH's driver.
#include <string.h>
#include "ch32fun.h"
#include "app.h"
#include "store.h"

#define STORE_ADDR   0x0800F700u   // last page of the 62 KB code flash
#define STORE_MAGIC  0x4B415032u   // "KAP2": KAP1 plus the enabled mask
#define STORE_MAGIC1 0x4B415031u   // "KAP1": all presets enabled
#define PAGE_SIZE    256

typedef struct {
	uint32_t magic;
	uint32_t active;
	struct { uint32_t ma, on, off; } p[NPRESETS];
	uint32_t crc;
	uint32_t flags;     // bit i = preset i+1 enabled; LED code in bits 8-9 (KAP2 only)
	uint32_t crc2;      // over everything above (KAP2 only)
} record_t;

_Static_assert(sizeof(record_t) <= PAGE_SIZE, "record too big");

static uint32_t fnv1a(const void *d, int n)
{
	const uint8_t *b = d;
	uint32_t h = 2166136261u;
	while (n--) { h ^= *b++; h *= 16777619u; }
	return h;
}

#define ALL_ENABLED    ((1u << NPRESETS) - 1)
// Light mode (1.0.3+), coded so that 0 (records from 1.0.2) means the 10 s blink.
#define LED_SHIFT      8
#define LED_MASK       (3u << LED_SHIFT)
static const uint8_t led_from_code[3] = { LED_MODE_REMIND, LED_MODE_OFF, LED_MODE_PULSE };
static const uint8_t code_from_led[3] = { 1, 2, 0 };   // indexed by LED_MODE_*

// Returns the flags of a valid record, 0 if it isn't valid (a valid record
// always has the active preset enabled, so its flags are never 0).
static uint32_t valid(const record_t *r)
{
	uint32_t fl;
	if (r->magic == STORE_MAGIC1) fl = ALL_ENABLED;
	else if (r->magic == STORE_MAGIC && r->crc2 == fnv1a(r, offsetof(record_t, crc2))) fl = r->flags;
	else return 0;
	if (r->crc != fnv1a(r, offsetof(record_t, crc))) return 0;
	if (r->active < 1 || r->active > NPRESETS) return 0;
	if (fl & ~(ALL_ENABLED | LED_MASK) || !(fl & (1u << (r->active - 1)))) return 0;
	if (((fl & LED_MASK) >> LED_SHIFT) > 2) return 0;
	for (int i = 0; i < NPRESETS; i++) {
		if (r->p[i].ma > MA_MAX) return 0;
		if (r->p[i].on < ON_MIN_MS || r->p[i].on > ON_MAX_MS) return 0;
		if (r->p[i].off > OFF_MAX_MS) return 0;
	}
	return fl;
}

void store_load(void)
{
	const record_t *r = (const record_t *)STORE_ADDR;
	uint32_t fl = valid(r);
	if (fl) {
		app.active = (uint8_t)r->active;
		app.led = led_from_code[(fl & LED_MASK) >> LED_SHIFT];
		for (int i = 0; i < NPRESETS; i++) {
			app.presets[i].ma = (uint16_t)r->p[i].ma;
			app.presets[i].on = r->p[i].on;
			app.presets[i].off = r->p[i].off;
			app.presets[i].en = (uint8_t)((fl >> i) & 1);
		}
	} else {
		app_defaults();
		app.active = 1;
		app.led = LED_MODE_REMIND;
	}
}

// Fast-mode bits (from WCH ch32x035_flash.c)
#define FL_PAGE_PG        0x00010000u
#define FL_PAGE_ER        0x00020000u
#define FL_BUF_LOAD       0x00040000u
#define FL_BUF_RST        0x00080000u
#define FL_STRT           0x00000040u
#define FL_LOCK           0x00000080u
#define FL_FLOCK          0x00008000u
#define FL_CLR_ER         (~(0x00000020u | FL_PAGE_ER))   // clear OPTER and PAGE_ER
#define FL_BSY            0x00000001u
#define FL_WRPRTERR       0x00000010u

static inline void wait_busy(void) { while (FLASH->STATR & FL_BSY); }

int store_save(void)
{
	static uint32_t page[PAGE_SIZE / 4];
	record_t *r = (record_t *)page;
	memset(page, 0xFF, sizeof page);
	r->magic = STORE_MAGIC;
	r->active = app.active;
	r->flags = (uint32_t)code_from_led[app.led] << LED_SHIFT;
	for (int i = 0; i < NPRESETS; i++) {
		r->p[i].ma = app.presets[i].ma;
		r->p[i].on = app.presets[i].on;
		r->p[i].off = app.presets[i].off;
		if (app.presets[i].en) r->flags |= 1u << i;
	}
	r->crc = fnv1a(r, offsetof(record_t, crc));
	r->crc2 = fnv1a(r, offsetof(record_t, crc2));

	// Skip the write if nothing changed (saves flash wear on repeated SAVE).
	if (memcmp((const void *)STORE_ADDR, page, sizeof(record_t)) == 0) return 0;

	__disable_irq();
	FLASH->KEYR = FLASH_KEY1;
	FLASH->KEYR = FLASH_KEY2;
	FLASH->MODEKEYR = FLASH_KEY1;
	FLASH->MODEKEYR = FLASH_KEY2;
	FLASH->STATR = FL_WRPRTERR;

	// Erase the page
	FLASH->CTLR &= FL_CLR_ER;
	FLASH->CTLR |= FL_PAGE_ER;
	FLASH->ADDR = STORE_ADDR;
	FLASH->CTLR |= FL_STRT;
	wait_busy();
	FLASH->CTLR &= ~FL_PAGE_ER;

	// Reset the page buffer, load 64 words, program
	FLASH->CTLR &= FL_CLR_ER;
	FLASH->CTLR |= FL_PAGE_PG;
	FLASH->CTLR |= FL_BUF_RST;
	wait_busy();
	FLASH->CTLR &= ~FL_PAGE_PG;
	for (int i = 0; i < PAGE_SIZE / 4; i++) {
		FLASH->CTLR &= FL_CLR_ER;
		FLASH->CTLR |= FL_PAGE_PG;
		*(volatile uint32_t *)(STORE_ADDR + 4 * i) = page[i];
		FLASH->CTLR |= FL_BUF_LOAD;
		wait_busy();
		FLASH->CTLR &= ~FL_PAGE_PG;
	}
	FLASH->CTLR &= FL_CLR_ER;
	FLASH->CTLR |= FL_PAGE_PG;
	FLASH->ADDR = STORE_ADDR;
	FLASH->CTLR |= FL_STRT;
	wait_busy();
	FLASH->CTLR &= ~FL_PAGE_PG;

	int err = (FLASH->STATR & FL_WRPRTERR) != 0;
	FLASH->CTLR |= FL_FLOCK;
	FLASH->CTLR |= FL_LOCK;
	__enable_irq();

	if (err) return -1;
	return memcmp((const void *)STORE_ADDR, page, sizeof(record_t)) == 0 ? 0 : -1;
}
