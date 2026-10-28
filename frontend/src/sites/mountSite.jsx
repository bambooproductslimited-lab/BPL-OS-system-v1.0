import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
// The dark theme's colours live here (on :root[data-theme='dark']); in the
// OS every screen has them because the shell is always loaded.
import '../layout/AppShell.css';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import { I18nProvider } from '../components/I18nProvider.jsx';
import { installTypeToSearch } from '../lib/typeToSearch.js';

// The till or the kitchen screen as a website of its own (pos-site.html,
// kds-site.html; tools/build-site.mjs): one page, signed in with a staff
// PIN, no OS account and none of the OS around it.
export function mountSite(Page) {
  // Every dropdown searchable, and typing goes into a screen's search box.
  installTypeToSearch();
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <ErrorBoundary>
        <I18nProvider>
          <Page />
        </I18nProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}
