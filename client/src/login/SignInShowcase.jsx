/**
 * The sign-in card's left half: a cluster of 3D tiles for what the system
 * does - a QR code under a sweeping scan line, verified scans, the shield,
 * a flagged pack, live scans - over captions that rotate.
 *
 * Everything is drawn in CSS and inline SVG in the app's own palette, so it
 * themes with the page and costs no image requests. Hidden on phones, where
 * it would only stand between the user and the form.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../components/Icons.jsx';

const SLIDES = [
  'Every pack verified at the scan',
  'Counterfeits flagged the moment they surface',
  'Recalls reach the next person to scan',
];

const SLIDE_MS = 4500;

/*
 * A 21 x 21 QR-like pattern: the three finder squares in their corners, and
 * modules from a fixed seed so the code looks the same on every load. It is
 * artwork, not a scannable code.
 */
const QR_PATH = (() => {
  const n = 21;
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const inFinder = (x, y) =>
    (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
  let d = '';
  const sq = (x, y, s = 1) => {
    d += `M${x} ${y}h${s}v${s}h-${s}z`;
  };
  for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 7; j++) {
        const ring = i === 0 || i === 6 || j === 0 || j === 6;
        const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        if (ring || core) sq(fx + i, fy + j);
      }
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!inFinder(x, y) && rand() < 0.5) sq(x, y);
    }
  }
  return d;
})();

export default function SignInShowcase() {
  const [slide, setSlide] = useState(0);

  useEffect(() => {
    // Captions hold still for anyone who has asked for less motion.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const timer = setTimeout(() => setSlide((s) => (s + 1) % SLIDES.length), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [slide]);

  return (
    <div className="showcase">
      <span className="showcase-glow one" aria-hidden="true" />
      <span className="showcase-glow two" aria-hidden="true" />

      <div className="showcase-art" aria-hidden="true">
        <div className="showcase-stage">
          {/* The float sits on its own wrapper: its transform would replace the tilt. */}
          <div className="tile-main-pos">
            <div className="float">
              <div className="tile-main">
                <div className="tile-main-plate">
                  <svg className="tile-qr" viewBox="0 0 21 21" shapeRendering="crispEdges">
                    <path d={QR_PATH} />
                  </svg>
                  <span className="tile-scanline" />
                </div>
              </div>
            </div>
          </div>

          <div className="float-slow tile-pos-bubble">
            <div className="tile-bubble">
              <Icon name="check" />
              12.4k
            </div>
          </div>

          <div className="float tile-pos-shield">
            <div className="tile-shield">
              <Icon name="shield" />
            </div>
          </div>

          <div className="float-slow tile-pos-chip">
            <div className="tile-chip">
              <span className="tile-ping" />
              36 live scans
            </div>
          </div>

          <div className="float tile-pos-alert">
            <div className="tile-alert">
              <Icon name="alert" />
            </div>
          </div>
        </div>
      </div>

      <div className="showcase-caption">
        <p className="showcase-text" aria-live="polite">
          {SLIDES[slide]}
        </p>
        <div className="showcase-dots">
          {SLIDES.map((text, i) => (
            <button
              key={text}
              type="button"
              onClick={() => setSlide(i)}
              aria-label={`Show slide ${i + 1}`}
              aria-current={i === slide}
            >
              <span className={i === slide ? 'on' : undefined} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
