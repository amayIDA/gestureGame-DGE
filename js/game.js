// Gameplay layer: falling items, baskets, scoring, juice.
// Output resolution is 1536×762. Layout is written in "design units" with the same aspect
// (2177×1080) so sizes read naturally; the canvas scales them down to 1536×762 when drawing.
import { CONFIG } from './config.js';
import { CATCH_ITEMS, AVOID_ITEMS } from './items.js';

export const RENDER_W = 1536, RENDER_H = 762;                   // output resolution
export const STAGE_H = 1080, STAGE_W = Math.round(STAGE_H * RENDER_W / RENDER_H); // 2177 design units
const R = RENDER_W / STAGE_W;                                    // design units → pixels
export const PF = { x: 60, y: 176, w: STAGE_W - 120, h: 864 };   // glass playfield (from storyboard)
export const PLAYER = {
  1: { color: '#2563EB', light: '#7FB0FF', name: 'PLAYER 1', tag: 'P1' },
  2: { color: '#0AA5C7', light: '#7FE3F5', name: 'PLAYER 2', tag: 'P2' },
};
const BASKET_W = 260, BASKET_H = 84;
const BASKET_Y = PF.y + PF.h - 112;           // basket centre
const CATCH_Y = BASKET_Y - BASKET_H / 2 + 6;  // rim line
const CARD_W = 150, CARD_H = 158, CARD_PAD = 18;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = (t) => t * t * (3 - 2 * t);
const rand = (a, b) => a + Math.random() * (b - a);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

class Bag { // shuffle-bag so the same item doesn't repeat back-to-back
  constructor(items) { this.items = items; this.q = []; }
  next() { if (!this.q.length) this.q = this.items.slice().sort(() => Math.random() - 0.5); return this.q.pop(); }
}

export class Game {
  constructor(canvas, images, sfx) {
    this.c = canvas; canvas.width = RENDER_W; canvas.height = RENDER_H;
    this.ctx = canvas.getContext('2d');
    this.images = images; this.sfx = sfx;
    this.sprites = new Map();
    this.buildSprites();
    this.names = { 1: 'P1', 2: 'P2' };
    this.catchBag = new Bag(CATCH_ITEMS);
    this.avoidBag = new Bag(AVOID_ITEMS);
    this.reset([1, 2]);
  }

  // ── pre-render each item as a glass card (cheap to draw every frame) ──
  buildSprites() {
    for (const it of [...CATCH_ITEMS, ...AVOID_ITEMS]) this.sprites.set(it.id, this.makeCard(this.images[it.src], it.label, false));
    this.sprites.set('bonus', this.makeCard(null, 'BONUS +3', true));
  }

