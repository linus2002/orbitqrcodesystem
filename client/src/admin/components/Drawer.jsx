/**
 * Detail modal, centered over the page, fading in and out.
 *
 * A single drawer instance lives in the shell; views open it by calling
 * `useDrawer().open({ title, subtitle, headerImage, avatar, body, footer })` - the name is kept from when it
 * was a slide-over, so no view had to change. Keeping one instance means
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
    // Next frame, so the fade transition actually runs.
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    setTimeout(() => {
      setContent(null);
      lastFocus.current?.focus?.();
    }, 220); // matches the fade-out in admin.css
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
            {content.avatar !== undefined ? (
              <ProfileHead content={content} closeBtn={closeBtn} onClose={close} />
            ) : (
              <div
                className={`drawer-head${content.headerImage ? ' drawer-head-hero' : ''}`}
                style={
                  content.headerImage
                    ? { backgroundImage: `url(${content.headerImage})` }
                    : undefined
                }
              >
                <div className="grow">
                  <h2>{content.title}</h2>
                  {content.subtitle && <p className="sub text-sm text-muted">{content.subtitle}</p>}
                </div>
                <button
                  className="icon-btn icon-btn-bare"
                  type="button"
                  ref={closeBtn}
                  onClick={close}
                  aria-label="Close"
                >
                  <Icon name="x" />
                </button>
              </div>
            )}

            <div className="drawer-body">{content.body}</div>

            {content.footer && <div className="drawer-foot">{content.footer}</div>}
          </>
        )}
      </aside>
    </DrawerContext.Provider>
  );
}

export const useDrawer = () => useContext(DrawerContext);

/**
 * A person's header: a gradient banner with glass shapes, drawn in CSS, and
 * the avatar overlapping its bottom edge above the name. Used when open() is
 * given an `avatar` (an <img>, or the person's initials).
 */
function ProfileHead({ content, closeBtn, onClose }) {
  return (
    <div className="drawer-head drawer-head-profile">
      <div className="profile-banner" aria-hidden="true">
        <i className="glass glass-1" />
        <i className="glass glass-2" />
        <i className="glass glass-3" />
        <i className="glass glass-4" />
      </div>
      <button
        className="icon-btn"
        type="button"
        ref={closeBtn}
        onClick={onClose}
        aria-label="Close"
      >
        <Icon name="x" />
      </button>
      <div className="profile-id">
        <span className="profile-id-avatar">{content.avatar}</span>
        <h2>{content.title}</h2>
        {content.subtitle && <p className="sub text-sm text-muted">{content.subtitle}</p>}
      </div>
    </div>
  );
}
