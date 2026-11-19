/**
 * A PDF, shown as pages on the page itself.
 *
 * A phone's browser does not display a PDF inside a page - Android's Chrome
 * downloads it instead - so someone who scanned a leaflet QR to read the
 * leaflet was handed a file. Here the PDF is drawn with PDF.js (Mozilla's
 * renderer, the one in Firefox) onto a canvas per page, the same on every
 * browser.
 *
 *   - PDF.js is loaded only when a leaflet has a PDF: nobody else downloads it.
 *   - Pages are drawn as they come near the screen, not all at once, so a long
 *     leaflet does not freeze a cheap phone.
 *   - Each page is drawn at the width it is shown at, times the screen's pixel
 *     density (capped at 2), so text stays sharp; and again if that width
 *     changes, as when the phone turns.
 *   - Zoom (- / +) redraws the pages larger, sharp, and lets them scroll
 *     sideways: a folded leaflet is a big sheet, unreadable at phone width,
 *     and pinching a page drawn small only blurs it.
 *   - Only the parts of the file a page needs are downloaded (byte ranges,
 *     see the leaflet.pdf route), as that page comes near the screen.
 *
 * Everything PDF.js loads - its worker, fonts, character maps and image
 * decoders - comes from this site (the worker from the bundle, the rest from
 * /pdfjs/, see server.js), because the CSP allows scripts from 'self' only.
 */
import { useEffect, useRef, useState } from 'react';

import { Icon } from './Icons.jsx';

let pdfjsPromise = null;

/** PDF.js and its worker, loaded once, on first use. */
function loadPdfjs() {
  pdfjsPromise ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return pdfjsPromise;
}

const ASSETS = '/pdfjs/';
const CHUNK = 512 * 1024;