  makeCard(img, label, gold) {
    const s = R; // exactly the size it's drawn at: sharp, and the cheapest possible copy every frame
    const cv = document.createElement('canvas');
    cv.width = (CARD_W + CARD_PAD * 2) * s; cv.height = (CARD_H + CARD_PAD * 2) * s;
    const g = cv.getContext('2d'); g.scale(s, s); g.translate(CARD_PAD, CARD_PAD);
    g.save();
    g.shadowColor = gold ? 'rgba(230,160,0,0.55)' : 'rgba(25,70,150,0.28)';
    g.shadowBlur = gold ? 22 : 16; g.shadowOffsetY = 7;
    roundRect(g, 0, 0, CARD_W, CARD_H, 20);
    if (gold) { const gr = g.createLinearGradient(0, 0, 0, CARD_H); gr.addColorStop(0, '#FFF6D6'); gr.addColorStop(1, '#FFD467'); g.fillStyle = gr; }
    else { const gr = g.createLinearGradient(0, 0, 0, CARD_H); gr.addColorStop(0, 'rgba(255,255,255,0.97)'); gr.addColorStop(1, 'rgba(232,243,255,0.95)'); g.fillStyle = gr; }
    g.fill(); g.restore();
    g.lineWidth = 2; g.strokeStyle = gold ? '#F0B400' : 'rgba(160,200,245,0.95)';
    roundRect(g, 1, 1, CARD_W - 2, CARD_H - 2, 19); g.stroke();
    // photo
    const ax = 10, ay = 10, aw = CARD_W - 20, ah = CARD_H - 50;
    g.save(); roundRect(g, ax, ay, aw, ah, 13); g.clip();
    g.fillStyle = '#fff'; g.fillRect(ax, ay, aw, ah);
    if (!img && gold) drawStar(g, ax + aw / 2, ay + ah / 2 + 2, 46, 21);
    if (img) {
      const k = Math.min(aw / img.width, ah / img.height) * (gold ? 0.92 : 1.0);
      const w = img.width * k, h = img.height * k;
      g.drawImage(img, ax + (aw - w) / 2, ay + (ah - h) / 2, w, h);
    }
    g.restore();
    // label
    let fs = 21; g.font = `700 ${fs}px Inter, "Noto Sans Arabic", "Segoe UI", system-ui, sans-serif`;
    while (g.measureText(label).width > CARD_W - 14 && fs > 12) { fs--; g.font = `700 ${fs}px Inter, "Noto Sans Arabic", "Segoe UI", system-ui, sans-serif`; }
    g.fillStyle = gold ? '#7A4B00' : '#12325F'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, CARD_W / 2, CARD_H - 21);
    return { canvas: cv, s };
  }

  // label under each basket: the player's (short) name, English or Arabic
  setNames(names) {
    for (const s of [1, 2]) {
      const n = (names[s] || `P${s}`).trim();
      // short names stay whole ("Player 1", "Sara Ali"); long ones use the first name ("Amay")
      const first = n.split(' ')[0];
      const short = [...n].length <= 12 || [...first].length < 3 ? n : first;
      this.names[s] = [...short].length > 12 ? [...short].slice(0, 11).join('') + '…' : short;
    }
  }

  reset(slots) {
    this.slots = slots.slice();
    this.solo = slots.length === 1;
    this.lanes = {};
    if (this.solo) this.lanes[slots[0]] = { x0: PF.x, x1: PF.x + PF.w };
    else { this.lanes[1] = { x0: PF.x, x1: PF.x + PF.w / 2 }; this.lanes[2] = { x0: PF.x + PF.w / 2, x1: PF.x + PF.w }; }
    this.baskets = {}; this.scores = {};
    for (const s of this.slots) {
      const L = this.lanes[s];
      this.baskets[s] = { x: (L.x0 + L.x1) / 2, target: (L.x0 + L.x1) / 2, present: true, bounce: 0, shake: 0, flash: 0, glow: 0, lean: 0 };
      this.scores[s] = { score: 0, correct: 0, wrong: 0, streak: 0, best: 0, bonus: 0 };
    }
    this.items = []; this.particles = []; this.texts = [];
    this.spawnT = 0.4; this.bonusT = CONFIG.BONUS_EVERY_S * 0.8;
    this.lastX = {};
    this.time = 0;
  }

  // x01: 0..1 position across that player's lane
  setBasket(slot, x01, present) {
    const b = this.baskets[slot]; if (!b) return;
    const L = this.lanes[slot], m = BASKET_W / 2 + 14;
    if (x01 != null) b.target = lerp(L.x0 + m, L.x1 - m, clamp(x01, 0, 1));
    b.present = present;
  }

  spawnWave(progress, forced) {
    const kind = forced || (Math.random() < CONFIG.CATCH_RATIO ? 'catch' : 'avoid');
    const item = kind === 'catch' ? this.catchBag.next() : kind === 'avoid' ? this.avoidBag.next() : null;
    const speed = lerp(CONFIG.SPEED_START, CONFIG.SPEED_END, easeInOut(progress)) * rand(0.97, 1.03);
    // Same item, same moment, both lanes → a fair race; positions differ per lane.
    for (const s of this.slots) {
      const L = this.lanes[s], m = CARD_W / 2 + 22;
      let x = rand(L.x0 + m, L.x1 - m);
      for (let k = 0; k < 4 && this.lastX[s] != null && Math.abs(x - this.lastX[s]) < 190; k++) x = rand(L.x0 + m, L.x1 - m);
      this.lastX[s] = x;
      const delay = 0;
      this.items.push({
        kind, item, lane: s, x, y: PF.y - CARD_H / 2 - delay * speed, vy: speed,
        t: 0, phase: rand(0, 6.28), sway: rand(8, 22), state: 'fall', k: 0, rot: 0, drawX: x, scale: 1,
      });
    }
  }

  update(dt, { progress = 0, spawning = false, final = false } = {}) {
    this.time += dt;
    if (spawning) {
      this.spawnT -= dt;
      // One item at a time at a steady pace, never two dropping together. The gap is at
      // least ~1.5 cards apart so falling items never overlap.
      this.bonusT -= dt;
      if (this.spawnT <= 0) {
        const speed = lerp(CONFIG.SPEED_START, CONFIG.SPEED_END, easeInOut(progress));
        this.spawnT = Math.max(CONFIG.SPAWN_GAP, (CARD_H * 1.5) / speed) * rand(0.95, 1.05);
        if (this.bonusT <= 0) { this.bonusT = CONFIG.BONUS_EVERY_S * rand(0.8, 1.2); this.spawnWave(progress, 'bonus'); } // replaces a normal item
        else this.spawnWave(progress);
      }
    }

    // baskets
    for (const s of this.slots) {
      const b = this.baskets[s];
      const prev = b.x;
      b.x += (b.target - b.x) * (1 - Math.exp(-dt * 18));
      b.lean = clamp((b.x - prev) / Math.max(dt, 1e-3) / 2500, -0.12, 0.12);
      b.bounce *= Math.exp(-dt * 7); b.shake *= Math.exp(-dt * 9);
      b.flash = Math.max(0, b.flash - dt * 2.5); b.glow = Math.max(0, b.glow - dt * 1.6);
    }

    // items
    for (const it of this.items) {
      it.t += dt;
      if (it.state === 'caught') {
        it.k += dt / 0.22;
        const b = this.baskets[it.lane];
        it.drawX = lerp(it.drawX, b.x, 0.35); it.y = lerp(it.y, BASKET_Y, 0.3);
        it.scale = lerp(1, 0.25, Math.min(1, it.k)); it.alpha = 1 - it.k;
        continue;
      }
      const prevY = it.y;
      it.y += it.vy * dt;
      it.drawX = it.x + Math.sin(it.t * 2.1 + it.phase) * it.sway;
      it.rot = Math.sin(it.t * 1.6 + it.phase) * 0.07;
      if (it.state === 'fall' && prevY < CATCH_Y && it.y >= CATCH_Y) {
        const b = this.baskets[it.lane];
        if (b.present && Math.abs(it.drawX - b.x) < BASKET_W / 2 + 18) this.onCatch(it, b);
        else { it.state = 'missed'; if (it.kind === 'catch') this.scores[it.lane].streak = 0; }
      }
      if (it.state === 'missed') it.alpha = clamp(1 - (it.y - CATCH_Y) / 220, 0, 1);
    }
    this.items = this.items.filter((it) => !(it.state === 'caught' && it.k >= 1) && it.y < STAGE_H + 120);

    // particles & texts
    for (const p of this.particles) { p.life -= dt; p.vy += 1100 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt; }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const t of this.texts) { t.life -= dt; t.y += t.vy * dt; t.vy *= Math.exp(-dt * 2); }
    this.texts = this.texts.filter((t) => t.life > 0);
  }

  onCatch(it, b) {
    const s = it.lane, sc = this.scores[s], col = PLAYER[s].color;
    const pan = this.solo ? 0 : s === 1 ? -0.5 : 0.5;
    it.state = 'caught'; it.k = 0;
    if (it.kind === 'avoid') {
      sc.wrong++; sc.streak = 0; sc.score = Math.max(0, sc.score - 1);
      b.shake = 1; b.flash = 1;
      this.text(b.x, BASKET_Y - 90, '−1', '#E5484D', 64);
      this.text(b.x, BASKET_Y - 150, `${it.item.label}? Not SCAD!`, '#E5484D', 28, 1.1);
      this.burst(b.x, CATCH_Y, ['#E5484D', '#FF9C9C', '#ffffff'], 14);
      this.sfx.wrong(pan);
      return;
    }
    b.bounce = 1; b.glow = 1;
    if (it.kind === 'bonus') {
      sc.score += 3; sc.bonus++; sc.correct++; sc.streak++;
      this.text(b.x, BASKET_Y - 100, '+3', '#E7A300', 78);
      this.text(b.x, BASKET_Y - 170, 'SCAD BONUS!', '#E7A300', 34, 1.2);
      this.burst(b.x, CATCH_Y, ['#FFD15C', '#FFF1B8', '#F0A800', '#ffffff'], 40);
      this.sfx.bonus(pan);
    } else {
      sc.score++; sc.correct++; sc.streak++;
      this.text(b.x, BASKET_Y - 90, '+1', col, 64);
      this.burst(b.x, CATCH_Y, [col, PLAYER[s].light, '#ffffff', '#BFE3FF'], 22);
      this.sfx.catch(sc.streak, pan);
    }
    sc.best = Math.max(sc.best, sc.streak);
    if (sc.streak > 0 && sc.streak % CONFIG.STREAK_BONUS_EVERY === 0) {
      sc.score += 1;
      this.text(b.x, BASKET_Y - 220, `${sc.streak} IN A ROW!  +1`, col, 36, 1.3);
      this.burst(b.x, CATCH_Y - 20, ['#FFD15C', col, '#ffffff'], 30, 1.4);
      setTimeout(() => this.sfx.streak(pan), 90);
    }
  }

  text(x, y, str, color, size, life = 0.9) { this.texts.push({ x, y, str, color, size, life, max: life, vy: -110 }); }
  burst(x, y, colors, n, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = rand(-Math.PI * 0.95, -Math.PI * 0.05), sp = rand(250, 720) * power;
      this.particles.push({ x: x + rand(-60, 60), y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: rand(0, 6), vr: rand(-10, 10), size: rand(6, 15), color: colors[i % colors.length], life: rand(0.5, 1.0), max: 1 });
    }
  }

  // ── drawing ──
  draw({ showItems = true, showBaskets = true } = {}) {
    const g = this.ctx;
    g.setTransform(R, 0, 0, R, 0, 0);
    g.clearRect(0, 0, STAGE_W, STAGE_H);

    // lane divider + lane tint
    if (showBaskets && !this.solo) {
      const cx = PF.x + PF.w / 2;
      g.save(); g.setLineDash([14, 16]); g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.75)';
      g.beginPath(); g.moveTo(cx, PF.y + 26); g.lineTo(cx, PF.y + PF.h - 26); g.stroke(); g.restore();
    }
    if (showBaskets) for (const s of this.slots) {
      const b = this.baskets[s];
      if (b.glow > 0) { // light column above a basket after a good catch
        const L = this.lanes[s];
        const gr = g.createLinearGradient(0, PF.y, 0, BASKET_Y);
        gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, hexA(PLAYER[s].light, 0.35 * b.glow));
        g.fillStyle = gr; g.fillRect(clamp(b.x - BASKET_W / 2, L.x0, L.x1), PF.y + 10, BASKET_W, BASKET_Y - PF.y);
      }
    }

    if (showItems) {
      // items enter from and leave through the playfield frame
      g.save(); g.beginPath(); g.rect(PF.x, PF.y, PF.w, PF.h); g.clip(); // plain rectangle clip = fast path
      for (const it of this.items) if (it.state !== 'caught') this.drawItem(it);
      g.restore();
    }
    if (showBaskets) for (const s of this.slots) this.drawBasket(s);
    if (showItems) for (const it of this.items) if (it.state === 'caught') this.drawItem(it);

    for (const p of this.particles) {
      g.save(); g.globalAlpha = clamp(p.life / 0.5, 0, 1); g.translate(p.x, p.y); g.rotate(p.r);
      g.fillStyle = p.color; g.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1.5; g.strokeRect(-p.size / 2, -p.size / 2, p.size, p.size);
      g.restore();
    }
    for (const t of this.texts) {
      const a = clamp(t.life / (t.max * 0.5), 0, 1);
      const pop = 1 + Math.max(0, (t.life - t.max + 0.12) / 0.12) * 0.4;
      g.save(); g.globalAlpha = a; g.translate(t.x, t.y); g.scale(pop, pop);
      g.font = `800 ${t.size}px Inter, "Noto Sans Arabic", "Segoe UI", system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = Math.max(4, t.size / 9); g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineJoin = 'round';
      g.strokeText(t.str, 0, 0); g.fillStyle = t.color; g.fillText(t.str, 0, 0);
      g.restore();
    }
  }

  clear() { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, RENDER_W, RENDER_H); }

  drawItem(it) {
    const g = this.ctx;
    const sp = this.sprites.get(it.kind === 'bonus' ? 'bonus' : it.item.id);
    const w = (CARD_W + CARD_PAD * 2), h = (CARD_H + CARD_PAD * 2);
    g.save();
    g.globalAlpha = it.alpha ?? 1;
    g.translate(it.drawX, it.y); g.rotate(it.rot); g.scale(it.scale, it.scale);
    if (it.kind === 'bonus') { // shimmer halo
      const r = 105 + Math.sin(this.time * 8) * 8;
      const gr = g.createRadialGradient(0, 0, 40, 0, 0, r);
      gr.addColorStop(0, 'rgba(255,215,90,0.55)'); gr.addColorStop(1, 'rgba(255,215,90,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    }
    g.drawImage(sp.canvas, -w / 2, -h / 2, w, h);
    g.restore();
  }

  drawBasket(s) {
    const g = this.ctx, b = this.baskets[s], P = PLAYER[s];
    const shakeX = Math.sin(this.time * 70) * 14 * b.shake;
    const sq = b.bounce * 0.12;
    g.save();
    g.translate(b.x + shakeX, BASKET_Y);
    g.globalAlpha = b.present ? 1 : 0.35;
    g.rotate(b.lean);
    g.scale(1 + sq, 1 - sq);
    const W = BASKET_W, H = BASKET_H, bw = W * 0.84;
    // shadow
    g.fillStyle = 'rgba(20,60,140,0.18)'; g.beginPath(); g.ellipse(0, H / 2 + 14, W * 0.48, 12, 0, 0, Math.PI * 2); g.fill();
    // back rim
    g.fillStyle = hexA(P.color, 0.25); g.beginPath(); g.ellipse(0, -H / 2, W / 2, 14, 0, 0, Math.PI * 2); g.fill();
    // body (glass trapezoid)
    g.beginPath(); g.moveTo(-W / 2, -H / 2); g.lineTo(W / 2, -H / 2); g.lineTo(bw / 2, H / 2); g.quadraticCurveTo(bw / 2, H / 2 + 8, bw / 2 - 12, H / 2 + 8);
    g.lineTo(-bw / 2 + 12, H / 2 + 8); g.quadraticCurveTo(-bw / 2, H / 2 + 8, -bw / 2, H / 2); g.closePath();
    const gr = g.createLinearGradient(0, -H / 2, 0, H / 2);
    const tint = b.flash > 0 ? '#E5484D' : P.color;
    gr.addColorStop(0, hexA(tint, 0.35)); gr.addColorStop(1, hexA(tint, 0.78));
    g.fillStyle = gr; g.fill();
    g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.9)'; g.stroke();
    // front rim + glossy highlight
    g.lineWidth = 5; g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.beginPath(); g.ellipse(0, -H / 2, W / 2, 14, 0, 0, Math.PI); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.28)'; roundRect(g, -W / 2 + 22, -H / 2 + 18, W * 0.5, 10, 5); g.fill();
    // label pill
    g.restore();
    g.save(); g.globalAlpha = b.present ? 1 : 0.6;
    const px = b.x + shakeX, py = BASKET_Y + H / 2 + 44;
    g.font = '800 22px Inter, "Noto Sans Arabic", "Segoe UI", system-ui, sans-serif';
    const label = this.names[s] || P.tag;
    const pw = Math.max(88, g.measureText(label).width + 40);
    g.fillStyle = P.color; roundRect(g, px - pw / 2, py - 20, pw, 40, 20); g.fill();
    g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.95)'; g.stroke();
    g.fillStyle = '#fff'; g.font = '800 22px Inter, "Noto Sans Arabic", "Segoe UI", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, px, py + 1);
    if (!b.present) {
      g.globalAlpha = 0.6 + Math.sin(this.time * 6) * 0.3;
      g.font = '700 26px Inter, "Noto Sans Arabic", "Segoe UI", system-ui, sans-serif'; g.fillStyle = '#12325F';
      g.fillText('Step back into view', px, BASKET_Y - BASKET_H - 20);
    }
    g.restore();
  }
}

function drawStar(g, cx, cy, R, r) {
  g.save();
  const bg = g.createRadialGradient(cx, cy, 4, cx, cy, R * 1.5);
  bg.addColorStop(0, '#FFF7DA'); bg.addColorStop(1, '#FFFFFF');
  g.fillStyle = bg; g.fillRect(cx - R * 2, cy - R * 1.4, R * 4, R * 2.8);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r : R;
    g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.closePath();
  const gr = g.createLinearGradient(0, cy - R, 0, cy + R);
  gr.addColorStop(0, '#FFE27A'); gr.addColorStop(1, '#F0A800');
  g.shadowColor = 'rgba(230,160,0,0.6)'; g.shadowBlur = 12;
  g.fillStyle = gr; g.fill();
  g.shadowBlur = 0; g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
  g.fillStyle = '#fff'; g.font = '900 24px Inter, "Noto Sans Arabic", "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('+3', cx, cy + 3);
  g.restore();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
