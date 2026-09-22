/**
 * Shared hooks and providers: theme, toasts, session, and data fetching.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api.js';

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME_KEY = 'qrshield.theme';

/**
 * Applied before React mounts (see main.jsx) so there is no flash of the
 * wrong theme, then managed here.
 */
export function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? null);

  const toggle = useCallback(() => {
    const current =
      document.documentElement.dataset.theme ??
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private browsing: the change still applies for this page view */
    }
  }, []);

  return { theme, toggle };
}

/**
 * Add a class to <body> for as long as a page is mounted.
 *
 * Used by the pages that sit on a plain white background. The class goes on
 * <body> rather than the page wrapper so overscroll on a phone reveals the
 * same colour instead of a strip of the app's default page tint.
 */
export function useBodyClass(className) {
  useEffect(() => {
    if (!className) return undefined;
    document.body.classList.add(className);
    return () => document.body.classList.remove(className);
  }, [className]);
}

/** Read the stored preference. Called from main.jsx before the first paint. */
export function applyStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored;
  } catch {
    /* fall back to the OS preference */
  }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const push = useCallback((message, kind = 'info') => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'err' : t.kind === 'success' ? 'ok' : ''}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const SessionContext = createContext(null);

/**
 * Holds the current staff session.
 *
 * The session is fetched ONLY when something asks for it, via `ensure()`.
 * It deliberately does not load on mount: the public portal is the most
 * visited page in the system and nobody using it is signed in, so an eager
 * /api/auth/me would add a guaranteed-401 round trip to a patient's critical
 * path - on the sort of connection where that round trip actually costs
 * something - and log a console error on every page view.
 *
 * `status` starts as 'idle' and becomes 'loading' the moment the dashboard
 * asks, so guarded routes never flash before the answer arrives.
 */
export function SessionProvider({ children }) {
  const [state, setState] = useState({ status: 'idle', user: null, error: null });
  const inFlight = useRef(null);
  const settled = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(async () => {
    setState((s) => (s.status === 'idle' ? { ...s, status: 'loading' } : s));
    try {
      const me = await api('/api/auth/me');
      settled.current = true;
      setState({ status: 'authenticated', user: me.user, error: null });
      return me.user;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        settled.current = true;
        setState({ status: 'anonymous', user: null, error: null });
      } else {
        // Left unsettled on purpose: a dropped connection is not an answer
        // about who is signed in, so `ensure` may ask again.
        setState({ status: 'error', user: null, error: err });
      }
      return null;
    }
  }, []);

  /**
   * Answer "is the session loaded yet", asking the server only if it is not.
   * Concurrent callers share one request, and `settled` stops a caller that
   * runs again AFTER the answer arrived from starting a second one. Callers
   * that specifically want fresh data - after a sign-in - call `refresh`.
   */
  const ensure = useCallback(() => {
    if (settled.current) return Promise.resolve(stateRef.current.user);
    if (!inFlight.current) {
      inFlight.current = refresh().finally(() => {
        inFlight.current = null;
      });
    }
    return inFlight.current;
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* the cookie may already be gone; sign out locally regardless */
    }
    settled.current = true;
    setState({ status: 'anonymous', user: null, error: null });
  }, []);

  /*
   * Memoised: consumers put this value in effect dependency arrays, so a fresh
   * object on every render would re-run those effects on every render.
   */
  const value = useMemo(
    () => ({ ...state, refresh, ensure, signOut }),
    [state, refresh, ensure, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

/** Does the signed-in user hold this permission? */
export function usePermission(permission) {
  const session = useSession();
  return Boolean(session?.user?.permissions?.includes(permission));
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

/**
 * Fetch on mount and whenever `deps` change.
 *
 * Aborts the in-flight request on unmount or when deps change again, so a
 * slow response cannot overwrite a newer one - the classic filter-race bug in
 * a dashboard with debounced search inputs.
 *
 * @returns {{data, error, loading, reload}}
 */
export function useApi(path, { query, skip = false } = {}, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: !skip });
  const [nonce, setNonce] = useState(0);
  const queryKey = JSON.stringify(query ?? null);

  useEffect(() => {
    if (skip) {
      setState({ data: null, error: null, loading: false });
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    setState((s) => ({ ...s, loading: true }));

    api(path, { query, signal: controller.signal })
      .then((data) => active && setState({ data, error: null, loading: false }))
      .catch((err) => {
        if (err.name === 'AbortError' || !active) return;
        setState({ data: null, error: err, loading: false });
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, queryKey, skip, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

/** Debounce a rapidly-changing value (search boxes). */
export function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
