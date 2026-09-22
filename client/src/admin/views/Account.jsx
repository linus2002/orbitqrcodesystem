/**
 * Account panel contents: your own profile, password change and open sessions.
 *
 * Renders only the BODY of the drawer. The drawer chrome (backdrop, header,
 * close button, Escape handling, focus restore) comes from the shared
 * DrawerProvider.
 *
 * It previously rendered its own copy of that chrome, which put a
 * viewport-covering overlay inside the sidebar. `position: sticky` on the
 * sidebar creates a stacking context, so the panel's z-index only applied
 * within it - and the page's sticky table headers, which sit at a higher
 * level in the root stacking context, painted straight through the panel.
 * Going through the provider renders it outside the sidebar, where it belongs.
 */
import { useEffect, useState } from 'react';

import { api } from '../../lib/api.js';
import { useSession, useToast } from '../../lib/hooks.jsx';
import { fmtDate } from '../../lib/format.js';
import { KV, Timeline, TimelineItem } from '../components/ui.jsx';

export default function Account() {
  const { user } = useSession();
  const toast = useToast();

  const [sessions, setSessions] = useState([]);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api('/api/auth/sessions')
      .then((r) => active && setSessions(r.items.filter((s) => !s.revoked_at)))
      .catch(() => {
        /* non-fatal: show the panel without the session list */
      });
    return () => {
      active = false;
    };
  }, []);

  async function changePassword(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: form });
      toast('Password changed. Other devices have been signed out.', 'success');
      setForm({ currentPassword: '', newPassword: '' });
    } catch (err) {
      setError(err.formMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <KV
        rows={[
          ['Role', <span className="badge badge-neutral">{user.role}</span>],
          ['Permissions', `${user.permissions.length} granted`],
          [
            'Last signed in',
            user.lastLoginAt ? fmtDate(user.lastLoginAt, { withTime: true }) : 'this session',
          ],
        ]}
      />

      <div>
        <h3 className="mb-8">Change password</h3>
        <form className="stack" onSubmit={changePassword} noValidate>
          <div className="field">
            <label className="label" htmlFor="curPw">
              Current password
            </label>
            <input
              className="input"
              id="curPw"
              type="password"
              autoComplete="current-password"
              value={form.currentPassword}
              onChange={(e) => setForm((f) => ({ ...f, currentPassword: e.target.value }))}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="newPw">
              New password
            </label>
            <input
              className="input"
              id="newPw"
              type="password"
              autoComplete="new-password"
              value={form.newPassword}
              onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))}
            />
            <p className="hint">At least 12 characters, with upper case, lower case and a digit.</p>
          </div>

          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}

          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Changing...' : 'Change password'}
          </button>
          <p className="hint">Changing it signs you out on every other device.</p>
        </form>
      </div>

      <div>
        <h3 className="mb-8">Open sessions</h3>
        {sessions.length ? (
          <Timeline>
            {sessions.map((s) => (
              <TimelineItem
                key={s.id}
                tone={s.current ? 'genuine' : 'invalid'}
                title={s.current ? 'This device' : 'Another device'}
                meta={`${fmtDate(s.created_at, { withTime: true })} · expires ${fmtDate(
                  s.expires_at,
                  { withTime: true }
                )}`}
              />
            ))}
          </Timeline>
        ) : (
          <p className="text-muted text-sm">No other sessions.</p>
        )}
      </div>
    </>
  );
}
