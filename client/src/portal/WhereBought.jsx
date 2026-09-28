/**
 * "Where did you buy this pack?" - asked on the result, per check.
 *
 * Optional on a genuine result, and phrased as a small favour. On a
 * suspicious one it is asked plainly, because that is when it matters - it
 * is what lets the security team find where unsafe packs are sold - and it
 * is the only place, besides a report, that offers to share the phone's
 * location. Either way nothing stops the person moving on without it.
 *
 * The box starts empty. The towns the page can guess - the one they gave
 * last time, the one their connection points to - are offered as buttons to
 * tap, never filled in (see PlacePicker).
 */
import { useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icons.jsx';
import PlacePicker from './PlacePicker.jsx';
import ShareLocation from './ShareLocation.jsx';
import { shopAfterPick } from './where.js';

export default function WhereBought({ result, suspicious, offers, onSaved }) {
  const [place, setPlace] = useState(null);
  const [outlet, setOutlet] = useState('');
  // The shop an offer put in the box, if it is still as it was put.
  const [filled, setFilled] = useState(null);
  const [location, setLocation] = useState(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);

  async function save(e) {
    e.preventDefault();
    setError(null);
    if (pending) {
      setError('Tap your town in the list first.');
      return;
    }
    if (!place && !outlet.trim() && !location) {
      setError(suspicious ? 'Choose the town, or share your location.' : 'Choose the town where you bought it.');
      return;
    }
    setBusy(true);
    try {
      const res = await api(`/api/checks/${result.scanId}/place`, {
        method: 'POST',
        body: {
          placeCode: place?.code,
          outlet: outlet.trim() || undefined,
          location: location ?? undefined,
        },
      });
      setSaved(res.purchasePlace ? `Thank you - saved as bought in ${res.purchasePlace}.` : 'Thank you - saved.');
      onSaved({ place, outlet: outlet.trim(), location });
    } catch (err) {
      if (err.status === 409) setSaved('Already recorded for this check. Thank you.');
      else setError(err.message || 'Could not save that. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <div className="card-body">
        <div className="alert alert-success" role="status">
          <Icon name="check" />
          <span>{saved}</span>
        </div>
      </div>
    );
  }

  return (
    <form className={`card-body where-bought${suspicious ? ' is-asked' : ''}`} onSubmit={save} noValidate>
      <h3>
        {suspicious ? 'Help trace this pack' : 'Where did you buy this pack?'}
        {!suspicious && <span className="text-muted"> (optional)</span>}
      </h3>
      <p className="hint">
        {suspicious
          ? 'Where you bought it helps the security team find where unsafe packs are being sold.'
          : 'It helps the manufacturer see where genuine packs reach people.'}
      </p>

      <div className="field">
        <label className="label" htmlFor="wbPlace">
          City or town where you bought it
        </label>
        <PlacePicker
          id="wbPlace"
          value={place}
          onChange={(p, offer) => {
            setPlace(p);
            if (p) {
              const shop = shopAfterPick({ outlet, filled }, offer);
              setOutlet(shop.outlet);
              setFilled(shop.filled);
            }
            setError(null);
          }}
          offers={offers}
          onPending={setPending}
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="wbOutlet">
          Pharmacy or shop <span className="text-muted">(optional)</span>
        </label>
        <input
          className="input"
          id="wbOutlet"
          value={outlet}
          onChange={(e) => setOutlet(e.target.value)}
          maxLength={120}
          placeholder="e.g. Mercury Drug, Molino"
        />
      </div>

      {suspicious && <ShareLocation value={location} onChange={setLocation} />}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" /> Saving...
          </>
        ) : (
          'Send'
        )}
      </button>
    </form>
  );
}
