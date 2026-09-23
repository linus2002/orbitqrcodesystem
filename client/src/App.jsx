/**
 * Top-level routes.
 *
 * The public portal is loaded eagerly - it is the page a patient opens on a
 * phone, possibly on a slow connection, and it must appear immediately.
 *
 * The dashboard is lazy-loaded. A patient checking a pack should never
 * download the admin bundle, and Vite emits it as a separate chunk that is
 * only fetched when someone actually navigates to /admin.
 */
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { IconSprite } from './components/Icons.jsx';
import PortalPage from './portal/PortalPage.jsx';
import LeafletPage from './portal/LeafletPage.jsx';
import LoginPage from './login/LoginPage.jsx';
import NotFound from './components/NotFound.jsx';

const AdminApp = lazy(() => import('./admin/AdminApp.jsx'));

/** Full-page fallback while a lazy chunk downloads. */
function ChunkLoading() {
  return (
    <div className="page-loading">
      <span className="spinner" aria-hidden="true" />
      <p className="text-muted mt-8">Loading...</p>
    </div>
  );
}

export default function App() {
  return (
    <>
      <IconSprite />
      <Routes>
        <Route path="/" element={<PortalPage />} />
        <Route path="/verify" element={<Navigate to="/" replace />} />
        {/* The QR deep link. The portal reads the code from the URL. */}
        <Route path="/v/:code" element={<PortalPage />} />
        {/* The leaflet QR: product information, no authenticity claim. */}
        <Route path="/leaflet/:sku" element={<LeafletPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/admin/*"
          element={
            <Suspense fallback={<ChunkLoading />}>
              <AdminApp />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
