import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import '../index.css';
import '../layout/AppShell.css';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import { I18nProvider } from '../components/I18nProvider.jsx';
import ShopPage from '../pages/ShopPage';
import BookPage from '../pages/BookPage';
import SharePage from '../pages/SharePage';

// Bamboo Products' customer website (online.bplghana.com; bpl-site.html,
// tools/build-bpl.mjs): the online shop at /, booking a consultation or a
// site visit at /book, a booking's own page at /book/<its link>, and a
// document's page at /share/<its link> — where the shop's and the bookings'
// invoices are paid. No account and none of the OS around it.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <I18nProvider>
          <Routes>
            <Route path="/" element={<ShopPage />} />
            <Route path="/shop" element={<Navigate to="/" replace />} />
            <Route path="/book" element={<BookPage />} />
            <Route path="/book/:token" element={<BookPage />} />
            <Route path="/share/:token" element={<SharePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </I18nProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>
);
