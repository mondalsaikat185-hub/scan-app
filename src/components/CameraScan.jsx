import React, { useEffect, useRef, useState, useCallback } from 'react';
import { detectEdges, sharpnessOf } from '../lib/cvClient';
import './CameraScan.css';

const DETECT_W = 560;        // ডিটেকশন ফ্রেমের প্রস্থ (বেশি = নির্ভুল, কম = দ্রুত)
const STABLE_FRAMES = 4;     // পরপর কত ফ্রেম স্থির হলে অটো-ক্যাপচার
const STABLE_TOL = 0.035;    // নড়াচড়ার সীমা (quad-এর নিজের মাপের অনুপাতে)
const SMOOTH = 0.5;          // EMA — ওভারলের কাঁপুনি কমায়
const HISTORY = 3;           // কত ফ্রেমের মধ্যক (median) নেওয়া হবে
const OUTLIER_TOL = 0.14;    // মধ্যক থেকে এত দূরের ফ্রেম "বিক্ষিপ্ত" ধরে বাদ
const MIN_SHARPNESS = 55;    // এর নিচে হলে ছবি ঝাপসা — অটো-ক্যাপচার আটকাবে

// কয়েক ফ্রেমের কোণার মধ্যক (median) — একটা-দুটো ভুল ফ্রেম ফেলে দেয়।
// গড়ের চেয়ে মধ্যক অনেক বেশি নির্ভরযোগ্য: একটা ফ্রেম বাজেভাবে ভুল হলেও ফল নড়ে না।
function medianQuad(list) {
  if (list.length === 1) return list[0];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const xs = list.map(q => q[i].x).sort((a, b) => a - b);
    const ys = list.map(q => q[i].y).sort((a, b) => a - b);
    const m = Math.floor(list.length / 2);
    out.push({
      x: list.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2,
      y: list.length % 2 ? ys[m] : (ys[m - 1] + ys[m]) / 2,
    });
  }
  return out;
}

// দুটো quad কতটা আলাদা (quad-এর মাপের অনুপাতে)
function quadDiff(a, b) {
  const size = Math.max(
    Math.hypot(a[1].x - a[0].x, a[1].y - a[0].y),
    Math.hypot(a[3].x - a[0].x, a[3].y - a[0].y)
  ) || 1;
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    worst = Math.max(worst, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  }
  return worst / size;
}

// quad আদৌ বিশ্বাসযোগ্য কিনা: যথেষ্ট বড়, উত্তল, স্বাভাবিক অনুপাত
function isPlausible(quad, w, h) {
  if (!quad || quad.length !== 4) return false;
  if (quad.some(p => !isFinite(p.x) || !isFinite(p.y))) return false;

  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;
  const ratio = area / (w * h);
  if (ratio < 0.20 || ratio > 0.985) return false;      // খুব ছোট বা পুরো ফ্রেম

  // উত্তল (convex) কিনা — সব cross product একই দিকে
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = quad[i], p1 = quad[(i + 1) % 4], p2 = quad[(i + 2) % 4];
    const cr = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (Math.abs(cr) < 1e-6) continue;
    if (sign === 0) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) return false;
  }

  // ধারের অনুপাত অস্বাভাবিক নয় (বিকৃত/সরু quad বাদ)
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wTop = d(quad[0], quad[1]), wBot = d(quad[3], quad[2]);
  const hL = d(quad[0], quad[3]), hR = d(quad[1], quad[2]);
  if (Math.min(wTop, wBot) < Math.max(wTop, wBot) * 0.45) return false;
  if (Math.min(hL, hR) < Math.max(hL, hR) * 0.45) return false;
  const side = Math.max(wTop, wBot) / Math.max(1, Math.max(hL, hR));
  if (side < 0.25 || side > 4) return false;

  return true;
}

// দুটো quad-এর গড় (EMA)
function blendQuad(prev, next, alpha) {
  if (!prev) return next;
  return next.map((p, i) => ({
    x: prev[i].x + (p.x - prev[i].x) * alpha,
    y: prev[i].y + (p.y - prev[i].y) * alpha,
  }));
}

