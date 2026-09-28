/**
 * "Share my location" - offered only on a suspicious result and on a report.
 *
 * Nothing is asked until the person taps: the phone then shows its own
 * "allow?" prompt. Declining is a normal answer, said so, and never stops
 * them sending. The reading goes to the server with what they send and is
 * reduced to a city there; the page says so before they tap.
 */
import { useState } from 'react';
import { Icon } from '../components/Icons.jsx';
import { askLocation } from './where.js';

export default function ShareLocation({ value, onChange }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState(null);

  async function share() {
    setAsking(true);
    setNote(null);
    try {
      onChange(await askLocation());
    } catch (err) {
      setNote(err.message);
    } finally {
      setAsking(false);
    }
  }

  if (value) {
    return (
      <p className="text-sm location-shared" role="status">
        <Icon name="check" /> Your location will be sent with this - only the city is kept.{' '}
        <button className="link-btn" type="button" onClick={() => onChange(null)}>
          Don&apos;t send it
        </button>
      </p>
    );
  }

  return (
    <div>
      <button className="btn btn-outline btn-block" type="button" onClick={share} disabled={asking}>
        {asking ? (
          <>
            <span className="spinner" aria-hidden="true" /> Finding your location...
          </>
        ) : (
          'Share my location (optional)'
        )}
      </button>
      <p className="hint">
        Your phone asks first. We keep only the city it points to, never the exact spot, and you
        can say no and still send.
      </p>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
