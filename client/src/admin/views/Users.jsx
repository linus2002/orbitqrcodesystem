/**
 * User administration (admin role only).
 *
 * Two deliberate behaviours:
 *   - a generated temporary password is shown exactly once and never stored
 *     in readable form, so it must be handed over out of band;
 *   - the server refuses to demote or suspend the last active administrator,
 *     which stops the system locking everyone out of its own administration.
 */
import { useState } from 'react';

import { api } from '../../lib/api.js';
import { useApi, useSession, useToast } from '../../lib/hooks.jsx';
import { fmtDate, initials } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { useDrawer } from '../components/Drawer.jsx';
import { Icon } from '../../components/Icons.jsx';
import { TableCard, Table, KV, StatusBadge, ErrorNote, Toolbar, Spacer } from '../components/ui.jsx';
import ViewToggle, { useRememberedView } from '../components/ViewToggle.jsx';

const ROLE_NOTE = {
  admin: 'Full access, including user administration.',
  security:
    'The full investigation surface: alerts, scans, batches and reports. No user administration.',
  regulator: 'Aggregate compliance reporting only. Cannot see individual patient scans.',
};

export default function Users() {
  const drawer = useDrawer();
  const session = useSession();
  const { data, error, loading, reload } = useApi('/api/admin/users');
  const [view, setView] = useRememberedView('qrshield.users-view');

  useHeader('Users', 'Staff accounts. Patients and pharmacists never need one.');

  if (error) return <ErrorNote error={error} />;

  const items = data?.items ?? [];

  /** One place to open an account, so both layouts behave identically. */
  const openUser = (row) =>
    drawer.open({
      title: row.fullName,
      subtitle: row.email,
      avatar: row.avatar ? <img src={row.avatar} alt="" /> : initials(row.fullName),
      body: <UserDetail user={row} isSelf={row.id === session.user.id} />,
      footer:
        row.id === session.user.id ? null : (
          <UserActions user={row} drawer={drawer} reload={reload} />
        ),
    });

  return (
    <>
      <Toolbar>
        <span className="text-sm text-muted">
          {items.length} {items.length === 1 ? 'account' : 'accounts'}
        </span>
        <Spacer />
        <ViewToggle view={view} onChange={setView} label="How to show the accounts" />
        <button className="btn btn-primary btn-sm" onClick={() => openNew(drawer, reload)}>
          Add user
        </button>
      </Toolbar>

      {view === 'grid' ? (
        <div className="user-grid">
          {items.map((row) => (
            <UserCard
              key={row.id}
              user={row}
              isSelf={row.id === session.user.id}
              onOpen={() => openUser(row)}
            />
          ))}
        </div>
      ) : (
        <UsersTable
          items={items}
          loading={loading}
          session={session}
          onOpen={openUser}
        />
      )}
    </>
  );
}

/**
 * One account as a card.
 *
 * The permissions are the substance here: a role name tells you what somebody
 * is called, the permission list tells you what they can actually reach, and
 * that is the question an administrator is usually on this screen to answer.
 * Four are shown with a count for the rest, so cards stay the same height and
 * comparable side by side.
 */
function UserCard({ user, isSelf, onOpen }) {
  const shown = user.permissions.slice(0, 4);
  const extra = user.permissions.length - shown.length;

  return (
    <article className={`user-card${user.status === 'active' ? '' : ' user-card-suspended'}`}>
      <header className="user-card-head">
        <span className="user-card-avatar" aria-hidden="true">
          {user.avatar ? <img src={user.avatar} alt="" /> : initials(user.fullName)}
        </span>
        <div className="user-card-who">
          <h3>
            {user.fullName}
            {isSelf && <span className="badge badge-info">you</span>}
          </h3>
          <p>{user.email}</p>
        </div>
      </header>

      <div className="user-card-facts">
        <span className={`user-card-role role-${user.role}`}>{user.role}</span>
        <span className="user-card-status">
          <Icon name={user.status === 'active' ? 'check' : 'lock'} />
          {user.status === 'active' ? 'Active' : 'Suspended'}
        </span>
      </div>

      <dl className="user-card-stats">
        <div>
          <dt>Last signed in</dt>
          <dd>{user.lastLoginAt ? fmtDate(user.lastLoginAt, { withTime: true }) : 'never'}</dd>
        </div>
        <div>
          <dt>Account added</dt>
          <dd>{fmtDate(user.createdAt)}</dd>
        </div>
      </dl>

      <ul className="user-card-tags">
        {shown.map((permission) => (
          <li key={permission}>{permission}</li>
        ))}
        {extra > 0 && <li className="is-more">+{extra}</li>}
      </ul>

      <footer className="user-card-foot">
        <div className="user-card-access">
          <strong>{user.permissions.length} permissions</strong>
          {user.mustChangePassword && <span>Must change password</span>}
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={onOpen}>
          {isSelf ? 'View account' : 'Manage'}
        </button>
      </footer>
    </article>
  );
}

