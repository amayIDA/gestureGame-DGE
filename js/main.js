// Catch the Target — flow controller.
//
//   Idle ("What to catch", waiting for the tablet)
//     → players registered on the tablet → Join (their names; raise a hand)
//     → Countdown → Gameplay (60 s) → Results (tracking off) → Idle → next group
//
// Single player: one basket across the whole screen. Two players: left / right halves.
import { CONFIG } from './config.js';
import { CATCH_ITEMS, AVOID_ITEMS, ALL_ITEMS, UI } from './items.js';
import { Game, PLAYER, STAGE_W, STAGE_H } from './game.js';
import { IdTracker } from './idtracker.js';
import { PresenceFilter } from './presence.js';
import { Sfx } from './audio.js';
import { Link } from './link.js';
import qrcode from '../vendor/qrcode/qrcode.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let scale = 1;
let game, pose = null, SKELETON = [];
const sfx = new Sfx();
const tracker = new IdTracker({ lostGraceMs: CONFIG.LOST_GRACE_MS });
// Ignores people who are too far away and bodies that never move (photos / posters / screens)
const presence = new PresenceFilter({ minDistance: CONFIG.MIN_DISTANCE_M, maxDistance: CONFIG.MAX_DISTANCE_M, liveness: CONFIG.LIVENESS, liveMotion: CONFIG.LIVE_MOTION, facing: CONFIG.FACING, reflections: CONFIG.REFLECTIONS });
const images = {};
const link = new Link();

// ─────────────────────────── stage scaling ───────────────────────────
function fit() {
  // fixed 1536×762 aspect; fills a 1536×762 screen exactly, letterboxes on others
  scale = Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H);
  stage.style.transform = `translate(${(innerWidth - STAGE_W * scale) / 2}px, ${(innerHeight - STAGE_H * scale) / 2}px) scale(${scale})`;
}
addEventListener('resize', fit);

// ─────────────────────────── keyboard / test mode ───────────────────────────
// K toggles. P1: A/D move, W raise hand, 1 enter/leave. P2: ←/→, ↑, 2.
const sim = {
  on: false, keys: new Set(),
  p: { 1: { x: 0.27, present: true, color: [0.5, 0.25, 0.45] }, 2: { x: 0.73, present: true, color: [0.22, 0.3, 0.5] } },
};
function simDets(dt) {
  const k = sim.keys, sp = 0.55 * dt;
  if (k.has('a')) sim.p[1].x -= sp; if (k.has('d')) sim.p[1].x += sp;
  if (k.has('arrowleft')) sim.p[2].x -= sp; if (k.has('arrowright')) sim.p[2].x += sp;
  sim.p[1].x = clamp(sim.p[1].x, 0.02, activeSlots.length === 1 ? 0.98 : 0.49); sim.p[2].x = clamp(sim.p[2].x, 0.51, 0.98);
  const out = [];
  for (const s of [1, 2]) {
    const p = sim.p[s]; if (!p.present) continue;
    const up = s === 1 ? k.has('w') : k.has('arrowup');
    out.push({ x: p.x, y: 0.5, sw: 0.15, color: p.color, handUp: up, cursor: { x: p.x, y: up ? 0.3 : 0.6, valid: true }, lm: null });
  }
  return out;
}

addEventListener('keydown', (e) => {
  sfx.ensure();
  const key = e.key.toLowerCase();
  sim.keys.add(key);
  if (key === 'k') { sim.on = !sim.on; tracker.releaseAll(); toast(sim.on ? 'Keyboard mode — P1: A/D + W   ·   P2: ←/→ + ↑' : 'Camera mode'); }
  if (key === '1' && sim.on) sim.p[1].present = !sim.p[1].present;
  if (key === '2' && sim.on) sim.p[2].present = !sim.p[2].present;
  if (key === 'd' && e.shiftKey || key === '`') $('debug').classList.toggle('hidden');
  if (key === 'c') $('pipWrap').classList.toggle('hidden', !$('pipWrap').classList.contains('hidden'));
  if (key === 'm') { sfx.muted = !sfx.muted; toast(sfx.muted ? 'Sound off' : 'Sound on'); }
  if (key === 'f') document.documentElement.requestFullscreen?.();
  if (key === 'enter') flow.skip?.(e.shiftKey);
  if (key === 'escape') abortSession();
});
addEventListener('keyup', (e) => sim.keys.delete(e.key.toLowerCase()));
addEventListener('pointerdown', () => sfx.ensure());
addEventListener('blur', () => sim.keys.clear());

