import { registerSW } from 'virtual:pwa-register';

let updateSWFn = null;

export function initPWA() {
  // Self-heal: নতুন service worker পেজের দখল নিলে একবার রিলোড
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (sessionStorage.getItem('sw-reloaded')) return;
      sessionStorage.setItem('sw-reloaded', '1');
      window.location.reload();
    });
  }

  updateSWFn = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateSWFn && updateSWFn(true);
    },
    onOfflineReady() {
      console.log('App ready to work offline');
    },
  });
}

/**
 * সত্যিকারের হার্ড রিফ্রেশ।
 * শুধু location.reload() যথেষ্ট নয় — service worker পুরোনো ফাইলই cache থেকে দেয়।
 * তাই: SW-কে update চেক করাও → নতুন থাকলে activate → app-shell cache মুছে → reload।
 * (opencv-cache রেখে দিই, নাহলে অকারণে ১২MB আবার নামবে।)
 */
export async function forceUpdate() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      // সার্ভারে নতুন ভার্সন আছে কিনা দেখো
      await Promise.all(regs.map(r => r.update().catch(() => {})));

      // অপেক্ষমাণ (waiting) SW থাকলে সঙ্গে সঙ্গে সক্রিয় করো
      for (const r of regs) {
        if (r.waiting) r.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
    }

    // app-shell cache পরিষ্কার (opencv-cache বাদে)
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(
        names.filter(n => !n.includes('opencv')).map(n => caches.delete(n))
      );
    }
  } catch (e) {
    console.warn('forceUpdate issue:', e);
  } finally {
    sessionStorage.removeItem('sw-reloaded');
    // cache-busting query — ব্রাউজার যাতে নতুন index.html আনে
    const url = new URL(window.location.href);
    url.searchParams.set('u', Date.now().toString(36));
    window.location.replace(url.toString());
  }
}
