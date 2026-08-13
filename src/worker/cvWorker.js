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

// বইয়ের ভাঁজ: quad-এর ভেতরে লম্বা প্রায়-উল্লম্ব রেখা খুঁজে ধার সরাও
function refineGutter(cv, edgesMat, quad) {
  let lines = null;
  try {
    const qH = Math.max(
      Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y),
      Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y)
    );
    const qW = Math.max(
      Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y),
      Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y)
    );
    lines = new cv.Mat();
    // লম্বা রেখাই চাই: minLineLength = quad উচ্চতার ৬৫%
    cv.HoughLinesP(edgesMat, lines, 1, Math.PI / 180, 60, qH * 0.65, qH * 0.08);

    const minX = Math.min(...quad.map(p => p.x)), maxX = Math.max(...quad.map(p => p.x));
    let best = null; // {x, len}
    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32S[i*4], y1 = lines.data32S[i*4+1];
      const x2 = lines.data32S[i*4+2], y2 = lines.data32S[i*4+3];
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      // প্রায়-উল্লম্ব? (উল্লম্ব থেকে ±12°)
      if (Math.abs(dx) > Math.abs(dy) * 0.21) continue;
      const midX = (x1 + x2) / 2;
      const t = (midX - minX) / (maxX - minX); // quad-প্রস্থে অবস্থান 0..1
      // quad-এর ভেতরের দিকে (ধার থেকে দূরে) — ১৫%..৮৫%
      if (t < 0.15 || t > 0.85) continue;
      if (!best || len > best.len) best = { x: midX, t, len };
    }
    if (!best) return quad;

    // কোন ধার সরবে? রেখা যেদিকে কাছে সেদিকের ধার
    const moveLeft = best.t < 0.5;
    const refined = quad.map(p => ({ ...p }));
    if (moveLeft) { refined[0].x = best.x; refined[3].x = best.x; }  // TL, BL
    else          { refined[1].x = best.x; refined[2].x = best.x; }  // TR, BR
    return refined;
  } catch (e) {
    return quad; // কোনো সমস্যায় আগেরটাই
  } finally {
    if (lines) lines.delete();
  }
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
      bestQuadSmall = refineGutter(cv, edges, bestQuadSmall);

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
    // কমপক্ষে 1px — degenerate কোণায় 0-size warp WASM ক্র্যাশ করাতে পারে
    const maxW = Math.max(1, Math.max(Math.hypot(br.x-bl.x, br.y-bl.y), Math.hypot(tr.x-tl.x, tr.y-tl.y)) | 0);
    const maxH = Math.max(1, Math.max(Math.hypot(tr.x-br.x, tr.y-br.y), Math.hypot(tl.x-bl.x, tl.y-bl.y)) | 0);
    srcTri = cv.matFromArray(4,1,cv.CV_32FC2,[tl.x,tl.y,tr.x,tr.y,br.x,br.y,bl.x,bl.y]);
    dstTri = cv.matFromArray(4,1,cv.CV_32FC2,[0,0,maxW,0,maxW,maxH,0,maxH]);
    M = cv.getPerspectiveTransform(srcTri, dstTri);
    dst = new cv.Mat();
    cv.warpPerspective(src, dst, M, new cv.Size(maxW, maxH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
    // src RGBA (CV_8UC4), তাই dst-ও RGBA — সরাসরি data নেওয়া যায়
    // (আগের cv.COLOR_RGBA2RGBA constant-টির অস্তিত্বই নেই — সেটিই warp fail-এর কারণ ছিল)
    return { width: dst.cols, height: dst.rows, data: new Uint8ClampedArray(dst.data) };
  } finally {
    [src,dst,srcTri,dstTri,M].forEach(m => { if (m) m.delete(); });
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
    // ব্যাকগ্রাউন্ড হিসাব ১/৪ সাইজে (≈১৬x দ্রুত), blur ছবির মাপের অনুপাতে —
    // ফলে বড় ছবিতেও আলোর প্যাটার্ন ঠিক ধরা পড়ে, লেখা ফিকে হয় না
    const q = 0.25;
    const qW = Math.max(1, Math.round(rgb.cols * q));
    const qH = Math.max(1, Math.round(rgb.rows * q));
    const sigmaQ = Math.max(8, Math.round(Math.max(qW, qH) / 40));
    for (let i = 0; i < 3; i++) {
      const ch = channels.get(i);
      const chSmall = new cv.Mat();
      cv.resize(ch, chSmall, new cv.Size(qW, qH), 0, 0, cv.INTER_AREA);
      const blurSmall = new cv.Mat();
      cv.GaussianBlur(chSmall, blurSmall, new cv.Size(0, 0), sigmaQ, sigmaQ, cv.BORDER_DEFAULT);
      const blur = new cv.Mat();
      cv.resize(blurSmall, blur, new cv.Size(rgb.cols, rgb.rows), 0, 0, cv.INTER_LINEAR);
      const norm = new cv.Mat();
      // ch/blur * 235 → ব্যাকগ্রাউন্ড ≈ সাদা (235), রং সংরক্ষিত
      cv.divide(ch, blur, norm, 235);
      merged.push_back(norm);
      tmp.push(ch, chSmall, blurSmall, blur, norm);
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
