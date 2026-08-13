import React, { useEffect, useState } from 'react';
import { canPickLocation } from '../lib/saveFile';
import { QUALITY_PRESETS } from '../lib/canvasUtils';
import './SaveDialog.css';

/**
 * সেভ করার সময়ের একক ডায়ালগ: নাম + মান + কোথায় রাখা হবে।
 *
 * গন্তব্য নিয়ে বাস্তবতা:
 *  • কম্পিউটারে (Chrome/Edge) আসল "Save As" খোলে — ফোল্ডার বেছে নেওয়া যায়।
 *  • ফোনের ব্রাউজারে ওই সুবিধা এখনো নেই। সেখানে দুটো পথ:
 *      – Download: ব্রাউজারের ডাউনলোড ফোল্ডারে যায়
 *      – Share: ফোনের শেয়ার শিট খোলে, সেখান থেকে "Files"/Drive বেছে
 *        নিজের পছন্দের ফোল্ডারে রাখা যায় (ফোনে এটাই সবচেয়ে কাছাকাছি উপায়)
 */
export default function SaveDialog({ defaultName, defaultQuality, onCancel, onConfirm }) {
  const [name, setName] = useState(defaultName || 'document');
  const [quality, setQuality] = useState(defaultQuality || 'high');
  const hasPicker = canPickLocation();

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const go = (destination) => {
    const finalName = (name || '').trim() || defaultName || 'document';
    onConfirm({ name: finalName, quality, destination });
  };

  return (
    <div className="save-backdrop" onClick={onCancel}>
      <div className="save-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>PDF সেভ করুন</h3>

        <label className="save-label">ফাইলের নাম</label>
        <div className="save-name-row">
          <input
            className="save-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="document"
            autoFocus
          />
          <span className="save-ext">.pdf</span>
        </div>

        <label className="save-label">কোয়ালিটি / ফাইল সাইজ</label>
        <div className="save-quality">
          {Object.entries(QUALITY_PRESETS).map(([key, p]) => (
            <button
              key={key}
              className={`save-q-btn ${quality === key ? 'active' : ''}`}
              onClick={() => setQuality(key)}
            >
              <strong>{p.label}</strong>
              <span>{p.maxDim}px</span>
            </button>
          ))}
        </div>

        <label className="save-label">কোথায় রাখবেন</label>
        <div className="save-dest">
          {hasPicker && (
            <button className="btn primary-btn save-dest-btn" onClick={() => go('pick')}>
              📁 ফোল্ডার বেছে সেভ করুন
            </button>
          )}
          <button className={`btn ${hasPicker ? 'secondary-btn' : 'primary-btn'} save-dest-btn`} onClick={() => go('download')}>
            ⬇️ ডাউনলোড ফোল্ডারে
          </button>
          <button className="btn secondary-btn save-dest-btn" onClick={() => go('share')}>
            🔗 শেয়ার / Files-এ পাঠান
          </button>
        </div>

        {!hasPicker && (
          <p className="save-note">
            এই ব্রাউজারে সরাসরি ফোল্ডার বেছে নেওয়ার সুবিধা নেই। নির্দিষ্ট ফোল্ডারে
            রাখতে <b>শেয়ার</b> বেছে নিয়ে <b>Files</b> বা Drive-এ সেভ করুন।
          </p>
        )}

        <button className="save-cancel" onClick={onCancel}>বাতিল</button>
      </div>
    </div>
  );
}
