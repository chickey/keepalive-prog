#!/bin/sh
# Sets up a Raspberry Pi (Raspberry Pi OS with desktop, Bookworm or later) as
# a Keep Alive factory rig. Run from this folder as the user who will use it:
#
#   ./setup-pi.sh              # adds a "Keep Alive Rig" launcher to the menu and desktop
#   ./setup-pi.sh --autostart  # also runs the rig on the console (tty1) at every boot,
#                              # for a Pi that does nothing else
#
# Re-running is safe.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
USER_NAME=$(id -un)
AUTOSTART=0
[ "${1:-}" = "--autostart" ] && AUTOSTART=1

echo "== packages"
sudo apt-get update -q
sudo apt-get install -y -q python3-venv libusb-1.0-0

echo "== python environment"
python3 -m venv "$HERE/.venv"
"$HERE/.venv/bin/pip" install -q -r "$HERE/requirements.txt"

echo "== USB permissions"
# WCH's bootloader (both vendor IDs it uses) for programming; the Keep Alive's
# serial port for the check afterwards. ModemManager is told to leave the
# Keep Alive alone, or it probes the serial port as it appears.
sudo tee /etc/udev/rules.d/50-keepalive-rig.rules >/dev/null <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="4348", ATTRS{idProduct}=="55e0", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="55e0", MODE="0666"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="d035", MODE="0666", ENV{ID_MM_DEVICE_IGNORE}="1"
EOF
sudo udevadm control --reload-rules
sudo usermod -aG dialout,plugdev "$USER_NAME"

echo "== desktop launcher"
chmod +x "$HERE/start-rig.sh" "$HERE/karig.py"
mkdir -p "$HOME/.local/share/applications"
cat >"$HOME/.local/share/applications/keepalive-rig.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Keep Alive Rig
Comment=Put the update loader on Keep Alive boards and check them
Exec=$HERE/start-rig.sh
Icon=applications-electronics
Terminal=false
Categories=Development;Electronics;
EOF
if [ -d "$HOME/Desktop" ]; then
	cp "$HOME/.local/share/applications/keepalive-rig.desktop" "$HOME/Desktop/"
	chmod +x "$HOME/Desktop/keepalive-rig.desktop"
fi

if [ $AUTOSTART = 1 ]; then
	echo "== run on the console at boot"
	sudo sed -i 's/^FONTFACE=.*/FONTFACE="TerminusBold"/; s/^FONTSIZE=.*/FONTSIZE="16x32"/' /etc/default/console-setup
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
fi

echo
echo "Done. Log out and back in (for the USB permissions), then start"
echo "\"Keep Alive Rig\" from the menu or the desktop."
[ $AUTOSTART = 1 ] && echo "The console rig also starts at every boot (sudo systemctl disable keepalive-rig to stop that)."
echo "Log: $HERE/rig-log.csv"
