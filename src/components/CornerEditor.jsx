import React, { useEffect, useRef, useState } from 'react';
import './CornerEditor.css';

const HANDLE_RADIUS = 24;

export default function CornerEditor({ imageCanvas, initialCorners, onComplete }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [corners, setCorners] = useState(initialCorners);
  const [draggingIdx, setDraggingIdx] = useState(-1);
  const [draggingEdge, setDraggingEdge] = useState(-1);   // পুরো একটা ধার টানা হচ্ছে?
  const dragStartRef = useRef(null);
  const [scale, setScale] = useState(1);

  // Initialize canvas and calculate scale to fit screen
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current || !imageCanvas) return;

    const container = containerRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    // Calculate scaling to fit the image on screen
    const maxWidth = container.clientWidth;
    const maxHeight = container.clientHeight - 80; // leave room for button
    
    let displayWidth = imageCanvas.width;
    let displayHeight = imageCanvas.height;
    
    const scaleX = maxWidth / displayWidth;
    const scaleY = maxHeight / displayHeight;
    const newScale = Math.min(scaleX, scaleY, 1);
    
    setScale(newScale);
    
    canvas.width = displayWidth * newScale;
    canvas.height = displayHeight * newScale;

    // Draw the original image onto our display canvas
    ctx.drawImage(imageCanvas, 0, 0, canvas.width, canvas.height);
    
  }, [imageCanvas]);

  // Draw handles and polygon on top of the image
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageCanvas) return;
    const ctx = canvas.getContext('2d');
    
    // Clear and redraw image
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imageCanvas, 0, 0, canvas.width, canvas.height);

    // Draw polygon overlay
    ctx.beginPath();
    ctx.moveTo(corners[0].x * scale, corners[0].y * scale);
    ctx.lineTo(corners[1].x * scale, corners[1].y * scale);
    ctx.lineTo(corners[2].x * scale, corners[2].y * scale);
    ctx.lineTo(corners[3].x * scale, corners[3].y * scale);
    ctx.closePath();
    
    ctx.fillStyle = 'rgba(59, 130, 246, 0.3)'; // blue tint
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#4ade80'; // green border
    ctx.stroke();

    // ধার টানা হলে সেটাকে মোটা করে দেখাও
    if (draggingEdge !== -1) {
      const a = corners[draggingEdge], b = corners[(draggingEdge + 1) % 4];
      ctx.beginPath();
      ctx.moveTo(a.x * scale, a.y * scale);
      ctx.lineTo(b.x * scale, b.y * scale);
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    // Draw handles
    corners.forEach((pt, i) => {
      ctx.beginPath();
      ctx.arc(pt.x * scale, pt.y * scale, HANDLE_RADIUS, 0, 2 * Math.PI);
      ctx.fillStyle = draggingIdx === i ? '#ffffff' : '#4ade80';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#1e293b';
      ctx.stroke();
    });

    // ম্যাগনিফায়ার — কোনো কোণা ড্র্যাগ হলে
    if (draggingIdx !== -1) {
      const pt = corners[draggingIdx];
      const LOUPE = 120;         // লুপের সাইজ (ডিসপ্লে px)
      const ZOOM = 2.5;
      const srcSize = LOUPE / ZOOM / scale;   // সোর্স ইমেজে কতটা অংশ
      // লুপ বসবে উপরের যে কোণে আঙুল নেই সেখানে
      const nearLeft = (pt.x * scale) < canvas.width / 2;
      const lx = nearLeft ? canvas.width - LOUPE - 10 : 10;
      const ly = 10;

      ctx.save();
      ctx.beginPath();
      ctx.arc(lx + LOUPE/2, ly + LOUPE/2, LOUPE/2, 0, 2*Math.PI);
      ctx.clip();
      ctx.drawImage(
        imageCanvas,
        pt.x - srcSize/2, pt.y - srcSize/2, srcSize, srcSize,  // সোর্স (পুরো রেজোলিউশন)
        lx, ly, LOUPE, LOUPE                                    // গন্তব্য
      );
      // ক্রসহেয়ার
      ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lx + LOUPE/2 - 12, ly + LOUPE/2); ctx.lineTo(lx + LOUPE/2 + 12, ly + LOUPE/2);
      ctx.moveTo(lx + LOUPE/2, ly + LOUPE/2 - 12); ctx.lineTo(lx + LOUPE/2, ly + LOUPE/2 + 12);
      ctx.stroke();
      ctx.restore();
      // লুপের বর্ডার
      ctx.beginPath();
      ctx.arc(lx + LOUPE/2, ly + LOUPE/2, LOUPE/2, 0, 2*Math.PI);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.stroke();
    }
  }, [corners, scale, draggingIdx, draggingEdge, imageCanvas]);

  // Input Handling (Mouse & Touch)
  // গুরুত্বপূর্ণ: CSS canvas-কে ছোট করে দেখাতে পারে (max-width:100%),
  // তাই rect (দৃশ্যমান) আর canvas.width (আসল) — দুটোর অনুপাত ধরতেই হবে।
  const getMousePos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const cssX = rect.width > 0 ? canvas.width / rect.width : 1;
    const cssY = rect.height > 0 ? canvas.height / rect.height : 1;
    return {
      x: ((clientX - rect.left) * cssX) / scale,
      y: ((clientY - rect.top) * cssY) / scale,
      cssX,
    };
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    const pos = getMousePos(e);

    // Find closest handle — hit area দৃশ্যমান পিক্সেলের হিসাবে (~44px টাচ টার্গেট)
    let closestIdx = -1;
    let minDist = Infinity;
    const hitRadius = (HANDLE_RADIUS * 2 * pos.cssX) / scale;

    corners.forEach((pt, i) => {
      const dist = Math.hypot(pt.x - pos.x, pt.y - pos.y);
      if (dist < hitRadius && dist < minDist) {
        minDist = dist;
        closestIdx = i;
      }
    });

    if (closestIdx !== -1) {
      setDraggingIdx(closestIdx);
      return;
    }

    // কোণা না পেলে — কোনো ধারের কাছাকাছি কিনা দেখি।
    // ধার ধরে টানলে পুরো লাইনটা সমান্তরালভাবে সরে, দুই কোণা আলাদা করে
    // টানার দরকার হয় না (গ্যালারির ছবিতে এটা অনেক দ্রুত)।
    let bestEdge = -1, bestDist = Infinity;
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      const vx = b.x - a.x, vy = b.y - a.y;
      const len2 = vx * vx + vy * vy || 1;
      let t = ((pos.x - a.x) * vx + (pos.y - a.y) * vy) / len2;
      if (t < 0.12 || t > 0.88) continue;          // কোণার খুব কাছে নয়
      const px = a.x + vx * t, py = a.y + vy * t;
      const dist = Math.hypot(pos.x - px, pos.y - py);
      if (dist < hitRadius && dist < bestDist) { bestDist = dist; bestEdge = i; }
    }
    if (bestEdge !== -1) {
      setDraggingEdge(bestEdge);
      dragStartRef.current = { pos, a: { ...corners[bestEdge] }, b: { ...corners[(bestEdge + 1) % 4] } };
    }
  };

  const handleReset = () => {
    const w = imageCanvas.width, h = imageCanvas.height;
    const mx = w * 0.02, my = h * 0.02;
    setCorners([
      { x: mx, y: my }, { x: w - mx, y: my },
      { x: w - mx, y: h - my }, { x: mx, y: h - my },
    ]);
  };

  const handlePointerMove = (e) => {
    if (draggingIdx === -1 && draggingEdge === -1) return;
    e.preventDefault();
    const pos = getMousePos(e);
    const clampX = (v) => Math.max(0, Math.min(v, imageCanvas.width));
    const clampY = (v) => Math.max(0, Math.min(v, imageCanvas.height));

    // ---- পুরো ধার সরানো ----
    if (draggingEdge !== -1 && dragStartRef.current) {
      const st = dragStartRef.current;
      const i0 = draggingEdge, i1 = (draggingEdge + 1) % 4;
      // ধারের লম্ব দিকেই কেবল সরাও — লাইনটা সমান্তরাল থাকে
      const ex = st.b.x - st.a.x, ey = st.b.y - st.a.y;
      const el = Math.hypot(ex, ey) || 1;
      const nx = -ey / el, ny = ex / el;
      const dx = pos.x - st.pos.x, dy = pos.y - st.pos.y;
      const amt = dx * nx + dy * ny;

      const next = [...corners];
      next[i0] = { x: clampX(st.a.x + nx * amt), y: clampY(st.a.y + ny * amt) };
      next[i1] = { x: clampX(st.b.x + nx * amt), y: clampY(st.b.y + ny * amt) };
      setCorners(next);
      return;
    }

    // ---- একটা কোণা সরানো ----
    const newCorners = [...corners];
    newCorners[draggingIdx] = { x: clampX(pos.x), y: clampY(pos.y) };
    setCorners(newCorners);
  };

  const handlePointerUp = () => {
    setDraggingIdx(-1);
    setDraggingEdge(-1);
    dragStartRef.current = null;
  };

  return (
    <div className="corner-editor-container" ref={containerRef}>
      <h2 className="editor-title">Adjust Corners</h2>
      <p className="editor-subtitle">কোণা টানুন, অথবা যেকোনো <b>ধার ধরে</b> টেনে পুরো লাইন সরান</p>
      
      <div className="canvas-wrapper">
        <canvas
          ref={canvasRef}
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onTouchStart={handlePointerDown}
          onTouchMove={handlePointerMove}
          onTouchEnd={handlePointerUp}
          style={{ touchAction: 'none' }}
        />
      </div>

      <div className="bottom-bar">
        <button className="btn secondary-btn" onClick={handleReset}>
          Reset
        </button>
        <button className="btn primary-btn next-btn" onClick={() => onComplete(corners)}>
          Next <span className="icon">→</span>
        </button>
      </div>
    </div>
  );
}