let toastT;
function toast(msg, ms = 2600) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), ms);
}
function banner(text, red = false) {
  const el = $('banner'); el.textContent = text; el.className = '';
  void el.offsetWidth; el.className = 'show' + (red ? ' red' : '');
}

// ─────────────────────────── players & names ───────────────────────────
let activeSlots = [1, 2];
let session = null;            // { id, mode, players:[{name}] } — id is null for keyboard test games
const nameOf = (slot) => session?.players?.[slot - 1]?.name || `Player ${slot}`;

function applyNames() {
  for (const el of document.querySelectorAll('.pname')) el.querySelector('bdi').textContent = nameOf(+el.dataset.name);
  game.setNames({ 1: nameOf(1), 2: nameOf(2) });
}

function info(slot, now) {
  const t = tracker.get(slot);
  if (!t) return { present: false, held: 0 };
  const range = activeSlots.length === 1 ? CONFIG.RANGE_SOLO : slot === 1 ? CONFIG.RANGE_P1 : CONFIG.RANGE_P2;
  const x01 = (t.fx - range[0]) / (range[1] - range[0]);
  // hand-raise timer only counts while the person is actually being seen right now
  const held = t.present && t.handUpSince != null && now - t.lastSeen < 250 ? now - t.handUpSince : 0;
  return { present: t.present, x01, held, lastSeen: t.lastSeen };
}

// ─────────────────────────── screens ───────────────────────────
const screens = ['scr-attract', 'scr-guide', 'scr-countdown', 'scr-results'];
function show(id, { hud = false, field = false } = {}) {
  for (const s of screens) $(s).classList.toggle('hidden', s !== id);
  $('hud').classList.toggle('hidden', !hud);
  $('playfield').classList.toggle('hidden', !field);
  for (const s of [1, 2]) document.querySelector(`.hud-player[data-slot="${s}"]`).style.visibility = activeSlots.includes(s) ? 'visible' : 'hidden';
}

let flow = { name: 'boot' };
function go(name, arg) {
  flow.exit?.();
  flow = FLOWS[name](arg);
  flow.name = name;
  flow.since = performance.now();
}

function report(status, extra) { if (session?.id) link.status(session.id, status, extra); }

// Esc: operator abandons the current group and returns to the idle screen
function abortSession() {
  if (session?.id) report(['countdown', 'play', 'results'].includes(flow.name) ? 'done' : 'noshow');
  session = null;
  go('idle');
}

