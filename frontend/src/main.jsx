import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'

// Makes the app installable (PWA) and lets the app shell open instantly on
// repeat visits — see public/sw.js. Registered at scope '/', which coexists
// fine with the separate kiosk service worker at scope '/kiosk' (the more
// specific scope wins for a given URL, so /kiosk stays on its own worker
// and cache, unaffected by this one).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
