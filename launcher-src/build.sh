#!/bin/bash
# Rebuild CatchTheTarget.exe after changing the game. Needs Go 1.22+ (https://go.dev/dl/).
set -e
cd "$(dirname "$0")"
G=..
rm -rf game && mkdir -p game/assets/ui
cp -r $G/index.html $G/css $G/js $G/vendor game/
cp -r $G/assets/items game/assets/
cp $G/assets/ui/background.mp4 $G/assets/ui/background.webm $G/assets/ui/background-poster.jpg $G/assets/ui/title-catch-the-target.png game/assets/ui/
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o ../windows/CatchTheTarget.exe .
rm -rf game
echo "Built ../windows/CatchTheTarget.exe"
