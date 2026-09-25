/**
 * The rotating panel beside the sign-in form.
 *
 * Each slide is one capability of the system, in the order a pack actually
 * travels: serialized on the line, checked by a patient, cloned and caught,
 * investigated by a person, accounted for to a regulator. Somebody evaluating
 * the system sees what it does; somebody signing in every morning sees why
 * their work matters. The same five slides serve both.
 *
 * ---------------------------------------------------------------------------
 * PHOTOGRAPHY
 *
 * Every slide is written around a person, because the subject of each one is a
 * person doing something - not a screenshot of software. A brief sits above
 * each slide below.
 *
 * Shooting notes that apply to all five:
 *
 *   - Real people in real settings. Stock photography of models in unbranded
 *     lab coats reads as stock, and this system's whole claim is that it is in
 *     use in actual pharmacies and actual production lines.
 *   - Portrait or landscape both work; the panel uses object-fit: cover, so
 *     keep the subject off-centre-left, away from where the text sits.
 *   - Roughly 1200x1500 or larger, under a few hundred KB each. This is the
 *     first thing anybody downloads on the sign-in page.
 *   - No readable patient details, no identifiable prescriptions, no real
 *     codes on a pack that could be photographed and reused.
 *   - Written consent from anybody recognisable, including staff.
 *
 * Drop the files into `client/public/img/signin/` and point `image` at them.
 * The files currently there are designed placeholders, not photographs.
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
    /* PHOTO: a packaging operator in gowning inspecting a coded carton, with
     the line running behind her. Serialization happens at manufacture, not
     in an office afterwards. */
    image: '/img/signin/slide-1.jpg',
    title: 'Serialized at the line',
    body: 'Every pack leaves production with its own signed, non-sequential code. Batches of up to 500,000 units are issued and exported for the printer in one step.',
  },
  {
    /* PHOTO: a woman at a kitchen table, phone raised to the code on a
     medicine box. Ordinary clothes, ordinary room - deliberately not a
     clinician, because this slide is about the person the system is for. */
    image: '/img/signin/slide-2.jpg',
    title: 'Anyone can check a pack',
    body: 'A patient scans the code and gets a plain answer in seconds - no app, no account, no sign-up. Where there is no data signal, the same check works over SMS.',
  },
  {
    /* PHOTO: two hands holding two identical-looking packs at a pharmacy
     counter. You cannot tell which is the copy by looking, which is the
     entire argument this slide makes. */
    image: '/img/signin/slide-3.jpg',
    title: 'Copies surface themselves',
    body: 'A cloned code passes exactly once. The second time anyone checks it, in any pharmacy or any city, the duplicate is flagged and an alert is raised.',
  },
  {
    /* PHOTO: an analyst on the phone mid-decision, pen in hand, screen out of
     focus behind her. The subject is the judgement, not the dashboard. */
    image: '/img/signin/slide-4.jpg',
    title: 'A person decides, not a rule',
    body: 'Flags become work for the security team, never an automatic recall. Every decision, and who made it, is written to an append-only audit log.',
  },
  {
    /* PHOTO: a quality lead working through a printed binder. Paper matters
     here: this slide is about what you can hand to an inspector. */
    image: '/img/signin/slide-5.jpg',
    title: 'Evidence for the regulator',
    body: 'Every scan, alert and batch transition is retained and exportable. A recall reaches the next person to scan the pack, and the record shows exactly who was told what, and when.',
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
      aria-label="About Getmeds"
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
