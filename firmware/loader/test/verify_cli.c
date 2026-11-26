// Host test helper: reads "pkhex sighex msghex" lines, prints 1 or 0 per line.
// The message is fed in random-sized pieces to exercise the streaming hash.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../ed25519.h"

static int unhex(const char *s, uint8_t *o, int max)
{
	int n = 0;
	while (s[0] && s[1] && s[0] != ' ' && n < max) { sscanf(s, "%2hhx", &o[n++]); s += 2; }
	return n;
}

int main(void)
{
	static char line[300000];
	static uint8_t msg[140000];
	srand(1);
	while (fgets(line, sizeof line, stdin)) {
		uint8_t pk[32], sig[64];
		char *a = strtok(line, " \n"), *b = strtok(NULL, " \n"), *c = strtok(NULL, " \n");
		unhex(a, pk, 32); unhex(b, sig, 64);
		int n = c ? unhex(c, msg, sizeof msg) : 0;
		ed25519_verify_ctx v;
		ed25519_verify_start(&v, sig, pk);
		for (int i = 0; i < n;) { int k = 1 + rand() % 300; if (k > n - i) k = n - i; ed25519_verify_update(&v, msg + i, k); i += k; }
		printf("%d\n", ed25519_verify_finish(&v));
	}
	return 0;
}
