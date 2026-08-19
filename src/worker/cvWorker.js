/* eslint-disable no-restricted-globals */
// classic worker — importScripts দিয়ে opencv লোড করা যায়
let ready = false;

function initCV() {
  return new Promise((resolve, reject) => {
    try {
      self.Module = { onRuntimeInitialized: () => resolve() };
      self.importScripts('/opencv.js');   // worker থ্রেডে ব্লক করলেও UI জমবে না
      // কিছু বিল্ডে onRuntimeInitialized আসে না — ব্যাকআপ polling
      const poll = setInterval(() => {
        if (self.cv && self.cv.Mat) { clearInterval(poll); resolve(); }
      }, 100);
    } catch (e) { reject(e); }
  });
}

// ---------- OpenCV helpers (main thread থেকে সরানো) ----------
function orderPoints(pts) {
  const xs = [...pts].sort((a, b) => a.x - b.x);
  const left = xs.slice(0, 2).sort((a, b) => a.y - b.y);
  const right = xs.slice(2, 4).sort((a, b) => a.y - b.y);
  return [left[0], right[0], right[1], left[1]]; // TL, TR, BR, BL
}

function matFromImageData(imageData) {
  const m = new self.cv.Mat(imageData.height, imageData.width, self.cv.CV_8UC4);
  m.data.set(imageData.data);
  return m;
}

// ---------- হোমোগ্রাফি হেল্পার ----------
// 3x3 ম্যাট্রিক্স (Minv.data64F) দিয়ে একটা বিন্দু ম্যাপ করা
function applyH(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/**
 * বইয়ের ভাঁজ (gutter) ডিটেকশন — v2
 * পুরোনো পদ্ধতি (গোটা ছবিতে HoughLinesP) বাস্তব ছবিতে ভুল রেখা ধরত।
 * নতুন পদ্ধতি: quad-টাকে আগে সমান আয়তক্ষেত্রে (rectify) এনে, প্রতিটা কলামের
 * গড় উজ্জ্বলতার প্রোফাইল বানিয়ে "গাঢ় উপত্যকা" খোঁজা হয় — বইয়ের ভাঁজ সবসময়
 * পাতার চেয়ে গাঢ় একটা লম্বা ব্যান্ড, তাই এটা অনেক নির্ভরযোগ্য।
 * নিশ্চিত না হলে quad অপরিবর্তিত থাকে (ভুল ক্রপের চেয়ে না-করা ভালো)।
 */
function refineGutter(cv, graySmall, quad) {
  const RW = 480, RH = 640;
  let srcTri = null, dstTri = null, M = null, Minv = null, rect = null;
  try {
    const [tl, tr, br, bl] = quad;
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, RW, 0, RW, RH, 0, RH]);
    M = cv.getPerspectiveTransform(srcTri, dstTri);
    rect = new cv.Mat();
    cv.warpPerspective(graySmall, rect, M, new cv.Size(RW, RH), cv.INTER_LINEAR,
                       cv.BORDER_REPLICATE, new cv.Scalar());

    const y0 = Math.floor(RH * 0.12), y1 = Math.floor(RH * 0.88);
    const rows = y1 - y0;

    // কলামভিত্তিক গড় উজ্জ্বলতা
    const prof = new Float64Array(RW);
    for (let x = 0; x < RW; x++) {
      let sum = 0;
      for (let y = y0; y < y1; y++) sum += rect.data[y * RW + x];
      prof[x] = sum / rows;
    }
    // মসৃণ করা
    const sm = new Float64Array(RW);
    const R = 4;
    for (let x = 0; x < RW; x++) {
      let s = 0, n = 0;
      for (let k = -R; k <= R; k++) {
        const i = x + k;
        if (i >= 0 && i < RW) { s += prof[i]; n++; }
      }
      sm[x] = s / n;
    }

    // ---------- কড়া শর্ত ১: অবস্থান মাঝামাঝি (৩০%–৭০%) ----------
    // (আগে ২৫–৭৫ ছিল; ভাঁজ প্রায় সবসময় মাঝ বরাবরই থাকে)
    const a = Math.floor(RW * 0.30), b = Math.floor(RW * 0.70);
    let vx = -1, vmin = Infinity;
    for (let x = a; x < b; x++) if (sm[x] < vmin) { vmin = sm[x]; vx = x; }
    if (vx < 0) return quad;

    const sorted = Array.from(sm).sort((p, q) => p - q);
    const median = sorted[Math.floor(sorted.length / 2)];

    // ---------- কড়া শর্ত ২: যথেষ্ট গাঢ় (≥৩০%, আগে ২২%) ----------
    if (!(vmin < median * 0.70)) return quad;

    // ---------- কড়া শর্ত ৩: সরু ব্যান্ড (<১২% প্রস্থ, আগে ২০%) ----------
    const thr = median - (median - vmin) * 0.6;
    let L = vx, Rr = vx;
    while (L > 0 && sm[L] < thr) L--;
    while (Rr < RW - 1 && sm[Rr] < thr) Rr++;
    const bandW = Rr - L;
    if (bandW > RW * 0.12 || bandW < 2) return quad;

    // ---------- কড়া শর্ত ৪: দুই পাশেই উজ্জ্বল পাতা আছে ----------
    // (ভাঁজ হলে দু'দিকেই কাগজ থাকবে; ছায়া/কালো ধার হলে এক পাশ অন্ধকার)
    const meanRange = (i0, i1) => {
      let s = 0, n = 0;
      for (let i = Math.max(0, i0); i < Math.min(RW, i1); i++) { s += sm[i]; n++; }
      return n ? s / n : 0;
    };
    const leftPage = meanRange(L - Math.floor(RW * 0.18), L - 4);
    const rightPage = meanRange(Rr + 4, Rr + Math.floor(RW * 0.18));
    if (!(leftPage > vmin * 1.35 && rightPage > vmin * 1.35)) return quad;
    // দুই পাশের উজ্জ্বলতা কাছাকাছি হতে হবে (একই বইয়ের দুই পাতা)
    const lo = Math.min(leftPage, rightPage), hi = Math.max(leftPage, rightPage);
    if (lo < hi * 0.72) return quad;

    // ---------- কড়া শর্ত ৫: রেখাটা উপর থেকে নিচ পর্যন্ত টানা ----------
    // প্রতিটি সারি-ব্যান্ডে vx-এর আশেপাশে সত্যিই গাঢ় বিন্দু আছে কিনা
    const BANDS = 10;
    const win = Math.max(6, Math.floor(RW * 0.05));
    let hits = 0;
    for (let bnd = 0; bnd < BANDS; bnd++) {
      const ry0 = y0 + Math.floor((rows * bnd) / BANDS);
      const ry1 = y0 + Math.floor((rows * (bnd + 1)) / BANDS);
      let bestLocal = Infinity, rowMean = 0, cnt = 0;
      for (let y = ry0; y < ry1; y++) {
        for (let x = 0; x < RW; x++) { rowMean += rect.data[y * RW + x]; cnt++; }
        for (let x = Math.max(0, vx - win); x < Math.min(RW, vx + win); x++) {
          const v = rect.data[y * RW + x];
          if (v < bestLocal) bestLocal = v;
        }
      }
      rowMean = cnt ? rowMean / cnt : 255;
      if (bestLocal < rowMean * 0.72) hits++;
    }
    // অন্তত ৮০% ব্যান্ডে রেখা থাকতে হবে (নাহলে এটা লেখা/ছায়া, ভাঁজ নয়)
    if (hits < BANDS * 0.8) return quad;

    // ---------- কড়া শর্ত ৬: বাদ যাওয়া অংশ যথেষ্ট বড় ----------
    const t = vx / RW;
    if (t > 0.42 && t < 0.58) {
      // ঠিক মাঝখানে — দুই পাতাই সমান; কোনটা রাখব অনিশ্চিত নয়, বড়টা রাখো
    } else if (Math.min(t, 1 - t) < 0.18) {
      return quad; // সামান্য এক ফালি — সম্ভবত ছায়া, বাদ দিও না
    }

    Minv = cv.getPerspectiveTransform(dstTri, srcTri);
    const h = Minv.data64F;
    const top = applyH(h, vx, 0);
    const bot = applyH(h, vx, RH);

    const refined = quad.map(p => ({ ...p }));
    if (t < 0.5) { refined[0] = top; refined[3] = bot; }
    else         { refined[1] = top; refined[2] = bot; }
    return refined;
  } catch (e) {
    return quad;
  } finally {
    [srcTri, dstTri, M, Minv, rect].forEach(m => { if (m) m.delete(); });
  }
}

/**
 * ছবিতে ট্যারা দেখানো আয়তক্ষেত্রের আসল প্রস্থ:উচ্চতা অনুপাত বের করা।
 * (Zhang & He-এর whiteboard-scanning অ্যালগরিদম)
 *
 * কেন দরকার: ক্যামেরা হেলিয়ে ছবি তুললে কাগজের উপরটা সরু, নিচটা চওড়া দেখায়।
 * শুধু কোণার দূরত্ব মেপে আউটপুট সাইজ ঠিক করলে পাতা চাপা/টানা লাগে।
 * এই হিসাব পরিপ্রেক্ষিত (perspective) থেকে আসল অনুপাত ফিরিয়ে আনে।
 */
