/**
 * Android অ্যাপ (APK) হিসেবে চললে: Google ML Kit Document Scanner
 *
 * কেন: ব্রাউজার ফোনের ক্যামেরার পুরো ক্ষমতা পায় না, আর ছবি-প্রক্রিয়াকরণও
 * সেখানে ধীর। ML Kit Google Play services-এর ভেতরে নেটিভভাবে চলে —
 * অটো-ক্যাপচার, নিখুঁত কোণা, ছায়া/দাগ/আঙুল মোছা, ফিল্টার সব ফোনের ভেতরেই।
 *
 * ওয়েবসাইট হিসেবে চললে (scan.sanvitools.in) এই ফাইল কিছুই করে না —
 * তখন আগের OpenCV পদ্ধতিই চলে।
 *
 * শিক্ষা (v1-এর বাগ): স্ক্যানার না খুললে প্রমিস কখনো শেষ হতো না, আর অ্যাপ
 * "Processing…"-এ চিরকাল আটকে থাকত। এখন একটা পাহারাদার (watchdog) আছে:
 * নির্দিষ্ট সময়ের মধ্যে স্ক্যানারের পর্দা না এলে কারণসহ জানিয়ে পুরোনো পদ্ধতিতে যায়।
 */
import { Capacitor } from '@capacitor/core';

const OPEN_TIMEOUT_MS = 15000;   // এর মধ্যে স্ক্যানারের পর্দা না খুললে ব্যর্থ ধরি

export function isNativeApp() {
  try { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'; }
  catch { return false; }
}

/**
 * স্ক্যানার খোলে।
 * ফেরত: { status: 'ok', blobs } | { status: 'cancel' } | { status: 'unavailable', reason }
 */
export async function scanWithMLKit() {
  if (!isNativeApp()) return { status: 'unavailable', reason: 'not-native' };
  let DS, AppPlugin;
  try {
    DS = (await import('@capacitor-mlkit/document-scanner')).DocumentScanner;
    AppPlugin = (await import('@capacitor/app')).App;
  } catch (e) {
    return { status: 'unavailable', reason: 'plugin-missing: ' + (e && e.message) };
  }

  // স্ক্যানারের পর্দা খুললে আমাদের অ্যাপ "pause" হয় — এটাই খোলার প্রমাণ
  let opened = false;
  let pauseHandle = null;
  try { pauseHandle = await AppPlugin.addListener('pause', () => { opened = true; }); } catch { /* ignore */ }

  const scanP = DS.scanDocument({
    galleryImportAllowed: true,   // গ্যালারির ছবিও স্ক্যানারে আনা যাবে
    pageLimit: 30,
    resultFormats: 'JPEG',
    scannerMode: 'FULL',          // ছায়া/দাগ/আঙুল মোছা সহ পূর্ণ ফিচার
  }).then((r) => ({ r }), (e) => ({ e }));

  let out = await Promise.race([
    scanP,
    new Promise((res) => setTimeout(() => res({ timeout: true }), OPEN_TIMEOUT_MS)),
  ]);
  if (out.timeout) {
    if (opened) {
      out = await scanP;           // পর্দা খুলেছে — ইউজার যতক্ষণ খুশি স্ক্যান করুক
    } else {
      if (pauseHandle) pauseHandle.remove();
      // সম্ভবত Google-এর স্ক্যানার মডিউল ফোনে নেই — নামানো শুরু করে দিই
      try { DS.installGoogleDocumentScannerModule().catch(() => {}); } catch { /* ignore */ }
      return { status: 'unavailable', reason: 'scanner-did-not-open (timeout)' };
    }
  }
  if (pauseHandle) pauseHandle.remove();

  if (out.e) {
    const msg = String((out.e && out.e.message) || out.e || '');
    // ইউজার নিজে Back চেপে বাতিল করলে Android RESULT_CANCELED (0) দেয়
    if (/Result code: 0\b/.test(msg)) return { status: 'cancel' };
    if (/not available|install/i.test(msg)) {
      try { DS.installGoogleDocumentScannerModule().catch(() => {}); } catch { /* ignore */ }
    }
    return { status: 'unavailable', reason: msg };
  }

  const uris = (out.r && out.r.scannedImages) || [];
  if (uris.length === 0) return { status: 'cancel' };
  const blobs = [];
  for (const u of uris) {
    try {
      const r = await fetch(Capacitor.convertFileSrc(u));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      blobs.push(await r.blob());
    } catch (e) { console.warn('Could not read scanned page', u, e); }
  }
  if (blobs.length === 0) return { status: 'unavailable', reason: 'could-not-read-scanned-files' };
  return { status: 'ok', blobs };
}

/** Blob → মাপ (প্রস্থ, উচ্চতা) */
export async function blobSize(blob) {
  const bmp = await createImageBitmap(blob);
  const s = { width: bmp.width, height: bmp.height };
  bmp.close();
  return s;
}

/**
 * অ্যাপের "খোলস" (APK) নতুন সংস্করণ আছে কিনা।
 * ওয়েব-অংশ প্রতিবার খোলার সময় নিজেই সর্বশেষটা নেয়; শুধু নেটিভ অংশ বদলালে
 * নতুন APK লাগে — তখন একবার জিজ্ঞেস করে ডাউনলোড পাতা খুলে দিই।
 */
const RELEASE_API = 'https://api.github.com/repos/mondalsaikat185-hub/scan-app/releases/tags/apk-latest';
export const APK_URL = 'https://github.com/mondalsaikat185-hub/scan-app/releases/download/apk-latest/ScanApp.apk';

export async function checkShellUpdate() {
  if (!isNativeApp()) return;
  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    const mine = parseInt(info.build, 10) || 0;
    const r = await fetch(RELEASE_API, { cache: 'no-store' });
    if (!r.ok) return;
    const rel = await r.json();
    const m = /run (\d+)/.exec(rel.body || '');
    const latest = m ? parseInt(m[1], 10) : 0;
    const key = 'shell-update-asked-' + latest;
    if (latest > mine && !localStorage.getItem(key)) {
      localStorage.setItem(key, '1');
      if (window.confirm('Scan App-এর নতুন সংস্করণ (APK) এসেছে। এখন নামাবেন?\n(নামানোর পর ফাইলটা খুলে Install চাপবেন — আপনার স্ক্যান মুছবে না)')) {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url: APK_URL });
      }
    }
  } catch (e) {
    console.warn('shell update check failed', e);
  }
}
