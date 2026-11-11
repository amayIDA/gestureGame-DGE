// Decides which detected bodies are real, nearby players before they reach the ID tracker.
//
//  • Distance: only people between MIN_DISTANCE_M and MAX_DISTANCE_M from the camera count.
//              Someone already accepted gets 15% extra leeway at both limits so they don't
//              flicker on and off at the boundary.
//  • Static:   photos, posters, statues and people on a TV are still detected by the pose model,
//              but their skeleton never really moves. Every body has to "prove it's alive"
//              by moving a little (walking in, raising a hand, swaying) before it can play.
//              Once proven, it stays alive as long as it is continuously seen.
//              Spots where a still body has sat for a while are remembered as "static zones",
//              and anything appearing there must move even more to count.
//  • Back view: a mirror / glass behind the players shows their back. Players face the camera,
//              so a body must show its face (and front-facing shoulders) to be able to join.
//  • Reflection: a reflection moves in perfect sync with a real, nearer (bigger) person.
//              If a smaller body's movement matches a bigger body's movement almost exactly
//              (allowing for left/right mirroring) for a moment, it is flagged as a reflection
//              and ignored. If it later clearly moves on its own, the flag is lifted.

const KEYPOINTS = [0, 11, 12, 13, 14, 15, 16]; // nose, shoulders, elbows, wrists
const WINDOW_MS = 3000;
const BIN_MS = 500;              // average landmarks in 0.5 s bins to cancel model jitter
const MIN_HISTORY_MS = 900;      // need this much history before judging
const STATIC_AFTER_MS = 3000;    // still this long → remember as a static zone
const ZONE_TTL_MS = 60000;
const CANDIDATE_GRACE_MS = 600;  // survive brief detection drop-outs
const SYNC_WINDOW_MS = 2400;     // movement compared over this long for the reflection check
const SYNC_LAG = 5;              // velocity = change over 5 frames (~0.17 s)
const SYNC_MIN_CORR = 0.88;      // how closely movement must match to be a reflection
const SYNC_MAX_SIZE = 0.88;      // a reflection looks smaller than the person (further away)

export class PresenceFilter {
  constructor({ minDistance = 0, maxDistance = 4.5, liveness = true, liveMotion = 0.06, facing = true, reflections = true } = {}) {
    Object.assign(this, { minDistance, maxDistance, liveness, liveMotion, facing, reflections });
    this.cands = [];
    this.zones = [];
    this.rejected = []; // last frame's rejected detections (for preview / UI hints)
    this.nextId = 1;
  }

  reset() { this.cands = []; this.rejected = []; }

