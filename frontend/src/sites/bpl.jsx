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
import PayPage from '../pages/PayPage';
import ContractPage from '../pages/ContractPage';
import ShopOrderPage from '../pages/ShopOrderPage';
import ShopServicePage from '../pages/ShopServicePage';
import PortalPage from '../pages/PortalPage';
import StatementPage from '../pages/StatementPage';

// Bamboo Products' customer website (online.bplghana.com; bpl-site.html,
// tools/build-bpl.mjs): the online shop at /, booking a consultation or a
// site visit at /book, a booking's own page at /book/<its link>, and a
// document's page at /share/<its link> — where the shop's and the bookings'
// invoices are paid — a payment link at /pay/<its link>, and a contract to
// sign at /c/<its link>, a shop order followed at /o/<its link> (and a
// repair asked for from it at /s/<its link>), a statement of account at
// /statement/<its link>, and the customer's own account at /account (a
// code, no password). None of the OS around it.
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
            <Route path="/pay/:token" element={<PayPage />} />
            <Route path="/c/:token" element={<ContractPage />} />
            <Route path="/o/:token" element={<ShopOrderPage />} />
            <Route path="/s/:token" element={<ShopServicePage />} />
            <Route path="/statement/:token" element={<StatementPage />} />
            <Route path="/account" element={<PortalPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </I18nProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>
);
