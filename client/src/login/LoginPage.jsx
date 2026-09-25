/**
 * Staff sign-in.
 *
 * Not linked from the public portal. Patients and pharmacists never need an
 * account, so surfacing a staff door on the page they use adds nothing for
 * them and advertises the admin surface to everyone who scans a pack.
 *
 * Two-step flow (email, then password). IMPORTANT: the first step does NOT
 * ask the server whether the address exists - it just advances. A step that
 * validated the email would turn this page into a user-enumeration oracle,
 * undoing the identical-error-message work in services/auth.js.
 *
 * On success the server sets an httpOnly session cookie plus a readable CSRF
 * cookie. This component never sees or stores the session token.
 */
import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { api, ApiError } from '../lib/api.js';
import { useBodyClass, useSession } from '../lib/hooks.jsx';
import { Icon } from '../components/Icons.jsx';
import PasswordField from '../components/PasswordField.jsx';
import { Logo } from '../components/Logo.jsx';
import SignInShowcase from './SignInShowcase.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useSession();

  useBodyClass('signin-page');

  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const passwordRef = useRef(null);

  function goToPassword(e) {
    e.preventDefault();
    setError(null);

    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }

    // Purely a client-side step. Nothing is sent, so nothing can be learned
    // about which addresses have accounts.
    setStep('password');
    requestAnimationFrame(() => passwordRef.current?.focus());
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);

    if (!password) {
      setError('Enter your password.');
      return;
    }

    setBusy(true);
    try {
      await api('/api/auth/login', { method: 'POST', body: { email: email.trim(), password } });
      await refresh();

      // Honour a ?next= redirect, but only to a same-site path, so this cannot
      // be used as an open redirect.
      const next = new URLSearchParams(location.search).get('next');
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/admin', {
        replace: true,
      });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 0
          ? 'Cannot reach the server. Check your connection and try again.'
          : err.message
      );
      setPassword('');
      setBusy(false);
      passwordRef.current?.focus();
    }
  }

  return (
    <main className="signin-shell">
      <section className="signin-form-pane">
        <div className="signin-brand">
          <Logo size="lg" />
        </div>

        <div className="signin-body">
          <h1 className="signin-title">Access your Getmeds account</h1>
          <p className="signin-sub">
            Sign in to manage serialization, investigate flagged packs and work the alert queue.
          </p>

          {error && (
            <div className="alert alert-error signin-alert" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </div>
          )}

          {step === 'email' ? (
            <form onSubmit={goToPassword} noValidate>
              <label className="signin-label" htmlFor="email">
                Enter your work email
              </label>
              <input
                className="signin-input"
                id="email"
                type="email"
                inputMode="email"
                autoComplete="username"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                autoFocus
              />
              <button className="signin-btn" type="submit">
                Next
                <Icon name="arrow-right" />
              </button>
            </form>
          ) : (
            <form onSubmit={submit} noValidate>
              {/* The chosen address stays visible and changeable, so nobody
                  has to restart the flow to fix a typo. */}
              <button type="button" className="signin-identity" onClick={() => setStep('email')}>
                <span>{email}</span>
                <span className="signin-change">Change</span>
              </button>

              <label className="signin-label" htmlFor="password">
                Enter your password
              </label>
              <PasswordField
                className="signin-input"
                id="password"
                ref={passwordRef}
                autoComplete="current-password"
                placeholder="Password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
              />
              <button className="signin-btn" type="submit" disabled={busy}>
                {busy ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Signing in...
                  </>
                ) : (
                  <>
                    Sign in
                    <Icon name="arrow-right" />
                  </>
                )}
              </button>
            </form>
          )}

          <p className="signin-note">
            Staff accounts are created by your administrator. Patients and pharmacists do not need
            one.
          </p>
        </div>

        <p className="signin-legal">
          Scan records are pseudonymised and retained for counterfeit investigation only. Every
          action taken in the dashboard is written to the audit log.
        </p>
      </section>

      <SignInShowcase />
    </main>
  );
}
