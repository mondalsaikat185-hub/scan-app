let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../worker/cvWorker.js', import.meta.url), { type: 'classic' });
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  worker.onerror = (e) => {
    pending.forEach(p => p.reject(new Error('Worker error: ' + e.message)));
    pending.clear();
  };
  return worker;
}

function call(type, payload, transfer = []) {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, payload }, transfer);
  });
}

export function initCV() { return call('init'); }

// canvas → ImageData → worker
function canvasToImageData(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// worker থেকে আসা {width,height,data} → নতুন canvas
function resultToCanvas(res) {
  const c = document.createElement('canvas');
  c.width = res.width; c.height = res.height;
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
  return c;
}

export async function detectEdges(canvas) {
  const img = canvasToImageData(canvas);
  return call('detect', { imageData: img }, [img.data.buffer]);
}

export async function warpCanvas(canvas, corners) {
  const img = canvasToImageData(canvas);
  const res = await call('warp', { imageData: img, corners }, [img.data.buffer]);
  return resultToCanvas(res);
}

export async function filterCanvas(canvas, filter) {
  if (filter === 'original') return canvas;
  const img = canvasToImageData(canvas);
  const res = await call('filter', { imageData: img, filter }, [img.data.buffer]);
  return resultToCanvas(res);
}
