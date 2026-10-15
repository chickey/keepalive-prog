#ifndef STORE_H
#define STORE_H
#include <stddef.h>
void store_load(void);   // fills app.presets / app.active (factory defaults if empty)
int  store_save(void);   // 0 = ok
#endif
