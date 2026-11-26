#!/bin/sh
# Starts the Keep Alive rig with its dashboard and opens it full-screen.
# Closing the dashboard window stops the rig. This is what the desktop
# launcher runs; it also works from a terminal.
#
#   ./start-rig.sh                 # loader only (what ships)
#   ./start-rig.sh --image ../../firmware/prebuilt/factory-full.bin
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
PORT=${RIG_PORT:-8765}
URL="http://localhost:$PORT/"
PY="$HERE/.venv/bin/python"
[ -x "$PY" ] || PY=python3
SERVER_LOG="$HERE/rig-server.log"

say_error() {
	if command -v zenity >/dev/null 2>&1; then zenity --error --title "Keep Alive rig" --text "$1" 2>/dev/null
	else echo "$1" >&2; fi
}

running() { "$PY" -c "import urllib.request,sys; urllib.request.urlopen('$URL'+'state', timeout=1)" 2>/dev/null; }

PID=""
if running; then
	echo "The rig is already running; opening its dashboard."
else
	"$PY" "$HERE/karig.py" --web "$PORT" "$@" >"$SERVER_LOG" 2>&1 &
	PID=$!
	i=0
	until running; do
		i=$((i + 1))
		if [ $i -gt 40 ] || ! kill -0 "$PID" 2>/dev/null; then
			say_error "The rig didn't start. Details are in $SERVER_LOG:
$(tail -n 5 "$SERVER_LOG")"
			kill "$PID" 2>/dev/null
			exit 1
		fi
		sleep 0.25
	done
fi

stop() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; }
trap stop EXIT INT TERM

BROWSER=""
for b in chromium-browser chromium google-chrome; do
	command -v "$b" >/dev/null 2>&1 && { BROWSER=$b; break; }
done

if [ -n "$BROWSER" ]; then
	# Its own profile, so it runs as a separate window we can wait for, and
	# sounds play without a click first.
	"$BROWSER" --app="$URL" --start-fullscreen --no-first-run --noerrdialogs \
		--user-data-dir="$HOME/.cache/keepalive-rig-browser" \
		--autoplay-policy=no-user-gesture-required >/dev/null 2>&1
elif [ "$(uname)" = Darwin ]; then
	open "$URL"
	echo "Dashboard open in your browser. Press Ctrl+C here to stop the rig."
	wait "$PID"
else
	echo "Open $URL in a browser. Press Ctrl+C here to stop the rig."
	wait "$PID"
fi