const FLOWS = {
  // ── Idle: "What to catch" + register on the tablet ──
  idle() {
    session = null;
    activeSlots = [1, 2];
    tracker.releaseAll();
    presence.reset();
    show('scr-guide');
    $('cursors').innerHTML = '';
    document.querySelectorAll('.tile').forEach((t) => { t.style.animation = 'none'; void t.offsetWidth; t.style.animation = ''; });
    let asking = false, lastAsk = 0;
    const cta = $('registerCta');
    const setCta = () => {
      const off = !link.available;
      cta.classList.toggle('offline', off || !link.online);
      if (off) cta.replaceChildren(Object.assign(document.createElement('span'), { textContent: 'Press Enter to start a test game (Shift+Enter: one player)' }));
    };
    setCta();
    return {
      update(dt, now) {
        if (now - lastAsk > 1000) setCta();
        // someone registered on the tablet → call them in
        if (link.pending && !asking && now - lastAsk > 700) {
          asking = true; lastAsk = now;
          link.next().then((s) => {
            asking = false;
            if (s && flow.name === 'idle') startSession(s);
          });
        }
      },
      // Enter: test game without the tablet (Shift+Enter = one player)
      skip(shift) {
        startSession({ id: null, mode: shift ? 'single' : 'multi', players: shift ? [{ name: 'Player 1' }] : [{ name: 'Player 1' }, { name: 'Player 2' }] });
      },
      trackingOff: true,
    };
  },

  // ── Join: the registered players step in and raise a hand ──
  attract() {
    const solo = session.mode === 'single';
    activeSlots = solo ? [1] : [1, 2];
    tracker.setMode('open', activeSlots);
    tracker.releaseAll();
    applyNames();
    show('scr-attract');
    $('slots').classList.toggle('single', solo);
    $('joinLead').textContent = solo ? 'Step in front of the screen and raise one hand to start.' : 'Stand side by side and raise one hand to join.';
    if (pose) $('pipWrap').classList.remove('hidden');
    game.reset(activeSlots);
    sfx.whoosh();
    report('waiting');
    const ready = { 1: false, 2: false };
    let allSince = null;
    const ui = { 1: { el: $('slot1'), side: solo ? 'front' : 'left' }, 2: { el: $('slot2'), side: 'right' } };
    const setSlot = (s, state, title, sub, prog) => {
      const u = ui[s];
      if (u.state !== state || u.title !== title) {
        u.el.classList.toggle('present', state === 'present');
        u.el.classList.toggle('ready', state === 'ready');
        u.el.querySelector('.slot-title').textContent = title;
        u.el.querySelector('.slot-sub').textContent = sub;
        u.state = state; u.title = title;
      }
      u.el.querySelector('.ring-fg').style.strokeDashoffset = 182.2 * (1 - prog);
    };
    return {
      update(dt, now) {
        // removed from the queue on the tablet → back to idle
        if (session.id && link.online && link.state && link.state.current?.id !== session.id) return go('idle');
        for (const s of activeSlots) {
          const p = info(s, now);
          if (!p.present) {
            ready[s] = false;
            const far = presence.rejected.some((d) => d.reject === 'far' && tracker.sideOf(d.x) === s);
            const near = presence.rejected.some((d) => d.reject === 'near' && tracker.sideOf(d.x) === s);
            if (far) setSlot(s, 'none', 'Come a bit closer', `Stand within ${CONFIG.MAX_DISTANCE_M} m`, 0);
            else if (near) setSlot(s, 'none', 'Step back a little', `Stand at least ${CONFIG.MIN_DISTANCE_M} m away`, 0);
            else setSlot(s, 'none', solo ? 'Step in front of the screen' : `Step in on the ${ui[s].side}`, solo ? 'Stand in the middle' : 'Stand on your side', 0);
            continue;
          }
          if (!ready[s] && p.held >= CONFIG.HAND_RAISE_HOLD_MS) { ready[s] = true; sfx.join(s); }
          if (ready[s]) setSlot(s, 'ready', 'Ready', 'Hand detected', 1);
          else setSlot(s, 'present', 'Raise one hand', 'Hold it up to join', clamp(p.held / CONFIG.HAND_RAISE_HOLD_MS, 0, 1));
        }
        const readySlots = activeSlots.filter((s) => ready[s]);
        const all = readySlots.length === activeSlots.length;
        $('joinCheck').classList.toggle('on', all);
        const note = $('soloNote');
        if (all) {
          note.textContent = "Great — let's play!";
          allSince ??= now;
          if (now - allSince > 900) return go('countdown', activeSlots);
          return;
        }
        allSince = null;
        // registered players who don't show up: move on
        const left = Math.ceil(CONFIG.NO_SHOW_SECONDS - (now - this.since) / 1000);
        if (left <= 0) {
          if (readySlots.length) return go('countdown', readySlots); // play with whoever is ready
          report('noshow');
          session = null;
          return go('idle');
        }
        const waitingFor = activeSlots.filter((s) => !ready[s]).map(nameOf);
        note.textContent = readySlots.length
          ? `Waiting for ${waitingFor.join(' & ')} to raise a hand…`
          : left <= 20 ? `Starting over in ${left} s if nobody joins` : '';
      },
      skip() { go('countdown', activeSlots); },
      exit() { $('pipWrap').classList.add('hidden'); },
    };
  },

  // ── Countdown (baskets already live so players can feel the controls) ──
  countdown(slots) {
    activeSlots = slots;
    tracker.setMode('locked', slots);
    game.reset(slots);
    applyNames();
    show('scr-countdown', { hud: true, field: true });
    updateHud(true);
    setText($('time'), fmtTime(CONFIG.ROUND_SECONDS));
    setClass($('timerCard'), 'final', false);
    report('countdown');
    let shown = null;
    const num = $('countNum'), dots = [...$('countDots').children];
    return {
      update(dt, now) {
        const el = (now - this.since) / 1000;
        const n = CONFIG.COUNTDOWN_FROM - Math.floor(el);
        const label = n > 0 ? String(n) : 'GO!';
        if (label !== shown) {
          shown = label;
          num.textContent = label;
          num.className = 'count tick' + (n > 0 ? '' : ' go');
          dots.forEach((d, i) => d.classList.toggle('on', i < CONFIG.COUNTDOWN_FROM - n + 1));
          n > 0 ? sfx.beep() : sfx.go();
        }
        feedBaskets(now);
        game.update(dt, { spawning: false });
        if (el >= CONFIG.COUNTDOWN_FROM + 0.55) go('play', slots);
      },
      skip() { go('play', slots); },
      draw: true,
    };
  },

  // ── Gameplay ──
  play(slots) {
    show('scr-none', { hud: true, field: true });
    report('playing');
    let finalShown = false, lastSec = null, ending = null, goneSince = null;
    const total = CONFIG.ROUND_SECONDS;
    return {
      update(dt, now) {
        const el = (now - this.since) / 1000;
        const remaining = Math.max(0, total - el);
        feedBaskets(now);
        game.update(dt, { progress: clamp(el / total, 0, 1), spawning: !ending, final: remaining <= CONFIG.FINAL_SECONDS });
        updateHud();
        setText($('time'), fmtTime(Math.ceil(remaining)));
        if (remaining <= CONFIG.FINAL_SECONDS && !ending) {
          setClass($('timerCard'), 'final', true);
          if (!finalShown) { finalShown = true; banner(`FINAL ${CONFIG.FINAL_SECONDS} SECONDS!`, true); }
          const sec = Math.ceil(remaining);
          if (sec !== lastSec) { lastSec = sec; sfx.tick(); }
        }
        if (remaining <= 0 && !ending) { ending = now; banner("TIME'S UP!"); sfx.whoosh(); }
        if (ending && now - ending > 1500) return go('results', slots);
        // everyone walked away mid-game: end the round early and show the scores
        if (abandoned(now)) { goneSince ??= now; if (now - goneSince > CONFIG.ABANDON_MS && !ending) { ending = now; banner("TIME'S UP!"); } } else goneSince = null;
      },
      skip() { go('results', slots); },
      draw: true,
    };
  },

  // ── Results (tracking off), then back to idle for the next group ──
  results(slots) {
    show('scr-results');
    setClass($('timerCard'), 'final', false);
    const sc = game.scores;
    const h1 = $('winnerText');
    const bdi = (t) => Object.assign(document.createElement('bdi'), { textContent: t });
    let winner = null;
    if (slots.length === 1) { winner = slots[0]; h1.replaceChildren(`Great catching, `, bdi(nameOf(winner)), '!'); h1.className = `p${winner}`; }
    else if (sc[1].score === sc[2].score) { h1.replaceChildren("It's a tie!"); h1.className = ''; }
    else { winner = sc[1].score > sc[2].score ? 1 : 2; h1.replaceChildren(bdi(nameOf(winner)), ' wins!'); h1.className = `p${winner}`; }
    const cards = $('resultCards'); cards.replaceChildren();
    for (const s of slots) {
      const r = sc[s], acc = r.correct + r.wrong ? Math.round((r.correct / (r.correct + r.wrong)) * 100) : 0;
      const card = document.createElement('div');
      card.className = `rcard ${winner === s && slots.length > 1 ? 'win' : ''}`;
      card.innerHTML = `${winner === s && slots.length > 1 ? '<div class="crown">WINNER</div>' : ''}
        <div class="row"><div><div class="hud-label pname"><span class="mark p${s}"></span><bdi></bdi></div><div class="hud-sub">CORRECT CATCHES</div></div><div class="big">${r.score}</div></div>
        <div class="stats"><span>Accuracy <b>${acc}%</b></span><span>Best streak <b>${r.best}</b></span><span>Bonus <b>${r.bonus}</b></span></div>`;
      card.querySelector('bdi').textContent = nameOf(s);
      cards.append(card);
    }
    // send the scores back to the server (tablet queue view + game-log.csv), one entry per registered player
    const count = session?.players?.length || slots.length;
    const results = Array.from({ length: count }, (_, i) => {
      const r = sc[i + 1];
      return { name: nameOf(i + 1), score: r?.score ?? 0, correct: r?.correct ?? 0, wrong: r?.wrong ?? 0, best: r?.best ?? 0 };
    });
    report('results', { results, winner: slots.length > 1 && winner ? winner - 1 : null });

    sfx.fanfare();
    const cols = winner ? [PLAYER[winner].color, PLAYER[winner].light, '#FFD15C', '#ffffff'] : ['#2563EB', '#0AA5C7', '#FFD15C', '#ffffff'];
    for (let i = 0; i < 6; i++) setTimeout(() => game.burst(200 + Math.random() * (STAGE_W - 400), STAGE_H, cols, 40, 2.1), i * 180);

    // Tracking is switched off on the results screen: players are released and body
    // detection pauses. It comes back when the next registered group is called in.
    tracker.releaseAll();
    presence.reset();
    const btn = $('playAgain'), fill = btn.querySelector('.fill'), label = btn.querySelector('.label'), hint = $('resultsHint');
    btn.classList.add('timer');
    btn.onclick = () => finish();
    hint.textContent = link.state?.queue?.length ? `Up next: ${link.state.queue[0].players.map((p) => p.name).join(' & ')}` : 'Next players: register on the tablet';
    hint.dir = 'auto';
    const total = CONFIG.RESULTS_IDLE_SECONDS * 1000;
    const finish = () => { report('done'); session = null; go('idle'); };
    return {
      update(dt, now) {
        game.update(dt, { spawning: false });
        const el = now - this.since;
        fill.style.width = `${clamp(el / total, 0, 1) * 100}%`;
        label.textContent = `Next game in ${Math.max(0, Math.ceil((total - el) / 1000))}`;
        if (el >= total) finish();
      },
      skip() { finish(); },
      exit() { btn.onclick = null; btn.classList.remove('timer'); fill.style.width = '0'; },
      draw: true, particlesOnly: true, trackingOff: true,
    };
  },
};

