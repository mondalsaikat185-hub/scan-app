import React, { useRef } from 'react';
import './ImageInput.css';

export default function ImageInput({ onImageLoaded }) {
  const cameraInputRef = useRef(null);
  const galleryInputRef = useRef(null);

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      // Create a canvas to draw the image
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      // Resize logic (max dimension ~2600px)
      const MAX_DIM = 2600;
      let width = img.width;
      let height = img.height;
      const longSide = Math.max(width, height);
      if (longSide > MAX_DIM) {
        const s = MAX_DIM / longSide;
        width = Math.round(width * s);
        height = Math.round(height * s);
      }

      canvas.width = width;
      canvas.height = height;

      // Draw image to canvas
      ctx.drawImage(img, 0, 0, width, height);

      // Free the object URL memory
      URL.revokeObjectURL(url);

      // Pass the canvas back to parent
      onImageLoaded(canvas);
    };

    img.src = url;
  };

  return (
    <div className="image-input-container">
      <div className="hero-text">
        <h1>Scan App</h1>
        <p>Digitize your documents privately, in the browser.</p>
      </div>

      <div className="button-group">
        <button className="btn primary-btn" onClick={() => cameraInputRef.current?.click()}>
          <span className="icon">📷</span>
          Open Camera
        </button>
        <button className="btn secondary-btn" onClick={() => galleryInputRef.current?.click()}>
          <span className="icon">📂</span>
          Upload File
        </button>
      </div>

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
        ref={galleryInputRef}
        onChange={handleImageChange}
        className="hidden-input"
      />
    </div>
  );
}
