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
import { useBodyClass, useTheme } from '../lib/hooks.jsx';
import { Icon } from '../components/Icons.jsx';
import { Logo } from '../components/Logo.jsx';
import BrandLoader from '../components/BrandLoader.jsx';
import Scanner from './Scanner.jsx';
import ResultCard from './ResultCard.jsx';
import DetailsForm from './DetailsForm.jsx';

export default function PortalPage() {
  const { code: deepLinkCode } = useParams();
  const navigate = useNavigate();
  const { toggle: toggleTheme } = useTheme();

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
  const shortcode = portal?.smsShortcode || '32123';
  const checker = portal?.checker ?? null;
  const needDetails = Boolean(portal && portal.detailsRequired && !checker);

  // A check waiting for the form: a QR deep link opened before the person
  // gave their details, or a check the server refused for want of them.
  const [pending, setPending] = useState(null);

  const resultRef = useRef(null);
  const inputRef = useRef(null);

  /** Run a verification and render the outcome. */
  const runVerify = useCallback(async (raw, signature = null) => {
    if (!raw?.trim()) {
      setFieldError('Please enter the code printed on the pack.');
      inputRef.current?.focus();
      return;
    }

    setBusy(true);
    setNotice(null);
    setFieldError(null);

    try {
      const payload = await api('/api/verify', {
        method: 'POST',
        body: { code: raw.trim(), signature },
      });
      setResult(payload);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'details_required') {
        // The server asks first. Keep the check; it runs once the form is done.
        setPending({ code: raw.trim(), signature });
        setPortal((p) => ({ ...(p ?? {}), detailsRequired: true, checker: null }));
      } else if (err instanceof ApiError && err.status === 429) {
        setNotice({
          kind: 'warn',
          text: 'Too many checks from this device in a short time. Please wait a minute and try again.',
        });
      } else if (err instanceof ApiError && err.status === 0) {
        setNotice({
          kind: 'warn',
          text: 'You appear to be offline. You can still check this pack by texting the code - see "No internet?" below.',
        });
      } else {
        setNotice({
          kind: 'error',
          text: err.message || 'Could not check that code. Please try again.',
        });
      }
    } finally {
      setBusy(false);
    }
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

  // Bring the answer into view once it renders.
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [result]);

  /** A QR decoded: stop the camera and verify what it carried. */
  const handleScanned = useCallback(
    (text) => {
      setScanning(false);

      let scanned = text;
      let signature = null;
      try {
        const url = new URL(text);
        signature = url.searchParams.get('s');
        scanned = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? text);
      } catch {
        /* not a URL - treat the payload as the bare code */
      }

      setCode(scanned);
      runVerify(scanned, signature);
    },
    [runVerify]
  );

  const reset = () => {
    setResult(null);
    setCode('');
    setNotice(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    inputRef.current?.focus();
  };

  return (
    <>
      <header className="portal-header">
        <div className="wrap">
          <Link className="brand" to="/" aria-label="Orbit - check your medicine">
            <Logo size="sm" />
          </Link>
          {/* No staff link here by design. Patients and pharmacists never
              need an account, so a sign-in door on the page they use adds
              nothing for them and advertises the admin surface to everyone
              who scans a pack. Staff reach /login directly. */}
          <div className="row">
            <button
              className="icon-btn"
              type="button"
              onClick={toggleTheme}
              aria-label="Switch between light and dark theme"
            >
              <Icon name="sun" className="icon-sun" />
              <Icon name="moon" className="icon-moon" />
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="portal-main">
        <div className="wrap portal-wrap">
          <section className="hero">
            <h1>Is your medicine genuine?</h1>
            <p>
              Scan the QR code on the pack, or type the code from under the scratch panel. It takes
              a few seconds. We ask who you are once, so we can reach you if a pack turns out to be
              unsafe.
            </p>
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

          {/* Staff-set notice, e.g. a recall. Plain text only - rendered as a
              text node, never as markup. */}
          {portal?.banner && (
            <div className="alert alert-info mb-16" role="status">
              <Icon name="alert" />
              <span>{portal.banner}</span>
            </div>
          )}

          {notice && (
            <div className={`alert alert-${notice.kind} mb-16`} role="status">
              <Icon name={notice.kind === 'error' ? 'alert' : 'help'} />
              <span>{notice.text}</span>
            </div>
          )}

          <div className="portal-layout">
            <div className="portal-primary">
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
                          placeholder="AMX25-260921-00483-K7"
                          autoComplete="off"
                          autoCapitalize="characters"
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
                {result && (
                  <ResultCard
                    result={result}
                    onCheckAnother={reset}
                    supportPhone={portal?.supportPhone}
                    checker={checker}
                  />
                )}
              </section>
            </div>

            <aside className="portal-aside" aria-label="Help">
              <article className="card help-card">
                <h3>
                  <Icon name="message" /> No internet?
                </h3>
                <p>
                  Text the code to <span className="mono">{shortcode}</span> and you will get the same
                  answer by SMS. Standard message rates apply.
                </p>
              </article>
              <article className="card help-card">
                <h3>
                  <Icon name="help" /> Where is the code?
                </h3>
                <p>
                  Look for the QR square on the carton. The typed code sits under the silver scratch
                  panel - scratch it off only when you open the pack.
                </p>
              </article>
              <article className="card help-card">
                <h3>
                  <Icon name="flag" /> Something looks wrong?
                </h3>
                <p>
                  Report it even if the check passed. Blurry printing, a broken seal or an odd smell
                  are all worth telling us about.
                </p>
              </article>
            </aside>
          </div>
        </div>
      </main>

      <footer className="portal-footer">
        <div className="wrap portal-wrap">
          <p>
            <strong>Orbit</strong> verifies that the pack in your hand matches a real,
            serialized unit made by the manufacturer.
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
