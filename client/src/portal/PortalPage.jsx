/**
 * Public verification portal.
 *
 * Flow: say who you are (once per browser) -> scan a QR (camera + jsQR) or
 * type the code -> POST /api/verify -> render a result the patient can act
 * on, without jargon.
 *
 * The details step is the server's rule, not the page's: /api/verify refuses
 * with `details_required` until the browser has given them, and this page
 * answers that refusal by showing the form and keeping the check waiting.
 * Staff can switch the step off from Settings.
 *
 * Accessibility: the result region is aria-live, so a screen reader announces
 * the verdict, and every verdict is icon + word + colour, never colour alone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, ApiError } from '../lib/api.js';
import { formatCodeInput } from '../lib/format.js';
import { readScannedQr, leafletPath } from '../lib/scanned.js';
import { useBodyClass } from '../lib/hooks.jsx';
import { Icon } from '../components/Icons.jsx';
import BrandLoader from '../components/BrandLoader.jsx';
import Scanner from './Scanner.jsx';
import ResultCard from './ResultCard.jsx';
import DetailsForm from './DetailsForm.jsx';
import CheckSheet from './CheckSheet.jsx';
import Steps from './Steps.jsx';

// The shortest time the scanner's "QR code read" check stays on screen.
const SCAN_CHECK_MS = 700;
// The shortest time the "Checking your pack..." sheet stays up: a fast answer
// still reads as a check that happened, not a flicker.
const MIN_CHECKING_MS = 900;

/** A buzz with the answer on phones that can: three for "do not use", one otherwise. */
function buzz(result) {
  if (!navigator.userActivation?.hasBeenActive) return; // browsers block it otherwise
  navigator.vibrate?.(result.result === 'flagged' ? [80, 60, 80, 60, 80] : 40);
}

