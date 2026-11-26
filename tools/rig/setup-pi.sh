#!/bin/sh
# Sets up a Raspberry Pi (Raspberry Pi OS Lite, Bookworm or later) as a Keep
# Alive factory rig: the rig starts at boot and shows its results full-screen
# on the HDMI console (tty1). Run from this folder as the normal user:
#
#   ./setup-pi.sh
#
# Then reboot. Re-running is safe.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
USER_NAME=$(id -un)

echo "== packages"
sudo apt-get update -q
sudo apt-get install -y -q python3-venv libusb-1.0-0

echo "== python environment"
python3 -m venv "$HERE/.venv"
"$HERE/.venv/bin/pip" install -q -r "$HERE/requirements.txt"

echo "== USB permissions"
# WCH's bootloader (both vendor IDs it uses) for programming; the Keep Alive's
# serial port for the check afterwards.
sudo tee /etc/udev/rules.d/50-keepalive-rig.rules >/dev/null <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="4348", ATTRS{idProduct}=="55e0", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="55e0", MODE="0666"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="d035", MODE="0666"
EOF
sudo udevadm control --reload-rules
sudo usermod -aG dialout,plugdev "$USER_NAME"

echo "== large console font for the HDMI screen"
sudo sed -i 's/^FONTFACE=.*/FONTFACE="TerminusBold"/; s/^FONTSIZE=.*/FONTSIZE="16x32"/' /etc/default/console-setup

echo "== start the rig on tty1 at boot"
sudo tee /etc/systemd/system/keepalive-rig.service >/dev/null <<EOF
[Unit]
Description=Keep Alive factory rig
After=multi-user.target

[Service]
User=$USER_NAME
WorkingDirectory=$HERE
ExecStart=$HERE/.venv/bin/python $HERE/karig.py --log $HERE/rig-log.csv
StandardInput=tty
StandardOutput=tty
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl disable getty@tty1.service >/dev/null 2>&1 || true
sudo systemctl daemon-reload
sudo systemctl enable keepalive-rig.service

echo
echo "Done. Reboot; the rig then runs on the HDMI screen."
echo "Log: $HERE/rig-log.csv   Stop: sudo systemctl stop keepalive-rig"
