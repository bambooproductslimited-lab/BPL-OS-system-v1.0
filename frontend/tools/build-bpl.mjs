// Builds Bamboo Products' customer website as a website of its own, ready
// to upload to its address. Run: npm run build:bpl
//
//   bpl → dist-bpl/   the shop, bookings, and invoices to pay   (online.bplghana.com)
//
// The same pages as the OS's /shop, /book and /share (src/sites/bpl.jsx),
// on the same API (VITE_API_URL from .env.production); the API lets this
// address reach those public pages and nothing else (backend
// config.bplSiteOrigins, BPL_SITE_URL), and sends customers' links here.
// Meant to be found by search engines.
import { build, loadEnv } from 'vite';
import { cpSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COLOR = '#234d21';
const FILES = ['favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png', 'logo.png'];

process.env.VITE_SITE = 'bpl';
const out = process.env.SITE_OUT || join(ROOT, 'dist-bpl');
process.env.SITE_OUT = out;
await build({ root: ROOT, mode: 'production', configFile: join(ROOT, 'vite.config.js') });

renameSync(join(out, 'bpl-site.html'), join(out, 'index.html'));
for (const f of FILES) cpSync(join(ROOT, 'public', f), join(out, f));

writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify({
  name: 'Bamboo Products',
  short_name: 'Bamboo Products',
  description: 'Furniture, blinds, garden pieces and lighting made from Ghanaian bamboo: order online, or book a consultation or a site measurement.',
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

writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nAllow: /\nDisallow: /share/\nDisallow: /book/\n');

const api = new URL(loadEnv('production', ROOT, 'VITE_').VITE_API_URL || 'http://localhost:4000/api').origin;
writeFileSync(join(out, '.htaccess'), `# Bamboo Products' customer website, built by frontend/tools/build-bpl.mjs.
DirectoryIndex index.html

<IfModule mod_mime.c>
  AddType application/manifest+json .webmanifest
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
  # The page is checked for a newer build every time; scripts and styles
  # carry the build's hash in their names.
  <FilesMatch "^(index\\.html|manifest\\.webmanifest)$">
    Header set Cache-Control "no-cache"
  </FilesMatch>

  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "DENY"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), interest-cohort=()"
  Header always set Cross-Origin-Opener-Policy "same-origin"
  Header always set Cross-Origin-Resource-Policy "same-origin"
  # The page's own scripts, Google Fonts, and the API (calls and product photos).
  Header always set Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: ${api}; connect-src 'self' ${api}; worker-src 'self'; manifest-src 'self'; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests"
</IfModule>
`);

console.log('\nBamboo Products\' website built in ' + out + ' — upload its contents to online.bplghana.com\'s folder.');
