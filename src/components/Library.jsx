import React, { useEffect, useState } from 'react';
import { forceUpdate } from '../lib/pwa';
import './Library.css';

export default function Library({ docs, onNewScan, onOpen, onExport, onDelete, onShare, onRename, quality, onQualityChange, aiOn, aiReady, onAiToggle }) {
  const [thumbnails, setThumbnails] = useState({});

  useEffect(() => {
    const urls = {};
    docs.forEach(doc => {
      if (doc.pages && doc.pages.length > 0) {
        urls[doc.id] = URL.createObjectURL(doc.pages[0].blob);
      }
    });
    setThumbnails(urls);

    return () => {
      Object.values(urls).forEach(url => URL.revokeObjectURL(url));
    };
  }, [docs]);

  const formatDate = (ts) => {
    return new Date(ts).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div className="library-container">
      <div className="library-header">
        <div className="library-topbar">
          <h1>My Documents</h1>
          <div className="topbar-actions">
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
            {aiReady && (
              <button
                className={`ai-toggle ${aiOn ? 'on' : ''}`}
                onClick={() => onAiToggle(!aiOn)}
                title="AI ডিটেকশন — এলোমেলো ব্যাকগ্রাউন্ডে কাগজ চিনতে সাহায্য করে"
              >
                ✨ AI {aiOn ? 'On' : 'Off'}
              </button>
            )}
            <button className="update-btn" onClick={forceUpdate} title="Check for updates">
              <span className="update-icon">↻</span> Update
            </button>
          </div>
        </div>
        <button className="btn primary-btn new-scan-btn" onClick={onNewScan}>
          <span className="icon">➕</span> New Scan
        </button>
      </div>

      {docs.length === 0 ? (
        <div className="empty-library">
          <span className="icon-large">🗂️</span>
          <h2>No scans yet</h2>
          <p>Tap "New Scan" to get started.</p>
        </div>
      ) : (
        <div className="doc-list">
          {docs.map(doc => (
            <div key={doc.id} className="doc-card">
              <div className="doc-thumb">
                {thumbnails[doc.id] ? (
                  <img src={thumbnails[doc.id]} alt="Thumbnail" />
                ) : (
                  <div className="no-thumb">No Pages</div>
                )}
              </div>
              
              <div className="doc-info">
                <h3>{doc.name || 'Untitled'}</h3>
                <p>{doc.pages.length} page{doc.pages.length !== 1 && 's'} • {formatDate(doc.updatedAt)}</p>
                
                <div className="doc-actions">
                  <button className="btn-small" onClick={() => onOpen(doc)}>Open</button>
                  <button className="btn-small" onClick={() => onRename(doc)}>Rename</button>
                  <button className="btn-small" onClick={() => onExport(doc.pages, doc.name)}>Export PDF</button>
                  <button className="btn-small" onClick={() => onShare(doc.pages, doc.name)}>Share</button>
                  <button className="btn-small danger" onClick={() => onDelete(doc.id)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