function UsersTable({ items, loading, session, onOpen }) {
  return (
    <TableCard>
      <Table
        loading={loading}
        rows={items}
        empty="No users."
        onRowClick={onOpen}
        columns={[
          {
            label: 'Name',
            render: (r) => (
              <>
                <strong>{r.fullName}</strong>
                {r.id === session.user.id && <span className="badge badge-info"> you</span>}
                <br />
                <span className="text-muted text-sm">{r.email}</span>
              </>
            ),
          },
          { label: 'Role', render: (r) => <span className="badge badge-neutral">{r.role}</span> },
          { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          {
            label: 'Last signed in',
            render: (r) =>
              r.lastLoginAt ? (
                fmtDate(r.lastLoginAt, { withTime: true })
              ) : (
                <span className="text-muted">never</span>
              ),
          },
          { label: 'Created', render: (r) => fmtDate(r.createdAt) },
        ]}
      />
    </TableCard>
  );
}

function UserDetail({ user, isSelf }) {
  return (
    <>
      <KV
        rows={[
          ['Role', <span className="badge badge-neutral">{user.role}</span>],
          ['Access', ROLE_NOTE[user.role] ?? ''],
          ['Status', <StatusBadge status={user.status} />],
          ['Must change password', user.mustChangePassword ? 'Yes' : 'No'],
          [
            'Last signed in',
            user.lastLoginAt ? fmtDate(user.lastLoginAt, { withTime: true }) : 'never',
          ],
          ['Created', fmtDate(user.createdAt)],
        ]}
      />

      {isSelf ? (
        <p className="text-sm text-muted">
          This is your own account. Change your role or status from another administrator account.
        </p>
      ) : (
        <>
          <div className="field">
            <label className="label" htmlFor="uRole">Role</label>
            <select className="select" id="uRole" defaultValue={user.role}>
              {['admin', 'security', 'regulator'].map((r) => (
                <option value={r} key={r}>{r}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="uStatus">Status</label>
            <select className="select" id="uStatus" defaultValue={user.status}>
              {['active', 'suspended'].map((s) => (
                <option value={s} key={s}>{s}</option>
              ))}
            </select>
            <p className="hint">Suspending an account signs it out of every device immediately.</p>
          </div>
        </>
      )}
    </>
  );
}

function UserActions({ user, drawer, reload }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: {
          role: document.getElementById('uRole').value,
          status: document.getElementById('uStatus').value,
        },
      });
      toast('User updated.', 'success');
      drawer.close();
      reload();
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!window.confirm(`Reset the password for ${user.email}? They will be signed out everywhere.`))
      return;
    try {
      const res = await api(`/api/admin/users/${user.id}/reset-password`, { method: 'POST' });
      drawer.open({
        title: 'Temporary password',
        subtitle: user.email,
        body: (
          <>
            <div className="alert alert-warn">
              <Icon name="alert" />
              <span>
                This is shown once and is not stored anywhere readable. Pass it on through a channel
                you trust, not email.
              </span>
            </div>
            <p className="temp-pw mono">{res.temporaryPassword}</p>
            <p className="text-sm text-muted">
              The user must change it the first time they sign in.
            </p>
          </>
        ),
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return (
    <div className="row row-wrap">
      <button className="btn btn-sm btn-primary" disabled={busy} onClick={save}>
        Save changes
      </button>
      <button className="btn btn-sm" disabled={busy} onClick={resetPassword}>
        Reset password
      </button>
    </div>
  );
}

function openNew(drawer, reload) {
  drawer.open({
    title: 'Add user',
    subtitle: 'Accounts are provisioned internally - there is no public sign-up',
    body: <NewUserForm drawer={drawer} reload={reload} />,
  });
}

function NewUserForm({ drawer, reload }) {
  const toast = useToast();
  const [form, setForm] = useState({ fullName: '', email: '', role: 'security', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  function generate() {
    // Generated in the browser with the CSPRNG; the server hashes it on arrival.
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const pw = `Qs${btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, 'x')}7`;
    setForm((f) => ({ ...f, password: pw }));
    setShowPassword(true);
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: {
          fullName: form.fullName.trim(),
          email: form.email.trim(),
          role: form.role,
          password: form.password,
        },
      });
      toast('Account created.', 'success');
      drawer.close();
      reload();
    } catch (err) {
      setError(err.formMessage);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="field">
        <label className="label" htmlFor="nName">Full name</label>
        <input className="input" id="nName" value={form.fullName} onChange={set('fullName')}
               maxLength={120} autoComplete="name" />
      </div>
      <div className="field">
        <label className="label" htmlFor="nEmail">Work email</label>
        <input className="input" id="nEmail" type="email" value={form.email} onChange={set('email')}
               autoComplete="off" />
      </div>
      <div className="field">
        <label className="label" htmlFor="nRole">Role</label>
        <select className="select" id="nRole" value={form.role} onChange={set('role')}>
          <option value="security">security</option>
          <option value="regulator">regulator</option>
          <option value="admin">admin</option>
        </select>
        <p className="hint">{ROLE_NOTE[form.role]}</p>
      </div>
      <div className="field">
        <label className="label" htmlFor="nPass">Initial password</label>
        <input className="input mono" id="nPass" type={showPassword ? 'text' : 'password'}
               value={form.password} onChange={set('password')} autoComplete="new-password" />
        <p className="hint">
          At least 12 characters with upper case, lower case and a digit. The user must change it on
          first sign-in.
        </p>
        <button className="btn btn-sm mt-8" type="button" onClick={generate}>
          Generate a strong one
        </button>
      </div>

      {error && <p className="field-error" role="alert">{error}</p>}

      <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
        {busy ? 'Creating...' : 'Create account'}
      </button>
    </form>
  );
}
