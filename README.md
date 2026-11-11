# Catch the Target — SCAD body-tracking game with tablet registration

Players register on a **tablet** (one player or two). The **game PC** calls them in by name; they stand in front of the webcam and their basket follows their body left and right. They catch SCAD-related items (statistics, census, data…) and let unrelated ones (frying pan, perfume…) fall past. 60-second rounds.

Two parts, served by one program on the game PC:

| | Where | What |
|---|---|---|
| **Game** | PC + webcam + big screen | `http://127.0.0.1:7420/` |
| **Registration** | iPad / any tablet on the same Wi-Fi | `http://<PC address>:7420/register/` |

## Run it

**Windows:** copy the `windows` folder to the PC and double-click **`CatchTheTarget.bat`**.
- First run only: click **Yes** on the Windows prompt. This adds a firewall rule so the tablet can reach the PC. If "Windows protected your PC" appears: More info → Run anyway.
- The game opens full-screen. The black window shows the **tablet link**, e.g. `http://192.168.1.42:7420/register/`. The idle screen also shows it with a **QR code** (bottom-right).
- The whole game is built into `CatchTheTarget.exe`; nothing else is needed. If neither Chrome nor Edge is installed, Chrome is installed automatically. Close the game with Alt+F4.
- `settings.txt` changes the port, round length, etc. Logs: `%LOCALAPPDATA%\CatchTheTarget\launcher.log`. Rebuild the exe after changing the game with `launcher-src/build.sh` (needs Go).

**Mac:** double-click **`start.command`**. It starts the server, opens Chrome full-screen and prints the tablet link in the Terminal window. Options are read from `settings.txt` in the project folder (same format as the Windows one). If macOS asks whether Python may accept incoming connections, click **Allow** (needed for the tablet).

**Manually:** `python3 server.py`, then open `http://127.0.0.1:7420` in Chrome.

**On the tablet:** open the link in Safari/Chrome. Use Share → **Add to Home Screen** so it runs full-screen like an app; turn on Guided Access to lock it to the registration page.

Everything runs offline on the local network. The MediaPipe runtime, pose models and fonts (Inter + Noto Sans Arabic) are all in `vendor/`.

## Ports and other apps on the same network
The game uses **one port: 7420** (TCP), on the game PC only. Ports only clash when two programs on the **same computer** use the same number. Another app using 3000 / 5173 (on this PC or any other) is not affected, and its tablet won't interfere: each tablet talks to its own PC's address. If 7420 is ever taken, set `port=7421` in `settings.txt` (Windows) or edit `PORT` in `start.command` (Mac).

## Flow
1. **Idle — "What to catch".** The 30 + 30 item guide with "Register on the tablet to play", plus the tablet link and QR code.
2. **Tablet registration** (from the Figma "iPad registration" screens, English + Arabic): Welcome → One player / Two players → name (+ optional email) for Player 1 → Player 2 → Thank you. The thank-you screen shows the queue position ("You're next!", "2 groups ahead of you"). Groups queue up while others play.
3. **Join.** The game calls in the next group **by name**. Two players: left = first name registered, right = second. One player: stand anywhere. Each raises a hand to start. If they don't show up within 60 s (`noshow=`), the game starts with whoever is ready, or moves to the next group.
4. **Countdown → Gameplay (60 s).** Names on the scoreboard and under each basket. +1 per SCAD item, −1 for an unrelated item, golden bonus star +3, +1 for every 5 in a row. Speed ramps up, with a "Final 10 seconds" rush.
5. **Results.** "<Name> wins!" (or a tie / solo score). Body tracking is off. Scores are sent back to the tablet's queue view and saved. After 15 s it returns to idle and calls the next group.

Names work in English and Arabic (typed on the tablet with the normal keyboard). They display correctly right-to-left, including mixed text like "سارة wins!".

**Data saved on the game PC** (next to the .exe on Windows, next to `server.py` on Mac). Both files open directly in Excel with Arabic names intact:
- **`players.csv`**: everyone who registers on the tablet, one row per player: **name, email, timestamp**.
- **`game-log.csv`**: the full history: registrations, scores (score, correct, wrong, win/lose/tie), no-shows and removals.

**Tablet queue view:** tap the status chip (top-right) to see who is at the screen, who is waiting (with **Remove**), and recent results.

**Operator keys on the game PC:** `Esc` skip the current group · `Enter` skip a screen (on idle: start a test game without the tablet; `Shift+Enter` = one player) · `C` camera view · `Shift+D` debug · `K` keyboard mode · `M` mute · `F` full screen.