  // dets: [{x, y, sw, dist, lm}] → returns the detections allowed to play
  filter(dets, now) {
    // ── match detections to candidates from previous frames (greedy, nearest first) ──
    const pairs = [];
    dets.forEach((d, di) => this.cands.forEach((c, ci) => {
      const ratio = d.sw / c.sw;
      const dd = Math.hypot(d.x - c.x, d.y - c.y);
      if (ratio > 0.6 && ratio < 1.6 && dd < 0.12 + 0.2 * Math.min(1, (now - c.lastSeen) / 1000)) pairs.push([dd, di, ci]);
    }));
    pairs.sort((a, b) => a[0] - b[0]);
    const usedD = new Set(), usedC = new Set();
    for (const [, di, ci] of pairs) {
      if (usedD.has(di) || usedC.has(ci)) continue;
      usedD.add(di); usedC.add(ci);
      this.observe(this.cands[ci], dets[di], now);
    }
    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      const c = { id: this.nextId++, x: d.x, y: d.y, sw: d.sw, hist: [], live: false, firstSeen: now, lastSeen: now, wasNear: false };
      this.cands.push(c);
      this.observe(c, d, now);
    });
    this.cands = this.cands.filter((c) => now - c.lastSeen < CANDIDATE_GRACE_MS);
    this.zones = this.zones.filter((z) => now - z.lastSeen < ZONE_TTL_MS);
    if (this.reflections) this.checkReflections(now);

    // ── decide ──
    const kept = [], rejected = [];
    for (const d of dets) {
      const c = d._cand;
      const limit = this.maxDistance * (c.wasNear ? 1.15 : 1);
      const minLimit = this.minDistance * (c.wasNear ? 0.85 : 1);
      if (d.dist != null && d.dist > limit) { d.reject = 'far'; rejected.push(d); continue; }
      if (d.dist != null && d.dist < minLimit) { d.reject = 'near'; rejected.push(d); continue; }
      c.wasNear = true;
      if (c.reflection) { d.reject = 'mirror'; rejected.push(d); continue; }
      if (this.liveness && !c.live) { d.reject = this.facing && c.facing < 0.6 ? 'back' : 'still'; rejected.push(d); continue; }
      d.reject = null; kept.push(d);
    }
    this.rejected = rejected;
    return kept;
  }

  observe(c, d, now) {
    d._cand = c;
    c.x = d.x; c.y = d.y; c.sw = c.sw * 0.8 + d.sw * 0.2; c.lastSeen = now;
    if (!d.lm) { c.live = true; c.facing = 1; return; } // keyboard/simulated players
    // facing-the-camera score (smoothed): front view = face visible + shoulders the right way round
    c.facing = (c.facing ?? (d.facing === false ? 0 : 1)) * 0.85 + (d.facing === false ? 0 : 1) * 0.15;
    // movement series for the reflection check (raw image coords)
    const L = d.lm;
    c.series ??= [];
    c.series.push({ t: now, f: [(L[11].x + L[12].x) / 2, (L[11].y + L[12].y) / 2, L[15].x, L[15].y, L[16].x, L[16].y] });
    while (c.series.length && now - c.series[0].t > SYNC_WINDOW_MS) c.series.shift();
    c.hist.push({ t: now, pts: KEYPOINTS.map((i) => ((d.lm[i].visibility ?? 1) > 0.6 ? [d.lm[i].x, d.lm[i].y] : null)) });
    while (c.hist.length && now - c.hist[0].t > WINDOW_MS) c.hist.shift();
    if (c.live) return;

    const span = now - c.hist[0].t;
    if (span < MIN_HISTORY_MS) return;
    const motion = this.motion(c);
    const zone = this.zones.find((z) => Math.hypot(z.x - c.x, z.y - c.y) < 0.06 && Math.abs(z.sw - c.sw) / z.sw < 0.3);
    const need = this.liveMotion * (zone ? 2 : 1);
    c.motion = motion;
    // back views (e.g. a mirror behind the players) never qualify
    c.hits = motion >= need && (!this.facing || c.facing >= 0.6) ? (c.hits || 0) + 1 : 0;
    // sustained for ~0.2 s (not a one-frame spike), seen long enough for the reflection check
    // to have had a look, and not moving in sync with someone else
    // a smaller body next to a bigger one must first show ~1 s of independent movement
    const bigger = this.cands.some((o) => o !== c && !o.reflection && now - o.lastSeen < 200 && c.sw <= o.sw * SYNC_MAX_SIZE);
    const syncClear = this.reflections && bigger ? (c.syncFrames >= 30 && c.sync < 0.4) : true;
    if (c.hits >= 6 && now - c.firstSeen >= 1300 && syncClear) { c.live = true; return; }
    if (now - c.firstSeen > STATIC_AFTER_MS && motion < this.liveMotion * 0.5) {
      if (zone) zone.lastSeen = now;
      else this.zones.push({ x: c.x, y: c.y, sw: c.sw, lastSeen: now });
    }
  }

  // Flag smaller bodies whose movement is a near-perfect copy of a bigger body's movement.
  checkReflections(now) {
    const seen = this.cands.filter((c) => c.lastSeen === now && c.series && c.series.length > 24);
    for (const b of seen) {
      let best = null;
      for (const a of seen) {
        if (a === b || a.reflection || b.sw > a.sw * SYNC_MAX_SIZE) continue;
        const sc = syncScore(a, b);
        if (sc != null) best = Math.max(best ?? 0, sc);
      }
      if (best == null) continue; // nobody bigger moving to compare with
      b.syncFrames = (b.syncFrames || 0) + 1;
      b.sync = (b.sync ?? best) * 0.9 + best * 0.1; // smoothed over ~0.3 s
      // flag when movement keeps matching; release only if it later clearly moves on its own
      // (a real player who happened to move in step with the other one for a moment)
      if (b.sync >= SYNC_MIN_CORR) b.reflection = true;
      else if (b.reflection && b.sync <= 0.2) { b.reflection = false; b.syncFrames = 0; }
    }
  }

  // Movement over the last few seconds, in shoulder widths.
  // For every keypoint we compare how far its 0.5 s averages travel (real movement) with how
  // much it jitters inside each bin (detector noise). A keypoint only counts as moving when
  // the travel is clearly bigger than the noise. We use the 2nd-most-moving keypoint so a
  // single jittery joint can never fake life on its own (raising a hand moves wrist + elbow).
  motion(c) {
    const t0 = c.hist[0].t;
    const K = KEYPOINTS.length;
    const bins = new Map();
    for (const h of c.hist) {
      const k = Math.floor((h.t - t0) / BIN_MS);
      if (!bins.has(k)) bins.set(k, KEYPOINTS.map(() => []));
      h.pts.forEach((p, i) => { if (p) bins.get(k)[i].push(p); });
    }
    const scores = [];
    for (let i = 0; i < K; i++) {
      let best = 0;
      for (const a of [0, 1]) {
        const means = [], ns = [];
        let ss = 0, N = 0;
        for (const b of bins.values()) {
          const v = b[i].map((p) => p[a]);
          if (v.length < 2) continue;
          const m = v.reduce((s, x) => s + x, 0) / v.length;
          for (const x of v) ss += (x - m) ** 2;
          means.push(m); ns.push(v.length); N += v.length;
        }
        if (means.length < 2) continue;
        const range = Math.max(...means) - Math.min(...means);
        const mm = means.reduce((s, x) => s + x, 0) / means.length;
        const spread = Math.sqrt(means.reduce((s, x) => s + (x - mm) ** 2, 0) / (means.length - 1));
        const noise = Math.sqrt(ss / Math.max(1, N - means.length)) / Math.sqrt(N / means.length);
        // must clearly stand out from this joint's own jitter (pure noise almost never reaches 6×)
        if (spread > 4 * noise + 1e-4 && range > 6 * noise) best = Math.max(best, range / Math.max(c.sw, 0.02));
      }
      scores.push(best);
    }
    scores.sort((x, y) => y - x);
    return scores[1] ?? 0;
  }
}