function startSession(s) {
  session = { id: s.id, mode: s.mode === 'single' ? 'single' : 'multi', players: s.players || [] };
  go('attract');
}

function abandoned(now) { return activeSlots.every((s) => !info(s, now).present); }

function feedBaskets(now) {
  for (const s of activeSlots) {
    const p = info(s, now);
    game.setBasket(s, p.present ? p.x01 : null, p.present);
  }
}

// Only touch the page when something actually changed: rewriting text every frame
// makes the browser redo layout + paint 60 times a second.
const hudCache = {}, hudPlayer = {};
const domCache = new Map();
function setText(el, v) { if (domCache.get(el) !== v) { domCache.set(el, v); el.textContent = v; } }
function setClass(el, cls, on) { const k = el.id + '|' + cls; if (domCache.get(k) !== on) { domCache.set(k, on); el.classList.toggle(cls, on); } }
function updateHud(force) {
  if (force) domCache.clear();
  for (const s of [1, 2]) {
    const r = game.scores[s];
    const el = $(`score${s}`), st = $(`streak${s}`);
    if (!r) { setText(el, '0'); setClass(st, 'on', false); continue; }
    const prev = hudCache[s];
    if (force || prev !== r.score) {
      el.textContent = r.score;
      if (!force && prev != null) { el.classList.remove('pop', 'hit'); void el.offsetWidth; el.classList.add(r.score > prev ? 'pop' : 'hit'); }
      hudCache[s] = r.score;
    }
    if (r.streak >= 3) setText(st, `🔥 ${r.streak} streak`);
    setClass(st, 'on', r.streak >= 3);
    setClass(hudPlayer[s] ||= document.querySelector(`.hud-player[data-slot="${s}"]`), 'gone', !!(game.baskets[s] && !game.baskets[s].present));
  }
}
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;

