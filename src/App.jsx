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
import { scaleCanvas, blobToCanvas, originalBlobOf } from './lib/canvasUtils';
import PageReview from './components/PageReview';
import Library from './components/Library';
import InstallPrompt from './components/InstallPrompt';

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
  const [quality, setQuality] = useState('high');        // এক্সপোর্ট মান: high | medium | small
  const [editingIndex, setEditingIndex] = useState(null); // কোন পেজ পুনঃসম্পাদনা হচ্ছে (null = নতুন)
  const [originalBlob, setOriginalBlob] = useState(null); // বর্তমান স্ক্যানের আসল ছবি
  const [lastCorners, setLastCorners] = useState(null);   // শেষ ব্যবহৃত কোণা
  const [editFilter, setEditFilter] = useState('magic');  // এডিটের সময় আগের ফিল্টার

  useEffect(() => {
    // Load OpenCV via Web Worker
    initCV()
      .then(() => setCvReady(true))
      .catch((err) => {
        console.error(err);
        setCvError(true);
      });
      
    // Load documents
    refreshLibrary();

  }, []);

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

  const handleRenameDoc = async (doc) => {
    const name = window.prompt('নতুন নাম দিন:', doc.name || '');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === doc.name) return;
    await saveDocument({ ...doc, name: trimmed });
    await refreshLibrary();
  };

  const handleDeleteDoc = async (id) => {
    if (window.confirm("Are you sure you want to delete this document?")) {
      await deleteDocument(id);
      refreshLibrary();
    }
  };

  const handleExportPdf = async (pages, name, q) => {
    if (!pages || pages.length === 0) return;
    try {
      const blob = await makePdfFromPages(pages, q || quality);
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

  const handleShareDoc = async (pages, name, q) => {
    try {
      await sharePdf(pages, name, q || quality);
    } catch (err) {
      console.error(err);
      alert('Could not share.');
    }
  };

  // --- Scan Flow Actions ---
  // একটা canvas নিয়ে ডিটেকশন চালিয়ে crop স্ক্রিনে যায়
  const startCropFor = async (canvas, presetCorners = null, keepOriginal = null) => {
    setImageCanvas(canvas);
    setBusy(true);
    try {
      // আসল ছবিটা রেখে দিই — পরে "Edit" চাপলে এখান থেকেই আবার শুরু হবে
      setOriginalBlob(keepOriginal || await originalBlobOf(canvas));
      const corners = presetCorners || await detectEdges(canvas);
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
    setLastCorners(finalCorners);
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
    // পুনঃসম্পাদনার জন্য দরকারি সব কিছু পেজের সাথেই সেভ হয়
    const fullPage = { ...pageObj, originalBlob, corners: lastCorners };

    let newPages;
    if (editingIndex !== null && workingDoc.pages[editingIndex]) {
      newPages = [...workingDoc.pages];
      newPages[editingIndex] = { ...fullPage, id: workingDoc.pages[editingIndex].id };
    } else {
      newPages = [...workingDoc.pages, fullPage];
    }
    setWorkingDoc({ ...workingDoc, pages: newPages, updatedAt: Date.now() });

    // Clear transient states
    setImageCanvas(null);
    setInitialCorners(null);
    setWarpedCanvas(null);
    setOriginalBlob(null);

    if (editingIndex !== null) {   // এডিট শেষ — সোজা pages স্ক্রিনে
      setEditingIndex(null);
      setStep('pages');
      return;
    }

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
    setOriginalBlob(null);
    setPendingQueue([]);  // Cancel করলে কিউও খালি

    if (editingIndex !== null) {   // এডিট বাতিল — পেজ অপরিবর্তিত থাকবে
      setEditingIndex(null);
      setStep('pages');
      return;
    }

    // If the document has pages, go back to pages view, else library
    if (workingDoc.pages.length > 0) {
      setStep('pages');
    } else {
      setWorkingDoc(null);
      setStep('library');
    }
  };

  // --- পেজ পুনঃসম্পাদনা ---
  // আসল ছবি ফিরিয়ে এনে আগের কোণাসহ crop স্ক্রিনে নিয়ে যায়,
  // সেখান থেকে ইউজার আবার ক্রপ/ফিল্টার বদলে "Update" করতে পারে।
  const handleEditPage = async (index) => {
    const page = workingDoc?.pages?.[index];
    if (!page) return;
    if (!page.originalBlob) {
      alert('এই পেজটি পুরোনো সংস্করণে তৈরি, তাই আসল ছবি সংরক্ষিত নেই। নতুন করে স্ক্যান করুন।');
      return;
    }
    setBusy(true);
    try {
      const canvas = await blobToCanvas(page.originalBlob);
      setEditingIndex(index);
      setEditFilter(page.filter || 'magic');
      await startCropFor(canvas, page.corners || null, page.originalBlob);
    } catch (err) {
      console.error(err);
      alert('আসল ছবি খোলা গেল না।');
    } finally {
      setBusy(false);
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
          onRename={handleRenameDoc}
          quality={quality}
          onQualityChange={setQuality}
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
              // ক্যানভাস রিসাইজ হলে কোণাগুলোও একই অনুপাতে সরাতে হবে,
              // নাহলে ক্রপ বক্স ভুল জায়গায় বসবে
              const k = scaled.width / canvas.width;
              setInitialCorners(k === 1 ? corners : corners.map(p => ({ x: p.x * k, y: p.y * k })));
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
          initialFilter={editingIndex !== null ? editFilter : 'magic'}
          isEditing={editingIndex !== null}
        />
      )}

      {step === 'pages' && (
        <PageReview 
          workingDoc={workingDoc}
          onUpdateDoc={handleUpdateDoc}
          onAddPage={() => setStep('input')}
          onEditPage={handleEditPage}
          onSave={handleSaveDoc}
          onExport={(pages, name) => handleExportPdf(pages, name)}
          quality={quality}
          onQualityChange={setQuality}
          onBack={handleBackToLibrary}
        />
      )}
      
      {busy && (
        <div className="processing-overlay">
          <span className="spinner" aria-hidden="true" />
          Processing…
        </div>
      )}

      <InstallPrompt />
    </div>
  );
}

export default App;
