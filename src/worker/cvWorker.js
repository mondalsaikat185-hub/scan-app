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

function detectEdges(imageData) {
  const cv = self.cv;
  const W = imageData.width, H = imageData.height;

  // --- ছোট কপিতে কাজ (দ্রুত + noise কম) ---
  const DETECT_DIM = 1000;
  const scale = Math.min(1, DETECT_DIM / Math.max(W, H));
  let full = null, small = null, gray = null;
  let smallW = 0, smallH = 0;
  const candidates = []; // {pts:[4], score}

  const quadScore = (ptsIn, imgArea, imgW, imgH) => {
    const pts = orderPoints(ptsIn);
    // area বড় + কোণ ~90° হলে score বেশি
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      area += a.x * b.y - b.x * a.y;
    }
    area = Math.abs(area) / 2;
    const areaRatio = area / imgArea;
    if (areaRatio < 0.15 || areaRatio > 0.99) return 0; // খুব ছোট/পুরো ফ্রেম বাদ

    // ডকুমেন্ট প্রায় সবসময় ছবির কেন্দ্র ঢেকে রাখে — কেন্দ্র quad-এর ভেতরে না থাকলে বাদ
    // (এতে "ভীষণ ছোট" ভুল ডিটেকশন দূর হয়)
    const cx = imgW / 2, cy = imgH / 2;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      const cross = (b.x - a.x) * (cy - a.y) - (b.y - a.y) * (cx - a.x);
      if (cross !== 0) {
        if (sign === 0) sign = Math.sign(cross);
        else if (Math.sign(cross) !== sign) return 0; // কেন্দ্র বাইরে
      }
    }

    let angPenalty = 0;
    for (let i = 0; i < 4; i++) {
      const p0 = pts[(i + 3) % 4], p1 = pts[i], p2 = pts[(i + 1) % 4];
      const v1 = { x: p0.x - p1.x, y: p0.y - p1.y }, v2 = { x: p2.x - p1.x, y: p2.y - p1.y };
      const dot = v1.x * v2.x + v1.y * v2.y;
      const n = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1;
      const ang = Math.acos(Math.max(-1, Math.min(1, dot / n))) * 180 / Math.PI;
      angPenalty += Math.abs(90 - ang);
    }
    let s = areaRatio * Math.max(0, 1 - angPenalty / 160);

    // প্রায় পুরো-ফ্রেম quad (সব কোণা ছবির কোণার ৩%-এর মধ্যে) = আসলে কিছু পায়নি — কম প্রাধান্য
    const eps = Math.max(imgW, imgH) * 0.03;
    const nearFrame = pts.every(p =>
      (p.x < eps || p.x > imgW - eps) && (p.y < eps || p.y > imgH - eps));
    if (nearFrame) s *= 0.5;

    return s;
  };

  const harvest = (binaryMat, imgArea) => {
    let contours = null, hier = null;
    try {
      contours = new cv.MatVector(); hier = new cv.Mat();
      cv.findContours(binaryMat, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        if (cv.contourArea(cnt) > imgArea * 0.1) {
          const hull = new cv.Mat();
          cv.convexHull(cnt, hull, false, true);
          const poly = new cv.Mat();
          cv.approxPolyDP(hull, poly, 0.02 * cv.arcLength(hull, true), true);
          if (poly.rows === 4) {
            const pts = [];
            for (let k = 0; k < 4; k++) pts.push({ x: poly.data32S[k * 2], y: poly.data32S[k * 2 + 1] });
            const s = quadScore(pts, imgArea, smallW, smallH);
            if (s > 0) candidates.push({ pts, score: s });
          } else if (poly.rows > 4) {
            // fallback প্রার্থী: ঘোরানো bounding box
            const rr = cv.minAreaRect(cnt);
            const v = cv.RotatedRect.points(rr);
            const pts = v.map(p => ({ x: p.x, y: p.y }));
            const s = quadScore(pts, imgArea, smallW, smallH) * 0.8; // সরাসরি 4-gon-এর চেয়ে কম প্রাধান্য
            if (s > 0) candidates.push({ pts, score: s });
          }
          poly.delete(); hull.delete();
        }
        cnt.delete();
      }
    } finally { if (contours) contours.delete(); if (hier) hier.delete(); }
  };

  try {
    full = matFromImageData(imageData);
    small = new cv.Mat();
    if (scale < 1) cv.resize(full, small, new cv.Size(Math.round(W * scale), Math.round(H * scale)), 0, 0, cv.INTER_AREA);
    else full.copyTo(small);
    gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY, 0);
    const imgArea = small.cols * small.rows;
    smallW = small.cols; smallH = small.rows;

    // --- পদ্ধতি ১: blur + Canny (মাঝারি) + dilate ---
    let blur = new cv.Mat(), edges = new cv.Mat(), dil = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, 50, 150);
    const M = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, dil, M, new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    harvest(dil, imgArea);

    // --- পদ্ধতি ২: Canny কড়া threshold ---
    let edges2 = new cv.Mat(), dil2 = new cv.Mat();
    cv.Canny(blur, edges2, 100, 250);
    cv.dilate(edges2, dil2, M, new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    harvest(dil2, imgArea);

    // --- পদ্ধতি ৩: Otsu binary (উজ্জ্বল কাগজ vs গাঢ় ব্যাকগ্রাউন্ড) ---
    let bin = new cv.Mat();
    cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    harvest(bin, imgArea);

    M.delete(); blur.delete(); edges2.delete(); dil.delete(); dil2.delete(); bin.delete();

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      let bestQuadSmall = orderPoints(candidates[0].pts);
      // Gutter refinement using edges from method 1
      bestQuadSmall = refineGutter(cv, gray, bestQuadSmall);

      const bestPts = bestQuadSmall.map(p => ({
        x: Math.max(0, Math.min(W, p.x / scale)),
        y: Math.max(0, Math.min(H, p.y / scale)),
      }));
      edges.delete();
      return bestPts;
    }
    
    edges.delete();
    // কিছুই না পেলে — ৫% মার্জিনে default
    const mx = W * 0.05, my = H * 0.05;
    return [{x:mx,y:my},{x:W-mx,y:my},{x:W-mx,y:H-my},{x:mx,y:H-my}];
  } finally {
    [full, small, gray].forEach(m => { if (m) m.delete(); });
  }
}

