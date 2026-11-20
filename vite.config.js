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
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * PDF.js's support files - standard fonts, character maps, image decoders,
 * colour profiles - at /pdfjs/, from this site: the CSP allows nothing from
 * anywhere else. Copied into the build (so it works on any host that serves
 * dist/, Vercel included) and served straight from node_modules in dev.
 * See client/src/components/PdfPages.jsx.
 */
function pdfjsAssets() {
  const src = path.resolve('node_modules/pdfjs-dist');
  const dirs = ['standard_fonts', 'cmaps', 'wasm', 'iccs'];
  const types = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.bcmap': 'application/octet-stream' };
  let outDir = 'dist';
  return {
    name: 'pdfjs-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const file = path.resolve(src, rel);
        // Only the four folders, never a path that climbs out of them.
        if (!dirs.some((d) => file.startsWith(path.join(src, d) + path.sep)) || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const d of dirs) fs.cpSync(path.join(src, d), path.join(outDir, 'pdfjs', d), { recursive: true });
    },
  };
}

// The API's port, from the same .env the server reads, so the dev proxy
// always points at where the API actually listens (a fixed port here once
// sent every /api call to nothing, and the portal showed a bare 502).
const env = loadEnv('development', process.cwd(), '');
const API_TARGET = env.API_TARGET || `http://localhost:${env.PORT || 3000}`;

export default defineConfig({
  root: 'client',
  plugins: [react(), pdfjsAssets()],

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
        target: API_TARGET,
        changeOrigin: false,
      },
    },
  },
});
