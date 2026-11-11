#!/bin/bash
# Double-click to start Catch the Target on a Mac.
# Starts the server (game + tablet registration), opens the game full-screen in Chrome,
# and shows the link to open on the registration tablet in this window.
# Options (distance limits, round length, port, …) are read from settings.txt in this folder.
cd "$(dirname "$0")"
PORT=7420
QUERY="kiosk=1"
WINDOWED=0
if [ -f settings.txt ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"                         # drop comments
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -z "$line" ] && continue
    key="${line%%=*}"; val="${line#*=}"
    [ "$key" = "$line" ] || [ -z "$val" ] && continue
    case "$key" in
      port) PORT="$val" ;;
      windowed) WINDOWED="$val" ;;
      *) QUERY="$QUERY&$key=$val" ;;
    esac
  done < settings.txt
fi

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use — is Catch the Target already running?"
  echo "Close the other window first, or set another port in settings.txt (e.g. port=7421)."
  read -r -p "Press Enter to close." _
  exit 1
fi

python3 server.py $PORT &
SERVER=$!
trap "kill $SERVER 2>/dev/null" EXIT
sleep 1
[ "$QUERY" != "kiosk=1" ] && echo "✓ settings.txt: ${QUERY#kiosk=1&}"

URL="http://127.0.0.1:$PORT/?$QUERY"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$CHROME" ]; then
  if [ "$WINDOWED" = "1" ]; then MODE=(--app="$URL" --start-maximized); else MODE=(--kiosk "$URL"); fi
  # Own profile so kiosk flags don't touch your normal Chrome; camera auto-allowed; sound without a click.
  "$CHROME" --user-data-dir="$HOME/.catch-the-target-chrome" \
    --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream \
    --disable-features=Translate --no-first-run "${MODE[@]}"
else
  open "$URL"
  echo "Press Ctrl+C here to stop the server."
  wait $SERVER
fi
