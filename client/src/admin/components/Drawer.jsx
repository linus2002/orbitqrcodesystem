/**
 * Slide-over detail panel.
 *
 * A single drawer instance lives in the shell; views open it by calling
 * `useDrawer().open({ title, body, footer })`. Keeping one instance means
 * focus handling, the Escape key and the backdrop are implemented once.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icons.jsx';

const DrawerContext = createContext({ open: () => {}, close: () => {} });

export function DrawerProvider({ children }) {
  const [content, setContent] = useState(null);
  const [visible, setVisible] = useState(false);
  const lastFocus = useRef(null);
  const closeBtn = useRef(null);

  const open = useCallback((next) => {
    lastFocus.current = document.activeElement;
    setContent(next);
    // Next frame, so the transform transition actually runs.
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    setTimeout(() => {
      setContent(null);
      lastFocus.current?.focus?.();
    }, 200);
  }, []);

  useEffect(() => {
    if (!content) return undefined;
    closeBtn.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [content, close]);

  return (
    <DrawerContext.Provider value={{ open, close }}>
      {children}

      <div
        className={`drawer-backdrop${visible ? ' open' : ''}`}
        onClick={close}
        aria-hidden="true"
      />
      <aside
        className={`drawer${visible ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={content?.title ?? 'Details'}
        hidden={!content}
      >
        {content && (
          <>
            <div className="drawer-head">
              <div className="grow">
                <h2>{content.title}</h2>
                {content.subtitle && <p className="sub text-sm text-muted">{content.subtitle}</p>}
              </div>
              <button
                className="icon-btn"
                type="button"
                ref={closeBtn}
                onClick={close}
                aria-label="Close panel"
              >
                <Icon name="x" />
              </button>
            </div>

            <div className="drawer-body">{content.body}</div>

            {content.footer && <div className="drawer-foot">{content.footer}</div>}
          </>
        )}
      </aside>
    </DrawerContext.Provider>
  );
}

export const useDrawer = () => useContext(DrawerContext);
