// Persistent player identities on top of a per-frame multi-person pose detector.
//
// MediaPipe returns poses in arbitrary order every frame, so "pose #0" can be a
// different person from one frame to the next. This module turns raw detections
// into two stable slots (Player 1 / Player 2) that never swap:
//
//   • motion: constant-velocity prediction of each player's torso position
//   • body size: shoulder width (distance to camera) must stay consistent
//   • appearance: a colour signature of each player's torso (their clothes)
//   • global assignment: every frame we pick the detection↔player pairing with
//     the lowest total cost (brute force — there are at most 2 players × 3 people)
//
// Two modes:
//   'open'   — attract/join screen. Slot = side of the screen. Anyone stepping in on
//              the left becomes Player 1, on the right Player 2.
//   'locked' — from the moment a round starts. Identities are frozen; a player who
//              walks out of frame keeps their slot and is re-acquired when they come
//              back (by appearance, or by being on their own side). Passers-by are ignored.

export class OneEuro {
  constructor(minCutoff = 1.0, beta = 4.0, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, tMs) {
    if (this.t === null) { this.x = x; this.t = tMs; return x; }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    const dx = (x - this.x) / dt;
    const ad = OneEuro.alpha(this.dCutoff, dt);
    this.dx = ad * dx + (1 - ad) * this.dx;
    const a = OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    this.x = a * x + (1 - a) * this.x;
    this.t = tMs;
    return this.x;
  }
}

export function colorDistance(a, b) {
  if (!a || !b) return 0.15; // unknown → neutral
  // a/b = [r chroma, g chroma, lightness]
  return Math.hypot(a[0] - b[0], a[1] - b[1]) * 3 + Math.abs(a[2] - b[2]) * 0.8;
}

const W_POS = 1.0, W_Y = 0.5, W_SIZE = 0.25, W_COLOR = 0.5;
const GATE_ACTIVE = 0.3;     // max cost to keep following a visible player
const GATE_COASTING = 0.55;  // looser while they've just been lost
const MAX_COLOR = 0.35;      // colour distance beyond which it's a different person

export class IdTracker {
  constructor({ lostGraceMs = 1200 } = {}) {
    this.lostGraceMs = lostGraceMs;
    this.mode = 'open';
    this.activeSlots = [1, 2];
    this.slots = { 1: null, 2: null };
    this.lastT = null;
    this.detections = []; // last frame's detections, each tagged with .slot (or null)
  }

  setMode(mode, activeSlots = [1, 2]) {
    this.mode = mode;
    this.activeSlots = activeSlots;
    if (mode === 'locked') {
      for (const s of [1, 2]) if (!activeSlots.includes(s)) this.slots[s] = null;
    }
  }

  releaseAll() { this.slots = { 1: null, 2: null }; }

  sideOf(x) { return x < 0.5 ? 1 : 2; }

  predict(track, now) {
    const dt = Math.min(0.5, (now - track.lastSeen) / 1000);
    return Math.min(1, Math.max(0, track.x + track.vx * dt * 0.6));
  }

  cost(track, det, now) {
    const lostFor = now - track.lastSeen;
    const coasting = lostFor > 150;
    const px = this.predict(track, now);
    const posW = lostFor > this.lostGraceMs ? 0.3 : W_POS; // long-lost: rely on looks + side
    const sizeRatio = det.sw / Math.max(track.sw, 0.01);
    const cd = colorDistance(det.color, track.color);
    // hard limits: a clearly different body size or clothing colour is never the same person
    if (sizeRatio < 0.6 || sizeRatio > 1.65 || cd > MAX_COLOR) return { c: Infinity, gate: 0 };
    let c = Math.abs(det.x - px) * posW
      + Math.abs(det.y - track.y) * W_Y * (coasting ? 0.5 : 1)
      + Math.abs(sizeRatio - 1) * W_SIZE
      + cd * W_COLOR;
    if (this.mode === 'locked' && this.activeSlots.length > 1 && this.sideOf(det.x) !== track.slot) c += 0.12;
    return { c, gate: coasting ? GATE_COASTING : GATE_ACTIVE };
  }

  newTrack(slot, det, now) {
    return {
      slot, x: det.x, y: det.y, sw: det.sw, vx: 0, color: det.color,
      firstSeen: now, lastSeen: now, present: true, det,
      filter: new OneEuro(), fx: det.x,
      handUpSince: null, wrongSideSince: null,
    };
  }

