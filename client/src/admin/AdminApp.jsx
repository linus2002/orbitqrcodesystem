/**
 * Dashboard shell: session guard, permission-driven navigation, routing.
 *
 * The navigation is built from the CURRENT USER'S PERMISSIONS, so a regulator
 * simply never sees Scans, Alerts, Users or the Audit log. That is a usability
 * measure only - the server enforces the same matrix independently, and
 * hand-typing /admin/scans as a regulator still gets a 403.
 */
import { useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { api } from '../lib/api.js';
import { initials } from '../lib/format.js';
import { useSession, useTheme } from '../lib/hooks.jsx';
import { Icon } from '../components/Icons.jsx';
import { Logo } from '../components/Logo.jsx';
import BrandLoader from '../components/BrandLoader.jsx';
import Clock from './components/Clock.jsx';
import { DrawerProvider, useDrawer } from './components/Drawer.jsx';
import { HeaderProvider, PageHeader, useHeader } from './components/PageHeader.jsx';

import Dashboard from './views/Dashboard.jsx';
import Alerts from './views/Alerts.jsx';
import Scans from './views/Scans.jsx';
import Reports from './views/Reports.jsx';
import Lookup from './views/Lookup.jsx';
import Products from './views/Products.jsx';
import LeafletCodes from './views/LeafletCodes.jsx';
import Batches from './views/Batches.jsx';
import Shipments from './views/Shipments.jsx';
import Compliance from './views/Compliance.jsx';
import Audit from './views/Audit.jsx';
import Users from './views/Users.jsx';
import Settings from './views/Settings.jsx';

/** Route table. `perm` gates both the nav entry and the route itself. */
const ROUTES = [
  { path: '', label: 'Overview', icon: 'grid', perm: 'dashboard:view', group: 'Monitor', element: <Dashboard /> },
  { path: 'alerts', label: 'Alerts', icon: 'alert', perm: 'alerts:read', group: 'Monitor', element: <Alerts />, badge: 'alerts' },
  { path: 'scans', label: 'Scan log', icon: 'scan', perm: 'scans:read', group: 'Monitor', element: <Scans /> },
  { path: 'reports', label: 'Patient reports', icon: 'report', perm: 'reports:read', group: 'Monitor', element: <Reports />, badge: 'reports' },

  { path: 'lookup', label: 'Code lookup', icon: 'search', perm: 'codes:read', group: 'Investigate', element: <Lookup /> },

  { path: 'products', label: 'Products', icon: 'pill', perm: 'products:read', group: 'Manage', element: <Products /> },
  { path: 'leaflet-codes', label: 'Leaflet QR codes', icon: 'qr', perm: 'products:read', group: 'Manage', element: <LeafletCodes /> },
  { path: 'batches', label: 'Batches & codes', icon: 'box', perm: 'batches:read', group: 'Manage', element: <Batches /> },
  { path: 'shipments', label: 'Shipments', icon: 'truck', perm: 'batches:read', group: 'Manage', element: <Shipments /> },

  { path: 'compliance', label: 'Compliance', icon: 'log', perm: 'batches:read', group: 'Governance', element: <Compliance /> },
  { path: 'audit', label: 'Audit log', icon: 'log', perm: 'audit:read', group: 'Governance', element: <Audit /> },
  { path: 'users', label: 'Users', icon: 'users', perm: 'users:read', group: 'Governance', element: <Users /> },
  { path: 'settings', label: 'Settings', icon: 'gear', perm: 'dashboard:view', group: 'Governance', element: <Settings /> },
];

export default function AdminApp() {
  const session = useSession();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  // The dashboard is the first thing that needs to know who is signed in, so
  // it is what triggers the session lookup. The public portal never does.
  //
  // Depend on `ensure` alone, never on the whole session object: `ensure`
  // resolving updates the session, and depending on the object would make that
  // update re-run this effect, which fetches again - an endless /api/auth/me
  // loop that hammers the server for as long as the dashboard is open.
  const { ensure } = session;
  useEffect(() => {
    ensure();
  }, [ensure]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setNavOpen(false), [location.pathname]);

  if (session.status === 'idle' || session.status === 'loading') {
    return (
      <div className="page-loading">
        <BrandLoader size="lg" message="Loading your dashboard..." />
      </div>
    );
  }

  if (session.status === 'anonymous') {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }

  if (session.status === 'error') {
    return (
      <div className="view">
        <div className="alert alert-error">
          <Icon name="alert" />
          <span>Could not load the dashboard: {session.error?.message}</span>
        </div>
        {/* A dropped connection is the usual cause, so offer the retry here
            rather than making the user reload the whole page. */}
        <button type="button" className="btn mt-8" onClick={() => session.refresh()}>
          Try again
        </button>
      </div>
    );
  }

  const can = (perm) => session.user.permissions.includes(perm);
  const allowed = ROUTES.filter((r) => can(r.perm));

  return (
    <HeaderProvider>
      <DrawerProvider>
        <div className="admin-shell">
          <Sidebar open={navOpen} routes={allowed} session={session} />

          <div className="admin-main">
            <header className="topbar">
              <button
                className="icon-btn menu-btn"
                type="button"
                onClick={() => setNavOpen((v) => !v)}
                aria-label="Open navigation"
                aria-expanded={navOpen}
              >
                <Icon name="menu" />
              </button>
              <PageHeader />
              <ShellTools signOut={session.signOut} user={session.user} />
            </header>

            <main className="view" aria-live="polite">
              <Routes>
                {ROUTES.map((r) => (
                  <Route
                    key={r.path || 'index'}
                    path={r.path}
                    element={can(r.perm) ? r.element : <Denied role={session.user.role} />}
                  />
                ))}
                <Route path="*" element={<Denied role={session.user.role} notFound />} />
              </Routes>
            </main>
          </div>
        </div>
      </DrawerProvider>
    </HeaderProvider>
  );
}

function Denied({ role, notFound = false }) {
  useHeader(notFound ? 'Not found' : 'Not available', '');
  return (
    <div className="alert alert-warn">
      <Icon name="alert" />
      <span>
        {notFound
          ? 'That dashboard section does not exist.'
          : `Your role (${role}) does not have access to this section.`}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell tools
// ---------------------------------------------------------------------------

/**
 * Clock, theme, sign-out and your own picture, pinned to the right of the top
 * bar.
 *
 * The two icon buttons are borderless: they sit beside a view's own action
 * buttons, and giving them the same boxed treatment would put three
 * equal-looking buttons in a row where only one is the thing the page wants
 * you to do.
 *
 * The picture is the same account button as the one in the sidebar foot, not a
 * second way in. It is duplicated here because the sidebar collapses off
 * screen on a narrow window, which is exactly where "am I still signed in as
 * the right person?" is hardest to answer - and on a shared workstation that
 * is a question worth being able to answer at a glance.
 */
function ShellTools({ signOut, user }) {
  const { toggle: toggleTheme } = useTheme();
  const { open: openAccount, loading } = useOpenAccount(user);

  return (
    <div className="shell-tools">
      <Clock />
      <span className="shell-tools-sep" aria-hidden="true" />
      <button
        className="icon-btn icon-btn-bare"
        type="button"
        onClick={toggleTheme}
        aria-label="Switch theme"
        title="Switch theme"
      >
        <Icon name="sun" className="icon-sun" />
        <Icon name="moon" className="icon-moon" />
      </button>
      <button
        className="icon-btn icon-btn-bare"
        type="button"
        onClick={signOut}
        aria-label="Sign out"
        title="Sign out"
      >
        <Icon name="out" />
      </button>
      <button
        className="shell-avatar"
        type="button"
        onClick={openAccount}
        disabled={loading}
        aria-label={`Your account: ${user.fullName}`}
        title={`${user.fullName} - ${user.email}`}
      >
        <span className="avatar">
          {user.avatar ? <img src={user.avatar} alt="" /> : initials(user.fullName)}
        </span>
      </button>
    </div>
  );
}

/**
 * Open the account panel through the shared drawer.
 *
 * Shared by the sidebar chip and the top bar picture so both open the same
 * panel with the same title - two account panels that differed would read as
 * two different accounts.
 *
 * It goes through the drawer provider rather than rendering its own overlay:
 * the sidebar is `position: sticky`, which creates a stacking context, so
 * anything viewport-covering rendered inside it is trapped behind elements
 * that sit higher in the root stacking context - the page's sticky table
 * headers, for one.
 *
 * The panel is loaded on demand so it stays out of the initial admin chunk.
 */
function useOpenAccount(user) {
  const drawer = useDrawer();
  const [loading, setLoading] = useState(false);

  async function open() {
    setLoading(true);
    try {
      const { default: Account } = await import('./views/Account.jsx');
      drawer.open({
        title: user.fullName,
        subtitle: user.email,
        body: <Account />,
      });
    } finally {
      setLoading(false);
    }
  }

  return { open, loading };
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function Sidebar({ open, routes, session }) {
  const badges = useBadgeCounts(session.user.permissions);

  // Insert a heading whenever the group changes.
  const items = useMemo(() => {
    const out = [];
    let lastGroup = null;
    for (const r of routes) {
      if (r.group !== lastGroup) {
        out.push({ kind: 'group', label: r.group });
        lastGroup = r.group;
      }
      out.push({ kind: 'link', route: r });
    }
    return out;
  }, [routes]);

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="sidebar-head">
        <Logo size="sm" />
      </div>

      <nav className="nav" aria-label="Dashboard sections">
        {items.map((item, i) =>
          item.kind === 'group' ? (
            <div className="nav-group-label" key={`g-${item.label}-${i}`}>
              {item.label}
            </div>
          ) : (
            <NavLink
              key={item.route.path || 'index'}
              to={`/admin/${item.route.path}`}
              end={item.route.path === ''}
              className={({ isActive }) => (isActive ? 'active' : undefined)}
            >
              <Icon name={item.route.icon} />
              <span>{item.route.label}</span>
              {item.route.badge && (
                <span className={`nav-count${badges[item.route.badge] ? '' : ' zero'}`}>
                  {badges[item.route.badge] > 99 ? '99+' : badges[item.route.badge] ?? 0}
                </span>
              )}
            </NavLink>
          )
        )}
      </nav>

      <div className="sidebar-foot">
        <AccountChip user={session.user} />
      </div>
    </aside>
  );
}

function AccountChip({ user }) {
  const { open: openAccount, loading } = useOpenAccount(user);

  return (
    <button className="user-chip" type="button" onClick={openAccount} disabled={loading}>
      <span className="avatar">
        {user.avatar ? <img src={user.avatar} alt="" /> : initials(user.fullName)}
      </span>
      <span className="who">
        <b>{user.fullName}</b>
        <span>{user.role}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Live badge counts
// ---------------------------------------------------------------------------

/** Poll the alert and report counters so the nav badges stay current. */
function useBadgeCounts(permissions) {
  const [counts, setCounts] = useState({ alerts: 0, reports: 0 });

  useEffect(() => {
    const canAlerts = permissions.includes('alerts:read');
    const canReports = permissions.includes('reports:read');
    if (!canAlerts && !canReports) return undefined;

    let active = true;

    async function refresh() {
      const next = {};
      if (canAlerts) {
        try {
          const c = await api('/api/admin/alerts/counts');
          next.alerts = (c.open ?? 0) + (c.investigating ?? 0);
        } catch {
          /* transient; the next tick retries */
        }
      }
      if (canReports) {
        try {
          const r = await api('/api/admin/reports', { query: { status: 'new', pageSize: 1 } });
          next.reports = r.total;
        } catch {
          /* ignore */
        }
      }
      if (active) setCounts((c) => ({ ...c, ...next }));
    }

    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [permissions]);

  return counts;
}
