import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '../index.css';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import { I18nProvider } from '../components/I18nProvider.jsx';
import { AuthProvider } from '../auth/AuthContext';
import { API_URL } from '../api/client';
import SalesApp from '../pages/sales/SalesApp.jsx';

// The sales team's own app as a website of its own (sales.oseitutu.com;
// sales-site.html, tools/build-sales.mjs): signed in with an OS account,
// the OS's Sales & CRM and nothing else. Its service worker is the OS's
// (public/sw.js), so the app opens instantly and notifications and calls
// still pop up with it closed.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js?api=' + encodeURIComponent(API_URL), { scope: '/' }).catch(() => {});
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <AuthProvider>
          <I18nProvider>
            <SalesApp />
          </I18nProvider>
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>
);
