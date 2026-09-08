import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
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
