/**
 * The file viewer: one window, over the page, for every file the dashboard
 * shows - a pack code's QR, a leaflet PDF, a product picture, a stored
 * spreadsheet - with its downloads beside it.
 *
 * Before this, each of those opened a bare file in a new browser tab, and
 * getting back meant finding the dashboard's tab again. Now nothing leaves
 * the page: open, look, download, close (Esc or the backdrop).
 *
 *   const viewer = useViewer();
 *   viewer.open({ kind: 'qr', title, subtitle, src, downloads: [...] });
 *
 * Kinds:
 *   qr     { src }            an image of a QR, shown large enough to scan
 *   image  { src }            any picture
 *   pdf    { src }            shown in a frame; phones that cannot show a PDF
 *                             inline get an "open" button instead
 *   sheet  { previewUrl }     a stored spreadsheet's first rows, as a table
 *
 * `downloads` is a list of { label, url, filename } - each a button, fetched
 * with the session and saved, never a navigation.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { download } from '../../lib/api.js';
import { useApi, useToast } from '../../lib/hooks.jsx';
import { fmtNumber } from '../../lib/format.js';
import { Icon } from '../../components/Icons.jsx';
import { ErrorNote } from './ui.jsx';

const ViewerContext = createContext({ open: () => {}, close: () => {} });

export const useViewer = () => useContext(ViewerContext);

export function ViewerProvider({ children }) {
  const [item, setItem] = useState(null);
  const lastFocus = useRef(null);

  const open = useCallback((next) => {
    lastFocus.current = document.activeElement;
    setItem(next);
  }, []);

  const close = useCallback(() => {
    setItem(null);
    lastFocus.current?.focus?.();
  }, []);

  return (
    <ViewerContext.Provider value={{ open, close }}>
      {children}
      {item && <Viewer item={item} onClose={close} />}
    </ViewerContext.Provider>
  );
}

function Viewer({ item, onClose }) {
  const toast = useToast();
  const closeBtn = useRef(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    closeBtn.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        // The viewer can sit over a drawer; Esc closes the viewer only.
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  async function save(d) {
    setBusy(d.url);
    try {
      await download(d.url, { filename: d.filename });
    } catch (err) {
      toast(err.message ?? 'Could not download that file.', 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="viewer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`viewer viewer-${item.kind}`}
        role="dialog"
        aria-modal="true"
        aria-label={item.title}
      >
        <header className="viewer-head">
          <div className="viewer-titles">
            <h3>{item.title}</h3>
            {item.subtitle && <p className="text-sm text-muted">{item.subtitle}</p>}
          </div>
          <div className="viewer-actions">
            {(item.downloads ?? []).map((d) => (
              <button
                key={d.url}
                type="button"
                className="btn btn-sm"
                disabled={busy === d.url}
                onClick={() => save(d)}
              >
                <Icon name="download" />
                {busy === d.url ? 'Preparing...' : d.label}
              </button>
            ))}
            <button
              ref={closeBtn}
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={onClose}
              aria-label="Close"
            >
              <Icon name="x" />
            </button>
          </div>
        </header>

        <div className="viewer-body">
          {item.kind === 'qr' && <QrBody item={item} />}
          {item.kind === 'image' && <img className="viewer-image" src={item.src} alt={item.title} />}
          {item.kind === 'pdf' && <PdfBody item={item} />}
          {item.kind === 'sheet' && <SheetBody item={item} />}
        </div>

        {item.note && <p className="viewer-note text-sm text-muted">{item.note}</p>}
      </div>
    </div>
  );
}

function QrBody({ item }) {
  const toast = useToast();
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${text}`, 'success');
    } catch {
      toast('Could not copy - select it and copy it by hand.', 'error');
    }
  }
  return (
    <div className="viewer-qr">
      {/* Big enough to scan straight off the screen with a phone. */}
      <img src={item.src} alt={`QR code ${item.code ?? ''}`} width="320" height="320" />
      {item.code && (
        <div className="row">
          <span className="mono">{item.code}</span>
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => copy(item.code)}>
            Copy
          </button>
        </div>
      )}
    </div>
  );
}

function PdfBody({ item }) {
  return (
    <>
      <iframe className="viewer-frame" src={item.src} title={item.title} />
      {/* A phone's browser often cannot show a PDF inside a page; this is
          the way through for it, and the only place the viewer leaves. */}
      <p className="text-sm text-muted viewer-fallback">
        PDF not showing?{' '}
        <a href={item.src} target="_blank" rel="noopener">
          Open it on its own
        </a>
        .
      </p>
    </>
  );
}

function SheetBody({ item }) {
  const { data, error, loading } = useApi(item.previewUrl);
  if (error) return <ErrorNote error={error} />;
  if (loading || !data) return <p className="text-sm text-muted">Reading the file...</p>;
  if (!data.columns.length) return <p className="text-sm text-muted">This file is empty.</p>;
  return (
    <>
      <p className="text-sm text-muted mb-8">
        {data.sheet ? `Sheet "${data.sheet}" · ` : ''}
        {fmtNumber(data.total)} {data.total === 1 ? 'row' : 'rows'}
        {data.truncated ? ` - showing the first ${fmtNumber(data.rows.length)}` : ''}
      </p>
      <div className="viewer-sheet">
        <table className="data">
          <thead>
            <tr>
              <th className="num">#</th>
              {data.columns.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={i}>
                <td className="num text-muted">{i + 1}</td>
                {data.columns.map((_, j) => (
                  <td key={j}>{r[j] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default ViewerProvider;