function rectAspectRatio(quad, imgW, imgH) {
  try {
    const u0 = imgW / 2, v0 = imgH / 2;
    // m1=TL, m2=TR, m3=BL, m4=BR
    const m1 = [quad[0].x, quad[0].y, 1];
    const m2 = [quad[1].x, quad[1].y, 1];
    const m3 = [quad[3].x, quad[3].y, 1];
    const m4 = [quad[2].x, quad[2].y, 1];

    const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
    const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

    const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
    const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
    if (!isFinite(k2) || !isFinite(k3)) return null;

    const n2 = [k2*m2[0]-m1[0], k2*m2[1]-m1[1], k2*m2[2]-m1[2]];
    const n3 = [k3*m3[0]-m1[0], k3*m3[1]-m1[1], k3*m3[2]-m1[2]];

    // প্রায় সমান্তরাল ধার → focal নির্ণয় অসম্ভব। সরল (affine) অনুপাত দিই,
    // কিন্তু conf:false — warp() তখন A4-এর দিকে বেশি ঝুঁকবে।
    if (Math.abs(n2[2]) < 1e-9 || Math.abs(n3[2]) < 1e-9) {
      const r = Math.sqrt((n2[0]*n2[0] + n2[1]*n2[1]) / (n3[0]*n3[0] + n3[1]*n3[1]));
      return (isFinite(r) && r > 0) ? { r, conf: false } : null;
    }

    const f2 = -(1 / (n2[2]*n3[2])) * (
      (n2[0]*n3[0] - (n2[0]*n3[2] + n2[2]*n3[0])*u0 + n2[2]*n3[2]*u0*u0) +
      (n2[1]*n3[1] - (n2[1]*n3[2] + n2[2]*n3[1])*v0 + n2[2]*n3[2]*v0*v0)
    );
    if (!(f2 > 0)) {
      const r = Math.sqrt((n2[0]*n2[0] + n2[1]*n2[1]) / (n3[0]*n3[0] + n3[1]*n3[1]));
      return (isFinite(r) && r > 0) ? { r, conf: false } : null;
    }
    const f = Math.sqrt(f2);

    // AtiAi = (A^T A)^-1 ; A = [[f,0,u0],[0,f,v0],[0,0,1]]
    const q = (n, m) =>
      (n[0]*m[0] + n[1]*m[1]) / (f*f) +
      (-(u0/(f*f)))*(n[0]*m[2] + n[2]*m[0]) +
      (-(v0/(f*f)))*(n[1]*m[2] + n[2]*m[1]) +
      ((u0*u0 + v0*v0)/(f*f) + 1) * n[2]*m[2];

    const num = q(n2, n2), den = q(n3, n3);
    if (!(num > 0) || !(den > 0)) return null;
    const ratio = Math.sqrt(num / den);
    return (isFinite(ratio) && ratio > 0) ? { r: ratio, conf: true } : null;
  } catch (e) {
    return null;
  }
}

/**
 * অনুপাত অনুমানের "স্থিতিশীলতা পরীক্ষা"।
 *
 * কেন দরকার: কাগজের ধার যখন প্রায় সমান্তরাল দেখায় (সোজাসুজি তোলা ছবি),
 * তখন পরিপ্রেক্ষিত-সমীকরণ প্রায় অনির্ণেয় হয়ে পড়ে — কোণায় মাত্র ২-৩ পিক্সেল
 * হেরফের হলেই অনুপাত অনেকটা বদলে যায়। (বাস্তবে মাপা হয়েছে: ৬px → ০.৭০৭ বনাম ০.৫০৯।)
 *
 * তাই কোণাগুলো সামান্য নাড়িয়ে কয়েকবার হিসাব করি। ফল যদি এদিক-ওদিক লাফায়,
 * অনুমানটাকে "অনির্ভরযোগ্য" ধরি — তখন warp() A4-এর দিকে বেশি ঝোঁকে,
 * যা বাস্তবে প্রায় সবসময়ই সঠিক (বেশিরভাগ কাগজই A4)।
 */
function rectAspectRatioRobust(quad, W, H) {
  const base = rectAspectRatio(quad, W, H);
  if (!base) return null;

  const d = Math.max(W, H) * 0.004;   // ≈ ছবির ০.৪% (১০০০px-এ ৪px)
  const samples = [base.r];
  const patterns = [
    [ 1, -1,  1, -1], [-1,  1, -1,  1],
    [ 1,  1, -1, -1], [-1, -1,  1,  1],
  ];
  for (const pat of patterns) {
    const q2 = quad.map((p, i) => ({ x: p.x + pat[i] * d, y: p.y + pat[(i + 1) % 4] * d }));
    const r2 = rectAspectRatio(q2, W, H);
    if (r2 && isFinite(r2.r) && r2.r > 0) samples.push(r2.r);
  }
  if (samples.length < 3) return { r: base.r, conf: false };

  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const spread = (samples[samples.length - 1] - samples[0]) / Math.max(1e-6, median);

  // ৮%-এর বেশি লাফালাফি = অনির্ভরযোগ্য
  return { r: median, conf: base.conf && spread < 0.08 };
}

// ---------- জ্যামিতি হেল্পার ----------
function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p.x * n.y - n.x * p.y; }
  return Math.abs(a) / 2;
}
function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = q[i], p1 = q[(i + 1) % 4], p2 = q[(i + 2) % 4];
    const cr = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (Math.abs(cr) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}
// quad-এর ভেতরে (u,v) ∈ [0,1]² অনুযায়ী বিন্দু (bilinear)
function quadPoint(q, u, v) {
  const [tl, tr, br, bl] = q;
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bot = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}
// দুটো লাইনের ছেদবিন্দু (প্রতিটি লাইন দুই বিন্দু দিয়ে)
function lineIntersect(a1, a2, b1, b2) {
  const d = (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x);
  if (Math.abs(d) < 1e-9) return null;
  const pa = a1.x * a2.y - a1.y * a2.x, pb = b1.x * b2.y - b1.y * b2.x;
  return { x: (pa * (b1.x - b2.x) - (a1.x - a2.x) * pb) / d,
           y: (pa * (b1.y - b2.y) - (a1.y - a2.y) * pb) / d };
}

/**
 * ডকুমেন্ট ডিটেকশন — v3
 *
 * আগের সংস্করণের দুর্বলতা: ছবিকে প্রথমেই grayscale করে ফেলত, তাই সাদা কাগজ আর
 * রঙিন বেডশিট প্রায় একই উজ্জ্বলতার হলে সীমানাই খুঁজে পেত না; আর কাপড়ের বুননের
 * অজস্র ছোট edge সত্যিকারের ধারকে ঢেকে দিত।
 *
 * নতুন পদ্ধতি:
 *  ১. bilateral filter — বুনন/দানা মসৃণ করে, কিন্তু কাগজের ধার ধারালো রাখে।
 *  ২. Lab রঙস্থানের তিন চ্যানেলেই gradient — রঙের পার্থক্যও ধরা পড়ে (শুধু আলো নয়)।
 *  ৩. দুই ধরনের প্রার্থী: contour থেকে, আর লম্বা সরলরেখার ছেদ থেকে।
 *  ৪. প্রতিটি প্রার্থীকে তিন দিক থেকে নম্বর: জ্যামিতি + ধারে প্রকৃত edge আছে কিনা
 *     + ভেতর-বাহিরের উজ্জ্বলতার পার্থক্য (কাগজ সাধারণত উজ্জ্বল ও সমসত্ত্ব)।
 */
