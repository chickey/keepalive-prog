# Hardware reference (Rev A samples)

## MCU: CH32X035F8U6, QFN-20 (LCSC C42442062)

| QFN pin | Port | Net | Firmware use |
|---|---|---|---|
| 1 | VDD | +3V3 | — |
| 21 (EP) | GND | GND | Exposed pad is the only ground |
| 2 | PA0 / TIM2_CH1 | GATE_A | Leg A, 100 Ω (~50 mA) |
| 3 | PA1 / TIM2_CH2 | GATE_B | Leg B, 47 Ω (~106 mA) |
| 4 | PA2 / TIM2_CH3 | GATE_C | Leg C, 2× 47 Ω parallel (~213 mA) |
| 6 | PA4 / ADC4 | VSENSE | VBUS via 1 MΩ / 150 kΩ (×0.1304) |
| 8 | PA6 / ADC6 | ISENSE | Shunt 1 Ω via 1 kΩ / 100 nF |
| 11 | PB1 | PRESET | Button to GND, use internal pull-up |
| 14 | PC18 | SWDIO | WCH-LinkE (SDI) |
| 15 | PB12 | LED | Active high, 1 kΩ |
| 16 | PC19 | SWCLK | WCH-LinkE (SDI) |
| 17 | PC16 / UDM | D− | USB, shared with passthrough |
| 18 | PC17 / UDP | D+ | USB, shared with passthrough |
| 5, 7, 9, 10, 12, 13, 19, 20 | — | NC | Leave as inputs |

Never configure PC10/PC11 as outputs (bonded internally to the USB pins).

## Load bank

- Low-side AO3400A per leg, 100 Ω gate resistor, 100 kΩ gate pull-down (load off at reset).
- All three sources → LOAD_RTN → 1 Ω 1% shunt → GND.
- Max ≈ 344 mA at 5.0 V (all legs). Usable spec 1–325 mA in 1 mA steps.
- Intermediate currents: hold lower combination on, PWM the next leg at ~20–25 kHz, close the loop on ISENSE.
- Disable load if VBUS > 6 V (QC raised the bus) or < ~4.2 V.

## ADC

- VDD is the ADC reference and comes from an HT7533 (±3%): correct each reading using the internal 1.2 V reference channel.
- Calibrate ISENSE zero with all legs off at boot.
- Resolution: 1 Ω shunt and 12-bit ADC give ~0.8 mA per LSB. The firmware averages 6 samples per control step (×16 fixed point), the integral loop averages further and the reported pulse `ma` is a mean over the whole pulse, so 1 mA set-point steps are meaningful. Expect absolute accuracy of about ±(2% + 2 mA), limited by ADC offset/INL at the low end; below ~10 mA treat readings as approximate.
- Use a long sample time on VSENSE (1 MΩ source, 100 nF across R13).

## Buttons and boot

- PRESET (PB1): short press = next enabled preset (disabled ones are skipped), LED blinks 1/2/3; selection saved to flash. Long press (≥ 1.5 s) = blink the current preset number without changing it.
- BOOT button: pulls D+ to +3V3 via 4.7 kΩ. Hold while plugging in → WCH USB ISP bootloader (4348:55E0), flash with `wchisp`.
- Firmware should also offer a command to jump to the bootloader.

## USB behaviour

- D+/D− pass straight through J1 ↔ J2 and the MCU taps them.
- At power-up, probe the lines before attaching: only enable the D+ pull-up and enumerate (CDC) if a real host is present; otherwise stay off the bus and run keep-alive mode.
- Sleep between pulses (~0.5 mA with timed wake); stay awake in config mode.
