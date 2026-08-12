import React, { useEffect, useRef, useState } from 'react';
import './CornerEditor.css';

const HANDLE_RADIUS = 24;

export default function CornerEditor({ imageCanvas, initialCorners, onComplete }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [corners, setCorners] = useState(initialCorners);
  const [draggingIdx, setDraggingIdx] = useState(-1);
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
  }, [corners, scale, draggingIdx, imageCanvas]);

  // Input Handling (Mouse & Touch)
  const getMousePos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale
    };
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    const pos = getMousePos(e);
    
    // Find closest handle
    let closestIdx = -1;
    let minDist = Infinity;
    
    corners.forEach((pt, i) => {
      const dist = Math.hypot(pt.x - pos.x, pt.y - pos.y);
      // Increased hit area by dividing HANDLE_RADIUS by scale to map it to real image coordinates
      if (dist < (HANDLE_RADIUS * 2) / scale && dist < minDist) {
        minDist = dist;
        closestIdx = i;
      }
    });

    if (closestIdx !== -1) {
      setDraggingIdx(closestIdx);
    }
  };

  const handlePointerMove = (e) => {
    if (draggingIdx === -1) return;
    e.preventDefault();
    const pos = getMousePos(e);
    
    // Constrain to image bounds
    pos.x = Math.max(0, Math.min(pos.x, imageCanvas.width));
    pos.y = Math.max(0, Math.min(pos.y, imageCanvas.height));

    const newCorners = [...corners];
    newCorners[draggingIdx] = pos;
    setCorners(newCorners);
  };

  const handlePointerUp = () => {
    setDraggingIdx(-1);
  };

  return (
    <div className="corner-editor-container" ref={containerRef}>
      <h2 className="editor-title">Adjust Corners</h2>
      <p className="editor-subtitle">Drag the points to match the document boundaries</p>
      
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
        <button className="btn primary-btn next-btn" onClick={() => onComplete(corners)}>
          Next <span className="icon">→</span>
        </button>
      </div>
    </div>
  );
}
