/**
 * কুঁচকানো / বাঁকা পাতা সোজা করা — UVDoc (ETH Zurich, SIGGRAPH Asia 2023, Apache-2.0)
 *
 * কেন দরকার: চার কোণা দিয়ে ক্রপ (perspective warp) কেবল "সমতল" কাগজকে সোজা করে।
 * কিন্তু ভাঁজ-খাওয়া, কুঁচকানো বা বইয়ের মতো বেঁকে থাকা পাতায় লেখার লাইন
 * ঢেউখেলানো থেকে যায়। বাণিজ্যিক স্ক্যানার এখানে নিউরাল নেটওয়ার্ক দিয়ে
 * পাতার "ভাঁজের মানচিত্র" (grid) অনুমান করে — আমরাও তাই করছি।
 *
 * কৌশল:
 *  ১. ক্রপ করা পাতার চারপাশে একটু গাঢ় ফ্রেম বসিয়ে মডেলকে দিই (মডেল শিখেছে
 *     পটভূমিসহ কাগজ দেখতে)।
 *  ২. মডেল দেয় 45×31 বিন্দুর grid — আউটপুটের প্রতিটি বিন্দু ছবির কোথা থেকে আসবে।
 *  ৩. সেই grid থেকে "সবচেয়ে মানানসই সমতল (homography)" অংশটা বাদ দিয়ে শুধু
 *     বাঁকের অংশটুকু রাখি, আর পাতার ধার আমাদের নিখুঁত ক্রপের সাথেই মিলিয়ে দিই।
 *     ফলে পাতা ছোট-বড় বা সরে যায় না।
 *  ৪. বাঁক নগণ্য হলে (সমতল কাগজ) কিছুই বদলাই না — ছবি অক্ষত।
 *
 * সব কাজ ব্রাউজারেই; ছবি কোথাও পাঠানো হয় না। মডেল (~30MB) একবার নামলে ক্যাশে থাকে।
 */

const MODEL_URL = '/models/uvdoc_grid.onnx';
const IN_W = 496, IN_H = 720;     // মডেলের ইনপুট মাপ
const PAD = 0.06;                 // পাতার চারপাশে ফ্রেম (প্রস্থ/উচ্চতার ৬%)
// সমতলতার সীমা (পাতার মাপের অনুপাতে) — পরীক্ষায় সমতল পাতায় সর্বোচ্চ ~০.৭%, গড় ~০.১১%;
// কুঁচকানো পাতায় সর্বোচ্চ ১.৩%+, গড় ০.৪%+
const MIN_DEV_MAX = 0.009;
const MIN_DEV_MEAN = 0.0022;
const MAX_DEV_MAX = 0.12;         // এর বেশি মানে মডেল বিভ্রান্ত — ঝুঁকি নিই না

let sessionPromise = null;
let ortRef = null;

async function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const ort = await import('onnxruntime-web');
    ortRef = ort;
    ort.env.wasm.wasmPaths = '/ort/';
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    return ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  })().catch((e) => { sessionPromise = null; throw e; });
  return sessionPromise;
}

export async function isDewarpModelAvailable() {
  try { const r = await fetch(MODEL_URL, { method: 'HEAD' }); return r.ok; } catch { return false; }
}

// ---------- ছোট লিনিয়ার-অ্যালজেব্রা হেল্পার ----------
// uv (0..1) → (x,y) homography, লঘিষ্ঠ বর্গ (h33 = 1)
function fitHomography(uv, xy, n) {
  const A = Array.from({ length: 8 }, () => new Float64Array(9)); // normal equations [AtA | Atb]
  const row = new Float64Array(8);
  const acc = (r, b) => {
    for (let i = 0; i < 8; i++) {
      if (r[i] === 0) continue;
      for (let j = 0; j < 8; j++) A[i][j] += r[i] * r[j];
      A[i][8] += r[i] * b;
    }
  };
  for (let k = 0; k < n; k++) {
    const u = uv[2 * k], v = uv[2 * k + 1], x = xy[2 * k], y = xy[2 * k + 1];
    row.set([u, v, 1, 0, 0, 0, -u * x, -v * x]); acc(row, x);
    row.set([0, 0, 0, u, v, 1, -u * y, -v * y]); acc(row, y);
  }
  // Gauss-Jordan
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) return null;
    for (let j = c; j < 9; j++) A[c][j] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f === 0) continue;
      for (let j = c; j < 9; j++) A[r][j] -= f * A[c][j];
    }
  }
  return [A[0][8], A[1][8], A[2][8], A[3][8], A[4][8], A[5][8], A[6][8], A[7][8], 1];
}
function applyH(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}
function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
          B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
          C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

