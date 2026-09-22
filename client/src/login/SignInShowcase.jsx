/**
 * The rotating panel beside the sign-in form.
 *
 * ---------------------------------------------------------------------------
 * SWAPPING IN REAL PHOTOGRAPHY
 *
 * Drop your images into `client/public/img/signin/` and point the `image`
 * fields below at them:
 *
 *     { image: '/img/signin/pharmacy.jpg', title: '...', body: '...' }
 *
 * Nothing else changes. Portrait or landscape both work (the panel uses
 * object-fit: cover). Use roughly 1200x1500 or larger, and keep each file
 * under a few hundred KB - this is the first thing a staff member downloads.
 *
 * The files currently here are designed placeholders, not photographs.
 * ---------------------------------------------------------------------------
 *
 * Images are served from our own origin, so the strict `img-src 'self'`
 * Content-Security-Policy stays intact. Do not point these at a CDN without
 * widening that directive.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** How long each slide is held, in milliseconds. */
const INTERVAL = 7000;

export const SLIDES = [
  {
    image: '/img/signin/slide-1.svg',
    title: 'One code per pack',
    body: 'Every unit leaves the line with a unique, non-sequential code - serialized here, verified in the patient’s hand.',
  },
  {
    image: '/img/signin/slide-2.svg',
    title: 'Copies surface themselves',
    body: 'A cloned code looks genuine exactly once. The moment a second person checks it, the duplicate is flagged and queued.',
  },
  {
    image: '/img/signin/slide-3.svg',
    title: 'A human closes the loop',
    body: 'Flags become work for the security team, never an automatic recall. Every decision is recorded in the audit log.',
  },
];

export default function SignInShowcase() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const panelRef = useRef(null);

  // Someone who has asked for reduced motion should not get a panel that
  // changes under them; they can still step through it by hand.
  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const go = useCallback((next) => {
    setIndex(((next % SLIDES.length) + SLIDES.length) % SLIDES.length);
  }, []);

  useEffect(() => {
    if (reducedMotion || paused) return undefined;
    const timer = setTimeout(() => go(index + 1), INTERVAL);
    return () => clearTimeout(timer);
  }, [index, paused, reducedMotion, go]);

  // Preload the next image so the crossfade has something to fade to.
  useEffect(() => {
    const next = new Image();
    next.src = SLIDES[(index + 1) % SLIDES.length].image;
  }, [index]);

  // Publish the interval to CSS so the progress bar fills in step with the
  // timer above, from one source of truth. Set through the CSSOM rather than
  // a style attribute, which the Content-Security-Policy forbids.
  useEffect(() => {
    panelRef.current?.style.setProperty('--slide-ms', `${INTERVAL}ms`);
  }, []);

  const slide = SLIDES[index];

  return (
    <aside
      className="showcase"
      ref={panelRef}
      aria-label="About QR Shield"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="showcase-stage">
        {SLIDES.map((s, i) => (
          <img
            key={s.image}
            className={`showcase-img${i === index ? ' on' : ''}`}
            src={s.image}
            alt=""
            aria-hidden="true"
            // Only the first slide blocks paint; the rest arrive lazily.
            loading={i === 0 ? 'eager' : 'lazy'}
            fetchPriority={i === 0 ? 'high' : 'low'}
            draggable="false"
          />
        ))}
        <div className="showcase-scrim" />
      </div>

      {/* aria-live so a screen reader hears the copy change rather than
          silently missing it. */}
      <div className="showcase-caption" aria-live="polite">
        <div className="showcase-progress" role="tablist" aria-label="Choose a slide">
          {SLIDES.map((s, i) => (
            <button
              key={s.image}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`Slide ${i + 1}: ${s.title}`}
              className={[
                'showcase-bar',
                i === index ? 'on' : '',
                i < index ? 'done' : '',
                i === index && !reducedMotion && !paused ? 'running' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => {
                setPaused(true);
                go(i);
              }}
            >
              <span className="showcase-bar-fill" />
            </button>
          ))}
        </div>

        <h2 className="showcase-title">{slide.title}</h2>
        <p className="showcase-body">{slide.body}</p>
      </div>
    </aside>
  );
}
