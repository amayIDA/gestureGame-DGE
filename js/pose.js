// Camera + MediaPipe Pose Landmarker (multi-person) → per-frame person descriptions.
// The model runs in a background thread (pose-worker.js) so it never holds up drawing;
// if the browser can't do that, it runs here on the main thread as before.
import { CONFIG } from './config.js';

const LM = { NOSE: 0, LS: 11, RS: 12, LW: 15, RW: 16, LI: 19, RI: 20, LH: 23, RH: 24 };
export const SKELETON = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

export class PoseSource {
  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true; this.video.muted = true;
    this.sampler = document.createElement('canvas');
    this.sampler.width = 96; this.sampler.height = 54;
    this.sctx = this.sampler.getContext('2d', { willReadFrequently: true });
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.lastTs = 0;
    this.fps = 0; this._frames = 0; this._fpsT = performance.now();
    this.delegate = '';
    this.worker = null; this.busy = false; this.busySince = 0; this.result = null; this.seq = 0; this.errors = 0;
    this.detTs = 0;      // camera-frame time of the last returned detections
    this.detMs = 0;      // how long the model took on the last frame
    this.mode = '';      // 'worker' | 'main'
  }

  async startCamera() {
    let deviceId;
    if (CONFIG.CAMERA_LABEL) {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      const devs = await navigator.mediaDevices.enumerateDevices();
      tmp.getTracks().forEach((t) => t.stop());
      const hit = devs.find((d) => d.kind === 'videoinput' && d.label.toLowerCase().includes(CONFIG.CAMERA_LABEL.toLowerCase()));
      if (hit) deviceId = { exact: hit.deviceId };
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { deviceId, width: { ideal: CONFIG.CAMERA_WIDTH }, height: { ideal: CONFIG.CAMERA_HEIGHT }, facingMode: 'user', frameRate: { ideal: 30 } },
    });
    this.video.srcObject = stream;
    await this.video.play();
  }

  modelUrl() { return new URL(`../vendor/models/pose_landmarker_${CONFIG.MODEL}.task`, import.meta.url).href; }
  wasmUrl() { return new URL('../vendor/mediapipe/wasm', import.meta.url).href; }

  async loadModel() {
    if (CONFIG.POSE_WORKER && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined') {
      try { await this.loadWorker(); return; } catch (e) {
        console.warn('Background body tracking unavailable, running it on the main thread', e);
        this.worker?.terminate(); this.worker = null;
      }
    }
    await this.loadMain();
  }

  loadWorker() {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./pose-worker.js', import.meta.url));
      const timer = setTimeout(() => reject(new Error('worker start timed out')), 60000);
      w.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || 'worker failed to load')); };
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          this.worker = w; this.delegate = m.delegate; this.mode = 'worker';
          w.onmessage = (ev) => this.onWorker(ev.data);
          w.onerror = (ev) => { console.error('pose worker', ev.message); this.toMain(); };
          resolve();
        } else if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.message)); }
      };
      w.postMessage({ type: 'init', wasm: this.wasmUrl(), model: this.modelUrl(), numPoses: CONFIG.NUM_POSES, delegate: 'GPU' });
    });
  }

  async loadMain() {
    const { FilesetResolver, PoseLandmarker } = await import('../vendor/mediapipe/vision_bundle.js');
    const fileset = await FilesetResolver.forVisionTasks(this.wasmUrl());
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: this.modelUrl(), delegate },
      runningMode: 'VIDEO',
      numPoses: CONFIG.NUM_POSES,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('GPU delegate failed, falling back to CPU', e);
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
      this.delegate = 'CPU';
    }
    this.mode = 'main';
  }

  // the background thread keeps failing → carry on in the main thread
  toMain() {
    if (!this.worker) return;
    this.worker.terminate(); this.worker = null; this.busy = false;
    this.loadMain().catch((e) => console.error('body tracking unavailable', e));
  }

  onWorker(m) {
    if (m.type === 'result') {
      this.busy = false; this.errors = 0;
      this.result = m; this.detMs = m.ms;
      this.countFrame(performance.now());
      this.pump(performance.now()); // start on the next camera frame straight away
    } else if (m.type === 'error') {
      this.busy = false;
      console.warn('pose worker:', m.message);
      if (++this.errors > 8) this.toMain();
    }
  }

  // send the newest camera frame to the worker (one frame in flight at a time)
  pump(now) {
    const v = this.video;
    if (!this.worker) return;
    if (this.busy) { if (now - this.busySince > 3000) this.busy = false; else return; } // lost frame → retry
    if (v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const ts = Math.max(now, this.lastTs + 1); this.lastTs = ts;
    this.busy = true; this.busySince = now;
    const id = ++this.seq;
    createImageBitmap(v).then((bitmap) => {
      if (!this.worker) { bitmap.close(); return; }
      this.worker.postMessage({ type: 'frame', bitmap, ts, id }, [bitmap]);
    }).catch(() => { this.busy = false; });
  }

  countFrame(now) {
    this._frames++;
    if (now - this._fpsT > 1000) { this.fps = (this._frames * 1000) / (now - this._fpsT); this._frames = 0; this._fpsT = now; }
  }

  // Returns null when there's no new result, else an array of people.
  // `detTs` is the time the camera frame was taken (use it for motion maths).
  detect(now) {
    if (this.worker) {
      this.pump(now);
      const r = this.result;
      if (!r) return null;
      this.result = null;
      this.detTs = r.ts;
      return r.landmarks.map((lm) => this.describe(lm, r.img)).filter(Boolean);
    }
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;
    const ts = Math.max(now, this.lastTs + 1); this.lastTs = ts;
    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(v, ts);
    this.detMs = performance.now() - t0;
    this.countFrame(now);
    this.detTs = ts;

    this.sctx.drawImage(v, 0, 0, this.sampler.width, this.sampler.height);
    const img = this.sctx.getImageData(0, 0, this.sampler.width, this.sampler.height).data;

    return (res.landmarks || []).map((lm) => this.describe(lm, img)).filter(Boolean);
  }

  describe(lm, img) {
    const vis = (i) => (lm[i].visibility ?? 1);
    if (vis(LM.LS) < 0.4 || vis(LM.RS) < 0.4) return null;
    const mx = (p) => (CONFIG.MIRROR ? 1 - p.x : p.x);
    const ls = lm[LM.LS], rs = lm[LM.RS];
    const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y);
    if (sw < 0.03) return null; // too far away / background figure
    const sMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const hipOk = vis(LM.LH) > 0.4 && vis(LM.RH) > 0.4;
    const hMid = hipOk ? { x: (lm[LM.LH].x + lm[LM.RH].x) / 2, y: (lm[LM.LH].y + lm[LM.RH].y) / 2 } : null;

    // Approximate distance from the camera (metres) from body size in the image.
    // Uses shoulder width (~0.40 m) and torso length (~0.50 m); takes the closer estimate
    // so turning sideways (narrow shoulders) doesn't make someone look far away.
    const aspect = (this.video.videoHeight || 720) / (this.video.videoWidth || 1280);
    const swFrac = Math.hypot(ls.x - rs.x, (ls.y - rs.y) * aspect);
    const viewW = 2 * Math.tan((CONFIG.CAMERA_HFOV * Math.PI) / 360); // frame width per metre of distance
    let dist = 0.40 / (Math.max(swFrac, 1e-3) * viewW);
    if (hMid) {
      const torsoFrac = Math.hypot(hMid.x - sMid.x, (hMid.y - sMid.y) * aspect);
      dist = Math.min(dist, 0.50 / (Math.max(torsoFrac, 1e-3) * viewW));
    }
    const cx = hMid ? sMid.x * 0.6 + hMid.x * 0.4 : sMid.x;
    const cy = hMid ? sMid.y * 0.6 + hMid.y * 0.4 : sMid.y + sw * 0.5;

    // Hand raised = wrist clearly above the shoulder line
    const shoulderTop = Math.min(ls.y, rs.y);
    const up = (w) => vis(w) > 0.5 && lm[w].y < shoulderTop - sw * 0.35;
    const lUp = up(LM.LW), rUp = up(LM.RW);
    // Cursor = the raised hand (or the higher hand), index-finger tip if visible
    let hand = lUp && !rUp ? 'L' : rUp && !lUp ? 'R' : (lm[LM.LW].y < lm[LM.RW].y ? 'L' : 'R');
    const tip = hand === 'L' ? (vis(LM.LI) > 0.4 ? lm[LM.LI] : lm[LM.LW]) : (vis(LM.RI) > 0.4 ? lm[LM.RI] : lm[LM.RW]);

    return {
      x: mx({ x: cx }), y: cy, sw, dist,
      // front view: nose visible and the person's left shoulder on the image's right
      facing: vis(LM.NOSE) > 0.5 && ls.x > rs.x,
      handUp: lUp || rUp,
      cursor: { x: mx(tip), y: tip.y, valid: vis(hand === 'L' ? LM.LW : LM.RW) > 0.5 },
      color: this.torsoColor(ls, rs, hMid, sw, img),
      lm,
    };
  }

  // Average clothing colour inside the torso (camera-space, not mirrored)
  torsoColor(ls, rs, hMid, sw, img) {
    const W = this.sampler.width, H = this.sampler.height;
    const top = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const bot = hMid || { x: top.x, y: top.y + sw * 1.1 };
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 1; i <= 3; i++) {
      for (let j = -1; j <= 1; j++) {
        const t = 0.15 + i * 0.18;
        const x = top.x + (bot.x - top.x) * t + j * sw * 0.22;
        const y = top.y + (bot.y - top.y) * t;
        const px = Math.round(x * W), py = Math.round(y * H);
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const k = (py * W + px) * 4;
        r += img[k]; g += img[k + 1]; b += img[k + 2]; n++;
      }
    }
    if (!n) return null;
    r /= n; g /= n; b /= n;
    const s = r + g + b + 1e-3;
    return [r / s, g / s, s / 765];
  }
}
