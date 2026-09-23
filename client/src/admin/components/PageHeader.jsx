/**
 * The page title strip.
 *
 * Views set their title through `useHeader(...)` rather than rendering it
 * themselves, because the strip lives in the shell, above the routed area.
 *
 * It carries the TITLE ONLY. A view's action buttons belong to that view's own
 * toolbar, directly above the rows they act on. Up here they shared a line
 * with the shell's own controls - theme, sign out, the clock - which read as
 * one undifferentiated row of buttons where only some had anything to do with
 * the page below.
 */
import { createContext, useContext, useEffect, useState } from 'react';

const HeaderContext = createContext({ set: () => {} });

export function HeaderProvider({ children }) {
  const [header, setHeader] = useState({ title: '', subtitle: '' });
  return (
    <HeaderContext.Provider value={{ ...header, set: setHeader }}>{children}</HeaderContext.Provider>
  );
}

/** Rendered once by the shell. */
export function PageHeader() {
  const { title, subtitle } = useContext(HeaderContext);
  return (
    <div className="grow">
      <h1>{title}</h1>
      {subtitle && <p className="sub">{subtitle}</p>}
    </div>
  );
}

/** Set the header from a view. */
export function useHeader(title, subtitle = '') {
  const { set } = useContext(HeaderContext);
  useEffect(() => {
    set({ title, subtitle });
    // `set` is a state setter and never changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, subtitle]);
}
