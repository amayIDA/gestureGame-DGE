// Catch the Target — tunable settings.
// Every value can be overridden from the URL, e.g. index.html?round=45&model=lite&solo=0&debug=1

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) ? Number(params.get(k)) : d);
const bool = (k, d) => (params.has(k) ? params.get(k) !== '0' && params.get(k) !== 'false' : d);

export const CONFIG = {
  // Flow timings
  ROUND_SECONDS: num('round', 60),          // 60-second rounds
  COUNTDOWN_FROM: 3,
  RESULTS_IDLE_SECONDS: num('idle', 15),    // results shown (tracking off), then back to the idle screen
  HAND_RAISE_HOLD_MS: num('hold', 700),     // raise-hand hold to join
  FINAL_SECONDS: 10,
  // Registered players who don't come to the screen: after this long the game moves on
  // (starts with whoever is ready, or calls the next group if nobody is)
  NO_SHOW_SECONDS: num('noshow', 60),

  // Body tracking
  MODEL: params.get('model') || 'full',     // 'full' (accurate) or 'lite' (faster machines)
  NUM_POSES: num('poses', 3),               // detect up to 3 so a passer-by can't steal a slot
  CAMERA_WIDTH: 1280,
  CAMERA_HEIGHT: 720,
  CAMERA_LABEL: params.get('camera') || '', // pick a camera whose label contains this text
  MIRROR: bool('mirror', true),

  // Where each player can stand (normalised camera width, already mirrored)
  // Their full left→right range maps to their whole lane, so small steps reach the edges.
  RANGE_P1: [num('p1min', 0.06), num('p1max', 0.48)],
  RANGE_P2: [num('p2min', 0.52), num('p2max', 0.94)],
  RANGE_SOLO: [0.15, 0.85],

  // Who counts as a player
  MAX_DISTANCE_M: num('maxdist', 4.5),     // people further than this (metres) are ignored
  CAMERA_HFOV: num('fov', 78),             // webcam horizontal field of view (most 1080p webcams: 70–90°)
  LIVENESS: bool('liveness', true),        // ignore bodies that never move (photos, posters, TV screens)
  FACING: bool('facing', true),            // players must face the camera to join (rejects mirror back-views)
  REFLECTIONS: bool('reflections', true),  // ignore bodies that copy another person's movement (mirrors, glass)
  LIVE_MOTION: num('motion', 0.12),        // movement that proves someone is real (× shoulder width ≈ 5 cm)

  LOST_GRACE_MS: 1200,      // keep a basket alive while tracking blips
  ABANDON_MS: 10000,        // everyone gone this long mid-game → back to attract

  // Gameplay feel
  CATCH_RATIO: 0.62,        // share of SCAD items vs unrelated items
  BONUS_EVERY_S: 9,         // golden SCAD bonus (+3)
  STREAK_BONUS_EVERY: 5,    // every 5 in a row → +1
  SPEED_START: 320,         // px/s on a 1080p stage
  SPEED_END: 560,
  SPAWN_START: 0.95,         // seconds between waves
  SPAWN_END: 0.5,

  DEBUG: bool('debug', false),
  KIOSK: bool('kiosk', false),
};
