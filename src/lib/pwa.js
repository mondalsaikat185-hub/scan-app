import { registerSW } from 'virtual:pwa-register';

export function initPWA() {
  const updateSW = registerSW({
    onNeedRefresh() {
      if (confirm('A new version is available. Update now?')) {
        updateSW(true);
      }
    },
    onOfflineReady() {
      console.log('App ready to work offline');
    },
  });
}
