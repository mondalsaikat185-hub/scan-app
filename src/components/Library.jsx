import React, { useEffect, useMemo, useState } from 'react';
import { forceUpdate } from '../lib/pwa';
import { QUALITY_PRESETS } from '../lib/canvasUtils';
import { CORRECTION_LABELS } from '../lib/settings';
import './Library.css';

/**
 * হোম স্ক্রিন — অ্যাপের মুখ।
 *
 * কাঠামো (উপর থেকে নিচে):
 *   ১. স্থির হেডার: আইকন + নাম, ডানে সেটিংস মেনু (⋮)
 *   ২. খোঁজার বাক্স (কয়েকটা ডকুমেন্ট হলেই কাজে লাগে)
 *   ৩. ডকুমেন্টের তালিকা — বড় থাম্বনেইল সহ পরিষ্কার কার্ড
 *   ৪. ভাসমান "New Scan" বাটন (FAB) — সবসময় হাতের নাগালে
 *
 * আগে সব বাটন এক লাইনে ঠাসা ছিল বলে ছোট পর্দায় একটার উপর আরেকটা পড়ে যেত।
 * এখন কম-ব্যবহৃত জিনিসগুলো (AI, কোয়ালিটি, আপডেট) মেনুর ভেতরে।
 */
export default function Library({
  docs, onNewScan, onOpen, onExport, onDelete, onShare, onRename,
  quality, onQualityChange, aiOn, aiReady, onAiToggle,
  corrections, onCorrectionToggle,
}) {
  const [thumbnails, setThumbnails] = useState({});
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [openCard, setOpenCard] = useState(null);   // কোন কার্ডের অ্যাকশন খোলা

  useEffect(() => {
    const urls = {};
    docs.forEach((doc) => {
      if (doc.pages && doc.pages.length > 0) {
        urls[doc.id] = URL.createObjectURL(doc.pages[0].blob);
      }
    });
    setThumbnails(urls);
    return () => Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
  }, [docs]);

  const formatDate = (ts) =>
    new Date(ts).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) => (d.name || '').toLowerCase().includes(q));
  }, [docs, query]);

  const totalPages = useMemo(
    () => docs.reduce((n, d) => n + (d.pages?.length || 0), 0), [docs]);

  return (
    <div className="library">
      {/* ---------- হেডার ---------- */}
      <header className="lib-header">
        <div className="lib-brand">
          <img src="/icon-192.png" alt="" className="lib-logo" />
          <div className="lib-titles">
            <h1>Scan App</h1>
            <span>{docs.length} ডকুমেন্ট · {totalPages} পেজ</span>
          </div>
        </div>
        <button
          className="lib-menu-btn"
          onClick={() => setMenuOpen(true)}
          aria-label="মেনু"
        >
          ⋮
        </button>
      </header>

      {/* ---------- খোঁজা ---------- */}
      {docs.length > 3 && (
        <div className="lib-search">
          <span className="lib-search-icon">🔍</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ডকুমেন্ট খুঁজুন…"
          />
          {query && (
            <button className="lib-search-clear" onClick={() => setQuery('')}>✕</button>
          )}
        </div>
      )}

      {/* ---------- তালিকা ---------- */}
      <div className="lib-body">
        {docs.length === 0 ? (
          <div className="lib-empty">
            <div className="lib-empty-art">🗂️</div>
            <h2>এখনো কোনো স্ক্যান নেই</h2>
            <p>নিচের বাটনে চেপে প্রথম ডকুমেন্ট স্ক্যান করুন।<br />সবকিছু আপনার ফোনেই থাকে।</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="lib-empty">
            <div className="lib-empty-art">🔍</div>
            <h2>কিছু পাওয়া যায়নি</h2>
            <p>“{query}” নামে কোনো ডকুমেন্ট নেই।</p>
          </div>
        ) : (
          <ul className="lib-list">
            {filtered.map((doc) => (
              <li key={doc.id} className="doc-card">
                <button className="doc-main" onClick={() => onOpen(doc)}>
                  <div className="doc-thumb">
                    {thumbnails[doc.id]
                      ? <img src={thumbnails[doc.id]} alt="" />
                      : <div className="doc-thumb-empty">📄</div>}
                  </div>
                  <div className="doc-info">
                    <h3>{doc.name || 'Untitled'}</h3>
                    <p className="doc-meta">
                      <span className="doc-pill">{doc.pages.length} page{doc.pages.length !== 1 ? 's' : ''}</span>
                      <span>{formatDate(doc.updatedAt)}</span>
                    </p>
                  </div>
                </button>

                <button
                  className="doc-more"
                  onClick={() => setOpenCard(openCard === doc.id ? null : doc.id)}
                  aria-label="আরও"
                >
                  ⋮
                </button>

                {openCard === doc.id && (
                  <div className="doc-actions">
                    <button onClick={() => { setOpenCard(null); onOpen(doc); }}>📂 খুলুন</button>
                    <button onClick={() => { setOpenCard(null); onRename(doc); }}>✏️ নাম বদল</button>
                    <button onClick={() => { setOpenCard(null); onExport(doc.pages, doc.name); }}>⬇️ PDF সেভ</button>
                    <button onClick={() => { setOpenCard(null); onShare(doc.pages, doc.name); }}>🔗 শেয়ার</button>
                    <button className="danger" onClick={() => { setOpenCard(null); onDelete(doc.id); }}>🗑 মুছুন</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---------- নতুন স্ক্যান (FAB) ---------- */}
      <button className="lib-fab" onClick={onNewScan}>
        <span className="lib-fab-icon">＋</span>
        <span className="lib-fab-text">New Scan</span>
      </button>

      {/* ---------- সেটিংস মেনু ---------- */}
      {menuOpen && (
        <div className="sheet-backdrop" onClick={() => setMenuOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <h3>সেটিংস</h3>

            {aiReady && (
              <button className="sheet-row" onClick={() => onAiToggle(!aiOn)}>
                <span className="sheet-ico">✨</span>
                <span className="sheet-text">
                  <strong>AI ডিটেকশন</strong>
                  <small>এলোমেলো ব্যাকগ্রাউন্ডে কাগজ চিনতে সাহায্য করে</small>
                </span>
                <span className={`sheet-switch ${aiOn ? 'on' : ''}`}><i /></span>
              </button>
            )}

            <div className="sheet-row static">
              <span className="sheet-ico">🎚️</span>
              <span className="sheet-text">
                <strong>ডিফল্ট কোয়ালিটি</strong>
                <small>সেভের সময় বদলানো যাবে</small>
              </span>
            </div>
            <div className="sheet-seg">
              {Object.entries(QUALITY_PRESETS).map(([key, p]) => (
                <button
                  key={key}
                  className={quality === key ? 'active' : ''}
                  onClick={() => onQualityChange(key)}
                >{p.label}</button>
              ))}
            </div>

            <div className="sheet-divider">স্বয়ংক্রিয় সংশোধন</div>
            <p className="sheet-hint">
              যত বেশি সংশোধন একসাথে চলে, ভুল হওয়ার সম্ভাবনাও তত বাড়ে।
              তাই কেবল পরীক্ষিতগুলো ডিফল্টে চালু।
            </p>
            {corrections && Object.keys(CORRECTION_LABELS).map((k) => (
              <button key={k} className="sheet-row" onClick={() => onCorrectionToggle(k)}>
                <span className="sheet-ico">{corrections[k] ? '✅' : '⬜'}</span>
                <span className="sheet-text">
                  <strong>{CORRECTION_LABELS[k].title}</strong>
                  <small>{CORRECTION_LABELS[k].desc}</small>
                </span>
                <span className={`sheet-switch ${corrections[k] ? 'on' : ''}`}><i /></span>
              </button>
            ))}

            <div className="sheet-divider">অ্যাপ</div>
            <button className="sheet-row" onClick={forceUpdate}>
              <span className="sheet-ico">↻</span>
              <span className="sheet-text">
                <strong>আপডেট দেখুন</strong>
                <small>নতুন ভার্সন থাকলে নামিয়ে নেবে</small>
              </span>
            </button>

            <div className="sheet-note">
              সব প্রসেসিং আপনার ফোনেই হয় — কোনো ছবি কোথাও পাঠানো হয় না।
            </div>

            <button className="sheet-close" onClick={() => setMenuOpen(false)}>বন্ধ করুন</button>
          </div>
        </div>
      )}
    </div>
  );
}
