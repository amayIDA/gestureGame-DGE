#!/bin/bash
# Double-click to start Catch the Target on a Mac.
# Starts the server (game + tablet registration), opens the game full-screen in Chrome,
# and shows the link to open on the registration tablet in this window.
cd "$(dirname "$0")"
PORT=7420

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use — is Catch the Target already running?"
  echo "Close the other window first, or edit PORT in this file."
  read -r -p "Press Enter to close." _
  exit 1
fi

python3 server.py $PORT &
SERVER=$!
trap "kill $SERVER 2>/dev/null" EXIT
sleep 1

URL="http://127.0.0.1:$PORT/?kiosk=1"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$CHROME" ]; then
  # Own profile so kiosk flags don't touch your normal Chrome; camera auto-allowed; sound without a click.
  "$CHROME" --kiosk --user-data-dir="$HOME/.catch-the-target-chrome" \
    --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream \
    --disable-features=Translate --no-first-run "$URL"
else
  open "$URL"
  echo "Press Ctrl+C here to stop the server."
  wait $SERVER
fi
