import React, { useRef, useState } from 'react';
import './ImageInput.css';

const MAX_DIM = 2600;

// একটা File → রিসাইজ করা canvas
function fileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let width = img.width, height = img.height;
      const longSide = Math.max(width, height);
      if (longSide > MAX_DIM) {
        const s = MAX_DIM / longSide;
        width = Math.round(width * s);
        height = Math.round(height * s);
      }
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

export default function ImageInput({ onImagesLoaded }) {
  const cameraInputRef = useRef(null);
  const galleryInputRef = useRef(null);
  const [loading, setLoading] = useState(false);

  const handleImageChange = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = ''; // একই ফাইল আবার বাছলে যাতে change fire করে
    if (files.length === 0) return;
    setLoading(true);
    try {
      const canvases = [];
      for (const f of files) {
        try { canvases.push(await fileToCanvas(f)); }
        catch (err) { console.error('Skipped a file:', err); }
      }
      if (canvases.length > 0) onImagesLoaded(canvases);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="image-input-container">
      <div className="hero-text">
        <h1>Scan App</h1>
        <p>Digitize your documents privately, in the browser.</p>
      </div>

      <div className="button-group">
        <button className="btn primary-btn" onClick={() => cameraInputRef.current?.click()} disabled={loading}>
          <span className="icon">📷</span>
          {loading ? 'Loading…' : 'Open Camera'}
        </button>
        <button className="btn secondary-btn" onClick={() => galleryInputRef.current?.click()} disabled={loading}>
          <span className="icon">📂</span>
          {loading ? 'Loading…' : 'Upload Files'}
        </button>
      </div>
      <p className="hint-text">গ্যালারি থেকে একসাথে একাধিক পেজ বাছাই করা যায়</p>

      {/* Hidden Inputs */}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        ref={cameraInputRef}
        onChange={handleImageChange}
        className="hidden-input"
      />
      <input
        type="file"
        accept="image/*"
        multiple
        ref={galleryInputRef}
        onChange={handleImageChange}
        className="hidden-input"
      />
    </div>
  );
}
