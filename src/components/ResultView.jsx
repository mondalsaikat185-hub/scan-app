import React, { useEffect, useRef, useState } from 'react';
import { canvasToBlob } from '../lib/canvasUtils';
import { filterCanvas } from '../lib/cvClient';
import './ResultView.css';

export default function ResultView({ warpedCanvas, onBack, onDiscard, onAddPage, initialFilter = 'magic', isEditing = false }) {
  const [filter, setFilter] = useState(initialFilter);
  const [finalCanvas, setFinalCanvas] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!warpedCanvas) return;
      setIsProcessing(true);
      try {
        const result = await filterCanvas(warpedCanvas, filter);
        if (!cancelled) setFinalCanvas(result);
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setIsProcessing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filter, warpedCanvas]);

  useEffect(() => {
    if (!finalCanvas || !canvasRef.current || !containerRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // Scale for display
    const maxWidth = containerRef.current.clientWidth;
    const maxHeight = containerRef.current.clientHeight - 150; 
    const scale = Math.min(maxWidth / finalCanvas.width, maxHeight / finalCanvas.height, 1);
    
    canvas.width = finalCanvas.width * scale;
    canvas.height = finalCanvas.height * scale;
    ctx.drawImage(finalCanvas, 0, 0, canvas.width, canvas.height);
    
  }, [finalCanvas]);

  const handleAddPage = async () => {
    if (!finalCanvas) return;
    setIsProcessing(true);
    try {
      const blob = await canvasToBlob(finalCanvas, filter);
      const page = {
        id: crypto.randomUUID(),
        blob,
        filter,
        width: finalCanvas.width,
        height: finalCanvas.height,
      };
      onAddPage(page);
    } catch (err) {
      console.error("Failed to generate Blob", err);
      alert("Failed to process image.");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="result-view-container" ref={containerRef}>
      <h2 className="editor-title">{isEditing ? 'Re-edit page' : 'Enhance & Save'}</h2>
      
      <div className="filter-group">
        <button className={`filter-btn ${filter === 'magic' ? 'active' : ''}`} onClick={() => setFilter('magic')}>Color</button>
        <button className={`filter-btn ${filter === 'original' ? 'active' : ''}`} onClick={() => setFilter('original')}>Original</button>
        <button className={`filter-btn ${filter === 'grayscale' ? 'active' : ''}`} onClick={() => setFilter('grayscale')}>Grayscale</button>
        <button className={`filter-btn ${filter === 'scan' ? 'active' : ''}`} onClick={() => setFilter('scan')}>B&W Scan</button>
      </div>

      <div className="canvas-wrapper">
        <canvas ref={canvasRef} />
      </div>

      <div className="action-bar">
        <button className="btn secondary-btn" onClick={onBack} disabled={isProcessing}
                title="আবার কোণা ঠিক করুন — পেজ বাতিল হবে না">
          ← কোণা ঠিক করুন
        </button>
        <button className="btn primary-btn" onClick={handleAddPage} disabled={isProcessing}>
          <span className="icon">✓</span>{' '}
          {isProcessing ? 'Processing...' : (isEditing ? 'Update page' : 'Add to document')}
        </button>
      </div>
    </div>
  );
}
