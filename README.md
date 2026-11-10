# Catch the Target — SCAD two-player body-tracking game

Two players stand side by side in front of a webcam. Each player's basket follows their body left and right. They catch SCAD-related items (statistics, census, data…) and let unrelated ones (frying pan, perfume…) fall past.

## Run it

**Windows, one file:** copy `windows/CatchTheTarget.exe` to the PC and double-click it. The whole game is built into the .exe, so no Python or anything else is needed. If neither Chrome nor Edge is installed, it installs Chrome automatically (via winget, or Google's installer). It also warns if no webcam is plugged in, then opens the game full-screen. Optional `settings.txt` next to the exe changes round length, model, etc. Logs go to `%LOCALAPPDATA%\CatchTheTarget\launcher.log`. After changing the game, rebuild the exe with `launcher-src/build.sh` (needs Go).

**Mac, one click:** double-click `start.command`. It starts a local server and opens Chrome full-screen in kiosk mode, with the camera allowed and sound on.
(The first time, macOS may ask you to allow it: right-click → Open. Quit kiosk with ⌘Q.)

**Manually:**
```
python3 server.py        # then open http://localhost:8080 in Chrome
```
The game must be served over `http://localhost`. Opening `index.html` as a file won't get camera access.

Everything runs offline. The MediaPipe runtime and both pose models are in `vendor/`. Only the Inter web font loads from Google Fonts, and it falls back to the system font when offline.

## Flow (matches the Figma storyboard)
1. **Attract / Join.** Stand on your side and raise one hand for under a second. P1 is the left side, P2 the right. A live camera preview (bottom-right) shows each person's skeleton tagged P1/P2.
   If only one person is ready and nobody is on the other side, a solo round starts after 6 s.
2. **What to catch.** The 30 + 30 item guide. Auto-advances after 8 s.
3. **Countdown.** 3‑2‑1‑GO. Baskets are already live so players can feel the controls.
4. **Gameplay.** 30 s. +1 per SCAD item, −1 for an unrelated item, golden bonus star +3, and +1 for every 5 in a row. Speed and density ramp up, with a "Final 10 seconds" rush.
5. **Results.** Winner, accuracy, best streak. Body tracking is switched off here: players are released and detection pauses. After 15 s (`?idle=` to change) it returns to the join screen, where tracking starts again and new players can step in.

## Player IDs that don't switch
MediaPipe reports poses in random order each frame. `js/idtracker.js` turns them into two stable players:
- **Motion prediction.** Each player's torso position is predicted from their velocity.
- **Body size.** Shoulder width (distance from the camera) must stay consistent.
- **Appearance.** A colour signature of each player's clothing is learned during play.
- **Global matching.** Every frame, the detection-to-player pairing with the lowest total cost wins.
- **Locked identities during a round.** A player who steps out keeps their slot (their basket dims with "Step back into view") and is re-acquired only by someone who matches their size and clothing. Passers-by are ignored.
- **Lanes.** Each basket stays in its own half, so players never fight over a basket.

## Who counts as a player
`js/presence.js` filters people before they can take a slot:
- **Distance limit.** Each person's distance is estimated from their shoulder width and torso length. Anyone further than **4.5 m** is ignored. On the join screen they're told to "Come a bit closer". Change it with `maxdist=` (metres). If distances look wrong for your webcam, set its field of view with `fov=` (default 78°).
- **Photos, posters and screens.** A body has to *move* (walk in, raise a hand, shift their weight about 5 cm) before it can play. Pictures of people never do, so they're ignored. Spots where a still body keeps being seen are remembered, and need even more movement there. Raise or lower the sensitivity with `motion=` (default 0.12). Turn the check off with `liveness=0`.
- **Reflections (mirrors, glass doors, shiny walls).** A mirror behind the players shows their *back*, so players must face the camera (face visible) to join. Glass or a mirror at the side can show a mirrored *front* view. That copy moves in perfect sync with a nearer, bigger person, so any smaller body whose movement keeps matching someone else's is ignored as a reflection. A real second player standing further back is accepted once they move on their own (about 2–3 s). Turn these off with `facing=0` / `reflections=0`.
- In the camera view (`C`), ignored bodies are grey and tagged **FAR**, **STILL**, **BACK** or **MIRROR**. `Shift+D` shows each person's estimated distance.

## Setup tips
- Put the camera centred at about chest height (1.2–1.4 m). Players stand **2.5–4 m** away, about 1.5 m apart.
- Avoid large mirrors or glass right behind or beside the play area; the game filters reflections, but covering them is still the safest setup.
- Use a 1080p webcam and even, front-facing light. Avoid strong backlight such as windows behind the players.
- Tune each player's reach with URL params if needed: `?p1min=0.08&p1max=0.46&p2min=0.54&p2max=0.92`.

## Keys (operator)
| Key | Action |
|---|---|
| `K` | Keyboard test mode (P1: A/D + W to raise hand · P2: ←/→ + ↑ · `1`/`2` make a player leave/return) |
| `Enter` | Skip to next screen |
| `Esc` | Back to Attract |
| `C` | Toggle camera preview |
| `Shift+D` | Debug overlay (fps, tracker state) |
| `M` | Mute |
| `F` | Full screen |

## URL options
`?round=45` round length · `?model=lite` faster model for weaker machines · `?solo=0` disable solo · `?camera=logitech` choose camera by name · `?debug=1` · `?keyboard` skip the camera · `?hold=700` hand-raise hold (ms) · `?mirror=0` · `?maxdist=4.5` max player distance (m) · `?fov=78` webcam field of view · `?motion=0.12` movement needed to count as a real person · `?liveness=0` allow still bodies · `?facing=0` allow back views · `?reflections=0` turn off reflection detection

## Files
```
index.html, css/style.css
js/main.js        flow / screens / HUD
js/game.js        falling items, baskets, scoring, effects (canvas)
js/idtracker.js   persistent player IDs
js/presence.js    distance limit, photo/poster and reflection rejection
js/pose.js        camera + MediaPipe Pose Landmarker
js/audio.js       synthesized sounds (no audio files)
js/config.js      all tunables
assets/items/     60 item images from Figma (catch/ and avoid/)
assets/ui/        background, title from Figma
assets/figma/     raw exports from the Figma file
vendor/           MediaPipe tasks-vision 0.10.35 + pose models (full, lite)
```