export default function CameraScan({ onCaptured, onFallback, onCancel }) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const detectCanvasRef = useRef(document.createElement('canvas'));
  const streamRef = useRef(null);
  const runningRef = useRef(true);
  const lastQuadRef = useRef(null);
  const stableCountRef = useRef(0);
  const smoothQuadRef = useRef(null);
  const historyRef = useRef([]);
  const sharpCheckRef = useRef(false);
  const blurCountRef = useRef(0);
  const capturingRef = useRef(false);
  const [err, setErr] = useState(null);
  const [stablePct, setStablePct] = useState(0);
  const [hint, setHint] = useState('কাগজ ফ্রেমে আনুন');

  // ---- ক্যাপচার: পুরো রেজোলিউশনের ফ্রেম + কোণা স্কেল-আপ ----
  const capture = useCallback((quadSmall) => {
    if (capturingRef.current) return;
    capturingRef.current = true;
    runningRef.current = false;
    const video = videoRef.current;
    const full = document.createElement('canvas');
    full.width = video.videoWidth;
    full.height = video.videoHeight;
    full.getContext('2d').drawImage(video, 0, 0);
    let corners = null;
    if (quadSmall) {
      const k = video.videoWidth / detectCanvasRef.current.width;
      corners = quadSmall.map(p => ({ x: p.x * k, y: p.y * k }));
    }
    onCaptured(full, corners);   // App এটাকে crop স্ক্রিনে পাঠাবে
  }, [onCaptured]);

  // ---- ক্যামেরা চালু ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 2560 }, height: { ideal: 1920 },
          },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();
        detectLoop();
      } catch (e) {
        console.warn('Camera unavailable:', e);
        setErr('ক্যামেরা পাওয়া যায়নি');
        setTimeout(() => onFallback(), 800);  // ফাইল-ইনপুট ফলব্যাক
      }
    })();
    return () => {
      cancelled = true;
      runningRef.current = false;
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- ডিটেকশন লুপ: আগেরটা শেষ হলে তবেই পরের ফ্রেম ----
  const detectLoop = useCallback(async () => {
    const video = videoRef.current;
    const dc = detectCanvasRef.current;
    while (runningRef.current) {
      if (!video || video.readyState < 2) { await sleep(120); continue; }
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw) { await sleep(120); continue; }
      dc.width = DETECT_W;
      dc.height = Math.round(vh * (DETECT_W / vw));
      dc.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, dc.width, dc.height);
      let quad = null;
      try { quad = await detectEdges(dc); } catch { /* ফ্রেম বাদ */ }
      if (!runningRef.current) break;
      const smooth = trackStability(quad);
      drawOverlay(smooth);
      await sleep(55);
    }
  }, []);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---- স্থিরতা: কোণাগুলো পরপর ফ্রেমে প্রায় এক জায়গায়? ----
  // কাঁচা ডিটেকশন ফ্রেমে-ফ্রেমে লাফায়, তাই (১) অবিশ্বাস্য quad বাদ,
  // (২) EMA দিয়ে মসৃণ, (৩) মসৃণ quad স্থির থাকলে তবেই অটো-ক্যাপচার।
  const trackStability = (rawQuad) => {
    const dc = detectCanvasRef.current;

    if (!isPlausible(rawQuad, dc.width, dc.height)) {
      stableCountRef.current = 0;
      smoothQuadRef.current = null;
      lastQuadRef.current = null;
      historyRef.current = [];
      setStablePct(0);
      setHint('কাগজ পুরোটা ফ্রেমে আনুন');
      return null;
    }

    // ---- ইতিহাসে যোগ, তারপর মধ্যক ----
    const hist = historyRef.current;
    hist.push(rawQuad);
    if (hist.length > HISTORY) hist.shift();
    const med = medianQuad(hist);

    // ---- বিক্ষিপ্ত ফ্রেম বাদ: মধ্যক থেকে বহু দূরে হলে এই ফ্রেম উপেক্ষা ----
    if (hist.length >= 3 && quadDiff(med, rawQuad) > OUTLIER_TOL) {
      hist.pop();                       // বাজে ফ্রেম ইতিহাসে ঢুকতে দিও না
      stableCountRef.current = Math.max(0, stableCountRef.current - 1);
      setHint('একটু নড়ছে…');
      return smoothQuadRef.current;     // আগের ভালো সীমানাই দেখাও
    }

    const prevSmooth = smoothQuadRef.current;
    const smooth = blendQuad(prevSmooth, med, prevSmooth ? SMOOTH : 1);
    smoothQuadRef.current = smooth;

    const prev = lastQuadRef.current;
    lastQuadRef.current = smooth;
    if (!prev) {
      stableCountRef.current = 1;
      setStablePct(Math.round(100 / STABLE_FRAMES));
      setHint('স্থির রাখুন…');
      return smooth;
    }

    const size = Math.max(
      Math.hypot(smooth[1].x - smooth[0].x, smooth[1].y - smooth[0].y),
      Math.hypot(smooth[3].x - smooth[0].x, smooth[3].y - smooth[0].y)
    );
    const tol = Math.max(4, size * STABLE_TOL);
    const stable = smooth.every((p, i) => Math.hypot(p.x - prev[i].x, p.y - prev[i].y) < tol);

    stableCountRef.current = stable ? stableCountRef.current + 1 : Math.max(0, stableCountRef.current - 1);
    const pct = Math.min(100, Math.round((stableCountRef.current / STABLE_FRAMES) * 100));
    setStablePct(pct);
    setHint(stable ? (pct > 60 ? 'প্রায় হয়ে গেছে…' : 'স্থির রাখুন…') : 'একটু নড়ছে…');

    // ইতিহাস পুরো ভরার আগে ক্যাপচার নয় — তাড়াহুড়োয় ভুল ফ্রেম যাতে না যায়
    if (stableCountRef.current >= STABLE_FRAMES && hist.length >= HISTORY) {
      tryCaptureIfSharp(smooth);
    }
    return smooth;
  };

  // ---- ঝাপসা হলে ক্যাপচার আটকাও ----
  // নড়া হাতে তোলা ছবি স্ক্যানের সবচেয়ে বড় শত্রু। কোণা স্থির মানেই ছবি ধারালো নয়
  // (ধীরে নড়লেও কোণা স্থির দেখাতে পারে), তাই ক্যাপচারের ঠিক আগে ধারালোতা মাপি।
  const tryCaptureIfSharp = async (smooth) => {
    if (capturingRef.current || sharpCheckRef.current) return;
    sharpCheckRef.current = true;
    try {
      const dc = detectCanvasRef.current;
      const score = await sharpnessOf(dc);
      if (capturingRef.current) return;
      if (score < MIN_SHARPNESS) {
        blurCountRef.current++;
        stableCountRef.current = Math.max(0, STABLE_FRAMES - 2);
        setHint('একটু ঝাপসা — স্থির ধরুন');
        return;
      }
      capture(smooth);
    } catch (e) {
      capture(smooth);   // মাপা না গেলে আটকাব না
    } finally {
      sharpCheckRef.current = false;
    }
  };

  // ---- ওভারলে আঁকা ----
  const drawOverlay = (quad) => {
    const video = videoRef.current, ov = overlayRef.current;
    if (!video || !ov) return;
    const rect = video.getBoundingClientRect();
    ov.width = rect.width; ov.height = rect.height;
    const ctx = ov.getContext('2d');
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (!quad) return;
    const dc = detectCanvasRef.current;
    // offset calculation for object-fit: contain
    const k = Math.min(ov.width / dc.width, ov.height / dc.height);
    const offsetX = (ov.width - dc.width * k) / 2;
    const offsetY = (ov.height - dc.height * k) / 2;

    ctx.beginPath();
    quad.forEach((p, i) => {
      const x = p.x * k + offsetX;
      const y = p.y * k + offsetY;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(74, 222, 128, 0.18)';
    ctx.fill();
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 3;
    ctx.stroke();
  };

  return (
    <div className="camera-scan-container">
      <div className="camera-viewport">
        <video ref={videoRef} playsInline muted />
        <canvas ref={overlayRef} className="camera-overlay" />
        {err && <div className="camera-error">{err}</div>}
        {!err && <div className="camera-hint">{hint}</div>}
        {stablePct > 0 && stablePct < 100 && (
          <div className="stable-indicator" style={{ width: `${stablePct}%` }} />
        )}
      </div>
      <div className="camera-controls">
        <button className="btn secondary-btn" onClick={onCancel}>Cancel</button>
        <button className="shutter-btn" aria-label="Capture"
          onClick={() => capture(lastQuadRef.current)} />
        <button className="btn secondary-btn" onClick={onFallback}>📂 File</button>
      </div>
    </div>
  );
}
