/**
 * AI ডকুমেন্ট ডিটেকশন — U²-Net-p (ONNX, ~4.6MB, Apache-2.0)
 *
 * কেন দরকার: OpenCV-র ধার-ভিত্তিক পদ্ধতি রঙিন/এলোমেলো ব্যাকগ্রাউন্ডে
 * (যেমন ছাপা বেডশিট) হার মানে — কাপড়ের নকশাকেও ধার ভেবে বসে।
 * নিউরাল নেটওয়ার্ক ছবির "মুখ্য বস্তু" চিনতে শেখা, তাই কাগজটাকে
 * পুরো আকৃতি হিসেবে আলাদা করতে পারে।
 *
 * ভাগাভাগি: মডেল দেয় mask (কোন পিক্সেল কাগজ), আর OpenCV সেই mask থেকে
 * চারটি কোণা বের করে — দুই প্রযুক্তির সেরাটা।
 *
 * সব ইনফারেন্স ব্রাউজারেই চলে; কোনো ছবি কোথাও পাঠানো হয় না।
 */

const MODEL_URL = '/models/u2netp.onnx';
const SIZE = 320;                    // U²-Net-p এর ইনপুট মাপ

let sessionPromise = null;
let ortRef = null;

export function isAIEnabled() {
  return localStorage.getItem('ai-detect') !== 'off';
}
export function setAIEnabled(on) {
  localStorage.setItem('ai-detect', on ? 'on' : 'off');
}

/** মডেল ফাইল আদৌ আছে কিনা (না থাকলে চুপচাপ ক্লাসিক পদ্ধতিতে ফিরবে) */
export async function isModelAvailable() {
  try {
    const r = await fetch(MODEL_URL, { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

async function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const ort = await import('onnxruntime-web');
    ortRef = ort;
    // wasm ফাইলগুলো নিজেদের সার্ভার থেকেই — অফলাইনেও চলবে
    ort.env.wasm.wasmPaths = '/ort/';
    ort.env.wasm.numThreads = 1;      // থ্রেড ছাড়া — COOP/COEP হেডার লাগে না
    ort.env.logLevel = 'error';
    return ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  })().catch((e) => {
    sessionPromise = null;           // পরে আবার চেষ্টা করা যাবে
    throw e;
  });
  return sessionPromise;
}

/** মডেল আগেভাগে লোড করে রাখা (ঐচ্ছিক) */
export async function warmUpAI() {
  try { await getSession(); return true; } catch { return false; }
}

/**
 * canvas → কাগজের mask (Float32Array, SIZE×SIZE, মান ০..১)
 * ব্যর্থ হলে null — কলার তখন ক্লাসিক পদ্ধতি ব্যবহার করবে।
 */
export async function segmentDocument(canvas) {
  let session;
  try { session = await getSession(); } catch (e) {
    console.warn('AI model unavailable:', e);
    return null;
  }

  try {
    // ---- ইনপুট প্রস্তুত: 320×320, RGB, ImageNet স্বাভাবিকীকরণ ----
    const c = document.createElement('canvas');
    c.width = SIZE; c.height = SIZE;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, SIZE, SIZE);
    const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

    const input = new Float32Array(3 * SIZE * SIZE);
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    // U²-Net সর্বোচ্চ মান দিয়ে ভাগ করে, তারপর normalize
    let maxV = 1e-6;
    for (let i = 0; i < data.length; i += 4) {
      maxV = Math.max(maxV, data[i], data[i + 1], data[i + 2]);
    }
    const px = SIZE * SIZE;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      input[p]          = (data[i]     / maxV - mean[0]) / std[0];
      input[px + p]     = (data[i + 1] / maxV - mean[1]) / std[1];
      input[2 * px + p] = (data[i + 2] / maxV - mean[2]) / std[2];
    }

    const tensor = new ortRef.Tensor('float32', input, [1, 3, SIZE, SIZE]);
    const feeds = {};
    feeds[session.inputNames[0]] = tensor;
    const out = await session.run(feeds);
    const first = out[session.outputNames[0]];
    if (!first) return null;

    // ---- আউটপুট: ০..১ এ স্বাভাবিক করা ----
    const d = first.data;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < px; i++) { if (d[i] < mn) mn = d[i]; if (d[i] > mx) mx = d[i]; }
    const range = (mx - mn) || 1;
    const mask = new Float32Array(px);
    for (let i = 0; i < px; i++) mask[i] = (d[i] - mn) / range;
    return { mask, size: SIZE };
  } catch (e) {
    console.warn('AI inference failed:', e);
    return null;
  }
}
