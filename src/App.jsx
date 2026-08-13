import React, { useState, useEffect } from 'react';
import { initCV, detectEdges, warpCanvas } from './lib/cvClient';
import { getAllDocuments, saveDocument, deleteDocument } from './lib/db';
import { makePdfFromPages } from './lib/makePdf';
import { sharePdf } from './lib/share';

import Loader from './components/Loader';
import ImageInput from './components/ImageInput';
import CameraScan from './components/CameraScan';
import CornerEditor from './components/CornerEditor';
import ResultView from './components/ResultView';
import { scaleCanvas } from './lib/canvasUtils';
import PageReview from './components/PageReview';
import Library from './components/Library';

import './App.css';

function App() {
  const [cvReady, setCvReady] = useState(false);
  const [cvError, setCvError] = useState(false);
  
  // State machine: 'library' -> 'input' -> 'crop' -> 'enhance' -> 'pages'
  const [step, setStep] = useState('library');
  
  // Storage state
  const [docs, setDocs] = useState([]);
  const [workingDoc, setWorkingDoc] = useState(null);

  // Transient image states for scanning flow
  const [imageCanvas, setImageCanvas] = useState(null);
  const [initialCorners, setInitialCorners] = useState(null);
  const [warpedCanvas, setWarpedCanvas] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingQueue, setPendingQueue] = useState([]);  // মাল্টি-সিলেক্টের অপেক্ষমাণ ছবি

  // PWA Install Prompt State
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showInstallPopup, setShowInstallPopup] = useState(false);

  useEffect(() => {
    // Listen for PWA install prompt
    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallPopup(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    
    // Load OpenCV via Web Worker
    initCV()
      .then(() => setCvReady(true))
      .catch((err) => {
        console.error(err);
        setCvError(true);
      });
      
    // Load documents
    refreshLibrary();

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      console.log('User accepted the A2HS prompt');
    }
    setDeferredPrompt(null);
    setShowInstallPopup(false);
  };

  const refreshLibrary = async () => {
    const allDocs = await getAllDocuments();
    setDocs(allDocs);
  };

  // --- Library Actions ---
  const handleNewScan = () => {
    setWorkingDoc({
      id: crypto.randomUUID(),
      name: `Scan ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pages: []
    });
    setStep('input');
  };

  const handleOpenDoc = (doc) => {
    setWorkingDoc(doc);
    setStep('pages');
  };

  const handleDeleteDoc = async (id) => {
    if (window.confirm("Are you sure you want to delete this document?")) {
      await deleteDocument(id);
      refreshLibrary();
    }
  };

  const handleExportPdf = async (pages, name) => {
    if (!pages || pages.length === 0) return;
    try {
      const blob = await makePdfFromPages(pages);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name || 'document'}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export error", err);
      alert("Failed to export PDF.");
    }
  };

  const handleShareDoc = async (pages, name) => {
    try {
      await sharePdf(pages, name);
    } catch (err) {
      console.error(err);
      alert('Could not share.');
    }
  };

  // --- Scan Flow Actions ---
  // একটা canvas নিয়ে ডিটেকশন চালিয়ে crop স্ক্রিনে যায়
  const startCropFor = async (canvas) => {
    setImageCanvas(canvas);
    setBusy(true);
    try {
      const corners = await detectEdges(canvas);
      setInitialCorners(corners);
      setStep('crop');
    } catch (err) {
      console.error(err);
      alert('Error detecting edges');
    } finally {
      setBusy(false);
    }
  };

  // মাল্টি-সিলেক্ট: প্রথমটা এখনই, বাকিগুলো কিউতে — এক এক করে আসবে
  const handleImagesLoaded = async (canvases) => {
    const [first, ...rest] = canvases;
    setPendingQueue(rest);
    await startCropFor(first);
  };

  const handleCornersComplete = async (finalCorners) => {
    setBusy(true);
    try {
      const warped = await warpCanvas(imageCanvas, finalCorners);
      setWarpedCanvas(warped);
      setStep('enhance');
    } catch (err) {
      console.error(err);
      alert('Error warping image');
    } finally {
      setBusy(false);
    }
  };

  const handleAddPage = (pageObj) => {
    // Add page to working doc
    const newDoc = {
      ...workingDoc,
      pages: [...workingDoc.pages, pageObj],
      updatedAt: Date.now()
    };
    setWorkingDoc(newDoc);

    // Clear transient states
    setImageCanvas(null);
    setInitialCorners(null);
    setWarpedCanvas(null);

    // কিউতে আরও ছবি থাকলে পরেরটা শুরু করো, নাহলে pages স্ক্রিন
    if (pendingQueue.length > 0) {
      const [next, ...rest] = pendingQueue;
      setPendingQueue(rest);
      startCropFor(next);
    } else {
      setStep('pages');
    }
  };

  const handleCancelScan = () => {
    setImageCanvas(null);
    setInitialCorners(null);
    setWarpedCanvas(null);
    setPendingQueue([]);  // Cancel করলে কিউও খালি

    // If the document has pages, go back to pages view, else library
    if (workingDoc.pages.length > 0) {
      setStep('pages');
    } else {
      setWorkingDoc(null);
      setStep('library');
    }
  };

  // --- Page Review Actions ---
  const handleUpdateDoc = (updatedDoc) => {
    setWorkingDoc(updatedDoc);
  };

  const handleSaveDoc = async () => {
    await saveDocument(workingDoc);
    await refreshLibrary();
    setWorkingDoc(null);
    setStep('library');
  };

  const handleBackToLibrary = () => {
    if (workingDoc && workingDoc.pages.length > 0) {
      if (!window.confirm('Unsaved changes will be lost. Return to Library?')) return;
    }
    setWorkingDoc(null);
    setStep('library');
  };


  if (cvError) {
    return (
      <div className="app-container error-screen" style={{textAlign: 'center', paddingTop: '40px'}}>
        <h2>লোড করা যায়নি</h2>
        <p style={{marginBottom: '20px'}}>OpenCV ইঞ্জিন লোড হতে পারেনি — ইন্টারনেট কানেকশন ধীর বা বাধাপ্রাপ্ত হতে পারে।</p>
        <button className="btn primary-btn" onClick={() => window.location.reload()}>আবার চেষ্টা করুন</button>
      </div>
    );
  }

  if (!cvReady) {
    return <Loader message="ইঞ্জিন প্রস্তুত হচ্ছে… প্রথমবার ~12MB ডাউনলোড হচ্ছে, একটু সময় লাগতে পারে।" />;
  }

  return (
    <div className="app-container">
      {step === 'library' && (
        <Library 
          docs={docs} 
          onNewScan={handleNewScan} 
          onOpen={handleOpenDoc}
          onExport={handleExportPdf}
          onDelete={handleDeleteDoc}
          onShare={handleShareDoc}
        />
      )}

      {step === 'input' && (
        <ImageInput 
          onImagesLoaded={handleImagesLoaded} 
          onOpenCamera={() => setStep('camera')}
        />
      )}
      
      {step === 'camera' && (
        <CameraScan
          onCaptured={async (canvas, corners) => {
            const scaled = scaleCanvas(canvas);
            setImageCanvas(scaled);
            if (corners) {
              setInitialCorners(corners);
              setStep('crop');
            } else {
              await startCropFor(scaled);
            }
          }}
          onFallback={() => setStep('input')}
          onCancel={handleCancelScan}
        />
      )}
      
      {step === 'crop' && (
        <CornerEditor 
          imageCanvas={imageCanvas}
          initialCorners={initialCorners}
          onComplete={handleCornersComplete}
        />
      )}

      {step === 'enhance' && (
        <ResultView 
          warpedCanvas={warpedCanvas}
          onAddPage={handleAddPage}
          onReset={handleCancelScan}
        />
      )}

      {step === 'pages' && (
        <PageReview 
          workingDoc={workingDoc}
          onUpdateDoc={handleUpdateDoc}
          onAddPage={() => setStep('input')}
          onSave={handleSaveDoc}
          onExport={(pages, name) => handleExportPdf(pages, name)}
          onBack={handleBackToLibrary}
        />
      )}
      
      {busy && (
        <div style={{
          position: 'fixed', top:0, left:0, right:0, bottom:0,
          background: 'rgba(0,0,0,0.5)', zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'white', fontSize: '1.2rem', fontWeight: 'bold'
        }}>
          Processing...
        </div>
      )}

      {showInstallPopup && (
        <div style={{
          position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
          background: '#0f172a', padding: '16px 24px', borderRadius: '12px',
          display: 'flex', alignItems: 'center', gap: '16px', zIndex: 10000,
          boxShadow: '0 10px 25px rgba(0,0,0,0.5)', border: '1px solid #334155',
          width: 'calc(100% - 40px)', maxWidth: '400px', justifyContent: 'space-between'
        }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '12px' }}>
            <img src="/icon-192.png" alt="App Icon" style={{ width: '40px', height: '40px', borderRadius: '8px' }} />
            <div>
              <div style={{ color: 'white', fontWeight: 'bold', fontSize: '1rem' }}>Install Scan App</div>
              <div style={{ color: '#94a3b8', fontSize: '0.8rem' }}>Fast, offline access</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              onClick={() => setShowInstallPopup(false)} 
              style={{ background: 'transparent', color: '#94a3b8', border: 'none', padding: '8px', cursor: 'pointer' }}
            >
              ✕
            </button>
            <button 
              onClick={handleInstallClick} 
              style={{ background: '#3b82f6', color: 'white', border: 'none', padding: '8px 16px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
            >
              Install
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