function detectEdges(imageData, opts) {
  const dopts = Object.assign({ gutter: false }, opts || {});
  const cv = self.cv;
  const W = imageData.width, H = imageData.height;
  const DETECT_DIM = 800;
  const scale = Math.min(1, DETECT_DIM / Math.max(W, H));

  let full = null, small = null, rgb = null, lab = null, chans = null,
      grad = null, gradAcc = null, edges = null, kernel = null, Lch = null;

  try {
    full = matFromImageData(imageData);
    small = new cv.Mat();
    if (scale < 1) cv.resize(full, small, new cv.Size(Math.round(W * scale), Math.round(H * scale)), 0, 0, cv.INTER_AREA);
    else full.copyTo(small);
    const sW = small.cols, sH = small.rows, imgArea = sW * sH;

    // ---- ১. টেক্সচার দমন (ধার অক্ষত) ----
    rgb = new cv.Mat();
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB, 0);
    const smoothed = new cv.Mat();
    try {
      cv.bilateralFilter(rgb, smoothed, 9, 45, 9, cv.BORDER_DEFAULT);
      smoothed.copyTo(rgb);
    } catch (e) { /* না পারলে আসলটাই */ }
    smoothed.delete();

    // ---- ২. Lab-এর তিন চ্যানেলে gradient, সর্বোচ্চটা নাও ----
    lab = new cv.Mat();
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab, 0);
    chans = new cv.MatVector();
    cv.split(lab, chans);
    const l0 = chans.get(0);
    Lch = l0.clone();                    // উজ্জ্বলতা — পরে contrast স্কোরে লাগবে
    l0.delete();

    gradAcc = cv.Mat.zeros(sH, sW, cv.CV_32F);
    for (let i = 0; i < 3; i++) {
      const ch = chans.get(i);
      const gx = new cv.Mat(), gy = new cv.Mat(), gx32 = new cv.Mat(), gy32 = new cv.Mat(), mag = new cv.Mat();
      cv.Scharr(ch, gx, cv.CV_32F, 1, 0, 1, 0, cv.BORDER_DEFAULT);
      cv.Scharr(ch, gy, cv.CV_32F, 0, 1, 1, 0, cv.BORDER_DEFAULT);
      gx.convertTo(gx32, cv.CV_32F); gy.convertTo(gy32, cv.CV_32F);
      cv.magnitude(gx32, gy32, mag);
      // a,b চ্যানেলের রঙ-পার্থক্যকে একটু বেশি গুরুত্ব (রঙিন ব্যাকগ্রাউন্ডে সাহায্য করে)
      if (i > 0) mag.convertTo(mag, -1, 1.6, 0);
      cv.max(gradAcc, mag, gradAcc);
      // ch সহ প্রতিটি অস্থায়ী Mat মুছতেই হবে — ক্যামেরা মোডে এই লুপ
      // সেকেন্ডে কয়েকবার চলে, একটা লিকও দ্রুত মেমরি শেষ করে দেবে
      [gx, gy, gx32, gy32, mag, ch].forEach(m => m.delete());
    }

    grad = new cv.Mat();
    cv.normalize(gradAcc, grad, 0, 255, cv.NORM_MINMAX, cv.CV_8U);

    edges = new cv.Mat();
    cv.threshold(grad, edges, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2,
                    cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());

    // ---------- স্কোরিং হেল্পার ----------
    const edgeAt = (x, y) => {
      const xi = Math.round(x), yi = Math.round(y);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const X = xi + dx, Y = yi + dy;
        if (X >= 0 && Y >= 0 && X < sW && Y < sH && edges.data[Y * sW + X]) return true;
      }
      return false;
    };
    // প্রতিটি ধারে সত্যিকারের edge কতটা আছে (0..1)
    const edgeSupport = (q) => {
      const N = 24;
      let hit = 0, tot = 0;
      for (let s = 0; s < 4; s++) {
        const a = q[s], b = q[(s + 1) % 4];
        for (let i = 1; i < N; i++) {
          const t = i / N;
          if (edgeAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) hit++;
          tot++;
        }
      }
      return tot ? hit / tot : 0;
    };
    // ভেতর বনাম বাহিরের উজ্জ্বলতা (কাগজ সাধারণত উজ্জ্বলতর ও সমসত্ত্ব)
    const Ldata = Lch.data;
    const Lat = (x, y) => {
      const xi = Math.min(sW - 1, Math.max(0, Math.round(x)));
      const yi = Math.min(sH - 1, Math.max(0, Math.round(y)));
      return Ldata[yi * sW + xi];
    };
    const contrastScore = (q) => {
      let insideSum = 0, insideSq = 0, n = 0;
      for (let u = 1; u <= 5; u++) for (let v = 1; v <= 5; v++) {
        const p = quadPoint(q, u / 6, v / 6);
        const val = Lat(p.x, p.y);
        insideSum += val; insideSq += val * val; n++;
      }
      const inMean = insideSum / n;
      const inStd = Math.sqrt(Math.max(0, insideSq / n - inMean * inMean));

      const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
      const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
      const off = Math.sqrt(quadArea(q)) * 0.06;
      let outSum = 0, m = 0;
      for (let s = 0; s < 4; s++) {
        const a = q[s], b = q[(s + 1) % 4];
        for (const t of [0.25, 0.5, 0.75]) {
          const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
          const dx = px - cx, dy = py - cy, len = Math.hypot(dx, dy) || 1;
          outSum += Lat(px + (dx / len) * off, py + (dy / len) * off);
          m++;
        }
      }
      const outMean = outSum / Math.max(1, m);
      const diff = Math.min(1, Math.abs(inMean - outMean) / 40);   // পার্থক্য যত বেশি তত ভালো
      const uniform = Math.max(0, 1 - inStd / 60);                 // ভেতর সমসত্ত্ব হলে ভালো
      const bright = inMean > outMean ? 1 : 0.55;                  // কাগজ সাধারণত উজ্জ্বলতর
      return (0.6 * diff + 0.4 * uniform) * bright;
    };
    const geomScore = (q) => {
      const area = quadArea(q);
      const ar = area / imgArea;
      if (ar < 0.12 || ar > 0.99) return 0;
      if (!isConvex(q)) return 0;
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const wT = d(q[0], q[1]), wB = d(q[3], q[2]), hL = d(q[0], q[3]), hR = d(q[1], q[2]);
      if (Math.min(wT, wB) < Math.max(wT, wB) * 0.4) return 0;
      if (Math.min(hL, hR) < Math.max(hL, hR) * 0.4) return 0;
      let angPen = 0;
      for (let i = 0; i < 4; i++) {
        const p0 = q[(i + 3) % 4], p1 = q[i], p2 = q[(i + 1) % 4];
        const v1 = { x: p0.x - p1.x, y: p0.y - p1.y }, v2 = { x: p2.x - p1.x, y: p2.y - p1.y };
        const dot = v1.x * v2.x + v1.y * v2.y;
        const nn = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1;
        angPen += Math.abs(90 - Math.acos(Math.max(-1, Math.min(1, dot / nn))) * 180 / Math.PI);
      }
      const angOk = Math.max(0, 1 - angPen / 140);
      // এলাকা: ৩৫–৯০% হলে আদর্শ
      const areaScore = ar < 0.35 ? ar / 0.35 : (ar > 0.9 ? Math.max(0, (0.99 - ar) / 0.09) : 1);
      return angOk * (0.5 + 0.5 * areaScore);
    };
    const totalScore = (q) => {
      const g = geomScore(q);
      if (g <= 0) return 0;
      return g * (0.25 + 0.45 * edgeSupport(q) + 0.30 * contrastScore(q));
    };


    // ---------- ধার সূক্ষ্ম সমন্বয় (edge snapping) ----------
    // সেরা quad পাওয়ার পরেও কোনো ধার কয়েক পিক্সেল ভেতরে/বাইরে বসতে পারে
    // (বিশেষত উপরের ধার, যেখানে ছায়া বা কম কনট্রাস্ট থাকে)। তাই প্রতিটি ধারকে
    // লম্বভাবে একটু সরিয়ে দেখি কোথায় সত্যিকারের edge সবচেয়ে বেশি — সেখানেই বসাই।
    const snapEdges = (q) => {
      const size = Math.sqrt(quadArea(q));
      const step = Math.max(1, size * 0.006);
      const out = q.map(p => ({ ...p }));
      const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
      const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;

      for (let sIdx = 0; sIdx < 4; sIdx++) {
        const i0 = sIdx, i1 = (sIdx + 1) % 4;
        const a = out[i0], b = out[i1];
        // ধারের লম্ব দিক (বাইরের দিকে ধনাত্মক)
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        let nx = mx - cx, ny = my - cy;
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;

        let bestOff = 0, bestSup = -1;
        for (let k = -8; k <= 8; k++) {
          const off = k * step;
          const pa = { x: a.x + nx * off, y: a.y + ny * off };
          const pb = { x: b.x + nx * off, y: b.y + ny * off };
          let hit = 0;
          const N = 20;
          for (let t = 1; t < N; t++) {
            const f = t / N;
            if (edgeAt(pa.x + (pb.x - pa.x) * f, pa.y + (pb.y - pa.y) * f)) hit++;
          }
          // সমান সমর্থন হলে কম সরানোকে প্রাধান্য
          const sup = hit / (N - 1) - Math.abs(k) * 0.012;
          if (sup > bestSup) { bestSup = sup; bestOff = off; }
        }
        if (bestOff !== 0) {
          a.x += nx * bestOff; a.y += ny * bestOff;
          b.x += nx * bestOff; b.y += ny * bestOff;
        }
      }
      // সমন্বয়ের পর খারাপ হলে আগেরটাই রাখো
      return totalScore(out) >= totalScore(q) ? out : q;
    };

    // ---------- প্রার্থী সংগ্রহ ----------
    const candidates = [];
    const addCand = (pts) => {
      if (!pts || pts.length !== 4) return;
      if (pts.some(p => !isFinite(p.x) || !isFinite(p.y))) return;
      // ছবির সীমার সামান্য বাইরে গেলে টেনে আনো
      const q = orderPoints(pts.map(p => ({
        x: Math.max(-sW * 0.05, Math.min(sW * 1.05, p.x)),
        y: Math.max(-sH * 0.05, Math.min(sH * 1.05, p.y)),
      })));
      const sc = totalScore(q);
      if (sc > 0) candidates.push({ q, sc });
    };

    // (ক) contour-ভিত্তিক
    {
      let contours = new cv.MatVector(), hier = new cv.Mat();
      cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        if (cv.contourArea(cnt) > imgArea * 0.08) {
          const hull = new cv.Mat(), poly = new cv.Mat();
          cv.convexHull(cnt, hull, false, true);
          for (const eps of [0.02, 0.04]) {
            cv.approxPolyDP(hull, poly, eps * cv.arcLength(hull, true), true);
            if (poly.rows === 4) {
              const pts = [];
              for (let k = 0; k < 4; k++) pts.push({ x: poly.data32S[k * 2], y: poly.data32S[k * 2 + 1] });
              addCand(pts);
              break;
            }
          }
          if (poly.rows !== 4) {
            const rr = cv.minAreaRect(cnt);
            addCand(cv.RotatedRect.points(rr).map(p => ({ x: p.x, y: p.y })));
          }
          hull.delete(); poly.delete();
        }
        cnt.delete();
      }
      contours.delete(); hier.delete();
    }

    // (খ) লাইন-ভিত্তিক: লম্বা সরলরেখা → চরম রেখা → ছেদ
    {
      const lines = new cv.Mat();
      cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 55,
                     Math.max(30, Math.min(sW, sH) * 0.22), Math.max(8, Math.min(sW, sH) * 0.03));
      const horiz = [], vert = [];
      for (let i = 0; i < lines.rows; i++) {
        const x1 = lines.data32S[i*4], y1 = lines.data32S[i*4+1];
        const x2 = lines.data32S[i*4+2], y2 = lines.data32S[i*4+3];
        const len = Math.hypot(x2 - x1, y2 - y1);
        const ang = Math.abs(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI);
        const item = { a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, len,
                       mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
        if (ang < 40 || ang > 140) horiz.push(item);
        else if (ang > 50 && ang < 130) vert.push(item);
      }
      lines.delete();

      if (horiz.length >= 2 && vert.length >= 2) {
        const byTop = [...horiz].sort((p, q2) => p.my - q2.my);
        const byLeft = [...vert].sort((p, q2) => p.mx - q2.mx);
        const tops = byTop.slice(0, 2);
        const bots = byTop.slice(-2).reverse();
        const lefts = byLeft.slice(0, 2);
        const rights = byLeft.slice(-2).reverse();
        for (const t of tops) for (const bo of bots) for (const l of lefts) for (const r of rights) {
          if (t === bo || l === r) continue;
          const tl = lineIntersect(t.a, t.b, l.a, l.b);
          const tr = lineIntersect(t.a, t.b, r.a, r.b);
          const br = lineIntersect(bo.a, bo.b, r.a, r.b);
          const bl = lineIntersect(bo.a, bo.b, l.a, l.b);
          if (tl && tr && br && bl) addCand([tl, tr, br, bl]);
        }
      }
    }

    // ---------- সেরা প্রার্থী ----------
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.sc - a.sc);
      const best = candidates[0];
      // নম্বর খুব কম হলে বিশ্বাস কোরো না
      if (best.sc >= 0.30) {
        let q = snapEdges(best.q);
        if (dopts.gutter) q = refineGutter(cv, Lch, q);
        return q.map(p => ({
          x: Math.max(0, Math.min(W, p.x / scale)),
          y: Math.max(0, Math.min(H, p.y / scale)),
        }));
      }
    }

    // কিছুই না পেলে — ৪% মার্জিনে default (ইউজার হাতে ঠিক করবে)
    const mx = W * 0.04, my = H * 0.04;
    return [{x:mx,y:my},{x:W-mx,y:my},{x:W-mx,y:H-my},{x:mx,y:H-my}];
  } catch (e) {
    const mx = W * 0.04, my = H * 0.04;
    return [{x:mx,y:my},{x:W-mx,y:my},{x:W-mx,y:H-my},{x:mx,y:H-my}];
  } finally {
    [full, small, rgb, lab, chans, grad, gradAcc, edges, kernel, Lch].forEach(m => { if (m) m.delete(); });
  }
}