/**
 * ক্রপ করা পাতা (canvas) → বাঁক-সংশোধনের grid, অথবা null (সমতল/অনিশ্চিত)।
 * ফেরত: { grid: Float32Array(R*C*2) — পাতার পিক্সেল স্থানাঙ্কে, rows: R, cols: C, devMax, devMean }
 */
export async function estimateDewarp(pageCanvas) {
  let session;
  try { session = await getSession(); } catch (e) {
    console.warn('Dewarp model unavailable:', e);
    return null;
  }
  try {
    const w = pageCanvas.width, h = pageCanvas.height;
    const px = Math.round(w * PAD), py = Math.round(h * PAD);
    const Wp = w + 2 * px, Hp = h + 2 * py;

    // ---- ইনপুট: গাঢ় ফ্রেমসহ পাতা, 496×720, RGB 0..1, NCHW ----
    const c = document.createElement('canvas');
    c.width = IN_W; c.height = IN_H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(40,40,40)';
    ctx.fillRect(0, 0, IN_W, IN_H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const sx = IN_W / Wp, sy = IN_H / Hp;
    ctx.drawImage(pageCanvas, px * sx, py * sy, w * sx, h * sy);
    const { data } = ctx.getImageData(0, 0, IN_W, IN_H);
    const N = IN_W * IN_H;
    const input = new Float32Array(3 * N);
    for (let i = 0, p = 0; p < N; i += 4, p++) {
      input[p] = data[i] / 255;
      input[N + p] = data[i + 1] / 255;
      input[2 * N + p] = data[i + 2] / 255;
    }
    const feeds = {};
    feeds[session.inputNames[0]] = new ortRef.Tensor('float32', input, [1, 3, IN_H, IN_W]);
    const out = await session.run(feeds);
    const t = out[session.outputNames[0]];
    const [, , R, C] = t.dims;            // 1×2×45×31
    const g = t.data;
    const n = R * C;

    // ---- grid → ফ্রেমসহ ছবির পিক্সেল স্থানাঙ্ক ----
    const G = new Float64Array(n * 2), UV = new Float64Array(n * 2);
    for (let r = 0; r < R; r++) for (let q = 0; q < C; q++) {
      const k = r * C + q;
      G[2 * k] = (g[k] + 1) / 2 * (Wp - 1);
      G[2 * k + 1] = (g[n + k] + 1) / 2 * (Hp - 1);
      UV[2 * k] = q / (C - 1);
      UV[2 * k + 1] = r / (R - 1);
    }
    // ---- সমতল অংশ (homography) আলাদা করা, ধার আমাদের ক্রপে মেলানো ----
    const Hfit = fitHomography(UV, G, n);
    if (!Hfit) return null;
    const Hinv = invert3(Hfit);
    if (!Hinv) return null;
    const grid = new Float32Array(n * 2);
    let devMax = 0, devSum = 0;
    const size = Math.max(w, h);
    for (let k = 0; k < n; k++) {
      const [u, v] = applyH(Hinv, G[2 * k], G[2 * k + 1]);     // fit-এর uv স্থানে
      const x = u * (w - 1), y = v * (h - 1);                 // পাতার আসল স্থানাঙ্কে
      grid[2 * k] = x; grid[2 * k + 1] = y;
      const d = Math.hypot(x - UV[2 * k] * (w - 1), y - UV[2 * k + 1] * (h - 1)) / size;
      if (d > devMax) devMax = d;
      devSum += d;
    }
    const devMean = devSum / n;
    console.info('[dewarp] bend max %s%% mean %s%%', (devMax * 100).toFixed(2), (devMean * 100).toFixed(2));
    if (!isFinite(devMax) || devMax > MAX_DEV_MAX) return null;
    if (devMax < MIN_DEV_MAX || devMean < MIN_DEV_MEAN) return null;   // সমতল — দরকার নেই
    return { grid, rows: R, cols: C, devMax, devMean };
  } catch (e) {
    console.warn('Dewarp failed:', e);
    return null;
  }
}