// ─────────────────────────── camera preview + debug ───────────────────────────
const pipCtx = $('pip').getContext('2d');
function drawPip() {
  if ($('pipWrap').classList.contains('hidden')) return;
  const W = 480, H = 270;
  pipCtx.fillStyle = '#0d1f3c'; pipCtx.fillRect(0, 0, W, H);
  if (pose && pose.video.readyState >= 2) {
    pipCtx.save(); pipCtx.globalAlpha = 0.75;
    if (CONFIG.MIRROR) { pipCtx.translate(W, 0); pipCtx.scale(-1, 1); }
    pipCtx.drawImage(pose.video, 0, 0, W, H); pipCtx.restore();
  }
  // side divider
  pipCtx.strokeStyle = 'rgba(255,255,255,.5)'; pipCtx.setLineDash([6, 6]);
  pipCtx.beginPath(); pipCtx.moveTo(W / 2, 0); pipCtx.lineTo(W / 2, H); pipCtx.stroke(); pipCtx.setLineDash([]);
  for (const d of [...presence.rejected, ...tracker.detections]) {
    const col = d.slot ? PLAYER[d.slot].color : d.reject ? 'rgba(160,170,185,0.55)' : '#9aa7bb';
    const X = (p) => (CONFIG.MIRROR ? 1 - p.x : p.x) * W, Y = (p) => p.y * H;
    if (d.lm) {
      pipCtx.strokeStyle = col; pipCtx.lineWidth = 4;
      for (const [a, b] of SKELETON) {
        if ((d.lm[a].visibility ?? 1) < 0.4 || (d.lm[b].visibility ?? 1) < 0.4) continue;
        pipCtx.beginPath(); pipCtx.moveTo(X(d.lm[a]), Y(d.lm[a])); pipCtx.lineTo(X(d.lm[b]), Y(d.lm[b])); pipCtx.stroke();
      }
    } else { pipCtx.fillStyle = col; pipCtx.beginPath(); pipCtx.arc(d.x * W, H * 0.5, 22, 0, 7); pipCtx.fill(); }
    const tag = d.slot ? `P${d.slot}` : ({ far: 'FAR', near: 'NEAR', still: 'STILL', back: 'BACK', mirror: 'MIRROR' })[d.reject] || '—';
    const tw = d.reject ? 66 : 44;
    pipCtx.fillStyle = col; pipCtx.fillRect(d.x * W - tw / 2, Math.max(4, d.y * H - 70), tw, 26);
    pipCtx.fillStyle = '#fff'; pipCtx.font = '800 16px Inter, sans-serif'; pipCtx.textAlign = 'center';
    pipCtx.fillText(tag, d.x * W, Math.max(4, d.y * H - 70) + 19);
  }
}
function drawDebug(now) {
  const el = $('debug'); if (el.classList.contains('hidden')) return;
  const line = (s) => { const t = tracker.get(s); return t ? `P${s} ${t.present ? 'ON ' : 'off'} ${t.det?.dist ? t.det.dist.toFixed(1) + 'm ' : ''}x=${t.fx.toFixed(2)} sw=${t.sw.toFixed(2)} hand=${t.handUpSince ? 'UP' : '--'} seen ${Math.round(now - t.lastSeen)}ms` : `P${s} empty`; };
  el.textContent = `state ${flow.name}  mode ${tracker.mode}  screen ${perf.fps.toFixed(0)}fps (slowest ${perf.worstShown.toFixed(0)}ms)  ${sim.on ? 'KEYBOARD' : `tracking ${pose ? `${pose.fps.toFixed(0)}fps ${pose.detMs.toFixed(0)}ms ${pose.delegate} ${pose.mode}` : 'none'}`}\npeople in view: ${tracker.detections.length}  ignored: ${presence.rejected.map((d) => `${d.reject}${d.dist ? ' ' + d.dist.toFixed(1) + 'm' : ''}`).join(', ') || 'none'}  static zones: ${presence.zones.length}\n${line(1)}\n${line(2)}`;
}