export default function PortalPage() {
  const { code: deepLinkCode } = useParams();
  const navigate = useNavigate();

  useBodyClass('page-white');

  const [code, setCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [notice, setNotice] = useState(null);
  const [fieldError, setFieldError] = useState(null);

  // What staff can change from Settings - a notice, the support number, the
  // SMS shortcode, whether details are asked for - plus who this browser has
  // already said it is. Nothing is offered until it arrives, so the page never
  // shows the check card and then takes it away. If the request fails the
  // check card is shown anyway: the server still enforces the step, and its
  // refusal is what brings the form up (see runVerify).
  const [portal, setPortal] = useState(null);
  useEffect(() => {
    let active = true;
    api('/api/portal')
      .then((p) => active && setPortal(p))
      .catch(() => active && setPortal({ detailsRequired: false, checker: null }));
    return () => {
      active = false;
    };
  }, []);
  const checker = portal?.checker ?? null;
  const needDetails = Boolean(portal && portal.detailsRequired && !checker);

  // A check waiting for the form: a QR deep link opened before the person
  // gave their details, or a check the server refused for want of them.
  const [pending, setPending] = useState(null);

  const resultRef = useRef(null);
  const inputRef = useRef(null);

  // The check sheet (see CheckSheet): null, checking, an answer, or an error.
  const [sheet, setSheet] = useState(null);

  /**
   * Run a verification and show the outcome in the sheet; the full result
   * card renders on the page behind it.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.fromScan] the scanner is on screen showing its own
   *   "QR code read, checking" state, so the sheet skips "checking" and comes
   *   up with the answer - after `beforeAnswer` has closed the scanner.
   * @param {() => void} [opts.beforeAnswer]
   */
  const runVerify = useCallback(async (raw, signature = null, opts = {}) => {
    if (!raw?.trim()) {
      setFieldError('Please enter the code printed on the pack.');
      inputRef.current?.focus();
      return;
    }

    const started = Date.now();
    const retry = { code: raw.trim(), signature };
    setBusy(true);
    setNotice(null);
    setFieldError(null);
    // The keyboard goes down: the sheet is what to look at now.
    inputRef.current?.blur();
    if (!opts.fromScan) setSheet({ phase: 'checking' });

    let next = null;
    let payload = null;
    try {
      payload = await api('/api/verify', { method: 'POST', body: { code: raw.trim(), signature } });
      next = { phase: 'result', result: payload };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'details_required') {
        // The server asks first. Keep the check; it runs once the form is done.
        setPending({ code: raw.trim(), signature });
        setPortal((p) => ({ ...(p ?? {}), detailsRequired: true, checker: null }));
      } else if (err instanceof ApiError && err.status === 429) {
        next = {
          phase: 'error',
          title: 'Please wait a minute',
          text: 'There were many checks from this phone in a short time. Wait a minute, then try again.',
        };
      } else if (err instanceof ApiError && err.status === 0) {
        next = {
          phase: 'error',
          title: 'No connection',
          text: 'Your phone could not reach us. Check your mobile data or Wi-Fi, then try again.',
          retry,
        };
      } else if (err instanceof ApiError && err.status >= 500) {
        // Our fault, never the pack's: say so plainly - a bare "502" reads
        // like a verdict to someone holding a medicine they are unsure of.
        next = {
          phase: 'error',
          title: 'We could not check your pack just now',
          text:
            'Our checking service is not answering. This is a problem on our side, not with ' +
            'your pack. Please try again in a minute.',
          retry,
        };
      } else {
        next = {
          phase: 'error',
          title: 'We could not check that code',
          text: err.message || 'Please try again.',
          retry,
        };
      }
    }

    // Pace it: "checking" stays long enough to be read rather than flash,
    // and after a scan the scanner's check gets its moment first.
    const shownFor = opts.fromScan ? SCAN_CHECK_MS : MIN_CHECKING_MS;
    await new Promise((r) => setTimeout(r, Math.max(0, started + shownFor - Date.now())));
    opts.beforeAnswer?.();
    setBusy(false);
    if (payload) setResult(payload);
    setSheet(next);
    if (next?.phase === 'result') buzz(next.result);
  }, []);

  // Deep link: /v/CODE?s=SIGNATURE - what a printed QR actually points at.
  useEffect(() => {
    if (!deepLinkCode) return;
    const decoded = decodeURIComponent(deepLinkCode);
    const signature = new URLSearchParams(window.location.search).get('s');
    setCode(decoded);
    setPending({ code: decoded, signature });
    // Tidy the address bar so a shared link does not leak the code.
    navigate('/', { replace: true });
  }, [deepLinkCode, navigate]);

  // Run a waiting check as soon as the page knows it may: the portal has
  // loaded, and either no details are asked for or they have been given.
  useEffect(() => {
    if (!pending || !portal || needDetails) return;
    const next = pending;
    setPending(null);
    runVerify(next.code, next.signature);
  }, [pending, portal, needDetails, runVerify]);

  /** "Not you?": forget this browser's details and ask again. */
  const forget = async () => {
    try {
      await api('/api/portal/details', { method: 'DELETE' });
    } catch {
      /* the cookie may already be gone; the form is the right answer either way */
    }
    setResult(null);
    setPortal((p) => ({ ...p, detailsRequired: true, checker: null }));
  };

  /**
   * A QR decoded: verify what it carried. The scanner stays up meanwhile,
   * showing its "QR code read" check, and closes as the answer comes up -
   * but not before the check has been on screen long enough to be seen.
   */
  const handleScanned = useCallback(
    async (text) => {
      const scanned = readScannedQr(text);

      // The carton's leaflet QR, not the pack's own: say so, and offer the
      // leaflet, rather than check it as a code and call it malformed.
      if (scanned.kind === 'leaflet') {
        await new Promise((r) => setTimeout(r, SCAN_CHECK_MS));
        setScanning(false);
        setResult(null);
        setNotice({
          kind: 'info',
          text:
            "That is the medicine's leaflet QR code. It opens the information about the medicine, " +
            "but it cannot tell you whether your pack is genuine. To check the pack, scan its own " +
            'QR code - the one printed with its unique code.',
          link: { to: leafletPath(scanned), label: 'Read the leaflet instead' },
        });
        return;
      }

      setCode(scanned.code);
      await runVerify(scanned.code, scanned.signature, {
        fromScan: true,
        beforeAnswer: () => setScanning(false),
      });
    },
    [runVerify]
  );

  const reset = () => {
    setSheet(null);
    setResult(null);
    setCode('');
    setNotice(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    inputRef.current?.focus();
  };

  /** The sheet's main button on an answer: close it and land on the details. */
  const sheetDone = () => {
    const wasInvalid = sheet?.result?.result === 'invalid';
    setSheet(null);
    if (wasInvalid) {
      // "Type the code again": back at the field, its text selected to retype.
      inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    // After the sheet's scroll lock lets go.
    requestAnimationFrame(() =>
      resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    );
  };

  return (
    <>
      {/* No header bar on this page: the photo behind it carries the brand,
          and the theme follows the phone's setting. There is no staff link
          by design - patients and pharmacists never need an account, and a
          sign-in door here would only advertise the admin surface to everyone
          who scans a pack. Staff reach /login directly. */}
      <main id="main" className="portal-main">
        <div className="wrap portal-wrap">
          {/* The company logo in white, above the heading - it sits on the
              darkened side of the photo with the white hero text. The page
              has no header bar, and the wordmark carries the name. */}
          <div className="portal-brand">
            <img
              className="portal-logo"
              src="/img/getmedslogowhite.png"
              alt="Getmeds"
              width="720"
              height="397"
            />
          </div>

          <section className="hero">
            <h1>Is your medicine genuine?</h1>
            {/* One sentence: the task, not an explanation of it. Why we ask
                for details is said where they are asked for. */}
            <p>Scan the QR code on the pack, or type the code from under the scratch panel.</p>
            <div className="trust-row">
              <span>
                <Icon name="check" /> No app needed
              </span>
              <span>
                <Icon name="check" /> No password
              </span>
              <span>
                <Icon name="check" /> Free
              </span>
            </div>
          </section>

          <div className="portal-layout">
            <div className="portal-primary">
              {portal?.detailsRequired && <Steps current={needDetails ? 0 : result ? 2 : 1} />}

              {!portal && (
                <section className="card check-card" aria-busy="true">
                  <BrandLoader message="One moment..." />
                </section>
              )}

              {needDetails && (
                <DetailsForm
                  pendingCode={pending?.code}
                  supportPhone={portal.supportPhone}
                  onDone={(c) => setPortal((p) => ({ ...p, checker: c }))}
                />
              )}

              {portal && !needDetails && checker && portal.detailsRequired && (
                <p className="checker-line">
                  Checking as <strong>{checker.name}</strong>
                  <button type="button" onClick={forget}>
                    Not you?
                  </button>
                </p>
              )}

              {/* The check card itself. Kept at its own indentation: it is
                  the whole point of the page, and the branches above are
                  the exceptions to it. */}
              {portal && !needDetails && (
              <section className="card check-card" aria-labelledby="check-title">
                <h2 id="check-title" className="sr-only">
                  Check a pack
                </h2>

                {/* Staff-set notice, e.g. a recall. Inside the card, set like
                    the card's own content: a coloured box at the top of a page
                    is the first thing people learn to skip (banner blindness).
                    Plain text only - a text node, never markup. */}
                {portal.banner && (
                  <div className="check-banner" role="note">
                    <Icon name="alert" />
                    <p>
                      <strong>Notice from Getmeds</strong>
                      {portal.banner}
                    </p>
                  </div>
                )}

                {/* About the last try - the camera would not open, or that
                    was the leaflet's QR - inside the card, right above the
                    buttons just pressed. (A check's own answer, or its
                    failure, is the sheet.) */}
                {notice && !scanning && (
                  <div className={`alert alert-${notice.kind} check-notice`} role="status">
                    <Icon name={notice.kind === 'info' ? 'help' : 'alert'} />
                    <div className="check-notice-body">
                      {notice.title && <strong>{notice.title}</strong>}
                      <span>
                        {notice.text}
                        {notice.link && (
                          <>
                            {' '}
                            <Link to={notice.link.to}>{notice.link.label}</Link>.
                          </>
                        )}
                      </span>
                    </div>
                  </div>
                )}

                {scanning ? (
                  <Scanner
                    onScan={handleScanned}
                    onCancel={() => setScanning(false)}
                    onError={(text) => {
                      setScanning(false);
                      setNotice({ kind: 'warn', text });
                    }}
                  />
                ) : (
                  <div className="scan-actions">
                    <button
                      className="btn btn-primary btn-lg btn-block"
                      type="button"
                      onClick={() => {
                        setNotice(null);
                        setResult(null);
                        setScanning(true);
                      }}
                    >
                      <Icon name="camera" />
                      Scan the QR code
                    </button>

                    <p className="divider">or type it</p>

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        runVerify(code);
                      }}
                      noValidate
                    >
                      <div className="field">
                        <label className="label sr-only" htmlFor="codeInput">
                          Product code
                        </label>
                        <input
                          className="input input-code"
                          id="codeInput"
                          ref={inputRef}
                          value={code}
                          onChange={(e) => {
                            setCode(formatCodeInput(e.target.value));
                            setFieldError(null);
                          }}
                          placeholder="AMX25-7KQ2M9-K7"
                          autoComplete="off"
                          autoCapitalize="characters"
                          enterKeyHint="go"
                          spellCheck="false"
                          maxLength={40}
                          aria-describedby="codeHint"
                          aria-invalid={fieldError ? 'true' : undefined}
                        />
                        <p className="hint" id="codeHint">
                          The code is printed on the pack and under the scratch panel.
                        </p>
                        {fieldError && (
                          <p className="field-error" role="alert">
                            {fieldError}
                          </p>
                        )}
                      </div>
                      <button
                        className="btn btn-primary btn-lg btn-block mt-12"
                        type="submit"
                        disabled={busy}
                      >
                        {busy ? (
                          <>
                            <span className="spinner" aria-hidden="true" /> Checking...
                          </>
                        ) : (
                          <>
                            <Icon name="shield" />
                            Check this pack
                          </>
                        )}
                      </button>
                    </form>
                  </div>
                )}
              </section>
              )}

              {/* The answer belongs with the form that produced it, so it
                  stays in the left column rather than below both. */}
              <section className="result" ref={resultRef} aria-live="polite" aria-atomic="true">
                {/* Keyed on the check, so a new result starts with a fresh
                    card - no half-written report or answer from the last one. */}
                {result && (
                  <ResultCard
                    key={result.scanId ?? `${result.code}-${result.reason}`}
                    result={result}
                    onCheckAnother={reset}
                    supportPhone={portal?.supportPhone}
                    checker={checker}
                    portal={portal}
                    onPlaceSaved={({ place, outlet }) => {
                      // The next check offers this back, as the server would on reload.
                      if (!place) return;
                      setPortal((p) =>
                        p?.checker
                          ? {
                              ...p,
                              checker: {
                                ...p.checker,
                                lastPurchase: { code: place.code, label: place.label, outlet: outlet || null },
                              },
                            }
                          : p
                      );
                    }}
                  />
                )}
              </section>
            </div>

          </div>
        </div>
      </main>

      <CheckSheet
        sheet={sheet}
        onDone={sheetDone}
        onClose={() => (sheet?.phase === 'result' ? sheetDone() : setSheet(null))}
        onRetry={() => runVerify(sheet.retry.code, sheet.retry.signature)}
        onCheckAnother={reset}
      />

      <footer className="portal-footer">
        <div className="wrap portal-wrap">
          <p>
            <strong>Getmeds</strong> verifies that the pack in your hand matches a real, serialized
            unit made by the manufacturer.
          </p>
          <p className="mt-8">
            A genuine result is not medical advice. Always follow the leaflet and your pharmacist's
            instructions. If you feel unwell, seek medical help.
          </p>
        </div>
      </footer>
    </>
  );
}
