import React, { useRef, useState } from 'react';
import { scaleCanvas } from '../lib/canvasUtils';
import './ImageInput.css';

// একটা File → রিসাইজ করা canvas
function fileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0, img.width, img.height);
      URL.revokeObjectURL(url);
      
      const scaledCanvas = scaleCanvas(canvas);
      resolve(scaledCanvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

export default function ImageInput({ onImagesLoaded, onOpenCamera }) {
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
        <button className="btn primary-btn" onClick={onOpenCamera} disabled={loading}>
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
        multiple
        ref={galleryInputRef}
        onChange={handleImageChange}
        className="hidden-input"
      />
    </div>
  );
}
