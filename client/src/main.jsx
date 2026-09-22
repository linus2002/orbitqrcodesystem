/**
 * Application entry point.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.jsx';
import { applyStoredTheme, SessionProvider, ToastProvider } from './lib/hooks.jsx';

/*
 * Poppins, self-hosted.
 *
 * Deliberately NOT loaded from Google Fonts: a CDN would force `style-src`
 * and `font-src` in the Content-Security-Policy to allow two third-party
 * origins, and would put a render-blocking cross-origin request on the
 * patient's critical path - on exactly the connections this system has to
 * work on.
 *
 * The latin subsets are ~8 kB each and ship `font-display: swap`, so text
 * paints immediately in the system fallback and re-renders when Poppins
 * arrives. Only the four weights the stylesheets actually use are loaded.
 */
import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-600.css';
import '@fontsource/poppins/latin-700.css';

// Stylesheets are imported here so Vite bundles and hashes them. They are the
// same framework-agnostic stylesheets the pre-React build used.
import './styles/app.css';
import './styles/portal.css';
import './styles/login.css';
import './styles/admin.css';

// Applied before the first paint so there is no flash of the wrong theme.
applyStoredTheme();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>
);
