/**
 * Grid / table switch, and the hook that remembers the choice.
 *
 * Shared because two screens now offer both layouts, and a switch that looked
 * or behaved differently between them would read as two unrelated controls.
 *
 * The choice is kept per screen rather than globally: which layout suits
 * depends on what that screen is for, so a person can reasonably want cards on
 * one and rows on another.
 */
import { useEffect, useState } from 'react';

import { Icon } from '../../components/Icons.jsx';

/**
 * @param {string} storageKey  unique per screen
 * @param {'grid'|'table'} [fallback]
 */
export function useRememberedView(storageKey, fallback = 'grid') {
  const [view, setView] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === 'grid' || stored === 'table' ? stored : fallback;
    } catch {
      return fallback; // private windows and blocked storage
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, view);
    } catch {
      /* the choice simply will not persist; the screen still works */
    }
  }, [storageKey, view]);

  return [view, setView];
}

/**
 * A radiogroup rather than two buttons: one choice with two states, so a
 * screen reader says which is selected instead of offering two commands that
 * look unrelated.
 */
export default function ViewToggle({ view, onChange, label = 'How to show these' }) {
  return (
    <div className="view-toggle" role="radiogroup" aria-label={label}>
      {[
        { id: 'grid', icon: 'grid', label: 'Grid' },
        { id: 'table', icon: 'menu', label: 'Table' },
      ].map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={view === option.id}
          /* The name lives here now that the text is gone: without it the
             control announces as an unnamed radio, and a pointer user has no
             way to learn what the icon means. */
          aria-label={`${option.label} view`}
          title={`${option.label} view`}
          className={`view-toggle-option${view === option.id ? ' is-active' : ''}`}
          onClick={() => onChange(option.id)}
        >
          <Icon name={option.icon} />
        </button>
      ))}
    </div>
  );
}