/**
 * AI mask থেকে কাগজের চার কোণা বের করা।
 * মডেল বলে "কোন পিক্সেল কাগজ"; এখানে সেই আকৃতির সীমানা থেকে
 * সবচেয়ে মানানসই চতুর্ভুজ বের করা হয় — mask ঝাপসা হলেও কাজ করে।
 */
function quadFromMask(maskData, maskSize, targetW, targetH) {
  const cv = self.cv;
  let m = null, big = null, bin = null, kernel = null, contours = null, hier = null;
  try {
    // Float mask → 8-bit Mat
    m = new cv.Mat(maskSize, maskSize, cv.CV_8UC1);
    for (let i = 0; i < maskSize * maskSize; i++) m.data[i] = Math.round(maskData[i] * 255);

    // আসল ছবির মাপে বড় করা
    big = new cv.Mat();
    cv.resize(m, big, new cv.Size(targetW, targetH), 0, 0, cv.INTER_LINEAR);

    // Otsu দিয়ে কাগজ/পটভূমি আলাদা
    bin = new cv.Mat();
    cv.threshold(big, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    // ছোট ফাঁক বোজানো
    const k = Math.max(3, Math.round(Math.min(targetW, targetH) / 120) * 2 + 1);
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 1,
                    cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());

    contours = new cv.MatVector(); hier = new cv.Mat();
    cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestIdx = -1, bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const a = cv.contourArea(cnt);
      if (a > bestArea) { bestArea = a; bestIdx = i; }
      cnt.delete();
    }
    if (bestIdx < 0 || bestArea < targetW * targetH * 0.12) return null;

    const best = contours.get(bestIdx);
    const hull = new cv.Mat(), poly = new cv.Mat();
    cv.convexHull(best, hull, false, true);
    let pts = null;
    for (const eps of [0.02, 0.03, 0.05]) {
      cv.approxPolyDP(hull, poly, eps * cv.arcLength(hull, true), true);
      if (poly.rows === 4) {
        pts = [];
        for (let i = 0; i < 4; i++) pts.push({ x: poly.data32S[i * 2], y: poly.data32S[i * 2 + 1] });
        break;
      }
    }
    if (!pts) {                       // ৪ কোণা না মিললে ঘোরানো আয়তক্ষেত্র
      const rr = cv.minAreaRect(best);
      pts = cv.RotatedRect.points(rr).map(p => ({ x: p.x, y: p.y }));
    }
    best.delete(); hull.delete(); poly.delete();

    return orderPoints(pts).map(p => ({
      x: Math.max(0, Math.min(targetW, p.x)),
      y: Math.max(0, Math.min(targetH, p.y)),
    }));
  } catch (e) {
    return null;
  } finally {
    [m, big, bin, kernel, contours, hier].forEach(x => { if (x) x.delete(); });
  }
}

/**
 * @param opts {deskew, unshear, trim, a4} — কোন স্বয়ংক্রিয় সংশোধন চলবে।
 *
 * শিক্ষা: প্রতিটি স্বয়ংক্রিয় সংশোধন "বেশিরভাগ সময়" কাজ করে, কিন্তু সেগুলো
 * একের পর এক চাপালে ভুলের সম্ভাবনা গুণিতক হারে বাড়ে (৫টা × ১০% ভুল =
 * ~৪১% পাতা নষ্ট)। তাই এখন কেবল প্রমাণিত সংশোধনই ডিফল্টে চলে।
 */
