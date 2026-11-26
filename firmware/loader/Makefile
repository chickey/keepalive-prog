# Eplop Keep Alive update loader (CH32X035F8U6), built with ch32fun.
#
#   make          build loader.bin (must stay below 0x3F00 bytes)
#   make test     check the Ed25519 code against Python's cryptography (host)
#
# The loader is written once, at the factory (tools/rig) or with WCH's
# bootloader; it never updates itself.

all : build

TARGET:=loader
TARGET_MCU:=CH32X035
TARGET_MCU_PACKAGE:=CH32X035F8U6

CH32FUN_ROOT ?= ../ch32fun
ADDITIONAL_C_FILES := ed25519.c sha512.c $(CH32FUN_ROOT)/extralibs/fsusb.c
EXTRA_CFLAGS += -I. -I../src
LINKER_SCRIPT := loader.ld

ifeq ($(filter test,$(MAKECMDGOALS)),)
include $(CH32FUN_ROOT)/ch32fun/ch32fun.mk
endif

# Stack starts below the update-request word (see ../src/image.h).
LDFLAGS += -Wl,--defsym=_eusrstack=0x20004FF0

loader.ld : $(GENERATED_LD_FILE)
	sed 's/ORIGIN = 0x00000000, LENGTH = 62K/ORIGIN = 0x00000000, LENGTH = 0x3F00/' $< > $@
	grep -q 'LENGTH = 0x3F00' $@

build : size_check
size_check : $(TARGET).bin
	@size=$$(wc -c < $(TARGET).bin); \
	if [ $$size -gt 16128 ]; then echo "loader.bin ($$size bytes) overlaps the firmware header"; exit 1; fi; \
	echo "loader.bin: $$size bytes (limit 16128)"

clean : cv_clean
	rm -f loader.ld test/verify_cli

test :
	python3 test/test_ed25519.py

.PHONY : test size_check
