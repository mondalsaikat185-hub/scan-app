import React, { useEffect, useRef, useState, useCallback } from 'react';
import { detectEdges } from '../lib/cvClient';
import './CameraScan.css';

const DETECT_W = 480;        // ডিটেকশন ফ্রেমের প্রস্থ (ছোট = দ্রুত)
const STABLE_FRAMES = 5;     // পরপর কত ফ্রেম স্থির হলে অটো-ক্যাপচার
const STABLE_TOL = 0.025;    // কোণার নড়াচড়ার সীমা (ফ্রেম প্রস্থের অনুপাতে)

export default function CameraScan({ onCaptured, onFallback, onCancel }) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const detectCanvasRef = useRef(document.createElement('canvas'));
  const streamRef = useRef(null);
  const runningRef = useRef(true);
  const lastQuadRef = useRef(null);
  const stableCountRef = useRef(0);
  const capturingRef = useRef(false);
  const [err, setErr] = useState(null);
  const [stablePct, setStablePct] = useState(0);

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
      drawOverlay(quad);
      trackStability(quad);
      await sleep(120);
    }
  }, []);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---- স্থিরতা: কোণাগুলো পরপর ফ্রেমে প্রায় এক জায়গায়? ----
  const trackStability = (quad) => {
    const dc = detectCanvasRef.current;
    // ডিটেকশন default (full-frame fallback) হলে quad-কে "পাওয়া যায়নি" ধরো
    const isDefault = quad && quad.every(p =>
      Math.min(p.x, dc.width - p.x) < dc.width * 0.06 ||
      Math.min(p.y, dc.height - p.y) < dc.height * 0.06
    ) && quad.some(p => Math.min(p.x, dc.width - p.x) < dc.width * 0.06);
    if (!quad || isDefault) {
      stableCountRef.current = 0; lastQuadRef.current = null; setStablePct(0);
      return;
    }
    const prev = lastQuadRef.current;
    lastQuadRef.current = quad;
    if (!prev) { stableCountRef.current = 1; setStablePct(20); return; }
    const tol = dc.width * STABLE_TOL;
    const stable = quad.every((p, i) => Math.hypot(p.x - prev[i].x, p.y - prev[i].y) < tol);
    stableCountRef.current = stable ? stableCountRef.current + 1 : 1;
    setStablePct(Math.min(100, Math.round((stableCountRef.current / STABLE_FRAMES) * 100)));
    if (stableCountRef.current >= STABLE_FRAMES) capture(quad);
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
