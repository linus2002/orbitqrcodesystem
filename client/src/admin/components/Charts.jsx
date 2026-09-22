/**
 * Dashboard charts, as React components rendering plain SVG.
 *
 * COLOUR DECISION: the two series are BLUE (genuine) and RED (flagged), not
 * green and red. Green vs red measures a colour-vision-deficiency separation
 * of only ~4 Delta E under deuteranopia - effectively identical for roughly 1
 * in 12 men, which is unacceptable for the one chart a security analyst reads
 * every morning. Blue vs red measures ~24-26 and passes every contrast and CVD
 * check in both light and dark mode. Series are also labelled in the legend
 * and the tooltip, so identity never rests on colour alone.
 *
 * Geometry uses SVG presentation ATTRIBUTES (x/y/width/height/fill), which
 * React passes straight through. No inline style attributes are used, because
 * the Content-Security-Policy forbids them.
 */
import { useEffect, useRef, useState } from 'react';
import { fmtNumber } from '../../lib/format.js';

/** Read a themed colour so the SVG matches the active light/dark palette. */
function useThemeColor(name, fallback) {
  const [color, setColor] = useState(fallback);
  useEffect(() => {
    const read = () =>
      setColor(
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
      );
    read();
    // Re-read when the theme attribute flips or the OS preference changes.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', read);
    return () => {
      observer.disconnect();
      mq.removeEventListener('change', read);
    };
  }, [name, fallback]);
  return color;
}

/** Choose a gridline step that produces round numbers. */
function niceStep(max) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= mag * m) return Math.max(1, mag * m);
  return mag * 10;
}

/**
 * Stacked daily bar chart of verification volume.
 *
 * Form choice: the question is "how much traffic per day, and how much of it
 * was suspicious". That is magnitude plus composition over an ordered axis, so
 * stacked bars beat a line - a line would imply values between days that do
 * not exist.
 *
 * @param {{series: Array<{day,genuine,flagged}>}} props
 */