  // dets: [{x, y, sw, color, handUp, cursor, lm}] — x mirrored & normalised 0..1
  update(dets, now) {
    dets = dets.slice().sort((a, b) => b.sw - a.sw).slice(0, 4);
    for (const d of dets) d.slot = null;

    const tracks = this.activeSlots.map((s) => this.slots[s]).filter(Boolean);

    // ── global assignment (brute force over ≤2 tracks × ≤4 detections) ──
    let best = { total: Infinity, pairs: [] };
    const search = (ti, used, total, pairs) => {
      if (total >= best.total) return;
      if (ti === tracks.length) { best = { total, pairs: pairs.slice() }; return; }
      const t = tracks[ti];
      // option: this track gets no detection this frame (costs as much as its gate)
      const noneCost = now - t.lastSeen > 150 ? GATE_COASTING : GATE_ACTIVE;
      search(ti + 1, used, total + noneCost, pairs);
      dets.forEach((d, di) => {
        if (used.has(di)) return;
        const { c, gate } = this.cost(t, d, now);
        if (c > gate) return;
        used.add(di); pairs.push([t, d]);
        search(ti + 1, used, total + c, pairs);
        pairs.pop(); used.delete(di);
      });
    };
    search(0, new Set(), 0, []);

    for (const [t, d] of best.pairs) this.apply(t, d, now);

    // ── tracks that got nothing: coast, then mark absent ──
    for (const t of tracks) {
      if (t.det && t.det.slot === t.slot && t.lastSeen === now) continue;
      if (now - t.lastSeen > this.lostGraceMs) { t.present = false; t.handUpSince = null; }
      t.vx *= 0.9;
    }

    // ── unclaimed detections: fill empty slots / re-acquire lost players ──
    const free = dets.filter((d) => d.slot === null);
    for (const d of free) {
      if (this.mode === 'open') {
        const s = this.sideOf(d.x);
        if (!this.activeSlots.includes(s)) continue;
        const t = this.slots[s];
        if (!t || (!t.present && now - t.lastSeen > 400)) {
          this.slots[s] = this.newTrack(s, d, now);
          d.slot = s;
        }
      } else {
        // locked: only re-acquire a lost player; never hand a slot to a stranger
        let pick = null, pickScore = Infinity;
        for (const s of this.activeSlots) {
          const t = this.slots[s];
          if (t && t.present) continue;
          const cd = t ? colorDistance(d.color, t.color) : 0.2;
          const sizeRatio = t ? d.sw / Math.max(t.sw, 0.01) : 1;
          const sizeOk = sizeRatio > 0.6 && sizeRatio < 1.65;
          const onSide = this.activeSlots.length === 1 || this.sideOf(d.x) === s;
          // must look like the same person; being on their own side relaxes the colour check
          const ok = sizeOk && (cd < 0.12 || (onSide && cd < MAX_COLOR));
          const score = cd + (onSide ? 0 : 0.2);
          if (ok && score < pickScore) { pick = s; pickScore = score; }
        }
        if (pick) {
          const old = this.slots[pick];
          if (old) { old.filter.reset(); this.apply(old, d, now, true); }
          else { this.slots[pick] = this.newTrack(pick, d, now); d.slot = pick; }
        }
      }
    }

    // ── open mode: someone who crosses to the other side for a while hands over their slot ──
    if (this.mode === 'open') {
      for (const s of [1, 2]) {
        const t = this.slots[s];
        if (!t || !t.present) continue;
        if (this.sideOf(t.x) !== s) {
          t.wrongSideSince ??= now;
          if (now - t.wrongSideSince > 800) this.slots[s] = null;
        } else t.wrongSideSince = null;
      }
    }

    this.detections = dets;
    this.lastT = now;
  }

  apply(t, d, now, reacquired = false) {
    const dt = Math.max(1e-3, (now - t.lastSeen) / 1000);
    if (!reacquired && dt < 0.5) t.vx = t.vx * 0.6 + ((d.x - t.x) / dt) * 0.4;
    else t.vx = 0;
    t.x = d.x; t.y = d.y;
    t.sw = t.sw * 0.8 + d.sw * 0.2;
    // update appearance slowly, and only when the match is unambiguous
    if (d.color) t.color = t.color ? t.color.map((v, i) => v * 0.95 + d.color[i] * 0.05) : d.color;
    t.lastSeen = now; t.present = true; t.det = d; d.slot = t.slot;
    t.fx = t.filter.filter(d.x, now);
    if (d.handUp) t.handUpSince ??= now; else t.handUpSince = null;
  }

  get(slot) { return this.slots[slot]; }
}
