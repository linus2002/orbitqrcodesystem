/**
 * Vite build for the React frontend.
 *
 * Two constraints shape this config:
 *
 * 1. THE STRICT CSP MUST SURVIVE THE BUILD. The app ships
 *    `script-src 'self'` with no `unsafe-inline`, so the build must not emit
 *    any inline <script>. Vite's module-preload polyfill is inlined, so it is
 *    switched off (every browser that supports ES modules - which is the only
 *    way this bundle loads at all - supports modulepreload or simply ignores
 *    it). `cssCodeSplit` stays on; CSS is emitted as files, never inlined.
 *
 * 2. THE PATIENT MUST NOT DOWNLOAD THE DASHBOARD. The portal is what someone
 *    loads on a phone, possibly on 2G, to check their medicine. The admin
 *    bundle is lazy-loaded (see client/src/App.jsx), and the manual chunk
 *    split below keeps React itself in a separate long-lived cache entry.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],

  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Inline nothing: an inlined asset would become a data: URI in CSS/JS and
    // a base64 blob in the patient's initial download.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Keep the framework in its own long-lived cache entry, so shipping a
        // change to our own code does not force a re-download of React.
        // Declared as a function because Vite 8 (Rolldown) requires that form.
        manualChunks(id) {
          if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'react';
          }
          return null;
        },
      },
    },
  },

  server: {
    port: 5173,
    // In development the React app runs on Vite's server and the API calls go
    // to the Express server, so cookies and same-origin requests behave
    // exactly as they do in production.
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
});
