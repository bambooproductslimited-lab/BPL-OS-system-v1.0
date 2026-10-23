// Builds the sales team's own app as a website of its own, ready to upload
// to its address. Run: npm run build:sales
//
//   sales → dist-sales/   Sales & CRM, signed in with an OS account   (sales.oseitutu.com)
//
// The same pages as the OS's Sales & CRM (src/pages/sales/SalesApp.jsx), on
// the same API (VITE_API_URL from .env.production); the API lets this
// address in (backend config.salesSiteOrigins, SALES_SITE_URL). OS_URL is
// where the full OS is (https://oseitutu.com unless set): shared documents,
// meeting links and anything outside Sales & CRM open there. The OS itself
// also serves the app at /sales, so nothing has to be uploaded for that.
import { build, loadEnv } from 'vite';
import { cpSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OS = (process.env.OS_URL || 'https://oseitutu.com').replace(/\/+$/, '');
const COLOR = '#072a20';
const FILES = ['favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png', 'logo.png', 'sw.js'];

process.env.VITE_SITE = 'sales';
process.env.VITE_OS_URL = OS;
const out = join(ROOT, 'dist-sales');
process.env.SITE_OUT = out;
await build({ root: ROOT, mode: 'production', configFile: join(ROOT, 'vite.config.js') });

renameSync(join(out, 'sales-site.html'), join(out, 'index.html'));
for (const f of FILES) cpSync(join(ROOT, 'public', f), join(out, f));

writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify({
  name: 'Bamboo Sales',
  short_name: 'Sales',
  description: 'Sales & CRM for the Bamboo Products sales team: the sales board, leads, customers, follow-ups, site visits, quotations and invoices.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: COLOR,
  theme_color: COLOR,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}, null, 2) + '\n');

writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

const api = new URL(loadEnv('production', ROOT, 'VITE_').VITE_API_URL || 'http://localhost:4000/api').origin;
// What the OS's own .htaccess allows (public/.htaccess), less Facebook's
// sign-up window, which only Integrations uses.
const TILES = 'https://tile.openstreetmap.org https://tile.googleapis.com https://developers.google.com';
writeFileSync(join(out, '.htaccess'), `# Bamboo Sales: the sales team's own app, built by frontend/tools/build-sales.mjs.
DirectoryIndex index.html

<IfModule mod_mime.c>
  AddType application/manifest+json .webmanifest
  # The PDF viewer's helper (components/FileViewer.jsx) is a JavaScript module saved as .mjs.
  AddType text/javascript .mjs
</IfModule>

# Every page address opens the one page; a missing file stays a real 404.
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteCond %{REQUEST_URI} !\\.[A-Za-z0-9]+$
  RewriteRule . /index.html [L]
</IfModule>

<IfModule mod_headers.c>
  # The page and the service worker are checked for a newer build every
  # time; scripts and styles carry the build's hash in their names.
  <FilesMatch "^(index\\.html|sw\\.js|manifest\\.webmanifest)$">
    Header set Cache-Control "no-cache"
  </FilesMatch>

  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "DENY"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set X-Robots-Tag "noindex, nofollow"
  # The camera, microphone and screen for calls and voice notes; where the phone is, for site visits.
  Header always set Permissions-Policy "camera=(self), geolocation=(self), microphone=(self), display-capture=(self), payment=(), usb=(), interest-cohort=()"
  Header always set Cross-Origin-Opener-Policy "same-origin-allow-popups"
  Header always set Cross-Origin-Resource-Policy "same-origin"
  # The page's own scripts, Google Fonts, the API, LiveKit for calls, and the map's streets.
  Header always set Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: ${api} ${TILES}; connect-src 'self' ${api} wss://*.livekit.cloud https://*.livekit.cloud https://tile.googleapis.com blob: data:; worker-src 'self' blob:; manifest-src 'self'; media-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests"
</IfModule>
`);

console.log('\nBamboo Sales built in ' + out + ' — upload its contents to sales.oseitutu.com\'s folder.');
