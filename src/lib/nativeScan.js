/**
 * Android অ্যাপ (APK) হিসেবে চললে: Google ML Kit Document Scanner
 *
 * কেন: ব্রাউজার ফোনের ক্যামেরার পুরো ক্ষমতা পায় না, আর ছবি-প্রক্রিয়াকরণও
 * সেখানে ধীর। ML Kit Google Play services-এর ভেতরে নেটিভভাবে চলে —
 * অটো-ক্যাপচার, নিখুঁত কোণা, ছায়া/দাগ/আঙুল মোছা, ফিল্টার সব ফোনের ভেতরেই,
 * ইন্টারনেট ছাড়া, বিনা খরচে।
 *
 * ওয়েবসাইট হিসেবে চললে (scan.sanvitools.in) এই ফাইল কিছুই করে না —
 * তখন আগের OpenCV পদ্ধতিই চলে।
 */
import { Capacitor } from '@capacitor/core';

export function isNativeApp() {
  try { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'; }
  catch { return false; }
}

async function plugin() {
  const mod = await import('@capacitor-mlkit/document-scanner');
  return mod.DocumentScanner;
}

/**
 * স্ক্যানার খোলে। ফেরত: Blob[] (প্রতি পাতায় একটা JPEG), বাতিল করলে [],
 * স্ক্যানার না পাওয়া গেলে null (তখন কলার পুরোনো পদ্ধতিতে যাবে)।
 */
export async function scanWithMLKit() {
  if (!isNativeApp()) return null;
  let DS;
  try { DS = await plugin(); } catch (e) { console.warn('ML Kit plugin missing', e); return null; }

  // Google-এর স্ক্যানার মডিউল ফোনে না থাকলে নামিয়ে নেওয়ার চেষ্টা
  try {
    const { available } = await DS.isGoogleDocumentScannerModuleAvailable();
    if (!available) {
      alert('Google স্ক্যানার মডিউল নামানো হচ্ছে (একবারই, ইন্টারনেট লাগবে)। কিছুক্ষণ পরে আবার চাপুন।');
      try { await DS.installGoogleDocumentScannerModule(); } catch { /* ignore */ }
      return null;
    }
  } catch { /* কিছু ফোনে এই চেক কাজ করে না — সরাসরি চেষ্টা করি */ }

  let res;
  try {
    res = await DS.scanDocument({
      galleryImportAllowed: true,   // গ্যালারির ছবিও স্ক্যানারে আনা যাবে
      pageLimit: 30,
      resultFormats: 'JPEG',
      scannerMode: 'FULL',          // ছায়া/দাগ/আঙুল মোছা সহ পূর্ণ ফিচার
    });
  } catch (e) {
    const msg = String((e && e.message) || e || '');
    if (/cancel/i.test(msg)) return [];       // ইউজার নিজে বাতিল করেছেন
    console.warn('ML Kit scan failed', e);
    return null;
  }

  const uris = (res && (res.scannedImages || res.imageUris || res.images)) || [];
  const blobs = [];
  for (const u of uris) {
    try {
      const r = await fetch(Capacitor.convertFileSrc(u));
      blobs.push(await r.blob());
    } catch (e) { console.warn('Could not read scanned page', u, e); }
  }
  return blobs;
}

/** Blob → মাপ (প্রস্থ, উচ্চতা) */
export async function blobSize(blob) {
  const bmp = await createImageBitmap(blob);
  const s = { width: bmp.width, height: bmp.height };
  bmp.close();
  return s;
}
