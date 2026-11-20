/**
 * Search, from the top bar or Ctrl/Cmd+J: go to any section this person can
 * open, or look up a pack code - typed or pasted - in one step.
 *
 * The list is built from the same routes the sidebar shows, so it never
 * offers a section the person is not allowed into.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Icon } from '../../components/Icons.jsx';

// What a pack code looks like: SKU-SERIAL-CHECK, e.g. AMX25-7KQ2M9-K7.
const CODE_RE = /^[A-Z0-9]{2,12}(-[A-Z0-9]{2,})+$/;

export default function CommandPalette({ routes, open, onClose }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // After the dialog paints.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = [];
    const asCode = query.trim().toUpperCase();
    if (CODE_RE.test(asCode) && routes.some((r) => r.path === 'lookup')) {
      out.push({
        key: 'code',
        group: 'Look up',
        icon: 'search',
        label: `Look up ${asCode}`,
        go: () => navigate(`/admin/lookup?code=${encodeURIComponent(asCode)}`),
      });
    }
    for (const r of routes) {
      if (q && !`${r.label} ${r.group}`.toLowerCase().includes(q)) continue;
      out.push({
        key: r.path || 'overview',
        group: r.group,
        icon: r.icon,
        label: r.label,
        go: () => navigate(`/admin/${r.path}`),
      });
    }
    return out;
  }, [query, routes, navigate]);

  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items.length, active]);

  if (!open) return null;

  const run = (item) => {
    onClose();
    item?.go();
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = null;
  return (
    <div
      className="cmdk-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Search">
        <div className="cmdk-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            placeholder="Search sections, or type a pack code..."
            aria-label="Search sections, or type a pack code"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={items[active] ? `cmdk-${items[active].key}` : undefined}
            autoComplete="off"
            spellCheck="false"
          />
        </div>
        <ul className="cmdk-list" id="cmdk-list" role="listbox">
          {items.length === 0 && <li className="cmdk-empty">No section matches.</li>}
          {items.map((item, i) => {
            const head = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.key} role="presentation">
                {head && <div className="cmdk-group">{head}</div>}
                <div
                  id={`cmdk-${item.key}`}
                  role="option"
                  aria-selected={i === active}
                  className={`cmdk-item${i === active ? ' is-active' : ''}`}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(item)}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
          <span><kbd>Enter</kbd> to open</span>
          <span><kbd>Esc</kbd> to close</span>
        </div>
      </div>
    </div>
  );
}
