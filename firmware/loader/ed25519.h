#ifndef ED25519_H
#define ED25519_H
#include <stdint.h>
#include "sha512.h"

// Streaming Ed25519 verification: start, feed the message in pieces, finish.
typedef struct {
	sha512_ctx h;
	uint8_t sig[64];
	uint8_t pk[32];
} ed25519_verify_ctx;

void ed25519_verify_start(ed25519_verify_ctx *v, const uint8_t sig[64], const uint8_t pk[32]);
void ed25519_verify_update(ed25519_verify_ctx *v, const void *msg, uint32_t n);
int  ed25519_verify_finish(ed25519_verify_ctx *v);   // 1 = valid

#endif