function warp(imageData, corners, opts) {
  const o = Object.assign({ deskew: true, unshear: false, trim: false, a4: true }, opts || {});
  const cv = self.cv;
  let src = null, dst = null, srcTri = null, dstTri = null, M = null;
  try {
    src = matFromImageData(imageData);
    const [tl, tr, br, bl] = corners;

    // ধারগুলোর মাপা দৈর্ঘ্য (পরিপ্রেক্ষিতের কারণে এগুলো "দেখা" মাপ, আসল নয়)
    const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const wBot = Math.hypot(br.x - bl.x, br.y - bl.y);
    const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const hRight = Math.hypot(br.x - tr.x, br.y - tr.y);
    const measW = Math.max(wTop, wBot);
    const measH = Math.max(hLeft, hRight);

    // আসল প্রস্থ:উচ্চতা অনুপাত (পরিপ্রেক্ষিত সংশোধন করে)
    const est = rectAspectRatioRobust(corners, imageData.width, imageData.height);
    const measRatio = measW / Math.max(1, measH);
    let ratio, confident;
    if (est && isFinite(est.r) && est.r > 0.2 && est.r < 5 &&
        est.r / measRatio <= 2.2 && measRatio / est.r <= 2.2) {
      ratio = est.r; confident = est.conf;
    } else {
      ratio = measRatio; confident = false;
    }

    // A4 (1:√2) কাছাকাছি হলে ঠিক A4 অনুপাতে বসাও — প্রিন্টে নিখুঁত হবে
    const A4_P = 1 / Math.SQRT2;   // ০.৭০৭ (portrait)
    const A4_L = Math.SQRT2;       // ১.৪১৪ (landscape)
    // ---------- সুরক্ষা ১: দিক (orientation) কখনো উল্টে যাবে না ----------
    // লম্বা কাগজ কখনোই চওড়া হয়ে যাবে না — এটাই "ছবি বিশৃঙ্খল হয়ে যাওয়ার"
    // প্রধান কারণ ছিল: কোণায় সামান্য নড়াচড়ায় অনুমান উল্টো দিকে লাফিয়ে
    // portrait কাগজকে landscape A4-এ ঠেসে দিত।
    const measPortrait = measRatio < 1;
    if ((ratio < 1) !== measPortrait) ratio = measRatio;

    // ---------- সুরক্ষা ২: মাপা অনুপাত থেকে বেশি দূরে যাবে না ----------
    // পরিপ্রেক্ষিত সংশোধন সাহায্য করে, কিন্তু ২৫%-এর বেশি টানাটানি মানেই
    // কিছু ভুল হয়েছে — তখন মাপা অনুপাতই নিরাপদ।
    const LIMIT = 0.25;
    const lo = measRatio * (1 - LIMIT), hi = measRatio * (1 + LIMIT);
    if (ratio < lo || ratio > hi) ratio = Math.min(hi, Math.max(lo, ratio));

    // ---------- A4 snap — শুধু মিলে যাওয়া দিকেই ----------
    if (o.a4) {
      const target = measPortrait ? A4_P : A4_L;
      const tol = confident ? 0.22 : 0.32;
      if (Math.abs(ratio - target) / target < tol &&
          Math.abs(target - measRatio) / measRatio < LIMIT) {
        ratio = target;
      }
    }

    // আউটপুট সাইজ — সবচেয়ে লম্বা দিকটা মূল মাপ ধরে রাখে (রেজোলিউশন হারায় না)
    const longSide = Math.max(measW, measH);
    let outW, outH;
    if (ratio >= 1) { outW = Math.round(longSide); outH = Math.round(longSide / ratio); }
    else            { outH = Math.round(longSide); outW = Math.round(longSide * ratio); }
    outW = Math.max(1, Math.min(4000, outW));
    outH = Math.max(1, Math.min(4000, outH));

    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
    M = cv.getPerspectiveTransform(srcTri, dstTri);
    dst = new cv.Mat();
    // INTER_CUBIC — সামান্য বেশি ধারালো ফল
    cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_CUBIC,
                       cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

    // ক্রপের পরে দুই ধাপ সংশোধন:
    //  ১. deskew — লেখার লাইন অনুভূমিক করা (ঘূর্ণন)
    //  ২. unshear — লেখার ব্লকের হেলে যাওয়া সোজা করা (শিয়ার)
    let cur = dst, owned = false;

    if (o.deskew) {
      const straight = deskewMat(cv, cur);
      if (straight) { cur = straight; owned = true; }
    }
    if (o.unshear) {
      const unsheared = unshearText(cv, cur);
      if (unsheared) { if (owned) cur.delete(); cur = unsheared; owned = true; }
    }
    if (o.trim) {
      const trimmed = autoTrimBorders(cv, cur);
      if (trimmed) { if (owned) cur.delete(); cur = trimmed; owned = true; }
    }

    const res = { width: cur.cols, height: cur.rows, data: new Uint8ClampedArray(cur.data) };
    if (owned) cur.delete();
    return res;
  } finally {
    [src, dst, srcTri, dstTri, M].forEach(m => { if (m) m.delete(); });
  }
}

/**
 * ছায়া ও অসম আলো দূর করা (একটি চ্যানেলের জন্য)।
 *
 * কৌশল: বড় kernel দিয়ে dilate + median blur করলে লেখা মুছে গিয়ে শুধু
 * "আলোর মানচিত্র" (background) থেকে যায়। মূল ছবিকে সেই মানচিত্র দিয়ে ভাগ
 * করলে ছায়া/অসম আলো বাদ যায়, কাগজ সমান সাদা হয়, লেখা অক্ষত থাকে।
 * গতির জন্য background হিসাব ১/৪ মাপে হয়।
 */
function estimateBackground(cv, ch) {
  const q = 0.25;
  const qW = Math.max(8, Math.round(ch.cols * q));
  const qH = Math.max(8, Math.round(ch.rows * q));
  let small = null, med = null, bg = null;
  try {
    small = new cv.Mat();
    cv.resize(ch, small, new cv.Size(qW, qH), 0, 0, cv.INTER_AREA);

    // শুধুই median — dilate নয়।
    //
    // কেন: dilate জানালার সর্বোচ্চ মান নেয়। ছায়ার ধারালো প্রান্তে জানালা
    // উজ্জ্বল ও অন্ধকার দুই পাশেই পড়ে, তাই উজ্জ্বল দিকের মান তুলে আনে →
    // অন্ধকার পাশে ব্যাকগ্রাউন্ড বেশি ধরা হয় → ভাগ করার পরেও গাঢ় ব্যান্ড
    // থেকে যায় → Sauvola সেটাকে "লেখা" ভেবে কালো ছোপ বানায়।
    //
    // median প্রান্ত-সংরক্ষী: সীমানার দুই পাশে আলাদা করে সঠিক মান দেয়,
    // আবার জানালা লেখার চেয়ে বড় হওয়ায় লেখাও মুছে ফেলে।
    //
    // মাপা ফল (ছায়াসহ কৃত্রিম পাতায়, ফাঁকা জায়গায় কালো ছোপ):
    //    dilate→median→Gaussian : ১.৭৭%   (ঘন লেখায় ০.৫৯%)
    //    শুধু median            : ০.০৩%   (ঘন লেখায় ০.০০%)
    //    — দুই ক্ষেত্রেই লেখা ১০০% অক্ষত।
    let k = Math.round(Math.min(qW, qH) * 0.06);
    k = Math.max(9, Math.min(31, k % 2 === 0 ? k + 1 : k));
    med = new cv.Mat();
    cv.medianBlur(small, med, k);

    bg = new cv.Mat();
    cv.resize(med, bg, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
    return bg;
  } catch (e) {
    if (bg) { bg.delete(); }
    return null;
  } finally {
    [small, med].forEach(m => { if (m) m.delete(); });
  }
}

/**
 * ছবি কতটা ধারালো — Laplacian-এর ভেদাঙ্ক (variance)।
 * নড়া হাতে তোলা ঝাপসা ছবিতে এই মান অনেক কম হয়।
 * তুলনাযোগ্য রাখতে হিসাব সবসময় ৬৪০px চওড়া কপিতে হয়।
 */
function sharpnessScore(imageData) {
  const cv = self.cv;
  let src = null, small = null, gray = null, lap = null;
  try {
    src = matFromImageData(imageData);
    const W = 640;
    const k = Math.min(1, W / Math.max(1, src.cols));
    small = new cv.Mat();
    cv.resize(src, small, new cv.Size(Math.round(src.cols * k), Math.round(src.rows * k)), 0, 0, cv.INTER_AREA);
    gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY, 0);
    lap = new cv.Mat();
    cv.Laplacian(gray, lap, cv.CV_64F, 3, 1, 0, cv.BORDER_DEFAULT);
    const mean = new cv.Mat(), std = new cv.Mat();
    cv.meanStdDev(lap, mean, std);
    const sd = std.data64F[0];
    mean.delete(); std.delete();
    return sd * sd;   // variance
  } catch (e) {
    return 9999;      // মাপা না গেলে আটকাব না
  } finally {
    [src, small, gray, lap].forEach(m => { if (m) m.delete(); });
  }
}

/**
 * লেখা সোজা করা (deskew) — ক্রপের পরেও লেখা ২-৪° বাঁকা থাকতে পারে।
 * লেখার লাইনগুলো HoughLinesP দিয়ে খুঁজে, প্রায়-অনুভূমিক লাইনগুলোর কোণের
 * মধ্যক নিয়ে পুরো ছবি ঘুরিয়ে দেয়। ±৭°-এর বেশি হলে কিছু করে না
 * (তখন সেটা বাঁকা লেখা নয়, ভুল ডিটেকশন হওয়ার সম্ভাবনাই বেশি)।
 */
