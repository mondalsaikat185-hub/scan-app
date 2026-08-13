import React, { useEffect, useState } from 'react';
import './InstallPrompt.css';

const DISMISS_KEY = 'install-prompt-dismissed';

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // ইতিমধ্যে ইনস্টল করা (standalone) হলে দেখানোর দরকার নেই
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    if (standalone) return;

    const handler = (e) => {
      e.preventDefault();
      setDeferred(e);
      // ইউজার আগে বন্ধ করে থাকলে ৭ দিন আর দেখাবে না
      const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - dismissedAt > sevenDays) setVisible(true);
    };

    const installed = () => setVisible(false);

    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', installed);
    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  const install = async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    setDeferred(null);
    setVisible(false);
  };

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="install-prompt" role="dialog" aria-label="Install app">
      <img src="/icon-192.png" alt="" className="install-icon" />
      <div className="install-text">
        <strong>Install Scan App</strong>
        <span>অফলাইনেও চলবে, হোম স্ক্রিনে আইকন থাকবে</span>
      </div>
      <button className="install-btn" onClick={install}>Install</button>
      <button className="install-close" onClick={dismiss} aria-label="Close">✕</button>
    </div>
  );
}
