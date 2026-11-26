// Flash layout and the signed image header, shared by the loader and the
// firmware (and mirrored in tools/kasign.py and docs/serial-loader.js).
//
//   0x0000 - 0x3EFF  update loader (written once, at the factory)
//   0x3F00 - 0x3FFF  header of the installed firmware (written last, only
//                    after its signature checked out)
//   0x4000 - 0xF6FF  firmware
//   0xF700 - 0xF7FF  saved presets and settings (store.c)
#ifndef IMAGE_H
#define IMAGE_H
#include <stdint.h>

#define FLASH_BASE_ADDR   0x08000000u   // writes go here; code runs from the alias at 0
#define LOADER_MAX        0x3F00u
#define IMG_HDR_OFF       0x3F00u
#define APP_OFF           0x4000u
#define APP_END_OFF       0xF700u
#define APP_MAX           (APP_END_OFF - APP_OFF)   // 46848 bytes

#define IMG_MAGIC         0x3149414Bu   // "KAI1"
#define IMG_HDR_VERSION   1u
#define IMG_HDR_SIGNED    64u           // bytes of the header covered by the signature

// 128 bytes, little-endian. The signature covers the first 64 bytes of the
// header followed by the whole image, so the version and length can't be
// changed either.
typedef struct {
	uint32_t magic;          // IMG_MAGIC
	uint32_t hdr_version;    // IMG_HDR_VERSION
	uint32_t length;         // image bytes, a multiple of 4, at most APP_MAX
	uint32_t load_off;       // APP_OFF
	char     version[16];    // e.g. "1.1.0", NUL padded
	uint32_t sec_level;      // the loader refuses an image below the installed one's
	uint32_t key_id;         // which of the loader's public keys signed it
	uint32_t crc32;          // of the image (zlib CRC-32), checked at every start
	uint32_t flags;          // 0
	uint8_t  reserved[16];   // 0
	uint8_t  sig[64];        // Ed25519
} img_header_t;

_Static_assert(sizeof(img_header_t) == 128, "header size");

// Set by the firmware's BOOT command just before a reset, so the loader stays
// in update mode. Sits above the stack (both builds start it at 0x20004FF0).
#define BOOT_REQ_ADDR     0x20004FF8u
#define BOOT_REQ_MAGIC    0x4C4F4144u   // "LOAD", followed by its complement

#endif
