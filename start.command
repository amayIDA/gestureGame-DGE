#!/bin/bash
# Double-click to launch Catch the Target full-screen in Chrome (macOS).
cd "$(dirname "$0")"
PORT=8080
python3 server.py $PORT &
SERVER=$!
trap "kill $SERVER 2>/dev/null" EXIT
sleep 1

URL="http://localhost:$PORT/?kiosk=1"
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
