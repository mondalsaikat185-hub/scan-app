import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initPWA } from './lib/pwa.js'
import { isNativeApp } from './lib/nativeScan.js'

// Android অ্যাপের ভেতরে service worker/ইনস্টল-প্রম্পট লাগে না (ফাইল অ্যাপেই আছে)
if (!isNativeApp()) initPWA();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