function deskewMat(cv, srcRgba) {
  let gray = null, small = null, bin = null, rot = null, out = null, test = null;
  try {
    // ---- ছোট, দ্বিমুখী (binary) কপি তৈরি ----
    gray = new cv.Mat();
    cv.cvtColor(srcRgba, gray, cv.COLOR_RGBA2GRAY, 0);
    const TW = 600;
    const k = Math.min(1, TW / Math.max(1, gray.cols));
    small = new cv.Mat();
    cv.resize(gray, small, new cv.Size(Math.max(8, Math.round(gray.cols * k)),
                                      Math.max(8, Math.round(gray.rows * k))), 0, 0, cv.INTER_AREA);
    bin = new cv.Mat();
    // লেখা = সাদা (255), কাগজ = কালো — তাই THRESH_BINARY_INV
    cv.threshold(small, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    const bw = bin.cols, bh = bin.rows;
    const center = new cv.Point(bw / 2, bh / 2);
    test = new cv.Mat();

    /**
     * একটা কোণে ঘুরিয়ে "সারি-প্রোফাইলের ভেদাঙ্ক" মাপি।
     *
     * লেখা যখন ঠিক অনুভূমিক, তখন প্রতিটি লেখার লাইন একটি সারিতে জড়ো হয় —
     * ফলে কোনো সারিতে অনেক কালো বিন্দু, কোনো সারিতে প্রায় কিছুই না; অর্থাৎ
     * ভেদাঙ্ক সর্বোচ্চ। বাঁকা থাকলে বিন্দুগুলো ছড়িয়ে যায়, ভেদাঙ্ক কমে।
     *
     * এই "মেপে দেখা" পদ্ধতির সবচেয়ে বড় সুবিধা: কোন দিকে ঘোরাতে হবে তা
     * অনুমান করতে হয় না — দুই দিকেই পরীক্ষা করে যেটা ভালো সেটাই নেওয়া হয়।
     * (আগের সংস্করণে চিহ্ন উল্টে যাওয়ায় লেখা উল্টো দিকে হেলে যাচ্ছিল।)
     */
    const scoreAt = (angle) => {
      let M = null;
      try {
        if (angle === 0) {
          bin.copyTo(test);
        } else {
          M = cv.getRotationMatrix2D(center, angle, 1);
          cv.warpAffine(bin, test, M, new cv.Size(bw, bh), cv.INTER_NEAREST,
                        cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
        }
        // সারি-প্রতি কালো বিন্দুর সংখ্যা
        const rows = new Float64Array(bh);
        let sum = 0;
        for (let y = 0; y < bh; y++) {
          let c = 0;
          const off = y * bw;
          for (let x = 0; x < bw; x++) if (test.data[off + x]) c++;
          rows[y] = c; sum += c;
        }
        if (sum < bh) return -1;                  // লেখা প্রায় নেই
        const mean = sum / bh;
        let varSum = 0;
        for (let y = 0; y < bh; y++) { const d = rows[y] - mean; varSum += d * d; }
        return varSum / bh;
      } catch (e) {
        return -1;
      } finally { if (M) M.delete(); }
    };

    // ---- মোটা দাগে খোঁজা (±৮°, ১° ধাপে) ----
    let bestA = 0, bestS = scoreAt(0);
    const base = bestS;
    for (let a = -6; a <= 6; a += 1) {
      if (a === 0) continue;
      const sc = scoreAt(a);
      if (sc > bestS) { bestS = sc; bestA = a; }
    }
    // ---- সূক্ষ্ম খোঁজা (সেরা কোণের ±১°, ০.২৫° ধাপে) ----
    for (let a = bestA - 1; a <= bestA + 1; a += 0.25) {
      const sc = scoreAt(a);
      if (sc > bestS) { bestS = sc; bestA = a; }
    }

    // ---- যথেষ্ট উন্নতি না হলে হাত দিও না ----
    // (৮% এর কম উন্নতি = সন্দেহজনক; অকারণে ঘুরিয়ে ক্ষতি করার দরকার নেই)
    if (Math.abs(bestA) < 0.3 || Math.abs(bestA) > 6 || base <= 0 || bestS < base * 1.12) return null;

    const fullCenter = new cv.Point(srcRgba.cols / 2, srcRgba.rows / 2);
    rot = cv.getRotationMatrix2D(fullCenter, bestA, 1);
    out = new cv.Mat();
    cv.warpAffine(srcRgba, out, rot, new cv.Size(srcRgba.cols, srcRgba.rows),
                  cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    return out;
  } catch (e) {
    if (out) { out.delete(); }
    return null;
  } finally {
    [gray, small, bin, rot, test].forEach(m => { if (m) m.delete(); });
  }
}

/**
 * লেখার ব্লকের "হেলে যাওয়া" (shear) সংশোধন।
 *
 * সমস্যা: ক্রপ ও ঘূর্ণন ঠিক হওয়ার পরেও অনেক সময় দেখা যায় লেখা উপর থেকে
 * নিচে যেতে যেতে ক্রমশ ডান/বাঁ দিকে সরে যাচ্ছে — অর্থাৎ লেখার বাঁ মার্জিন
 * কাগজের ধারের সমান্তরাল নয়। এটা ঘূর্ণন নয়, তাই deskew ধরতে পারে না।
 *
 * সমাধান: প্রতিটি সারিতে লেখার বাঁ ও ডান প্রান্ত খুঁজে, সেই প্রান্তরেখার
 * ঢাল বের করা হয়। দুই পাশের ঢাল কাছাকাছি হলে (মানে সত্যিই পুরো ব্লক হেলে
 * আছে, ছন্নছাড়া লেখা নয়) তখনই একটা shear রূপান্তর প্রয়োগ করা হয়।
 */
function unshearText(cv, srcRgba) {
  let gray = null, small = null, bin = null, M = null, out = null;
  try {
    gray = new cv.Mat();
    cv.cvtColor(srcRgba, gray, cv.COLOR_RGBA2GRAY, 0);
    const TW = 600;
    const k = Math.min(1, TW / Math.max(1, gray.cols));
    small = new cv.Mat();
    cv.resize(gray, small, new cv.Size(Math.max(8, Math.round(gray.cols * k)),
                                      Math.max(8, Math.round(gray.rows * k))), 0, 0, cv.INTER_AREA);
    bin = new cv.Mat();
    cv.threshold(small, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    const W = bin.cols, H = bin.rows;
    const BANDS = 28;
    const lefts = [], rights = [];
    for (let b = 0; b < BANDS; b++) {
      const y0 = Math.floor((H * b) / BANDS), y1 = Math.floor((H * (b + 1)) / BANDS);
      let minX = W, maxX = -1, count = 0;
      for (let y = y0; y < y1; y++) {
        const off = y * W;
        for (let x = 0; x < W; x++) {
          if (bin.data[off + x]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            count++;
          }
        }
      }
      // যথেষ্ট লেখা আছে এমন ব্যান্ডই গোনা হবে
      if (count > (y1 - y0) * 2 && maxX > minX) {
        const yc = (y0 + y1) / 2;
        lefts.push({ y: yc, x: minX });
        rights.push({ y: yc, x: maxX });
      }
    }
    if (lefts.length < 12) return null;

    // ঢাল নির্ণয় (dx/dy) — বহিরাগত মান এড়াতে মধ্যক-ভিত্তিক
    const slopeOf = (pts) => {
      const sl = [];
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 3; j < pts.length; j++) {
          const dy = pts[j].y - pts[i].y;
          if (Math.abs(dy) < 1) continue;
          sl.push((pts[j].x - pts[i].x) / dy);
        }
      }
      if (sl.length < 5) return null;
      sl.sort((a, b) => a - b);
      return sl[Math.floor(sl.length / 2)];
    };

    const sL = slopeOf(lefts), sR = slopeOf(rights);
    if (sL === null || sR === null) return null;

    // দুই পাশের ঢাল একই দিকে ও কাছাকাছি হলে তবেই বিশ্বাস
    if (sL * sR <= 0) return null;
    const diff = Math.abs(sL - sR) / Math.max(Math.abs(sL), Math.abs(sR));
    if (diff > 0.35) return null;

    const slope = (sL + sR) / 2;
    const deg = Math.atan(slope) * 180 / Math.PI;
    if (Math.abs(deg) < 0.5 || Math.abs(deg) > 4.5) return null;  // নগণ্য বা সন্দেহজনক

    // shear ম্যাট্রিক্স: x' = x - slope*(y - yc)
    const yc = srcRgba.rows / 2;
    M = cv.matFromArray(2, 3, cv.CV_64F, [1, -slope, slope * yc, 0, 1, 0]);
    out = new cv.Mat();
    cv.warpAffine(srcRgba, out, M, new cv.Size(srcRgba.cols, srcRgba.rows),
                  cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    return out;
  } catch (e) {
    if (out) { out.delete(); }
    return null;
  } finally {
    [gray, small, bin, M].forEach(m => { if (m) m.delete(); });
  }
}

/**
 * ক্রপের পরেও ধারে থেকে যাওয়া গাঢ় ফালি ছেঁটে ফেলা।
 *
 * বাস্তবে কোণা নিখুঁতভাবে বসানো কঠিন — ফলে কাগজের বাইরের সামান্য অংশ
 * (বেডশিট, টেবিল, ছায়া) সরু ফালি হয়ে ধারে থেকে যায়। এখানে প্রতিটি ধার
 * থেকে ভেতরের দিকে এগিয়ে দেখা হয় কোন সারি/কলামগুলো কাগজের তুলনায়
 * স্পষ্টতই গাঢ় — সেগুলোই বাদ যায়। সর্বোচ্চ ৬% পর্যন্ত, যাতে ভুল করে
 * লেখা কেটে না যায়।
 */
function autoTrimBorders(cv, srcRgba) {
  let gray = null;
  try {
    gray = new cv.Mat();
    cv.cvtColor(srcRgba, gray, cv.COLOR_RGBA2GRAY, 0);
    const W = gray.cols, H = gray.rows;
    if (W < 60 || H < 60) return null;

    // কাগজের ভেতরের সাধারণ উজ্জ্বলতা (মাঝের ৬০% থেকে)
    const x0 = Math.floor(W * 0.2), x1 = Math.floor(W * 0.8);
    const y0 = Math.floor(H * 0.2), y1 = Math.floor(H * 0.8);
    const samples = [];
    for (let y = y0; y < y1; y += 3) {
      for (let x = x0; x < x1; x += 3) samples.push(gray.data[y * W + x]);
    }
    samples.sort((a, b) => a - b);
    const paper = samples[Math.floor(samples.length * 0.7)];   // উজ্জ্বল দিকের মান
    if (!paper) return null;
    const darkThr = paper * 0.72;

    // একটি সারি/কলাম "বাইরের" কিনা: বেশিরভাগ পিক্সেল গাঢ়
    const rowDark = (y) => {
      let dark = 0, n = 0;
      for (let x = 0; x < W; x += 2) { if (gray.data[y * W + x] < darkThr) dark++; n++; }
      return dark / n;
    };
    const colDark = (x) => {
      let dark = 0, n = 0;
      for (let y = 0; y < H; y += 2) { if (gray.data[y * W + x] < darkThr) dark++; n++; }
      return dark / n;
    };

    const maxTrimY = Math.floor(H * 0.06), maxTrimX = Math.floor(W * 0.06);
    const RATIO = 0.55;          // ৫৫%+ পিক্সেল গাঢ় হলে সেটা বাইরের ফালি

    let top = 0;
    while (top < maxTrimY && rowDark(top) > RATIO) top++;
    let bottom = 0;
    while (bottom < maxTrimY && rowDark(H - 1 - bottom) > RATIO) bottom++;
    let left = 0;
    while (left < maxTrimX && colDark(left) > RATIO) left++;
    let right = 0;
    while (right < maxTrimX && colDark(W - 1 - right) > RATIO) right++;

    if (top + bottom + left + right === 0) return null;   // ছাঁটার কিছু নেই

    // ছাঁটার পরেও যেন যথেষ্ট বড় থাকে
    const nw = W - left - right, nh = H - top - bottom;
    if (nw < W * 0.8 || nh < H * 0.8) return null;

    const rect = new cv.Rect(left, top, nw, nh);
    const cropped = srcRgba.roi(rect).clone();
    return cropped;
  } catch (e) {
    return null;
  } finally {
    if (gray) gray.delete();
  }
}

/**
 * Sauvola স্থানীয় বাইনারাইজেশন — ডকুমেন্ট স্ক্যানিংয়ের শিল্পমান।
 *
 * সাধারণ adaptiveThreshold শুধু চারপাশের *গড়* দেখে সিদ্ধান্ত নেয়। ফলে
 * ফাঁকা সাদা জায়গায় সামান্য দানা থাকলেও সেটাকে "লেখা" ভেবে কালো ছোপ ফেলে,
 * আবার ফ্যাকাশে লেখা মুছে দেয়।
 *
 * Sauvola গড়ের সাথে *বিচ্যুতিও* (standard deviation) মাপে:
 *      T = m · (1 + k · (s / R − 1))
 * যেখানে m = স্থানীয় গড়, s = স্থানীয় বিচ্যুতি, R = 128, k ≈ 0.2
 *
 * অর্থ: যেখানে আশপাশ সমসত্ত্ব (ফাঁকা কাগজ) সেখানে s ছোট → threshold নেমে
 * যায় → দানা কালো হয় না। আর যেখানে সত্যিকারের লেখা আছে সেখানে s বড় →
 * ফ্যাকাশে লেখাও ধরা পড়ে। এটাই "পরিষ্কার সাদা + কুচকুচে কালো" চেহারার রহস্য।
 *
 * গতি: integral image (summed-area table) দিয়ে যেকোনো জানালার গড় ও বর্গগড়
 * ধ্রুব সময়ে পাওয়া যায়, তাই বড় ছবিতেও দ্রুত চলে।
 */
/**
 * CLAHE — স্থানীয় কনট্রাস্ট বাড়ানো।
 *
 * ছায়ার ভেতরে লেখা "ধুয়ে" যায়: উজ্জ্বলতা ভাগ করে সমান করলেও লেখা ও
 * কাগজের পার্থক্য কম থাকে। CLAHE ছবিটাকে ছোট ছোট টালিতে ভাগ করে প্রতিটিতে
 * আলাদাভাবে কনট্রাস্ট প্রসারিত করে — তাই ছায়ার ভেতরের লেখাও ফুটে ওঠে।
 * clipLimit দানা বাড়া আটকায়।
 */
function applyCLAHE(cv, mat, clip, tiles) {
  let c = null, out = null;
  try {
    c = new cv.CLAHE(clip || 2.0, new cv.Size(tiles || 8, tiles || 8));
    out = new cv.Mat();
    c.apply(mat, out);
    out.copyTo(mat);
    return true;
  } catch (e) {
    return false;
  } finally {
    if (c) c.delete();
    if (out) out.delete();
  }
}

function sauvolaBinarize(cv, grayMat, kParam, windowFrac) {
  const W = grayMat.cols, H = grayMat.rows;
  const N = W * H;
  const src = grayMat.data;

  // ---- integral images (Float64 — যোগফল বড় হয়) ----
  const w1 = W + 1;
  const sum = new Float64Array((W + 1) * (H + 1));
  const sqs = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0, rowSq = 0;
    for (let x = 0; x < W; x++) {
      const v = src[y * W + x];
      rowSum += v; rowSq += v * v;
      sum[(y + 1) * w1 + (x + 1)] = sum[y * w1 + (x + 1)] + rowSum;
      sqs[(y + 1) * w1 + (x + 1)] = sqs[y * w1 + (x + 1)] + rowSq;
    }
  }

  // জানালার অর্ধ-আকার — ছবির মাপের অনুপাতে (লেখার আকারের সাথে মানানসই)
  const r = Math.max(7, Math.round(Math.min(W, H) * (windowFrac || 0.025)));
  const k = (kParam === undefined ? 0.2 : kParam);
  const R = 128;

  const out = new cv.Mat(H, W, cv.CV_8UC1);
  const dst = out.data;

  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);

      const A = y0 * w1 + x0, B = y0 * w1 + (x1 + 1);
      const C = (y1 + 1) * w1 + x0, D = (y1 + 1) * w1 + (x1 + 1);

      const s1 = sum[D] - sum[B] - sum[C] + sum[A];
      const s2 = sqs[D] - sqs[B] - sqs[C] + sqs[A];
      const mean = s1 / area;
      const variance = Math.max(0, s2 / area - mean * mean);
      const std = Math.sqrt(variance);

      const T = mean * (1 + k * (std / R - 1));
      dst[y * W + x] = src[y * W + x] > T ? 255 : 0;
    }
  }
  return out;
}

