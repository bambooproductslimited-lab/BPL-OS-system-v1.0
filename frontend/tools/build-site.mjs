// Builds the restaurant till or the kitchen screen as a small website of its
// own, ready to upload to its address. Run: npm run build:pos / build:kds
//
//   pos → dist-pos/   the till        (pos.starbartema.com)
//   kds → dist-kds/   the kitchen screen (kds.starbartema.com)
//
// Each is one page opened with a staff PIN, on the same API as the OS
// (VITE_API_URL from .env.production) — the API lets these addresses reach
// the till's API and nothing else (backend config.restaurantSiteOrigins).
// The page answers at every path, so the address alone opens it; a missing
// file stays a 404. KDS_URL changes where the till's "Open the kitchen
// screen" goes.
import { build, loadEnv } from 'vite';
import { cpSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = ['pos-icon-192.png', 'pos-icon-512.png', 'pos-icon-512-maskable.png', 'pos-apple-touch-icon.png', 'restaurant-logos'];
const SITES = {
  pos: {
    name: 'Star Bar POS', shortName: 'POS Till',
    description: 'Restaurant till for Star Bar Restaurant and Bamboo Garden: the menu, tables, payments and the kitchen.',
    files: ICONS.concat(['pos-sw.js']),
    env: { VITE_KDS_URL: process.env.KDS_URL || 'https://kds.starbartema.com' }
  },
  kds: {
    name: 'Star Bar Kitchen', shortName: 'Kitchen',
    description: 'Kitchen screen: the tickets from the till, station by station.',
    files: ICONS,
    env: {}
  }
};

const site = process.argv[2];
const conf = SITES[site];
if (!conf) {
  console.error('Usage: node tools/build-site.mjs ' + Object.keys(SITES).join('|'));
  process.exit(1);
}

process.env.VITE_SITE = site;
Object.assign(process.env, conf.env);
await build({ root: ROOT, mode: 'production', configFile: join(ROOT, 'vite.config.js') });

const out = join(ROOT, 'dist-' + site);
renameSync(join(out, site + '-site.html'), join(out, 'index.html'));
for (const f of conf.files) cpSync(join(ROOT, 'public', f), join(out, f), { recursive: true });

writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify({
  name: conf.name,
  short_name: conf.shortName,
  description: conf.description,
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#0b1220',
  theme_color: '#0b1220',
  icons: [
    { src: '/pos-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/pos-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/pos-icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}, null, 2) + '\n');

// A till is not something to find on a search engine.
writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

const apiUrl = loadEnv('production', ROOT, 'VITE_').VITE_API_URL || 'http://localhost:4000/api';
const api = new URL(apiUrl).origin;
writeFileSync(join(out, '.htaccess'), `# ${conf.name}: a website of its own, built by frontend/tools/build-site.mjs.
DirectoryIndex index.html

<IfModule mod_mime.c>
  AddType application/manifest+json .webmanifest
</IfModule>

# Every page address opens the one page; a missing file (a script, an icon,
# an older app's service worker) stays a real 404 rather than the page.
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteCond %{REQUEST_URI} !\\.[A-Za-z0-9]+$
  RewriteRule . /index.html [L]
</IfModule>

<IfModule mod_headers.c>
  # The page is checked for a newer build every time; its scripts and
  # styles carry the build's hash in their names.
  <FilesMatch "^(index\\.html|pos-sw\\.js|manifest\\.webmanifest)$">
    Header set Cache-Control "no-cache"
  </FilesMatch>

  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "DENY"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set X-Robots-Tag "noindex, nofollow"
  # USB and Bluetooth for the receipt printer; nothing else.
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(self), bluetooth=(self), interest-cohort=()"
  Header always set Cross-Origin-Opener-Policy "same-origin"
  Header always set Cross-Origin-Resource-Policy "same-origin"
  # The page's own scripts, Google Fonts, and the API (calls and menu photos).
  Header always set Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: ${api}; connect-src 'self' ${api}; worker-src 'self'; manifest-src 'self'; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests"
</IfModule>
`);

console.log('\n' + conf.name + ' built in ' + out + ' — upload its contents to the website\'s folder.');
