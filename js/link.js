// Connection to the local server: receives registered players from the tablet,
// reports game progress and results back. If the game is opened without the server
// (e.g. a plain static host), `available` stays false and the game can still be
// started from the keyboard for testing.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Link {
  constructor() {
    this.available = false;
    this.state = null;      // last /api/state
    this.info = null;       // { port, tabletUrls }
    this.lastOk = 0;
  }

  get online() { return this.available && performance.now() - this.lastOk < 4000; }

  async start() {
    try {
      const r = await fetch('/api/info', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      this.info = await r.json();
      this.available = true;
    } catch {
      this.available = false;
      return;
    }
    this.loop();
  }

  async loop() {
    for (;;) {
      try {
        const r = await fetch('/api/state?client=game', { cache: 'no-store' });
        if (r.ok) { this.state = await r.json(); this.lastOk = performance.now(); }
      } catch { /* server restarting / network blip — keep trying */ }
      await sleep(500);
    }
  }

  async post(path, body) {
    if (!this.available) return null;
    try {
      const r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  /** take the next registered group (or the one already in progress) */
  async next() { return (await this.post('next'))?.session ?? null; }

  /** report progress: waiting | countdown | playing | results | done | noshow */
  status(id, status, extra = {}) {
    if (!id) return Promise.resolve(null);
    return this.post('status', { id, status, ...extra });
  }

  /** anyone registered and waiting (or a group the game should resume)? */
  get pending() {
    const s = this.state;
    return !!s && (!!s.current || s.queue.length > 0);
  }
}
