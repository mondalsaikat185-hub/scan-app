import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        globIgnores: ['**/opencv.js', '**/models/*.onnx', '**/ort/*'],
        runtimeCaching: [{
          // AI মডেল ও onnxruntime — একবার নামলে অফলাইনেও থাকবে
          urlPattern: ({ url }) => url.pathname.startsWith('/models/') || url.pathname.startsWith('/ort/'),
          handler: 'CacheFirst',
          options: {
            cacheName: 'ai-cache',
            expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 180 },
            cacheableResponse: { statuses: [0, 200] },
          },
        }, {
          urlPattern: ({ url }) => url.pathname.endsWith('/opencv.js'),
          handler: 'CacheFirst',
          options: {
            cacheName: 'opencv-cache',
            expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 90 },
            cacheableResponse: { statuses: [0, 200] },
          },
        }],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      manifest: {
        name: 'Scan App',
        short_name: 'ScanApp',
        description: 'Private in-browser document scanner',
        theme_color: '#1e293b',
        background_color: '#1e293b',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ],
});
