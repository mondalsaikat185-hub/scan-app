import React, { useEffect, useRef, useState } from 'react';
import { applyFilter } from '../lib/enhance';
import { canvasToBlob } from '../lib/canvasUtils';
import './ResultView.css';

export default function ResultView({ cv, warpedCanvas, onReset, onAddPage }) {
  const [filter, setFilter] = useState('scan');
  const [finalCanvas, setFinalCanvas] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!warpedCanvas) return;
    // Apply filter synchronously or wrap in timeout to not block UI immediately
    const result = applyFilter(cv, warpedCanvas, filter);
    setFinalCanvas(result);
  }, [filter, warpedCanvas, cv]);

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
    setIsGenerating(true);
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
      setIsGenerating(false);
    }
  };

  return (
    <div className="result-view-container" ref={containerRef}>
      <h2 className="editor-title">Enhance & Save</h2>
      
      <div className="filter-group">
        <button className={`filter-btn ${filter === 'original' ? 'active' : ''}`} onClick={() => setFilter('original')}>Original</button>
        <button className={`filter-btn ${filter === 'grayscale' ? 'active' : ''}`} onClick={() => setFilter('grayscale')}>Grayscale</button>
        <button className={`filter-btn ${filter === 'scan' ? 'active' : ''}`} onClick={() => setFilter('scan')}>B&W Scan</button>
      </div>

      <div className="canvas-wrapper">
        <canvas ref={canvasRef} />
      </div>

      <div className="action-bar">
        <button className="btn secondary-btn" onClick={onReset} disabled={isGenerating}>
          Cancel
        </button>
        <button className="btn primary-btn" onClick={handleAddPage} disabled={isGenerating}>
          <span className="icon">➕</span>
          {isGenerating ? 'Processing...' : 'Add to document'}
        </button>
      </div>
    </div>
  );
}
