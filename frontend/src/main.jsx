import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { I18nProvider } from './components/I18nProvider.jsx'
import { AuthProvider } from './auth/AuthContext'

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
      <ErrorBoundary>
        {/* AuthProvider sits ABOVE I18nProvider on purpose. Switching
            language remounts everything below the I18n provider (see
            lib/i18n.jsx); with the session inside that subtree, every
            switch threw the session away, re-fetched /api/me and bounced
            the user through /login on the way back. */}
        <AuthProvider>
          <I18nProvider>
            <App />
          </I18nProvider>
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
)