// ─────────────────────────── main loop ───────────────────────────
let last = performance.now();
const perf = { fps: 0, frames: 0, t: performance.now(), worst: 0, worstShown: 0 };
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  perf.worst = Math.max(perf.worst, now - last); last = now;
  if (++perf.frames && now - perf.t >= 1000) { perf.fps = perf.frames * 1000 / (now - perf.t); perf.frames = 0; perf.t = now; perf.worstShown = perf.worst; perf.worst = 0; }
  let dets = null;
  if (!flow.trackingOff) {
    let t = now;
    if (sim.on) dets = simDets(dt);
    else if (pose) {
      try { dets = pose.detect(now); t = pose.detTs || now; } catch (e) { console.error(e); }
      if (dets) dets = presence.filter(dets, t);
    }
    if (dets) tracker.update(dets, t);
  } else { tracker.detections = []; presence.rejected = []; }

  flow.update?.(dt, now);
  if (flow.draw) game.draw({ showItems: !flow.particlesOnly, showBaskets: !flow.particlesOnly });
  else game.clear();
  drawPip(); drawDebug(now);
  requestAnimationFrame(frame);
}

// ─────────────────────────── tablet link + QR on the idle screen ───────────────────────────
function showTabletLink() {
  const url = link.info?.tabletUrls?.[0];
  if (!url) return;
  const qr = qrcode(0, 'M');
  qr.addData(url); qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  $('tabletUrl').textContent = url.replace(/^http:\/\//, '').replace(/\/$/, '');
  $('tabletLink').classList.remove('hidden');
}

// ─────────────────────────── boot ───────────────────────────
const loadImg = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => { console.warn('missing', src); res(null); }; i.src = src; });