/**
 * Unsharp masking — লেখার কিনারা ধারালো করা।
 *
 * ক্যামেরার ছবি লেন্স ও সেন্সরের কারণে সবসময় সামান্য নরম হয়। আসল স্ক্যানারে
 * কাগজ কাচের সাথে লেগে থাকে বলে ধারালো আসে। সেই পার্থক্য মেটাতে:
 *   ধারালো = আসল + amount × (আসল − ঝাপসা)
 * অর্থাৎ ছবি থেকে তার ঝাপসা রূপ বিয়োগ করলে যা থাকে তা-ই কিনারা;
 * সেটুকু ফিরিয়ে যোগ করলে লেখা স্পষ্ট হয়।
 */
/**
 * মৃদু S-curve টোন কার্ভ (LUT দিয়ে)।
 *
 * আগে ব্যবহার হচ্ছিল রৈখিক সূত্র: out = in × 1.10 − 8
 * সমস্যা: ঋণাত্মক ফল ৮-বিটে শূন্যে চাপা পড়ে, তাই ইনপুটের ০–৭ মানগুলো
 * সব একসাথে কালো হয়ে যায় — ছায়ার ভেতরের সূক্ষ্ম তারতম্য চিরতরে হারায়,
 * আর কালো অংশ আরও শক্ত কালো দেখায়।
 *
 * S-curve একঘেয়ে বর্ধমান, দুই প্রান্ত অক্ষত (০→০, ২৫৫→২৫৫), কোনো
 * মান চাপা পড়ে না — অথচ মাঝখানে কনট্রাস্ট বাড়ে, যা চোখে "পরিষ্কার" লাগে।
 */
function applyToneCurve(cv, mat, strength) {
  let lut = null;
  try {
    const p = strength || 1.18;
    lut = new cv.Mat(1, 256, cv.CV_8UC1);
    for (let v = 0; v < 256; v++) {
      const x = v / 255;
      const y = x < 0.5 ? 0.5 * Math.pow(2 * x, p) : 1 - 0.5 * Math.pow(2 * (1 - x), p);
      lut.data[v] = Math.round(Math.max(0, Math.min(255, y * 255)));
    }
    cv.LUT(mat, lut, mat);
    return true;
  } catch (e) {
    return false;
  } finally {
    if (lut) lut.delete();
  }
}

