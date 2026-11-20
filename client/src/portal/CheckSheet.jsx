/**
 * The check, as a sheet that slides up over the page: "Checking your pack..."
 * while the server answers, then the answer itself - a badge, one line, one
 * button.
 *
 * Most people check a pack on a phone, usually by pointing the phone's camera
 * at the QR, which opens this page with the check already running. Before
 * this, the answer was a card rendered below the form, scrolled to - easy to
 * miss, and it arrived with no sign that anything was happening first. Now:
 *
 *   - the sheet comes up from the bottom, where the thumb is, and its button
 *     is in thumb reach (on a wide screen it is a centred dialog instead);
 *   - while checking it shows something moving, at once (Doherty threshold),
 *     and for long enough to be read - never a flash;
 *   - the answer is the badge, a word and a sentence. The full details (the
 *     pack, the leaflet, reporting) stay in the result card on the page; the
 *     sheet's button closes it and lands there.
 *
 * Colour still never stands alone: every verdict has its own shape inside the
 * badge (tick, !, ?, i) and its own heading.
 */
import { useEffect, useRef } from 'react';

const VERDICT = {
  genuine: {
    tone: 'genuine',
    mark: 'tick',
    title: 'Genuine',
    action: 'See the details',
  },
  flagged: {
    tone: 'flagged',
    mark: 'bang',
    title: 'Do not use this pack',
    action: 'See what to do',
  },
  invalid: {
    tone: 'invalid',
    mark: 'query',
    title: 'Check the code',
    action: 'Type the code again',
  },
  // Checked twice already: their earlier answer, not a new finding. Calm.
  limit: {
    tone: 'info',
    mark: 'info',
    title: 'Already checked twice',
    action: 'See the details',
  },
};

/** Which presentation a verify answer gets. */
export function verdictOf(result) {
  if (result.reason === 'check_limit') return VERDICT.limit;
  return VERDICT[result.result] ?? VERDICT.invalid;
}

/**
 * @param {object} props
 * @param {null | {phase: 'checking'} | {phase: 'result', result: object}
 *   | {phase: 'error', title: string, text: string, retry?: object}} props.sheet
 * @param {() => void} props.onDone       the main button on an answer
 * @param {() => void} props.onClose      dismissed (backdrop, Esc, Close)
 * @param {() => void} props.onRetry      "Try again" on an error
 * @param {() => void} props.onCheckAnother
 */