/** Bytes `begin` to `end` (exclusive) of the file, or the whole file if the server ignores ranges. */
async function fetchRange(url, begin, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { partial: res.status === 206, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/**
 * Open the PDF by byte ranges WE fetch, rather than by URL.
 *
 * Given a URL, PDF.js starts a full download just to read the response
 * headers, and cancels it once it sees ranges are allowed - by which time a
 * slow phone has already spent megabytes on bytes nobody asked for. With the
 * size known in advance (the leaflet API gives it), PDF.js can be handed the
 * first chunk and asked for the rest, range by range, and nothing is fetched
 * twice. A server that ignores ranges just gets the whole file read once.
 */
async function openDocument(pdfjs, url, size, options, onBytes) {
  if (!size) return pdfjs.getDocument({ url, ...options });
  const first = await fetchRange(url, 0, Math.min(size, CHUNK));
  onBytes(first.bytes.length);
  if (!first.partial) return pdfjs.getDocument({ data: first.bytes, ...options });

  const transport = new pdfjs.PDFDataRangeTransport(size, first.bytes);
  transport.requestDataRange = (begin, end) => {
    fetchRange(url, begin, end)
      .then(({ bytes }) => {
        onBytes(bytes.length);
        transport.onDataRange(begin, bytes);
      })
      // PDF.js waits for a range forever; a failed one fails the document.
      .catch((err) => transport.onError?.(err) ?? task?.destroy());
  };
  const task = pdfjs.getDocument({ range: transport, ...options });
  return task;
}
const MAX_DPR = 2;
const ZOOMS = [1, 1.5, 2, 3];
// The largest canvas every phone browser will draw (Safari's limit is 16.7M px).
const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * @param {object} props
 * @param {string} props.url       the PDF
 * @param {number} [props.size]    its size in bytes; lets it load by ranges
 * @param {string} [props.title]   for screen readers: what the pages are
 * @param {string} [props.downloadName]
 */
export default function PdfPages({ url, size, title = 'Document', downloadName }) {
  const wrap = useRef(null);
  const [doc, setDoc] = useState(null);
  const [state, setState] = useState({ status: 'loading' });
  // Download progress, kept apart from `state`: with byte ranges, progress
  // reports keep arriving after the document itself is open.
  const [progress, setProgress] = useState(null);
  // The loading line stays until page 1 is actually on screen - the document
  // opens from its index long before the first page's pictures arrive.
  const [firstDrawn, setFirstDrawn] = useState(false);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(0); // an index into ZOOMS

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    let task = null;
    setDoc(null);
    setState({ status: 'loading' });
    setProgress(null);
    setFirstDrawn(false);
    let loaded = 0;
    loadPdfjs()
      .then((pdfjs) =>
        cancelled
          ? null
          : openDocument(
              pdfjs,
              url,
              size,
              {
                standardFontDataUrl: `${ASSETS}standard_fonts/`,
                cMapUrl: `${ASSETS}cmaps/`,
                cMapPacked: true,
                wasmUrl: `${ASSETS}wasm/`,
                iccUrl: `${ASSETS}iccs/`,
                // Scripts inside a PDF never run here.
                enableScripting: false,
                // Only what the pages on screen need: the first page appears
                // without waiting for the whole file, and pages nobody
                // scrolls to cost no mobile data.
                rangeChunkSize: CHUNK,
                disableAutoFetch: true,
                disableStream: true,
              },
              (n) => {
                loaded += n;
                if (!cancelled && size) setProgress(Math.min(loaded / size, 1));
              }
            )
      )
      .then((t) => {
        if (cancelled || !t) return null;
        task = t;
        if (!size) {
          t.onProgress = ({ loaded: l, total }) => {
            if (!cancelled && total) setProgress(Math.min(l / total, 1));
          };
        }
        return t.promise;
      })
      .then((d) => {
        if (cancelled || !d) return;
        setDoc(d);
        setState({ status: 'ready' });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', error });
      });
    return () => {
      cancelled = true;
      task?.destroy();
    };
  }, [url, size]);

  // Follow the width the pages are shown at.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    let timer = null;
    const measure = () => setWidth(Math.floor(el.clientWidth));
    measure();
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  const pageWidth = Math.floor(width * ZOOMS[zoom]);

  return (
    <div className="pdf-pages" ref={wrap} role="document" aria-label={title}>
      {doc && (
        <div className="pdf-toolbar" role="toolbar" aria-label="Zoom">
          <span className="pdf-count">
            {doc.numPages} {doc.numPages === 1 ? 'page' : 'pages'}
          </span>
          <button
            type="button"
            className="pdf-zoom"
            onClick={() => setZoom((z) => Math.max(z - 1, 0))}
            disabled={zoom === 0}
            aria-label="Zoom out"
          >
            -
          </button>
          <span className="pdf-zoom-level" aria-live="polite">
            {Math.round(ZOOMS[zoom] * 100)}%
          </span>
          <button
            type="button"
            className="pdf-zoom"
            onClick={() => setZoom((z) => Math.min(z + 1, ZOOMS.length - 1))}
            disabled={zoom === ZOOMS.length - 1}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      )}

      {state.status !== 'error' && !firstDrawn && (
        <div className="pdf-status" role="status">
          <span className="pdf-spinner" aria-hidden="true" />
          <span>
            Loading the leaflet
            {progress != null && progress < 1 ? ` - ${Math.round(progress * 100)}%` : '...'}
          </span>
        </div>
      )}

      {state.status === 'error' && (
        <div className="alert alert-warn">
          <Icon name="alert" />
          <span>
            The leaflet could not be shown here.{' '}
            <a href={url} download={downloadName}>
              Download the PDF
            </a>{' '}
            to read it instead.
          </span>
        </div>
      )}

      {doc && width > 0 && (
        // Wider than the screen once zoomed in: it scrolls sideways, the
        // page around it does not.
        <div className="pdf-scroll">
          {Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage
              key={i + 1}
              doc={doc}
              number={i + 1}
              width={pageWidth}
              total={doc.numPages}
              onDrawn={i === 0 ? () => setFirstDrawn(true) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One page: a placeholder of the right shape until it nears the screen, then drawn. */
function PdfPage({ doc, number, width, total, onDrawn }) {
  const canvas = useRef(null);
  const holder = useRef(null);
  const [ratio, setRatio] = useState(1.414); // A4 until the page says otherwise
  const [near, setNear] = useState(number === 1);
  const [drawn, setDrawn] = useState(false);

  // Draw when within a screen or so of being seen.
  useEffect(() => {
    if (near) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: '1200px 0px' }
    );
    io.observe(holder.current);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return undefined;
    let cancelled = false;
    let task = null;
    (async () => {
      const page = await doc.getPage(number);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const cssHeight = (width * base.height) / base.width;
      // Zoomed far in on a big sheet, a full-density canvas would be too
      // large for a phone to draw; trade a little sharpness instead.
      dpr = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (width * cssHeight)));
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      const el = canvas.current;
      el.width = Math.floor(viewport.width);
      el.height = Math.floor(viewport.height);
      task = page.render({ canvas: el, viewport });
      await task.promise;
      if (!cancelled) {
        setDrawn(true);
        onDrawn?.();
      }
    })().catch((err) => {
      // A newer draw (the width changed) cancels the one in progress.
      if (err?.name !== 'RenderingCancelledException') console.error(err);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, width, near]);

  return (
    <div
      className={`pdf-page${drawn ? ' is-drawn' : ''}`}
      ref={holder}
      style={{ width, aspectRatio: `1 / ${ratio}` }}
    >
      <canvas ref={canvas} aria-label={`Page ${number} of ${total}`} role="img" />
    </div>
  );
}
