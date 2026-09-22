/**
 * The page title strip.
 *
 * Views set their title through `useHeader(...)` rather than rendering it
 * themselves, because the strip lives in the shell above the routed area and
 * has to carry each view's action buttons too.
 */
import { createContext, useContext, useEffect, useState } from 'react';

const HeaderContext = createContext({ set: () => {} });

export function HeaderProvider({ children }) {
  const [header, setHeader] = useState({ title: '', subtitle: '', actions: null });
  return (
    <HeaderContext.Provider value={{ ...header, set: setHeader }}>{children}</HeaderContext.Provider>
  );
}

/** Rendered once by the shell. */
export function PageHeader() {
  const { title, subtitle, actions } = useContext(HeaderContext);
  return (
    <>
      <div className="grow">
        <h1>{title}</h1>
        {subtitle && <p className="sub">{subtitle}</p>}
      </div>
      <div className="row row-wrap">{actions}</div>
    </>
  );
}

/**
 * Set the header from a view.
 *
 * `actions` is a React node; pass it through `useMemo` in the caller if it is
 * more than a plain element, or list its inputs in `deps`.
 */
export function useHeader(title, subtitle = '', actions = null, deps = []) {
  const { set } = useContext(HeaderContext);
  useEffect(() => {
    set({ title, subtitle, actions });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, subtitle, ...deps]);
}
