# Eplop Keep Alive firmware (CH32X035F8U6), built with ch32fun.
#
#   make            build keepalive.bin / .hex
#   make test       run the host-side protocol and scheduler tests
#   make isp        flash over USB with wchisp (board in bootloader)
#   make flash      flash with a WCH-LinkE via minichlink
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

# Debian/Ubuntu picolibc headers; override on other systems if needed.
ifneq ($(wildcard /usr/lib/picolibc/riscv64-unknown-elf/include),)
NEWLIB ?= /usr/lib/picolibc/riscv64-unknown-elf/include
endif

ifneq ($(MAKECMDGOALS),test)
include $(CH32FUN_ROOT)/ch32fun/ch32fun.mk
endif

# The settings page lives in the last 256-byte flash page; make sure code never reaches it.
build : size_check
size_check : $(TARGET).bin
	@size=$$(wc -c < $(TARGET).bin); \
	if [ $$size -gt 63232 ]; then echo "keepalive.bin ($$size bytes) overlaps the settings page"; exit 1; fi; \
	echo "keepalive.bin: $$size bytes (limit 63232)"

flash : cv_flash
clean : cv_clean
	rm -f test/test_host

isp : $(TARGET).bin
	wchisp flash $(TARGET).bin

test :
	cc -Wall -Wextra -Isrc -o test/test_host test/test_host.c src/proto.c src/sched.c src/app.c
	./test/test_host

.PHONY : test isp size_check
