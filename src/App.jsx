import React, { useState, useEffect } from 'react';
import { initCV, detectEdges, warpCanvas, quadFromMask } from './lib/cvClient';
import { segmentDocument, isAIEnabled, setAIEnabled, isModelAvailable } from './lib/aiDetect';
import { getAllDocuments, saveDocument, deleteDocument } from './lib/db';
import { makePdfFromPages } from './lib/makePdf';
import { sharePdf } from './lib/share';
import { savePdfBlob, canPickLocation } from './lib/saveFile';

import Loader from './components/Loader';
import ImageInput from './components/ImageInput';
import CameraScan from './components/CameraScan';
import CornerEditor from './components/CornerEditor';
import ResultView from './components/ResultView';
import { scaleCanvas, blobToCanvas, originalBlobOf } from './lib/canvasUtils';
import PageReview from './components/PageReview';
import Library from './components/Library';
import InstallPrompt from './components/InstallPrompt';
import SaveDialog from './components/SaveDialog';

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
  const [aiOn, setAiOn] = useState(isAIEnabled());        // AI ডিটেকশন চালু?
  const [aiReady, setAiReady] = useState(false);          // মডেল ফাইল আছে?
  const [saveReq, setSaveReq] = useState(null);           // সেভ ডায়ালগের অনুরোধ

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

    // AI মডেল আছে কিনা দেখে নিই (না থাকলে চুপচাপ ক্লাসিক পদ্ধতিই চলবে)
    isModelAvailable().then(setAiReady);

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

  // Export চাপলে সরাসরি সেভ নয় — আগে ডায়ালগ (নাম + মান + গন্তব্য)
  const handleExportPdf = (pages, name) => {
    if (!pages || pages.length === 0) return;
    setSaveReq({ pages, name: name || 'document' });
  };

  // ডায়ালগে ইউজার সব ঠিক করে দিলে তবেই আসল কাজ
  const doSave = async ({ name, quality: q, destination }) => {
    const req = saveReq;
    setSaveReq(null);
    if (!req) return;
    setBusy(true);
    try {
      if (destination === 'share') {
        await sharePdf(req.pages, name, q);
        return;
      }
      const blob = await makePdfFromPages(req.pages, q);
      await savePdfBlob(blob, name, destination);
    } catch (err) {
      console.error('Save error', err);
      alert('PDF সেভ করা গেল না।');
    } finally {
      setBusy(false);
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
      let corners = presetCorners;
      if (!corners) {
        // ১. AI চেষ্টা (রঙিন/এলোমেলো ব্যাকগ্রাউন্ডে অনেক ভালো)
        if (aiOn && aiReady) {
          try {
            const seg = await segmentDocument(canvas);
            if (seg) {
              corners = await quadFromMask(seg.mask, seg.size, canvas.width, canvas.height);
            }
          } catch (e) { console.warn('AI detect skipped', e); }
        }
        // ২. না পারলে ক্লাসিক OpenCV পদ্ধতি
        if (!corners) corners = await detectEdges(canvas);
      }
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

  // প্রিভিউ স্ক্রিন থেকে "ফিরে যান" — পেজ বাতিল নয়, শুধু আবার ক্রপ ঠিক করা।
  // ইউজার যেভাবে কোণা রেখে এসেছিল ঠিক সেখান থেকেই শুরু হয়, তাই কাজ হারায় না।
  const handleBackToCrop = () => {
    if (lastCorners) setInitialCorners(lastCorners);
    setWarpedCanvas(null);
    setStep('crop');
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
          aiOn={aiOn}
          aiReady={aiReady}
          onAiToggle={(v) => { setAIEnabled(v); setAiOn(v); }}
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
          onCancel={handleCancelScan}
          isEditing={editingIndex !== null}
        />
      )}

      {step === 'enhance' && (
        <ResultView 
          warpedCanvas={warpedCanvas}
          onAddPage={handleAddPage}
          onBack={handleBackToCrop}
          onDiscard={handleCancelScan}
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

      {saveReq && (
        <SaveDialog
          defaultName={saveReq.name}
          defaultQuality={quality}
          onCancel={() => setSaveReq(null)}
          onConfirm={doSave}
        />
      )}

      <InstallPrompt />
    </div>
  );
}

export default App;
