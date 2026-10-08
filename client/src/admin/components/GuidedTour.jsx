/**
 * The dashboard's guided tour.
 *
 * Opens on someone's first sign-in and walks through where things are: the
 * page dims, the part being explained is lit and ringed, and a card beside it
 * says what it is for, with progress dots, Skip and Next. Finishing or
 * skipping records it on the account (POST /api/auth/tour-done), so it does
 * not open again - on any device. Settings can replay it.
 *
 * A step names its target by `data-tour`. When the target is not on screen -
 * the sidebar is folded away on a phone, or a role does not have that section
 * - the card stands in the middle of the page instead, so no step is lost.
 *
 * Rendered into <body> through a portal: the sidebar is sticky, which makes a
 * stacking context that would trap anything drawn inside it.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Starts the tour again; provided by the dashboard shell, used by Settings. */
export const TourContext = createContext(null);
export const useTour = () => useContext(TourContext);

const SPOT_PAD = 6; // light around the target, px
const GAP = 22; // between the lit target and the card, room for the arrow
const EDGE = 12; // nearest a card comes to the window's edge

/** The step's target, if it is on screen and can be pointed at. */
function findTarget(step) {
  if (!step.target) return null;
  const el = document.querySelector(`[data-tour="${step.target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height || r.right <= 0 || r.left >= window.innerWidth) return null;
  return el;
}

/** Where the card goes beside `rect`: to the right if it fits, else below, else above. */
function place(rect, card) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

  if (rect.right + GAP + card.width <= vw - EDGE) {
    const top = clamp(rect.top + rect.height / 2 - card.height / 2, EDGE, vh - card.height - EDGE);
    return { side: 'right', left: rect.right + GAP, top, arrow: rect.top + rect.height / 2 - top };
  }
  const left = clamp(rect.left + rect.width / 2 - card.width / 2, EDGE, vw - card.width - EDGE);
  const arrow = rect.left + rect.width / 2 - left;
  if (rect.bottom + GAP + card.height <= vh - EDGE) {
    return { side: 'below', left, top: rect.bottom + GAP, arrow };
  }
  return { side: 'above', left, top: Math.max(EDGE, rect.top - GAP - card.height), arrow };
}

export default function GuidedTour({ steps, onClose }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState(null); // the lit target, or null for a centred card
  const [pos, setPos] = useState(null);
  const cardRef = useRef(null);
  const nextRef = useRef(null);

  const step = steps[index];
  const last = index === steps.length - 1;

  // Find the target, bring it into view, and follow it as the page moves.
  useLayoutEffect(() => {
    const el = findTarget(step);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    const measure = () => {
      const target = findTarget(step);
      setRect(target ? target.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  // Place the card once its size is known.
  useLayoutEffect(() => {
    if (!cardRef.current) return;
    setPos(rect ? place(rect, cardRef.current.getBoundingClientRect()) : null);
  }, [rect, index]);

  // Keep focus on the card's main button as the steps change.
  useEffect(() => {
    nextRef.current?.focus();
  }, [index]);

  const finish = useCallback(() => onClose(), [onClose]);
  const next = useCallback(() => (last ? finish() : setIndex((i) => i + 1)), [last, finish]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish, next, back]);

  const spot = rect && {
    left: rect.left - SPOT_PAD,
    top: rect.top - SPOT_PAD,
    width: rect.width + SPOT_PAD * 2,
    height: rect.height + SPOT_PAD * 2,
  };

  const cardStyle = pos
    ? { left: pos.left, top: pos.top, '--tour-arrow': `${pos.arrow}px` }
    : undefined;

  return createPortal(
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text">
      {/* The dimmed page, with a hole cut around the target by the ring's shadow. */}
      {spot ? <div className="tour-spot" style={spot} /> : <div className="tour-dim" />}

      <div
        ref={cardRef}
        key={index}
        className={`tour-card${pos ? ` tour-${pos.side}` : ' tour-center'}`}
        style={cardStyle}
      >
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-text">{step.text}</p>

        <div className="tour-foot">
          <div className="tour-dots" aria-label={`Step ${index + 1} of ${steps.length}`}>
            {steps.map((s, i) => (
              <span key={s.id} className={i === index ? 'on' : i < index ? 'done' : undefined} />
            ))}
          </div>
          {!last && (
            <button type="button" className="tour-skip" onClick={finish}>
              Skip
            </button>
          )}
          {index > 0 && (
            <button type="button" className="tour-back" onClick={back}>
              Back
            </button>
          )}
          <button ref={nextRef} type="button" className="tour-next" onClick={next}>
            {last ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