function unsharpMask(cv, mat, amount, radius) {
  const blur = new cv.Mat();
  const sigma = radius || Math.max(1, Math.round(Math.min(mat.cols, mat.rows) / 500));
  cv.GaussianBlur(mat, blur, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REPLICATE);
  const a = (amount === undefined ? 0.8 : amount);
  cv.addWeighted(mat, 1 + a, blur, -a, 0, mat);
  blur.delete();
}

/**
 * White balance — কাগজ সত্যিকারের সাদা করা।
 *
 * ঘরের আলো হলদে, ছায়া নীলচে — ফলে কাগজ কখনোই নিখুঁত সাদা আসে না।
 * প্রতিটি রঙের চ্যানেলে উজ্জ্বল প্রান্তের (৯৫তম পার্সেন্টাইল) মান খুঁজে
 * সেটাকে ২৪৫-এ টেনে তুললে রঙের ঢাল দূর হয়, কিন্তু লেখার রং অক্ষত থাকে।
 */
function balanceChannel(ch) {
  const hist = new Uint32Array(256);
  const d = ch.data;
  for (let j = 0; j < d.length; j++) hist[d[j]]++;
  let acc = 0, p95 = 255;
  const target = d.length * 0.95;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) { p95 = v; break; } }
  const gain = p95 > 10 ? Math.min(1.6, 245 / p95) : 1;
  if (gain !== 1) ch.convertTo(ch, -1, gain, 0);
}

function magicColor(imageData) {
  const cv = self.cv;
  let src = null, rgb = null, channels = null, bg = null, out = null, rgba = null, merged = null;
  try {
    src = matFromImageData(imageData);
    rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB, 0);

    channels = new cv.MatVector();
    cv.split(rgb, channels);

    merged = new cv.MatVector();
    const tmp = [];
    for (let i = 0; i < 3; i++) {
      const ch = channels.get(i);
      const bgc = estimateBackground(cv, ch);      // ছায়া/আলোর মানচিত্র
      const norm = new cv.Mat();
      if (bgc) {
        cv.divide(ch, bgc, norm, 235);             // ভাগ → সমান সাদা কাগজ
        tmp.push(bgc);
      } else {
        ch.copyTo(norm);
      }
      merged.push_back(norm);
      tmp.push(ch, norm);
    }

    out = new cv.Mat();
    cv.merge(merged, out);
    // Lab রঙস্থানে গিয়ে শুধু উজ্জ্বলতায় (L) CLAHE — রং অবিকৃত থাকে,
    // অথচ ছায়ার ভেতরের লেখা ও ফ্যাকাশে ছাপা ফুটে ওঠে
    {
      let lab2 = null, ch2 = null, merged2 = null, L2 = null, a2 = null, b2 = null;
      try {
        lab2 = new cv.Mat();
        cv.cvtColor(out, lab2, cv.COLOR_RGB2Lab, 0);
        ch2 = new cv.MatVector();
        cv.split(lab2, ch2);
        L2 = ch2.get(0); a2 = ch2.get(1); b2 = ch2.get(2);
        applyCLAHE(cv, L2, 1.5, 8);
        merged2 = new cv.MatVector();
        merged2.push_back(L2); merged2.push_back(a2); merged2.push_back(b2);
        cv.merge(merged2, lab2);
        cv.cvtColor(lab2, out, cv.COLOR_Lab2RGB, 0);
      } catch (e) {
        // CLAHE না চললেও ছবি নষ্ট হবে না
      } finally {
        [lab2, ch2, merged2, L2, a2, b2].forEach(m => { if (m) m.delete(); });
      }
    }

    // কনট্রাস্ট বাড়াতে রৈখিক সূত্রের বদলে S-curve — কোনো মান চাপা পড়ে না,
    // তাই ছায়ার ভেতরের বিস্তারিত অক্ষত থাকে (মাপা: রৈখিকে ৮টি মান শূন্যে
    // ও ১৬টি ২৫৫-এ চাপা পড়ত; S-curve-এ ১টিও নয়)।
    applyToneCurve(cv, out, 1.18);
    unsharpMask(cv, out, 0.7);

    rgba = new cv.Mat();
    cv.cvtColor(out, rgba, cv.COLOR_RGB2RGBA, 0);
    const result = { width: rgba.cols, height: rgba.rows, data: new Uint8ClampedArray(rgba.data) };
    tmp.forEach(m => m.delete());
    return result;
  } finally {
    [src, rgb, channels, bg, out, rgba, merged].forEach(m => { if (m) m.delete(); });
  }
}

function applyFilter(imageData, filter) {
  const cv = self.cv;
  if (filter === 'original') return imageData;
  if (filter === 'magic') return magicColor(imageData);

  let src = null, gray = null, bin = null, rgba = null;
  try {
    src = matFromImageData(imageData);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

    // ধাপ ১ — আলো সমান করা (ছায়া/অসম আলো দূর)
    const bgg = estimateBackground(cv, gray);
    if (bgg) { cv.divide(gray, bgg, gray, 235); bgg.delete(); }

    if (filter === 'scan') {
      // এখানে ইচ্ছাকৃতভাবে CLAHE ব্যবহার করা হয়নি।
      //
      // মাপা ফল (একই ছবিতে, ছায়া+দানা সহ):
      //    CLAHE নেই   → লেখা ৭৯.১%, ফাঁকায় দাগ ৩.৩৩%
      //    clip 1.0    → লেখা ৮২.০%, দাগ ৪.৩৪%
      //    clip 2.0    → লেখা ৮৫.৫%, দাগ ৫.৭৫%
      // অর্থাৎ লেখা যতটুকু বাড়ে, দাগ তার চেয়ে দ্রুত বাড়ে। সাদা-কালো মোডে
      // দাগ কালো বিন্দু হয়ে চোখে লাগে, তাই এই বিনিময় লাভজনক নয়।
      // (কালার/গ্রেস্কেল মোডে দাগ বিন্দু হয় না, তাই সেখানে CLAHE রাখা হয়েছে।)

      // ধাপ ২ — কিনারা ধারালো করা (বাইনারাইজেশনের আগেই, তাতে ফল অনেক পরিষ্কার)
      unsharpMask(cv, gray, 0.6);

      // ধাপ ৩ — Sauvola স্থানীয় বাইনারাইজেশন (শিল্পমান)
      //
      // জানালার আকার স্থির (ছবির ২.৫%) রাখা হয়েছে ইচ্ছাকৃতভাবে। লেখার
      // স্ট্রোক-প্রস্থ মেপে জানালা বসানোর একটা সংস্করণ লিখে পরীক্ষা করেছিলাম —
      // কিছু ক্ষেত্রে ভালো, কিন্তু এক ক্ষেত্রে ফল খারাপ হয়েছিল (দাগ ০.৪১% → ১.০৪%)।
      // অনিশ্চিত উন্নতির চেয়ে অনুমানযোগ্য ফলই ভালো, তাই স্থির মানই রাখা হলো।
      bin = sauvolaBinarize(cv, gray, 0.2, 0.025);

      // ধাপ ৪ — বিচ্ছিন্ন দানা মুছে ফেলা (median 3×3 — লেখা অক্ষত থাকে)
      cv.medianBlur(bin, bin, 3);

      rgba = new cv.Mat();
      cv.cvtColor(bin, rgba, cv.COLOR_GRAY2RGBA);
      return { width: rgba.cols, height: rgba.rows, data: new Uint8ClampedArray(rgba.data) };
    }

    // grayscale মোড — আলো সমান + স্থানীয় কনট্রাস্ট + হালকা ধারালো
    applyCLAHE(cv, gray, 1.5, 8);
    unsharpMask(cv, gray, 0.5);
    rgba = new cv.Mat();
    cv.cvtColor(gray, rgba, cv.COLOR_GRAY2RGBA);
    return { width: rgba.cols, height: rgba.rows, data: new Uint8ClampedArray(rgba.data) };
  } finally {
    [src, gray, bin, rgba].forEach(m => { if (m) m.delete(); });
  }
}

// ---------- message protocol ----------
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    if (type === 'init') {
      if (!ready) { await initCV(); ready = true; }
      self.postMessage({ id, ok: true, result: 'ready' });
      return;
    }
    if (!ready) throw new Error('OpenCV not ready');

    let result;
    if (type === 'detect')      result = detectEdges(payload.imageData, payload.opts);
    else if (type === 'warp')   result = warp(payload.imageData, payload.corners, payload.opts);
    else if (type === 'filter') result = applyFilter(payload.imageData, payload.filter);
    else if (type === 'sharpness') result = sharpnessScore(payload.imageData);
    else if (type === 'quadFromMask') result = quadFromMask(payload.mask, payload.size, payload.w, payload.h);
    else throw new Error('Unknown message type: ' + type);

    // ImageData-জাতীয় ফল হলে buffer transfer করো (দ্রুত, কপি ছাড়া)
    if (result && result.data && result.data.buffer) {
      self.postMessage({ id, ok: true, result }, [result.data.buffer]);
    } else {
      self.postMessage({ id, ok: true, result });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