## Player IDs that don't switch
MediaPipe reports poses in random order each frame. `js/idtracker.js` turns them into two stable players:
- **Motion prediction.** Each player's torso position is predicted from their velocity.
- **Body size.** Shoulder width (distance from the camera) must stay consistent.
- **Appearance.** A colour signature of each player's clothing is learned during play.
- **Global matching.** Every frame, the detection-to-player pairing with the lowest total cost wins.
- **Newcomers never take over.** From the countdown until the results, the players are locked in. Someone who walks into the frame (between the players, next to them, or across the whole screen in single-player mode) is ignored and never gets a basket. If a player briefly steps out, their basket waits for them. The only case that can be fooled: a player steps out *and* someone of the same build in very similar clothes steps into that exact spot before they return. On the join screen, an empty side can be filled by whoever stands there. The camera looks at up to 3 people at once (`poses=`); raise it to 4 in very busy areas.
- **Locked identities during a round.** A player who steps out keeps their slot (their basket dims with "Step back into view") and is re-acquired only by someone who matches their size and clothing. Passers-by are ignored.
- **Lanes.** Each basket stays in its own half, so players never fight over a basket.

## Who counts as a player
`js/presence.js` filters people before they can take a slot:
- **Distance limits.** Each person's distance is estimated from their shoulder width and torso length. Only people between **1 m and 4.5 m** from the camera count. On the join screen, anyone outside that range is told "Step back a little" or "Come a bit closer". Change the limits with `mindist=` and `maxdist=` (metres) in `settings.txt` (Windows: `windows/settings.txt`, Mac: `settings.txt`). If distances look wrong for your webcam, set its field of view with `fov=` (default 78°). Press `Shift+D` to see each person's estimated distance.
- **Photos, posters and screens.** A body has to *move* (walk in, raise a hand, shift their weight about 5 cm) before it can play. Pictures of people never do, so they're ignored. Spots where a still body keeps being seen are remembered, and need even more movement there. Raise or lower the sensitivity with `motion=` (default 0.12). Turn the check off with `liveness=0`.
- **Reflections (mirrors, glass doors, shiny walls).** A mirror behind the players shows their *back*, so players must face the camera (face visible) to join. Glass or a mirror at the side can show a mirrored *front* view. That copy moves in perfect sync with a nearer, bigger person, so any smaller body whose movement keeps matching someone else's is ignored as a reflection. A real second player standing further back is accepted once they move on their own (about 2–3 s). Turn these off with `facing=0` / `reflections=0`.
- In the camera view (`C`), ignored bodies are grey and tagged **FAR**, **NEAR**, **STILL**, **BACK** or **MIRROR**. `Shift+D` shows each person's estimated distance.

## Setup tips
- Put the camera centred at about chest height (1.2–1.4 m). Players stand **2.5–4 m** away, about 1.5 m apart.
- Avoid large mirrors or glass right behind or beside the play area; the game filters reflections, but covering them is still the safest setup.
- Use a 1080p webcam and even, front-facing light. Avoid strong backlight such as windows behind the players.
- Tune each player's reach with URL params if needed: `?p1min=0.08&p1max=0.46&p2min=0.54&p2max=0.92`.

## Keys (all)
| Key | Action |
|---|---|
| `K` | Keyboard test mode (P1: A/D + W to raise hand · P2: ←/→ + ↑ · `1`/`2` make a player leave/return) |
| `Enter` | Skip to next screen (idle: test game without the tablet, `Shift+Enter` = one player) |
| `Esc` | Skip the current group, back to idle |
| `C` | Toggle camera preview |
| `Shift+D` | Debug overlay (fps, tracker state) |
| `M` | Mute |
| `F` | Full screen |

## URL options
`?round=60` round length · `?noshow=60` wait for registered players (s) · `?model=lite` faster model for weaker machines · `?camera=logitech` choose camera by name · `?debug=1` · `?keyboard` skip the camera · `?hold=700` hand-raise hold (ms) · `?mirror=0` · `?mindist=1.0` / `?maxdist=4.5` min / max player distance (m) · `?fov=78` webcam field of view · `?motion=0.12` movement needed to count as a real person · `?liveness=0` allow still bodies · `?facing=0` allow back views · `?reflections=0` turn off reflection detection

## Files
```
index.html, css/style.css
js/main.js        flow / screens / HUD / names
js/link.js        talks to the server (registered players in, progress + results out)
register/         tablet registration app (index.html, style.css, app.js, Figma assets)
server.py         Mac/any-OS server: game + tablet + player queue API + players.csv / game-log.csv
windows/          CatchTheTarget.bat (start here), CatchTheTarget.exe, settings.txt
js/game.js        falling items, baskets, scoring, effects (canvas)
js/idtracker.js   persistent player IDs
js/presence.js    distance limit, photo/poster and reflection rejection
js/pose.js        camera + MediaPipe Pose Landmarker
js/audio.js       synthesized sounds (no audio files)
js/config.js      all tunables
assets/items/     60 item images from Figma (catch/ and avoid/)
assets/ui/        background video (+ webm fallback, poster), title
assets/figma/     raw exports from the Figma file
vendor/           MediaPipe tasks-vision 0.10.35 + pose models, fonts, QR code generator
launcher-src/     Windows launcher + server (Go): main.go, server.go — same API as server.py
```
