import React, { useState, useEffect } from 'react';
import { loadOpenCV } from './lib/opencvLoader';
import { detectEdges } from './lib/detectEdges';
import { warp } from './lib/warp';
import { getAllDocuments, saveDocument, deleteDocument } from './lib/db';
import { makePdfFromPages } from './lib/makePdf';

import Loader from './components/Loader';
import ImageInput from './components/ImageInput';
import CornerEditor from './components/CornerEditor';
import ResultView from './components/ResultView';
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

  useEffect(() => {
    // Load OpenCV
    loadOpenCV()
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

  // --- Scan Flow Actions ---
  const handleImageLoaded = (canvas) => {
    setImageCanvas(canvas);
    const corners = detectEdges(window.cv, canvas);
    setInitialCorners(corners);
    setStep('crop');
  };

  const handleCornersComplete = (finalCorners) => {
    const warped = warp(window.cv, imageCanvas, finalCorners);
    setWarpedCanvas(warped);
    setStep('enhance');
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
    
    setStep('pages');
  };

  const handleCancelScan = () => {
    setImageCanvas(null);
    setInitialCorners(null);
    setWarpedCanvas(null);
    
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
    return <div className="app-container"><p style={{color: 'red'}}>Error loading OpenCV.js.</p></div>;
  }

  if (!cvReady) {
    return <Loader message="Initializing AI Core..." />;
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
        />
      )}

      {step === 'input' && (
        <ImageInput onImageLoaded={handleImageLoaded} />
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
          cv={window.cv}
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
    </div>
  );
}

export default App;
