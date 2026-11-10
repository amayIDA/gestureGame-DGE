// Tiny synthesized sound kit (no audio files needed).
export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
  }
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  get ready() { return this.ctx && this.ctx.state === 'running'; }

  tone({ f = 440, f2 = null, t = 0, d = 0.15, type = 'sine', v = 0.3, pan = 0 }) {
    const ctx = this.ensure(); if (!ctx || this.muted) return;
    const t0 = ctx.currentTime + t;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + d);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    let node = o.connect(g);
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
    node.connect(this.master);
    o.start(t0); o.stop(t0 + d + 0.05);
  }

  // pentatonic ladder: the longer the streak, the higher the ping
  catch(streak = 1, pan = 0) {
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
    const n = scale[Math.min(streak - 1, scale.length - 1)];
    const f = 523.25 * Math.pow(2, n / 12);
    this.tone({ f, d: 0.16, type: 'triangle', v: 0.35, pan });
    this.tone({ f: f * 1.5, t: 0.06, d: 0.18, type: 'sine', v: 0.2, pan });
  }
  bonus(pan = 0) {
    [0, 4, 7, 12, 16].forEach((n, i) => this.tone({ f: 659 * Math.pow(2, n / 12), t: i * 0.05, d: 0.25, type: 'triangle', v: 0.28, pan }));
  }
  streak(pan = 0) {
    [0, 7, 12].forEach((n, i) => this.tone({ f: 784 * Math.pow(2, n / 12), t: i * 0.07, d: 0.2, type: 'square', v: 0.12, pan }));
  }
  wrong(pan = 0) {
    this.tone({ f: 180, f2: 90, d: 0.28, type: 'sawtooth', v: 0.22, pan });
    this.tone({ f: 120, f2: 70, t: 0.03, d: 0.25, type: 'square', v: 0.12, pan });
  }
  join(slot) { this.tone({ f: slot === 1 ? 587 : 698, d: 0.18, type: 'triangle', v: 0.3 }); this.tone({ f: slot === 1 ? 880 : 1046, t: 0.08, d: 0.22, v: 0.25 }); }
  beep() { this.tone({ f: 660, d: 0.14, type: 'square', v: 0.15 }); }
  go() { [523, 659, 784, 1046].forEach((f) => this.tone({ f, d: 0.5, type: 'triangle', v: 0.18 })); }
  tick() { this.tone({ f: 1200, d: 0.05, type: 'square', v: 0.07 }); }
  whoosh() { this.tone({ f: 300, f2: 900, d: 0.25, type: 'sine', v: 0.12 }); }
  fanfare() {
    const seq = [[523, 0], [659, 0.12], [784, 0.24], [1046, 0.4], [784, 0.56], [1046, 0.68]];
    seq.forEach(([f, t]) => { this.tone({ f, t, d: 0.3, type: 'triangle', v: 0.25 }); this.tone({ f: f / 2, t, d: 0.3, type: 'sine', v: 0.15 }); });
  }
}
