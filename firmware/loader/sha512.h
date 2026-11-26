#ifndef SHA512_H
#define SHA512_H
#include <stdint.h>

typedef struct {
	uint64_t h[8];
	uint32_t len;        // bytes so far (images are far below 4 GB)
	uint8_t  buf[128];
} sha512_ctx;

void sha512_init(sha512_ctx *c);
void sha512_update(sha512_ctx *c, const void *data, uint32_t n);
void sha512_final(sha512_ctx *c, uint8_t out[64]);

#endif
