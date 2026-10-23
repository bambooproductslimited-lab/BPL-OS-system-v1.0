import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { I18nProvider } from './components/I18nProvider.jsx'
import { AuthProvider } from './auth/AuthContext'
import { API_URL } from './api/client'
import { LazySalesApp } from './pages/sales/lazySalesApp.js'

// oseitutu.com/sales is the sales team's own app (pages/sales/SalesApp.jsx),
// the same one as sales.oseitutu.com (src/sites/sales.jsx): only Sales &
// CRM, signed in with the same account.
const SALES = /^\/sales(\/|$)/.test(window.location.pathname)

// Makes the app installable (PWA) and lets the app shell open instantly on
// repeat visits — see public/sw.js. Registered at scope '/', which coexists
// fine with the separate kiosk service worker at scope '/kiosk' (the more
// specific scope wins for a given URL, so /kiosk stays on its own worker
// and cache, unaffected by this one).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // The API's address rides along so the worker can decline a call
    // straight from its pop-up (public/sw.js), with the OS closed.
    navigator.serviceWorker.register('/sw.js?api=' + encodeURIComponent(API_URL), { scope: '/' }).catch(() => {});
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter basename={SALES ? '/sales' : undefined}>
      <ErrorBoundary>
        {/* AuthProvider sits ABOVE I18nProvider on purpose. Switching
            language remounts everything below the I18n provider (see
            lib/i18n.jsx); with the session inside that subtree, every
            switch threw the session away, re-fetched /api/me and bounced
            the user through /login on the way back. */}
        <AuthProvider>
          <I18nProvider>
            {SALES ? <Suspense fallback={null}><LazySalesApp /></Suspense> : <App />}
          </I18nProvider>
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
)
