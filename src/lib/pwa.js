import { registerSW } from 'virtual:pwa-register';

export function initPWA() {
  // Self-heal: যখন নতুন service worker পেজের দখল নেয় (পুরোনো ভাঙা SW সরে যায়),
  // পেজ একবার নিজে থেকে রিলোড হবে — ইউজারকে cache মুছতে হবে না।
  // sessionStorage guard — অসীম রিলোড লুপ আটকায়।
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (sessionStorage.getItem('sw-reloaded')) return;
      sessionStorage.setItem('sw-reloaded', '1');
      window.location.reload();
    });
  }

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // autoUpdate + skipWaiting থাকায় সাধারণত এটা লাগবে না, তবু fallback
      updateSW(true);
    },
    onOfflineReady() {
      console.log('App ready to work offline');
    },
  });
}
