import React, { useEffect, useState, useRef } from 'react';
import { sharePdf } from '../lib/share';
import './PageReview.css';

export default function PageReview({ 
  workingDoc, 
  onUpdateDoc, 
  onAddPage,
  onEditPage,
  onRotatePage,
  
  onSave, 
  onExport, 
  onBack,
  quality,
  onQualityChange
}) {
  const [name, setName] = useState(workingDoc.name || 'Untitled Document');
  const [objectUrls, setObjectUrls] = useState({});
  const isGenerating = useRef(false);

  // Generate object URLs for blobs safely
  useEffect(() => {
    const newUrls = {};
    workingDoc.pages.forEach(p => {
      newUrls[p.id] = URL.createObjectURL(p.blob);
    });
    setObjectUrls(newUrls);

    return () => {
      // Cleanup URLs on unmount or pages change
      Object.values(newUrls).forEach(url => URL.revokeObjectURL(url));
    };
  }, [workingDoc.pages]);

  const handleNameChange = (e) => {
    setName(e.target.value);
    onUpdateDoc({ ...workingDoc, name: e.target.value });
  };

  const handleMovePage = (index, dir) => {
    const newIndex = index + dir;
    if (newIndex < 0 || newIndex >= workingDoc.pages.length) return;
    
    const newPages = [...workingDoc.pages];
    [newPages[index], newPages[newIndex]] = [newPages[newIndex], newPages[index]];
    onUpdateDoc({ ...workingDoc, pages: newPages });
  };

  const handleDeletePage = (index) => {
    if (!window.confirm("Delete this page?")) return;
    const newPages = [...workingDoc.pages];
    newPages.splice(index, 1);
    onUpdateDoc({ ...workingDoc, pages: newPages });
  };

  const handleExportClick = async () => {
    if (isGenerating.current || workingDoc.pages.length === 0) return;
    isGenerating.current = true;
    try {
      await onExport(workingDoc.pages, name);
    } finally {
      isGenerating.current = false;
    }
  };

  const handleShare = async () => {
    if (isGenerating.current || workingDoc.pages.length === 0) return;
    isGenerating.current = true;
    try {
      await sharePdf(workingDoc.pages, name);
    } catch (err) {
      console.error('Share error', err);
      alert('Could not share the document.');
    } finally {
      isGenerating.current = false;
    }
  };

  return (
    <div className="page-review-container">
      <div className="header">
        <input 
          type="text" 
          className="doc-name-input" 
          value={name} 
          onChange={handleNameChange}
          placeholder="Document Name"
        />
        <select
          className="quality-select"
          value={quality}
          onChange={(e) => onQualityChange(e.target.value)}
          title="PDF কোয়ালিটি / ফাইল সাইজ"
        >
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="small">Small</option>
        </select>
      </div>

      <div className="pages-grid">
        {workingDoc.pages.length === 0 && (
          <div className="empty-state">No pages added yet.</div>
        )}
        
        {workingDoc.pages.map((page, index) => (
          <div key={page.id} className="page-card">
            <div className="page-header">
              <span className="page-num">Page {index + 1}</span>
              <button className="icon-btn delete-btn" onClick={() => handleDeletePage(index)}>🗑</button>
            </div>
            
            <div className="page-img-wrapper">
              {objectUrls[page.id] && (
                <img src={objectUrls[page.id]} alt={`Page ${index + 1}`} />
              )}
            </div>
            
            <div className="page-footer">
              <button
                className="icon-btn edit-page-btn"
                onClick={() => onEditPage(index)}
                title="আবার ক্রপ/ফিল্টার করুন"
              >✏️ Edit</button>
              <button className="icon-btn" onClick={() => onRotatePage(index, -90)} title="বাঁদিকে ঘোরান">↺</button>
              <button className="icon-btn" onClick={() => onRotatePage(index, 90)} title="ডানদিকে ঘোরান">↻</button>
              <button 
                className="icon-btn" 
                onClick={() => handleMovePage(index, -1)}
                disabled={index === 0}
              >←</button>
              <button 
                className="icon-btn" 
                onClick={() => handleMovePage(index, 1)}
                disabled={index === workingDoc.pages.length - 1}
              >→</button>
            </div>
          </div>
        ))}
      </div>

      <div className="bottom-bar action-bar">
        <button className="btn secondary-btn" onClick={onBack}>Back</button>
        <button className="btn secondary-btn" onClick={onAddPage}>+ Add Page</button>
        
        <button 
          className="btn primary-btn" 
          onClick={onSave}
          disabled={workingDoc.pages.length === 0}
        >
          Save
        </button>
        
        <button 
          className="btn primary-btn" 
          onClick={handleExportClick}
          disabled={workingDoc.pages.length === 0}
        >
          Export PDF
        </button>
        
        <button 
          className="btn primary-btn" 
          onClick={handleShare}
          disabled={workingDoc.pages.length === 0}
        >
          <span className="icon">🔗</span> Share
        </button>
      </div>
    </div>
  );
}