function buildGuide() {
  const tile = (it, i) => `<div class="tile" style="animation-delay:${(i % 30) * 22}ms"><img src="${it.src}" alt=""><span>${it.label}</span></div>`;
  $('gridCatch').innerHTML = CATCH_ITEMS.map(tile).join('');
  $('gridAvoid').innerHTML = AVOID_ITEMS.map(tile).join('');
}

async function boot() {
  fit();
  if (CONFIG.KIOSK) document.body.classList.add('kiosk');
  const bg = $('bgVideo');
  bg.play?.().catch(() => {}); // muted autoplay; poster frame shows until it starts
  if (CONFIG.DEBUG) $('debug').classList.remove('hidden');
  const msg = (m, hint = '') => { $('bootMsg').textContent = m; $('bootHint').innerHTML = hint; };

  msg('Loading artwork…');
  await Promise.all([...ALL_ITEMS.map((it) => it.src), UI.title].map(async (src) => { images[src] = await loadImg(src); }));
  if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  game = new Game($('game'), images, sfx);
  buildGuide();
  if (CONFIG.DEBUG) Object.assign(window, { __game: game, __tracker: tracker, __presence: presence, __go: go, __link: link, __showTabletLink: showTabletLink });
  if (CONFIG.DEBUG) Object.defineProperty(window, '__pose', { get: () => pose });

  const forceKeyboard = new URLSearchParams(location.search).has('keyboard');
  if (!forceKeyboard) {
    try {
      msg('Starting camera…', 'Allow camera access when the browser asks.');
      const mod = await import('./pose.js');
      SKELETON = mod.SKELETON;
      pose = new mod.PoseSource();
      await pose.startCamera();
      msg('Loading body tracking…');
      await pose.loadModel();
    } catch (e) {
      console.error(e);
      pose = null;
      sim.on = true;
      $('boot').classList.add('error');
      msg('Camera or body tracking unavailable', `${e?.name === 'NotAllowedError' ? 'Camera permission was denied.' : (e?.message || e)}<br>Starting in keyboard mode — P1: A/D + W · P2: ←/→ + ↑`);
      await new Promise((r) => setTimeout(r, 3500));
    }
  } else sim.on = true;

  $('boot').classList.add('fade');
  setTimeout(() => $('boot').classList.add('hidden'), 700);
  await link.start();
  showTabletLink();
  go('idle');
  if (sim.on) toast('Keyboard mode — P1: A/D + W   ·   P2: ←/→ + ↑   ·   Enter to skip', 5000);
  sfx.ensure();
  if (!sfx.ready) setTimeout(() => { if (!sfx.ready) toast('Click anywhere to turn on sound', 4000); }, 1200);
  requestAnimationFrame(frame);
}

boot();
