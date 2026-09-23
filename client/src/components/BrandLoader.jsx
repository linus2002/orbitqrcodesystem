/**
 * The loading state, built from the system's own mark.
 *
 * The name is Orbit, so the wait is drawn as one: the mark holds still while
 * two arcs travel around it, one in each brand colour, turning in opposite
 * directions at different speeds. A generic spinner says "something is
 * happening"; this says which system is doing it - which is worth something at
 * the two moments it appears, the first paint after sign-in and a slow query
 * on a dashboard somebody is waiting on.
 *
 * The arcs are SVG rather than CSS borders so each can carry a real colour and
 * a rounded cap, and the mark is the logo file itself rather than a redrawn
 * copy, so there is one source of truth for what the mark looks like.
 *
 * All motion sits behind `prefers-reduced-motion`. Someone who has asked their
 * system to stop animating gets the mark inside two static arcs, which still
 * reads as a loading state.
 */

/**
 * @param {object} props
 * @param {'sm'|'md'|'lg'} [props.size]
 * @param {string} [props.message]  shown beneath; pass '' for none
 * @param {string} [props.className]
 */
export default function BrandLoader({ size = 'md', message = 'Loading...', className = '' }) {
  return (
    <div className={`brand-loader brand-loader-${size} ${className}`} role="status" aria-live="polite">
      <div className="brand-loader-stage">
        <svg className="brand-loader-orbit" viewBox="0 0 120 120" aria-hidden="true">
          {/* The track, faint enough to read as a path rather than a border. */}
          <circle
            className="brand-loader-track"
            cx="60"
            cy="60"
            r="50"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />

          {/*
            Circumference at r=50 is ~314. A 70-unit dash leaves a little under
            a quarter of the ring lit, which is enough to follow with the eye
            without becoming a solid ring.
          */}
          <circle
            className="brand-loader-arc brand-loader-arc-blue"
            cx="60"
            cy="60"
            r="50"
            fill="none"
            stroke="#1d9fda"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray="70 244"
          />

          {/*
            The second arc runs inside the first, the other way, and slower.
            Two arcs at the same speed would look like one thick ring; the
            difference is what makes it read as motion around something.
          */}
          <circle
            className="brand-loader-arc brand-loader-arc-green"
            cx="60"
            cy="60"
            r="41"
            fill="none"
            stroke="#61a644"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray="44 214"
          />
        </svg>

        <img className="brand-loader-mark" src="/img/logo-mark-192.png" alt="" width="192" height="192" />
      </div>

      {message ? <p className="brand-loader-message">{message}</p> : null}
    </div>
  );
}
