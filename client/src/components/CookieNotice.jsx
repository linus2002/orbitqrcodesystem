/**
 * The cookie notice: what this site stores, in one line, with the details a
 * tap away.
 *
 * Every cookie here is essential - remembering a patient's details so they
 * are asked once, and keeping staff sign-in secure - with no advertising or
 * tracking. So this tells rather than asks: one button, "OK", and no "Reject"
 * that would turn off nothing. The full list (name, purpose, how long) is in
 * the privacy notice, which "Cookie details" opens at that part.
 *
 * Shown on the public pages and sign-in, not inside the dashboard. "OK" is
 * remembered on this device in localStorage - not in yet another cookie - and
 * the notice comes back only if NOTICE_VERSION changes, i.e. if the cookies
 * themselves change.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { Icon } from './Icons.jsx';

const PrivacyPolicy = lazy(() => import('../portal/PrivacyPolicy.jsx'));

const KEY = 'qrs.cookies';
// Bump when the cookies listed in the privacy notice change.
const NOTICE_VERSION = '2026-11-20';

function seen() {
  try {
    return localStorage.getItem(KEY) === NOTICE_VERSION;
  } catch {
    return false; // private mode: shown each visit, which is harmless
  }
}

export default function CookieNotice() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(() => !seen());
  const [details, setDetails] = useState(false);
  const show = open && !pathname.startsWith('/admin');

  // Room under the page for the bar, so it never covers the last button.
  useEffect(() => {
    if (!show) return undefined;
    document.body.classList.add('has-cookie-notice');
    return () => document.body.classList.remove('has-cookie-notice');
  }, [show]);

  const ok = () => {
    try {
      localStorage.setItem(KEY, NOTICE_VERSION);
    } catch {
      /* not remembered; shown again next visit */
    }
    setOpen(false);
  };

  return (
    <>
      {show && (
        <div className="cookie-notice" role="region" aria-label="Cookies">
          <Icon name="cookie" className="cookie-notice-icon" />
          <p>
            We use only essential cookies: to remember your details so we ask once, and to keep
            staff sign-in secure. No ads, no tracking.{' '}
            <button type="button" className="cookie-notice-link" onClick={() => setDetails(true)}>
              Cookie details
            </button>
          </p>
          <button type="button" className="btn btn-primary btn-sm cookie-notice-ok" onClick={ok}>
            OK
          </button>
        </div>
      )}
      {details && (
        <Suspense fallback={null}>
          <PrivacyPolicy open section="cookies" standalone onClose={() => setDetails(false)} />
        </Suspense>
      )}
    </>
  );
}