export default function CheckSheet({ sheet, onDone, onClose, onRetry, onCheckAnother }) {
  const primary = useRef(null);
  const phase = sheet?.phase;
  const settled = phase === 'result' || phase === 'error';
  const open = Boolean(sheet);

  // The page behind does not scroll while the sheet is up.
  useEffect(() => {
    if (!open) return undefined;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  // An answer takes the focus, so a screen reader reads it and Enter acts on it.
  useEffect(() => {
    if (settled) primary.current?.focus();
  }, [settled, sheet]);

  // Esc closes an answer; a check in progress cannot be dismissed.
  useEffect(() => {
    if (!settled) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settled, onClose]);

  // Pull down to dismiss. The sheet covers only part of the screen, with the
  // page showing above it and a grip on top: a card cut off like that reads
  // as one that moves (closure), so it does - it follows the finger down,
  // and let go far enough, it closes; not far enough, it springs back.
  const sheetRef = useRef(null);
  const drag = useRef(null);
  const onPointerDown = (e) => {
    if (!settled || e.button > 0) return;
    drag.current = { y: e.clientY, dy: 0, moving: false };
    const move = (ev) => {
      const d = drag.current;
      if (!d) return;
      d.dy = Math.max(0, ev.clientY - d.y);
      // A tap that wobbles a few pixels is still a tap on the button.
      if (!d.moving && d.dy < 8) return;
      d.moving = true;
      const el = sheetRef.current;
      el.style.transition = 'none';
      el.style.transform = `translateY(${d.dy}px)`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const d = drag.current;
      drag.current = null;
      const el = sheetRef.current;
      if (!d?.moving || !el) return;
      // A drag that started on a button is not a press of it.
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      if (d.dy > Math.min(120, el.offsetHeight * 0.3)) {
        onClose();
        return;
      }
      el.style.transition = 'transform 0.22s ease-out';
      el.style.transform = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  if (!sheet) return null;

  const result = phase === 'result' ? sheet.result : null;
  const verdict = result ? verdictOf(result) : null;
  const product = result?.product
    ? `${result.product.name}${result.product.strength ? ` ${result.product.strength}` : ''}`
    : null;

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (settled && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className={`sheet sheet-${phase}${verdict ? ` sheet-${verdict.tone}` : ''}`}
        onPointerDown={onPointerDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        aria-describedby="sheet-text"
      >
        <span className="sheet-grip" aria-hidden="true" />

        {phase === 'checking' && (
          <>
            <CheckingArt />
            <h2 id="sheet-title" className="sheet-title">
              Checking your pack...
            </h2>
            <p id="sheet-text" className="sheet-text">
              Making sure it was made and released by the manufacturer. This takes a few seconds.
            </p>
          </>
        )}

        {result && (
          <>
            <Badge tone={verdict.tone} mark={verdict.mark} />
            <h2 id="sheet-title" className="sheet-title">
              {verdict.title}
            </h2>
            {product && <p className="sheet-product">{product}</p>}
            <p id="sheet-text" className="sheet-text">
              {result.message}
            </p>
            <div className="sheet-actions">
              <button
                ref={primary}
                type="button"
                className={`btn btn-lg btn-block sheet-cta${verdict.tone === 'flagged' ? ' btn-danger' : ' btn-primary'}`}
                onClick={onDone}
              >
                {verdict.action}
              </button>
              {verdict.tone === 'genuine' && (
                <button type="button" className="btn btn-quiet btn-block" onClick={onCheckAnother}>
                  Check another pack
                </button>
              )}
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <Badge tone="warn" mark="bang" />
            <h2 id="sheet-title" className="sheet-title">
              {sheet.title}
            </h2>
            <p id="sheet-text" className="sheet-text">
              {sheet.text}
            </p>
            <div className="sheet-actions">
              {sheet.retry ? (
                <>
                  <button ref={primary} type="button" className="btn btn-lg btn-block btn-primary sheet-cta" onClick={onRetry}>
                    Try again
                  </button>
                  <button type="button" className="btn btn-quiet btn-block" onClick={onClose}>
                    Close
                  </button>
                </>
              ) : (
                <button ref={primary} type="button" className="btn btn-lg btn-block btn-primary sheet-cta" onClick={onClose}>
                  OK
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The verdict badge: a scalloped seal, like the stamp on a certificate, with
 * the verdict's own mark inside.
 */
function Badge({ tone, mark }) {
  return (
    <div className={`sheet-badge seal-${tone}`} aria-hidden="true">
      <svg viewBox="0 0 96 96">
        <path className="seal" d={SEAL} />
        {mark === 'tick' && <path className="mark" d="M31 49l12 12 23-25" />}
        {mark === 'bang' && (
          <>
            <path className="mark" d="M48 29v24" />
            <path className="mark dot" d="M48 66h.01" />
          </>
        )}
        {mark === 'query' && (
          <>
            <path className="mark" d="M38 38a10 10 0 1 1 14 9.2c-2.6 1.2-4 3.3-4 6V56" />
            <path className="mark dot" d="M48 67h.01" />
          </>
        )}
        {mark === 'info' && (
          <>
            <path className="mark dot" d="M48 30h.01" />
            <path className="mark" d="M48 44v24" />
          </>
        )}
      </svg>
    </div>
  );
}

/** A 12-lobed seal around (48, 48): the badge's outline, computed once. */
const SEAL = (() => {
  const lobes = 10;
  const valley = 38; // where two lobes meet
  const crest = 50; // the control point that bulges each lobe out
  const at = (r, a) => `${(48 + r * Math.cos(a)).toFixed(2)} ${(48 + r * Math.sin(a)).toFixed(2)}`;
  const step = (2 * Math.PI) / lobes;
  const start = -Math.PI / 2;
  // From valley to valley, one round bump each: a scalloped edge, not a star.
  let d = `M${at(valley, start)}`;
  for (let i = 1; i <= lobes; i++) {
    d += `Q${at(crest, start + step * (i - 0.5))} ${at(valley, start + step * i)}`;
  }
  return `${d}Z`;
})();

/** While checking: the pack's shield, with a scan line passing over it. */
function CheckingArt() {
  return (
    <div className="sheet-art" aria-hidden="true">
      <svg viewBox="0 0 96 96">
        <path className="shield" d="M48 10l30 12.8v22.4C78 63 65.6 77.4 48 82 30.4 77.4 18 63 18 45.2V22.8z" />
        <path className="shield-mark" d="M36 47l8.5 8.5L61 39" />
        <rect className="scanbar" x="12" y="0" width="72" height="4" rx="2" />
      </svg>
    </div>
  );
}
