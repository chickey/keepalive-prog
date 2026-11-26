# Eplop Keep Alive firmware (CH32X035F8U6), built with ch32fun.
#
#   make            build keepalive.bin / .hex
#   make test       run the host-side protocol and scheduler tests
#   make flash      flash with a WCH-LinkE via minichlink
#   make sign       sign keepalive.bin for the update loader -> keepalive.kai
#                   (KEY=~/.eplop/keepalive-primary.pem KEY_ID=0 SEC_LEVEL=0)
#   make prebuilt   build the loader and firmware, sign, and copy to prebuilt/
#                   with the factory images
#   make site       publish prebuilt/ to the web flasher (../docs/firmware);
#                   NOTE="..." adds a line shown under the version
#
# The firmware is linked to run after the update loader (loader/), from
# 0x4000; src/image.h has the flash layout.
#
# ch32fun is expected in ./ch32fun (git submodule) or set CH32FUN_ROOT.

all : build

TARGET:=keepalive
TARGET_MCU:=CH32X035
TARGET_MCU_PACKAGE:=CH32X035F8U6

CH32FUN_ROOT ?= ./ch32fun
SRC := src/app.c src/proto.c src/sched.c src/load.c src/store.c src/ui.c src/usbio.c src/power.c
ADDITIONAL_C_FILES := $(SRC) $(CH32FUN_ROOT)/extralibs/fsusb.c
EXTRA_CFLAGS += -Isrc
LINKER_SCRIPT := app.ld

# Debian/Ubuntu picolibc headers; override on other systems if needed.
ifneq ($(wildcard /usr/lib/picolibc/riscv64-unknown-elf/include),)
NEWLIB ?= /usr/lib/picolibc/riscv64-unknown-elf/include
endif

ifeq ($(filter test site sign,$(MAKECMDGOALS)),)
include $(CH32FUN_ROOT)/ch32fun/ch32fun.mk
endif

# Stack starts below the update-request word (see src/image.h).
LDFLAGS += -Wl,--defsym=_eusrstack=0x20004FF0

# Runs from 0x4000, after the loader, up to the settings page at 0xF700.
app.ld : $(GENERATED_LD_FILE)
	sed 's/ORIGIN = 0x00000000, LENGTH = 62K/ORIGIN = 0x00004000, LENGTH = 0xB700/' $< > $@
	grep -q 'ORIGIN = 0x00004000' $@

build : size_check
size_check : $(TARGET).bin
	@size=$$(wc -c < $(TARGET).bin); \
	if [ $$size -gt 46848 ]; then echo "keepalive.bin ($$size bytes) overlaps the settings page"; exit 1; fi; \
	echo "keepalive.bin: $$size bytes (limit 46848)"

flash : cv_flash
clean : cv_clean
	rm -f test/test_host app.ld keepalive.kai

test :
	cc -Wall -Wextra -Isrc -o test/test_host test/test_host.c src/proto.c src/sched.c src/app.c
	./test/test_host
	$(MAKE) -C loader test

KASIGN := python3 ../tools/kasign.py
KEY ?= ~/.eplop/keepalive-primary.pem
KEY_ID ?= 0
SEC_LEVEL ?= 0
FW_VER = $(shell sed -n 's/^\#define FW_VERSION *"\(.*\)".*/\1/p' src/board.h)

sign :
	$(KASIGN) sign keepalive.bin keepalive.kai --key $(KEY) --key-id $(KEY_ID) --version $(FW_VER) --sec-level $(SEC_LEVEL)
	$(KASIGN) verify keepalive.kai --keys loader/keys.h

# prebuilt/: the signed firmware, the loader, and the two factory images:
# loader only (what ships) and loader + firmware (for boards updated through
# WCH's bootloader, e.g. ones that had firmware from before the loader).
prebuilt : build
	$(MAKE) -C loader
	$(MAKE) sign
	cp keepalive.kai loader/loader.bin prebuilt/
	$(KASIGN) factory loader/loader.bin -o prebuilt/factory-loader.bin
	$(KASIGN) factory loader/loader.bin keepalive.kai --keys loader/keys.h -o prebuilt/factory-full.bin

.PHONY : test size_check sign prebuilt

# Copy prebuilt/ to the web flasher and regenerate its manifest.
SITE_FW := ../docs/firmware
NOTE ?=
site :
	$(KASIGN) site prebuilt $(SITE_FW) --keys loader/keys.h --note "$(NOTE)"

.PHONY : site