function warp(imageData, corners) {
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
    // A4-এর কাছাকাছি হলে ঠিক A4 অনুপাতে বসাও — প্রিন্টে নিখুঁত হবে।
    // অনুমান আত্মবিশ্বাসী হলে কড়া সীমা (২২%), না হলে শিথিল (৩২%) —
    // কারণ তখন A4 হওয়ার সম্ভাবনাই বেশি। রসিদ/কার্ড এই সীমার বাইরে থাকে।
    const tol = confident ? 0.22 : 0.32;
    for (const target of [A4_P, A4_L]) {
      if (Math.abs(ratio - target) / target < tol) { ratio = target; break; }
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

    // ক্রপের পরেও লেখা সামান্য বাঁকা থাকলে সোজা করো
    const straight = deskewMat(cv, dst);
    if (straight) {
      const res = { width: straight.cols, height: straight.rows, data: new Uint8ClampedArray(straight.data) };
      straight.delete();
      return res;
    }
    return { width: dst.cols, height: dst.rows, data: new Uint8ClampedArray(dst.data) };
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
  let small = null, dil = null, med = null, bg = null, kernel = null;
  try {
    small = new cv.Mat();
    cv.resize(ch, small, new cv.Size(qW, qH), 0, 0, cv.INTER_AREA);

    // kernel ছবির মাপের সাথে মানানসই (ছোট ছবিতে ছোট, বড়তে বড়)
    const k = Math.max(3, (Math.round(Math.max(qW, qH) / 60) * 2 + 1));
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));
    dil = new cv.Mat();
    cv.dilate(small, dil, kernel, new cv.Point(-1, -1), 1,
              cv.BORDER_REPLICATE, cv.morphologyDefaultBorderValue());

    // medianBlur ksize বিজোড় ও ≤ ৩১ রাখি
    let mk = Math.max(3, Math.min(31, (Math.round(k / 2) * 2 + 1)));
    med = new cv.Mat();
    cv.medianBlur(dil, med, mk);

    bg = new cv.Mat();
    cv.resize(med, bg, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
    return bg;
  } catch (e) {
    if (bg) { bg.delete(); }
    return null;
  } finally {
    [small, dil, med, kernel].forEach(m => { if (m) m.delete(); });
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
  let gray = null, bin = null, edges = null, lines = null, rot = null, out = null;
  try {
    gray = new cv.Mat();
    cv.cvtColor(srcRgba, gray, cv.COLOR_RGBA2GRAY, 0);
    edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150);
    lines = new cv.Mat();
    const minLen = Math.max(40, srcRgba.cols * 0.25);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 80, minLen, 12);

    const angles = [];
    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32S[i*4], y1 = lines.data32S[i*4+1];
      const x2 = lines.data32S[i*4+2], y2 = lines.data32S[i*4+3];
      const dx = x2 - x1, dy = y2 - y1;
      if (Math.abs(dx) < 1) continue;
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      if (Math.abs(ang) <= 7) angles.push(ang);   // প্রায়-অনুভূমিক লাইনই লেখা
    }
    if (angles.length < 6) return null;            // যথেষ্ট প্রমাণ নেই

    angles.sort((a, b) => a - b);
    const med = angles[Math.floor(angles.length / 2)];
    if (Math.abs(med) < 0.25 || Math.abs(med) > 7) return null;  // নগণ্য বা সন্দেহজনক

    const center = new cv.Point(srcRgba.cols / 2, srcRgba.rows / 2);
    rot = cv.getRotationMatrix2D(center, med, 1);
    out = new cv.Mat();
    cv.warpAffine(srcRgba, out, rot, new cv.Size(srcRgba.cols, srcRgba.rows),
                  cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    return out;
  } catch (e) {
    if (out) { out.delete(); }
    return null;
  } finally {
    [gray, bin, edges, lines, rot].forEach(m => { if (m) m.delete(); });
  }
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
    // হালকা কনট্রাস্ট: alpha=1.15, beta=-12
    out.convertTo(out, -1, 1.15, -12);

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
  
  let src = null, dst = null, rgba = null;
  try {
    src = matFromImageData(imageData);
    dst = new cv.Mat();
    cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY, 0);

    // ছায়া/অসম আলো দূর — grayscale ও scan দুটোতেই
    const bgg = estimateBackground(cv, dst);
    if (bgg) { cv.divide(dst, bgg, dst, 235); bgg.delete(); }

    if (filter === 'scan') {
      cv.GaussianBlur(dst, dst, new cv.Size(5,5), 0, 0, cv.BORDER_DEFAULT);
      cv.adaptiveThreshold(dst, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 10);
    }
    rgba = new cv.Mat();
    cv.cvtColor(dst, rgba, cv.COLOR_GRAY2RGBA);
    return { width: rgba.cols, height: rgba.rows, data: new Uint8ClampedArray(rgba.data) };
  } finally {
    [src,dst,rgba].forEach(m => { if (m) m.delete(); });
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
    if (type === 'detect')      result = detectEdges(payload.imageData);
    else if (type === 'warp')   result = warp(payload.imageData, payload.corners);
    else if (type === 'filter') result = applyFilter(payload.imageData, payload.filter);
    else if (type === 'sharpness') result = sharpnessScore(payload.imageData);
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
