/**
 * Staff sign-in.
 *
 * Not linked from the public portal. Patients and pharmacists never need an
 * account, so surfacing a staff door on the page they use adds nothing for
 * them and advertises the admin surface to everyone who scans a pack.
 *
 * Email and password go to the server together, in one request. Nothing
 * here asks the server whether an address exists on its own: that would turn
 * the page into a user-enumeration oracle, undoing the identical-error-message
 * work in services/auth.js.
 *
 * On success the server sets an httpOnly session cookie plus a readable CSRF
 * cookie. This component never sees or stores the session token.
 */
import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { api, ApiError } from '../lib/api.js';
import { useBodyClass, useSession, useTheme, useToast } from '../lib/hooks.jsx';
import { Icon } from '../components/Icons.jsx';
import PasswordField from '../components/PasswordField.jsx';
import SignInShowcase from './SignInShowcase.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useSession();

  useBodyClass('signin-page');

  const { theme, toggle: toggleTheme } = useTheme();
  // No stored choice means the page follows the OS, so ask it.
  const isDark =
    (theme ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) ===
    'dark';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // Problems show as a toast in the top-right corner, not inside the card.
  const fail = (message) => toast(message, 'error', { title: 'Sign-in failed' });

  const passwordRef = useRef(null);

  const emailRef = useRef(null);

  async function submit(e) {
    e.preventDefault();

    if (!EMAIL_RE.test(email.trim())) {
      fail('Enter a valid email address.');
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      fail('Enter your password.');
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
      fail(
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
    <main className="signin-backdrop">
      {/* Soft brand-coloured lights behind the card. */}
      <span className="signin-glow blue" aria-hidden="true" />
      <span className="signin-glow green" aria-hidden="true" />
      <span className="signin-glow brand" aria-hidden="true" />

      <div className="signin-card">
        <SignInShowcase />

        <section className="signin-form-pane">
          <button
            type="button"
            className="signin-theme"
            onClick={toggleTheme}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDark ? 'Light mode' : 'Dark mode'}
          >
            <Icon name={isDark ? 'sun' : 'moon'} />
          </button>

          <div className="signin-brand">
            <img src="/img/logo-mark-192.png" alt="" width="192" height="192" />
            <span>Getmeds</span>
          </div>

          <p className="signin-welcome">Welcome back</p>
          <h1 className="signin-title">Sign in now</h1>

          <form className="signin-form" onSubmit={submit} noValidate>
            <label className="signin-label" htmlFor="email">
              Work email
            </label>
            <input
              className="signin-input"
              id="email"
              ref={emailRef}
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              autoFocus
            />

            <label className="signin-label" htmlFor="password">
              Password
            </label>
            <PasswordField
              className="signin-input"
              id="password"
              ref={passwordRef}
              autoComplete="current-password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />

            <p className="signin-note">
              Forgot the password? <strong>Ask your administrator.</strong>
            </p>

            <div className="signin-actions">
              <button className="signin-btn" type="submit" disabled={busy}>
                {busy ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Signing in...
                  </>
                ) : (
                  'Sign in'
                )}
              </button>
              <a className="signin-back" href="/">
                Back to portal
              </a>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
