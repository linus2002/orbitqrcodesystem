/**
 * Shared dashboard presentation components.
 *
 * Note what is absent compared with the pre-React version: there is no
 * escaping helper. React escapes everything it renders, so a product name or
 * a free-text patient report can no longer reach the DOM as markup by
 * accident - which was the single largest risk in the old string-templated UI.
 */
import { fmtNumber, humanise } from '../../lib/format.js';
import { Link } from 'react-router-dom';

import { Icon } from '../../components/Icons.jsx';
import BrandLoader from '../../components/BrandLoader.jsx';

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export function Card({ title, actions, children, footer, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <h2>{title}</h2>
          <div className="row row-wrap">{actions}</div>
        </div>
      )}
      {children}
      {footer}
    </section>
  );
}

/**
 * A table with its heading ABOVE the card rather than inside it.
 *
 * A data table already has a header row of its own - a blue bar with the
 * column names - so a `Card` title sits awkwardly right on top of it, reading
 * as a second header for the same thing. Putting the heading outside leaves
 * the blue bar as the top edge of the card and the heading as a label for it.
 *
 * Same props as `Card`, so the two are interchangeable at a call site.
 */
export function TableCard({ title, actions, children, footer, className = '' }) {
  return (
    <section className={`table-section ${className}`}>
      {(title || actions) && (
        <div className="section-head">
          {title && <h2>{title}</h2>}
          <div className="row row-wrap">{actions}</div>
        </div>
      )}
      <div className="card">
        {children}
        {footer}
      </div>
    </section>
  );
}

export function Toolbar({ children }) {
  return <div className="toolbar">{children}</div>;
}

export const Spacer = () => <span className="spacer" />;

export function Loading({ message = 'Loading...' }) {
  return (
    <div className="empty">
      <BrandLoader size="sm" message={message} />
    </div>
  );
}