export function TrendChart({ series }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);

  const colGenuine = useThemeColor('--series-genuine', '#2a78d6');
  const colFlagged = useThemeColor('--series-flagged', '#d03b3b');
  const colGrid = useThemeColor('--grid', '#e8edf3');
  const colAxis = useThemeColor('--ink-muted', '#6b7a8d');
  const colBaseline = useThemeColor('--axis', '#c3ccd8');

  if (!series?.length) return <Empty />;

  const W = 760;
  const H = 230;
  const PAD = { top: 14, right: 12, bottom: 26, left: 40 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const max = Math.max(1, ...series.map((d) => d.genuine + d.flagged));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v) => PAD.top + plotH - (v / top) * plotH;

  const slot = plotW / series.length;
  const barW = Math.max(4, Math.min(28, slot - 6));

  const gridValues = [];
  for (let v = 0; v <= top; v += step) gridValues.push(v);

  // Label only the first, middle and last day, to avoid collisions.
  const labelIdx = new Set([0, Math.floor(series.length / 2), series.length - 1]);

  const totalGenuine = series.reduce((a, d) => a + d.genuine, 0);
  const totalFlagged = series.reduce((a, d) => a + d.flagged, 0);

  return (
    <>
      <div className="chart-wrap" ref={wrapRef}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Daily verification volume over ${series.length} days. ${fmtNumber(
            totalGenuine
          )} genuine and ${fmtNumber(totalFlagged)} flagged checks.`}
        >
          {gridValues.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={colGrid} strokeWidth="1" />
              <text
                x={PAD.left - 8}
                y={y(v) + 4}
                textAnchor="end"
                fill={colAxis}
                fontSize="11"
                fontFamily="inherit"
              >
                {fmtNumber(v)}
              </text>
            </g>
          ))}

          {series.map((d, i) => {
            const total = d.genuine + d.flagged;
            if (total === 0) return null;
            const x = PAD.left + slot * i + slot / 2 - barW / 2;
            const hGen = (d.genuine / top) * plotH;
            const hFlag = (d.flagged / top) * plotH;
            return (
              <g key={d.day}>
                {d.genuine > 0 && (
                  <rect
                    x={x}
                    y={y(d.genuine)}
                    width={barW}
                    height={Math.max(1, hGen)}
                    fill={colGenuine}
                    rx={d.flagged > 0 ? 0 : 3}
                  />
                )}
                {d.flagged > 0 && (
                  // Flagged sits on top of genuine, so the suspicious portion
                  // is always at the eye-line top of the bar. The 2px gap keeps
                  // the segments distinct even when flagged is a pixel tall.
                  <rect
                    x={x}
                    y={y(total)}
                    width={barW}
                    height={Math.max(1, hFlag - 2)}
                    fill={colFlagged}
                    rx="3"
                  />
                )}
              </g>
            );
          })}

          {series.map((d, i) =>
            labelIdx.has(i) ? (
              <text
                key={`l-${d.day}`}
                x={PAD.left + slot * i + slot / 2}
                y={H - 8}
                textAnchor="middle"
                fill={colAxis}
                fontSize="11"
                fontFamily="inherit"
              >
                {new Date(`${d.day}T00:00:00Z`).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                })}
              </text>
            ) : null
          )}

          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(0)}
            y2={y(0)}
            stroke={colBaseline}
            strokeWidth="1"
          />

          {/* Full-height hit targets: much easier to hit than a short bar. */}
          {series.map((d, i) => (
            <rect
              key={`h-${d.day}`}
              x={PAD.left + slot * i}
              y={PAD.top}
              width={slot}
              height={plotH}
              fill="transparent"
              onMouseEnter={() =>
                setHover({ day: d, left: ((PAD.left + slot * i + slot / 2) / W) * 100 })
              }
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>

        {hover && <Tooltip hover={hover} colGenuine={colGenuine} colFlagged={colFlagged} />}
      </div>

      <div className="legend">
        <span>
          <Swatch color={colGenuine} />
          Genuine
        </span>
        <span>
          <Swatch color={colFlagged} />
          Flagged
        </span>
      </div>
    </>
  );
}

/** Colour swatches are set through the CSSOM, which the CSP permits. */
function Swatch({ color, size = 11 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.style.background = color;
  }, [color]);
  return <i ref={ref} />;
}

function Tooltip({ hover, colGenuine, colFlagged }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const parentWidth = node.parentElement?.clientWidth ?? 0;
    const left = (hover.left / 100) * parentWidth;
    node.style.left = `${Math.min(Math.max(left - 64, 8), Math.max(8, parentWidth - 150))}px`;
    node.style.top = '18px';
  }, [hover]);

  const d = hover.day;
  return (
    <div className="chart-tip on" ref={ref}>
      <b>
        {new Date(`${d.day}T00:00:00Z`).toLocaleDateString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        })}
      </b>
      <div className="tr">
        <Swatch color={colGenuine} />
        <span>Genuine</span>
        <strong>{fmtNumber(d.genuine)}</strong>
      </div>
      <div className="tr">
        <Swatch color={colFlagged} />
        <span>Flagged</span>
        <strong>{fmtNumber(d.flagged)}</strong>
      </div>
    </div>
  );
}

/**
 * Ranked horizontal bar list, used for "where are flags clustering".
 * A ranked list of places is a magnitude comparison against labels, which
 * horizontal bars handle better than a map would at this data volume.
 *
 * @param {{rows: Array<{label,total,flagged}>}} props
 */
export function BarList({ rows }) {
  const colGenuine = useThemeColor('--series-genuine', '#2a78d6');
  const colFlagged = useThemeColor('--series-flagged', '#d03b3b');

  if (!rows?.length) {
    return (
      <div className="card-body">
        <p className="text-muted text-sm">No location data recorded yet.</p>
      </div>
    );
  }

  const max = Math.max(...rows.map((r) => r.total), 1);

  return (
    <div className="card-body">
      {rows.map((r) => (
        <div className="bl-row" key={r.label}>
          <div className="bl-label">{r.label}</div>
          <div className="bl-track">
            <Segment width={((r.total - r.flagged) / max) * 100} color={colGenuine} />
            <Segment width={(r.flagged / max) * 100} color={colFlagged} />
          </div>
          <div className="bl-value">
            {fmtNumber(r.total)}
            {r.flagged > 0 && <span className="bl-flag">{fmtNumber(r.flagged)} flagged</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Segment({ width, color }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.style.width = `${Math.max(0, width)}%`;
    ref.current.style.background = color;
  }, [width, color]);
  return <div className="bl-seg" ref={ref} />;
}

function Empty() {
  return (
    <div className="card-body">
      <p className="text-muted text-sm">Not enough data yet to draw a trend.</p>
    </div>
  );
}
