/**
 * Picking a city or town from the list.
 *
 * A picked place, not free text: "Bacoor", "bacoor city" and "Bacoor Cavite"
 * are one place to the security team only if they arrive as one. A place
 * already chosen - the last one this person gave, or the one their
 * connection points to - shows as itself with a "Change" link, so the usual
 * answer is no typing at all. `note` says where that suggestion came from,
 * and goes as soon as the person picks something else.
 *
 * "Change" empties the answer rather than leaving the old one standing
 * behind the search box: someone who types a new town and sends without
 * tapping it must not have the old town saved in its place. "Keep ..."
 * puts it back.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../components/Icons.jsx';
import { loadPlaces, searchPlaces } from './where.js';

export default function PlacePicker({ id, value, onChange, note, onPending }) {
  const [term, setTerm] = useState('');
  const [places, setPlaces] = useState(null);
  const [error, setError] = useState(null);
  // What "Change" took away, so it can be kept after all.
  const [previous, setPrevious] = useState(null);
  const [changed, setChanged] = useState(false);
  const editing = !value;

  // Typed but not picked: the form holds its send until a town is tapped.
  const pending = editing && term.trim().length > 0;
  useEffect(() => {
    onPending?.(pending);
  }, [pending, onPending]);

  useEffect(() => {
    if (!editing || places) return;
    let active = true;
    loadPlaces()
      .then((list) => active && setPlaces(list))
      .catch(() => active && setError('The list of towns could not be loaded. Please try again.'));
    return () => {
      active = false;
    };
  }, [editing, places]);

  if (!editing) {
    return (
      <div className="place-chosen">
        <p>
          <Icon name="check" />
          <strong id={id}>{value.label}</strong>{' '}
          <button
            className="link-btn"
            type="button"
            onClick={() => {
              setPrevious(value);
              onChange(null);
            }}
          >
            Change
          </button>
        </p>
        {note && !changed && <p className="hint">{note}</p>}
      </div>
    );
  }

  const typed = term.trim().length >= 2;
  const hits = places && typed ? searchPlaces(places, term) : [];

  return (
    <div className="place-search">
      <input
        className="input"
        id={id}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Type the city or town, e.g. Bacoor"
        autoComplete="off"
        spellCheck={false}
      />
      {hits.length > 0 && (
        <ul className="place-hits">
          {hits.map(([code, label]) => (
            <li key={code}>
              <button
                type="button"
                onClick={() => {
                  onChange({ code, label });
                  setChanged(true);
                  setPrevious(null);
                  setTerm('');
                }}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {typed && places && !hits.length && (
        <p className="hint">No city or town by that name - check the spelling.</p>
      )}
      {!places && !error && typed && <p className="hint">Loading the list...</p>}
      {error && <p className="field-error">{error}</p>}
      {typed && places && hits.length > 0 && <p className="hint">Tap your town in the list.</p>}
      {previous && (
        <button
          className="link-btn text-sm"
          type="button"
          onClick={() => {
            onChange(previous);
            setPrevious(null);
            setTerm('');
          }}
        >
          Keep {previous.label}
        </button>
      )}
    </div>
  );
}