export function Empty({ message = 'Nothing to show yet.' }) {
  return (
    <div className="empty">
      <Icon name="empty" />
      <p>{message}</p>
    </div>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div className="alert alert-error">
      <Icon name="alert" />
      <span>{error.message}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

/**
 * @param {object} props
 * @param {Array<{
 *   label: string,
 *   value: React.ReactNode,
 *   meta?: React.ReactNode,
 *   change?: number|null,        percentage against the previous period
 *   changeGood?: 'up'|'down',    which direction is the good news
 *   to?: string,                 where the corner arrow goes
 *   tone?: 'blue'|'red'|'violet'|'green'   which gradient the card carries
 * }>} props.items
 */
export function Tiles({ items }) {
  return (
    <div className="tiles">
      {items.filter(Boolean).map((t) => (
        <Tile key={t.label} {...t} />
      ))}
    </div>
  );
}

function Tile({ label, value, meta, change, changeGood = 'up', to, tone = 'blue' }) {
  const hasChange = typeof change === 'number' && Number.isFinite(change);
  const rising = hasChange && change > 0;
  /*
   * Which direction counts as good is per-metric, not universal: more checks
   * is reassuring, more flagged packs is not. Without this the same green
   * arrow would congratulate somebody on a rise in counterfeits.
   */
  const welcome = hasChange && (rising ? changeGood === 'up' : changeGood === 'down');

  return (
    <div className={`tile tone-${tone}`}>
      {/*
        The shape sits behind the content as a lighter facet of the same
        gradient, the way the reference does. Decorative, so it is hidden from
        assistive tech and never carries meaning on its own.
      */}
      <span className="tile-shape" aria-hidden="true" />

      <div className="tile-top">
        <span className="k">{label}</span>
        {to && (
          <Link className="tile-link" to={to} aria-label={`Open ${label}`}>
            <Icon name="arrow-right" />
          </Link>
        )}
      </div>

      <div className="tile-figure">
        <div className="tile-value-row">
          <span className="v">{value}</span>
          {hasChange && change !== 0 && (
            <span className={`tile-change${welcome ? ' is-good' : ' is-bad'}`}>
              {rising ? '↗' : '↘'} {rising ? '+' : ''}
              {change}%
            </span>
          )}
        </div>
        {meta && <div className="m">{meta}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * @param {object} props
 * @param {Array}  props.columns  [{ key, label, render?, className? }]
 * @param {Array}  props.rows
 * @param {Function} [props.onRowClick]
 * @param {Function} [props.rowKey] defaults to row.id
 */
export function Table({ columns, rows, onRowClick, rowKey, empty, loading }) {
  if (loading) return <Loading />;
  if (!rows?.length) return <Empty message={empty} />;

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={c.className}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={rowKey ? rowKey(row) : (row.id ?? i)}
              className={onRowClick ? 'clickable' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td key={c.label} className={c.className}>
                  {c.render ? c.render(row) : (row[c.key] ?? '-')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="pager">
      <span>
        {fmtNumber(from)}-{fmtNumber(to)} of {fmtNumber(total)}
      </span>
      <span className="btns">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges
//
// Every badge carries an icon or a word as well as colour. Status is never
// communicated by colour alone.
// ---------------------------------------------------------------------------

const RESULT_BADGE = {
  genuine: ['badge-good', 'check', 'Genuine'],
  flagged: ['badge-danger', 'alert', 'Flagged'],
  invalid: ['badge-warn', 'alert', 'Invalid'],
};

export function ResultBadge({ result }) {
  const [cls, icon, label] = RESULT_BADGE[result] ?? ['badge-neutral', 'alert', result];
  return (
    <span className={`badge ${cls}`}>
      <Icon name={icon} />
      {label}
    </span>
  );
}

const SEVERITY_CLASS = {
  critical: 'badge-danger',
  high: 'badge-danger',
  medium: 'badge-warn',
  low: 'badge-neutral',
};

export function SeverityBadge({ severity }) {
  return <span className={`badge ${SEVERITY_CLASS[severity] ?? 'badge-neutral'}`}>{severity}</span>;
}

const STATUS_CLASS = {
  open: 'badge-danger',
  investigating: 'badge-warn',
  resolved: 'badge-good',
  dismissed: 'badge-neutral',
  new: 'badge-danger',
  reviewing: 'badge-warn',
  closed: 'badge-neutral',
  active: 'badge-good',
  suspended: 'badge-neutral',
  planned: 'badge-neutral',
  codes_issued: 'badge-info',
  printed: 'badge-info',
  released: 'badge-good',
  distributed: 'badge-good',
  recalled: 'badge-danger',
  verified: 'badge-good',
  issued: 'badge-neutral',
  void: 'badge-neutral',
  in_transit: 'badge-warn',
  received: 'badge-good',
  disputed: 'badge-danger',
};

export function StatusBadge({ status }) {
  return (
    <span className={`badge ${STATUS_CLASS[status] ?? 'badge-neutral'}`}>{humanise(status)}</span>
  );
}

// ---------------------------------------------------------------------------
// Definition list, used inside drawers
// ---------------------------------------------------------------------------

/** @param {{rows: Array<[string, React.ReactNode]|false|null>}} props */
export function KV({ rows }) {
  return (
    <dl className="kv">
      {rows.filter(Boolean).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? '-'}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Timeline, used for scan and alert history
// ---------------------------------------------------------------------------

export function Timeline({ children }) {
  return <div className="timeline">{children}</div>;
}

export function TimelineItem({ tone = 'genuine', title, meta }) {
  return (
    <div className="tl-item">
      <span className={`tl-dot ${tone}`} />
      <div className="tl-body">
        <b>{title}</b>
        {meta && <div className="meta">{meta}</div>}
      </div>
    </div>
  );
}

/** A select bound to a piece of filter state. */
export function Select({ label, value, onChange, options, allLabel }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {allLabel && <option value="">{allLabel}</option>}
      {options.map((o) => {
        const val = typeof o === 'string' ? o : o.value;
        const text = typeof o === 'string' ? humanise(o) : o.label;
        return (
          <option value={val} key={val}>
            {text}
          </option>
        );
      })}
    </select>
  );
}