// How closely b's movement copies a's (0..1). Compares ~0.1 s velocities on matching frames:
// body centre x/y and both wrists. Sign is ignored (mirrors can flip direction) and the two
// wrists may be swapped (mirrors swap left and right). Channels where either body barely
// moves are skipped; one body moving while the other is still counts as independence.
function syncScore(a, b) {
  const bt = new Map(b.series.map((s, i) => [s.t, i]));
  const pairs = [];
  for (let i = SYNC_LAG; i < a.series.length; i++) {
    const j = bt.get(a.series[i].t), j0 = bt.get(a.series[i - SYNC_LAG].t);
    if (j == null || j0 == null) continue;
    const va = a.series[i].f.map((v, k) => v - a.series[i - SYNC_LAG].f[k]);
    const vb = b.series[j].f.map((v, k) => v - b.series[j0].f[k]);
    pairs.push([va, vb]);
  }
  if (pairs.length < 15) return null;
  const corr = (ka, kb) => {
    const xs = pairs.map((p) => p[0][ka]), ys = pairs.map((p) => p[1][kb]);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    const n = xs.length;
    // how much this channel really moves, in shoulder widths (jitter alone stays small)
    const wa = Math.sqrt(sxx / n) / a.sw, wb = Math.sqrt(syy / n) / b.sw;
    const MOVING = 0.12; // below this it's mostly detector jitter, which proves nothing
    if (wa < MOVING && wb < MOVING) return null;
    // one moves clearly while the other stays still → can't be a reflection (strong evidence)
    if (wa < MOVING * 0.5 || wb < MOVING * 0.5) return { c: 0, w: Math.max(wa, wb) };
    if (wa < MOVING || wb < MOVING) return null; // borderline, skip
    return { c: Math.abs(sxy / Math.sqrt(sxx * syy)), w: Math.min(wa, wb) };
  };
  // movement-weighted average: joints that really move dominate, jittery still joints barely count
  const avg = (list) => {
    const v = list.filter((x) => x != null);
    if (!v.length) return null;
    const W = v.reduce((s, x) => s + x.w, 0);
    return v.reduce((s, x) => s + x.c * x.w, 0) / W;
  };
  // A reflection copies vertical movement too (hand raises, bobbing) at exactly the same moment.
  // Sideways drifting alone can line up by chance between two real players, so vertical
  // evidence is required before anyone can be called a reflection.
  const score = (map) => {
    const all = map.map(([x, y]) => corr(x, y));
    const vertical = [all[1], all[3], all[5]].filter((v) => v && v.c > 0.9);
    const total = avg(all);
    return total == null ? null : vertical.length ? total : Math.min(total, 0.5);
  };
  const straight = score([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
  const swapped = score([[0, 0], [1, 1], [2, 4], [3, 5], [4, 2], [5, 3]]);
  if (straight == null && swapped == null) return null;
  return Math.max(straight ?? 0, swapped ?? 0);
}
