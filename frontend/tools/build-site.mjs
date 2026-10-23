// Builds the restaurant till, the kitchen screen, the delivery screen or the
// ordering website as a small website of its own, ready to upload to its
// address. Run: npm run build:pos / build:kds / build:delivery / build:online
//
//   pos      → dist-pos/        the till              (pos.starbartema.com)
//   kds      → dist-kds/        the kitchen screen    (kds.starbartema.com)
//   delivery → dist-delivery/   deliveries and riders (delivery.starbartema.com)
//   online   → dist-online/     customers order       (online.starbartema.com)
//
// Each is one page opened with a staff PIN, on the same API as the OS
// (VITE_API_URL from .env.production) — the API lets these addresses reach
// the till's API and nothing else (backend config.restaurantSiteOrigins).
// The page answers at every path, so the address alone opens it; a missing
// file stays a 404. KDS_URL and DELIVERY_URL change where the till's "Open
// the kitchen screen" and "Deliveries" go; ONLINE_COMPANY which restaurant
// the website sells for. The delivery screen and the website show a map
// (OpenStreetMap's streets, or MAP_TILES) and may ask where the phone is;
// the website, unlike the others, is meant to be found by search engines.
//
// BRAND=bamboogarden builds the same four for Bamboo Garden on its own
// addresses (pos., kds., delivery., online.bamboogarden.biz) into
// dist-bamboogarden-<site>/: its name on the pages, its website selling
// for BGN. The till, the kitchen and the delivery screen serve any
// restaurant (the staff PIN says which); only the names and links differ.
import { build, loadEnv } from 'vite';
import { cpSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRANDS = {
  starbar: { name: 'Star Bar', full: 'Star Bar Restaurant', domain: 'starbartema.com', company: 'SBR', color: '#0b1220' },
  bamboogarden: { name: 'Bamboo Garden', full: 'Bamboo Garden', domain: 'bamboogarden.biz', company: 'BGN', color: '#0b1a12' }
};
const BRAND_KEY = process.env.BRAND || 'starbar';
const BRAND = BRANDS[BRAND_KEY];
if (!BRAND) {
  console.error('BRAND must be one of: ' + Object.keys(BRANDS).join(', '));
  process.exit(1);
}
const at = (sub) => 'https://' + sub + '.' + BRAND.domain;
const ICONS = ['pos-icon-192.png', 'pos-icon-512.png', 'pos-icon-512-maskable.png', 'pos-apple-touch-icon.png', 'restaurant-logos'];
const SITES = {
  pos: {
    name: BRAND.name + ' POS', shortName: 'POS Till',
    description: 'Restaurant till for ' + BRAND.full + ': the menu, tables, payments and the kitchen.',
    files: ICONS.concat(['pos-sw.js']),
    env: { VITE_KDS_URL: process.env.KDS_URL || at('kds'), VITE_DELIVERY_URL: process.env.DELIVERY_URL || at('delivery') },
    map: true // sending a delivery out may need its pin dropped
  },
  kds: {
    name: BRAND.name + ' Kitchen', shortName: 'Kitchen',
    description: 'Kitchen screen: the tickets from the till, station by station.',
    files: ICONS,
    env: {}
  },
  delivery: {
    name: BRAND.name + ' Delivery', shortName: 'Delivery',
    description: 'Website orders to accept, food to send out with a rider, and the riders on a live map.',
    files: ICONS,
    env: {}, map: true, where: true
  },
  online: {
    name: BRAND.name + ' · Order online', shortName: BRAND.name,
    description: 'Order from ' + BRAND.full + ': delivered to your door or ready to pick up.',
    files: ICONS,
    env: { VITE_ONLINE_COMPANY: process.env.ONLINE_COMPANY || BRAND.company }, map: true, where: true, public: true
  }
};
// The map's streets: OpenStreetMap's, unless MAP_TILES names others (its host is let through);
// and Google's (its Map Tiles API, with its logo) when the server has a key for it (GOOGLE_MAPS_KEY).
const TILES = process.env.MAP_TILES || '';
if (TILES) process.env.VITE_MAP_TILES = TILES;
const TILE_HOSTS = (TILES ? new URL(TILES.replace(/\{[a-z]\}/g, 'a')).origin : 'https://tile.openstreetmap.org') + ' https://tile.googleapis.com https://developers.google.com';
const MAP_CALLS = 'https://tile.googleapis.com';

const site = process.argv[2];
const conf = SITES[site];
if (!conf) {
  console.error('Usage: node tools/build-site.mjs ' + Object.keys(SITES).join('|'));
  process.exit(1);
}

process.env.VITE_SITE = site;
Object.assign(process.env, conf.env);
const out = join(ROOT, BRAND_KEY === 'starbar' ? 'dist-' + site : 'dist-' + BRAND_KEY + '-' + site);
process.env.SITE_OUT = out;
await build({ root: ROOT, mode: 'production', configFile: join(ROOT, 'vite.config.js') });

renameSync(join(out, site + '-site.html'), join(out, 'index.html'));
if (BRAND_KEY !== 'starbar') {
  // The page's title, description and colour: this restaurant's.
  const page = join(out, 'index.html');
  writeFileSync(page, readFileSync(page, 'utf8').replace(/Star Bar Restaurant/g, BRAND.full).replace(/Star Bar/g, BRAND.name).replace(/#0b1220/g, BRAND.color));
}
for (const f of conf.files) cpSync(join(ROOT, 'public', f), join(out, f), { recursive: true });

writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify({
  name: conf.name,
  short_name: conf.shortName,
  description: conf.description,
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: BRAND.color,
  theme_color: BRAND.color,
  icons: [
    { src: '/pos-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/pos-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/pos-icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}, null, 2) + '\n');

// A till is not something to find on a search engine; the ordering website is.
writeFileSync(join(out, 'robots.txt'), conf.public ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n');

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
${conf.public ? '' : '  Header always set X-Robots-Tag "noindex, nofollow"\n'}  # USB and Bluetooth for the receipt printer${conf.where ? '; where the phone is, for the map' : ''}; nothing else.
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=${conf.where ? '(self)' : '()'}, display-capture=(), payment=(), usb=(self), bluetooth=(self), interest-cohort=()"
  Header always set Cross-Origin-Opener-Policy "same-origin"
  Header always set Cross-Origin-Resource-Policy "same-origin"
  # The page's own scripts, Google Fonts, and the API (calls and menu photos)${conf.map ? ', and the map\'s streets' : ''}.
  Header always set Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: ${api}${conf.map ? ' ' + TILE_HOSTS : ''}; connect-src 'self' ${api}${conf.map ? ' ' + MAP_CALLS : ''}; worker-src 'self'; manifest-src 'self'; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests"
</IfModule>
`);

console.log('\n' + conf.name + ' built in ' + out + ' — upload its contents to the website\'s folder.');
