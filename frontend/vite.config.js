import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// VITE_SITE=pos|kds (set by tools/build-site.mjs): the till or the kitchen
// screen built as a small website of its own into dist-pos/ or dist-kds/,
// from pos-site.html / kds-site.html alone. The script copies the few
// public files it needs, so nothing else from public/ goes with it.
const SITE = process.env.VITE_SITE

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  publicDir: SITE ? false : 'public',
  build: SITE
    ? {
        outDir: process.env.SITE_OUT || 'dist-' + SITE, // SITE_OUT: another restaurant's build (BRAND)
        emptyOutDir: true,
        rollupOptions: { input: { [SITE]: resolve(__dirname, SITE + '-site.html') } }
      }
    : {
        rollupOptions: {
          // kiosk.html and pos.html are additional static shells for the same
          // SPA (same src/main.jsx entry, same React app) — they exist only so
          // /kiosk and /pos each get their own <link rel="manifest"> baked into
          // the HTML from the first byte. iOS Safari's "Add to Home Screen"
          // resolves the manifest from the served document, before any
          // client-side JS runs, so swapping the tag at runtime (what
          // KioskPage.jsx used to do) was too late to matter on it — see
          // kiosk-manifest.webmanifest's own comment.
          input: {
            main: resolve(__dirname, 'index.html'),
            kiosk: resolve(__dirname, 'kiosk.html'),
            pos: resolve(__dirname, 'pos.html')
          }
        }
      }
})
