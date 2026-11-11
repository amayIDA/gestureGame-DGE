// Body tracking runs here, in a background thread, so the game can keep drawing at the
// screen's full frame rate while MediaPipe works on the camera image (15–40 ms per frame).
// Classic worker: MediaPipe's loader uses importScripts.
/* eslint-disable no-restricted-globals */
self.exports = {}; self.module = { exports: self.exports };
importScripts('../vendor/mediapipe/vision_bundle_classic.js');
const { FilesetResolver, PoseLandmarker } = self.module.exports;
delete self.module; delete self.exports; // so MediaPipe's wasm loader sets its global normally

let landmarker = null, sampler = null, sctx = null;

async function init({ wasm, model, numPoses, delegate }) {
  const fileset = await FilesetResolver.forVisionTasks(wasm);
  const opts = (d) => ({
    baseOptions: { modelAssetPath: model, delegate: d },
    runningMode: 'VIDEO', numPoses,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let used = delegate === 'CPU' ? 'CPU' : 'GPU';
  try { landmarker = await PoseLandmarker.createFromOptions(fileset, opts(used)); }
  catch (e) {
    if (used === 'CPU') throw e;
    used = 'CPU';
    landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
  }
  sampler = new OffscreenCanvas(96, 54);
  sctx = sampler.getContext('2d', { willReadFrequently: true });
  return used;
}

function detect({ bitmap, ts, id }) {
  const t0 = performance.now();
  const res = landmarker.detectForVideo(bitmap, ts);
  // small copy of the frame for clothing colours (used to keep player IDs stable)
  sctx.drawImage(bitmap, 0, 0, 96, 54);
  const img = sctx.getImageData(0, 0, 96, 54).data;
  const width = bitmap.width, height = bitmap.height;
  bitmap.close();
  const landmarks = (res.landmarks || []).map((lm) => lm.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility })));
  self.postMessage({ type: 'result', id, ts, landmarks, img, width, height, ms: performance.now() - t0 }, [img.buffer]);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') self.postMessage({ type: 'ready', delegate: await init(m) });
    else if (m.type === 'frame') detect(m);
  } catch (err) {
    try { m.bitmap?.close(); } catch { /* already closed */ }
    self.postMessage({ type: 'error', id: m.id, stage: m.type, message: String(err?.message || err) });
  }
};
