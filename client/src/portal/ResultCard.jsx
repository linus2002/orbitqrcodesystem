/**
 * The verification answer.
 *
 * Three presentations, and the distinction between them is a safety decision,
 * not a styling one:
 *
 *   genuine  green   - the pack checks out
 *   flagged  red     - do not use this pack
 *   invalid  amber   - you probably mistyped; this is NOT a counterfeit warning
 *
 * The leaflet is rendered only for a genuine result. The server already
 * withholds it otherwise, and this component does not attempt to show one
 * either: putting official dosing instructions next to a counterfeit warning
 * would be actively dangerous.
 */
import { useState } from 'react';
import { fmtDate } from '../lib/format.js';
import { Icon } from '../components/Icons.jsx';
import ReportForm from './ReportForm.jsx';

const PRESENTATION = {
  genuine: { cls: 'banner-genuine', icon: 'check', heading: 'Genuine' },
  flagged: { cls: 'banner-flagged', icon: 'alert', heading: 'Do not use this pack' },
  invalid: { cls: 'banner-invalid', icon: 'help', heading: 'Check the code' },
};

export default function ResultCard({ result, onCheckAnother }) {
  const [reporting, setReporting] = useState(false);
  const presentation = PRESENTATION[result.result] ?? PRESENTATION.invalid;
  const genuine = result.result === 'genuine';

  return (
    <article className="card result-card">
      <div className={`result-banner ${presentation.cls}`}>
        <Icon name={presentation.icon} />
        <div>
          <h2>{presentation.heading}</h2>
          <p>{result.message}</p>
        </div>
      </div>

      {result.product && <Details result={result} />}

      {genuine && result.leaflet && <Leaflet leaflet={result.leaflet} />}

      <div className="card-body">
        {genuine && result.batch?.expiringSoon && (
          <div className="alert alert-warn mt-16">
            <Icon name="alert" />
            <span>
              This pack expires on <strong>{fmtDate(result.batch.expiryDate)}</strong> - in{' '}
              {result.batch.daysToExpiry} days. Check with your pharmacist before starting a long
              course.
            </span>
          </div>
        )}

        {!genuine && (
          <p className="text-sm text-muted mb-8">
            Keep the pack and its packaging. Reporting it helps the manufacturer trace where it came
            from.
          </p>
        )}

        <div className="stack-sm mt-8">
          <button
            className={`btn ${genuine ? '' : 'btn-danger'} btn-block`}
            type="button"
            onClick={() => setReporting(true)}
          >
            <Icon name="flag" />
            Report a problem with this pack
          </button>
          <button className="btn btn-ghost btn-block" type="button" onClick={onCheckAnother}>
            Check another pack
          </button>
        </div>
      </div>

      {reporting && <ReportForm result={result} />}
    </article>
  );
}

/** The factual rows: what the pack is, when it expires, how it was checked. */
function Details({ result }) {
  const { product, batch } = result;

  const rows = [
    ['Product', `${product.name}${product.strength ? ` ${product.strength}` : ''}`],
    product.dosageForm && ['Form', product.dosageForm],
    product.packSize && ['Pack size', product.packSize],
    ['Manufacturer', product.manufacturer],
    ['Batch', <span className="mono">{batch.number}</span>],
    [
      'Expires',
      <>
        {fmtDate(batch.expiryDate)}
        {batch.isExpired && <strong> (expired)</strong>}
      </>,
    ],
    result.code && ['Code', <span className="mono">{result.code}</span>],
    result.result === 'genuine' &&
      result.scanNumber && [
        'Verification',
        result.scanNumber === 1 ? 'First check of this pack' : `Check number ${result.scanNumber}`,
      ],
    result.result === 'flagged' &&
      result.firstVerifiedAt && [
        'First verified',
        fmtDate(result.firstVerifiedAt, { withTime: true }),
      ],
    batch.recallReason && ['Recall reason', batch.recallReason],
  ].filter(Boolean);

  return (
    <dl className="detail-list">
      {rows.map(([label, value]) => (
        <div className="detail-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The patient information leaflet, collapsed by section. */
function Leaflet({ leaflet }) {
  const [open, setOpen] = useState(0);

  if (!leaflet?.sections?.length) return null;

  return (
    <div className="leaflet">
      <div className="card-head">
        <h3>Patient information leaflet</h3>
        <span className="badge badge-neutral">v{leaflet.version}</span>
      </div>
      {leaflet.sections.map((section, i) => (
        <div className="leaflet-section" key={`${section.heading}-${i}`}>
          <button
            className="leaflet-toggle"
            type="button"
            aria-expanded={open === i}
            aria-controls={`leaflet-body-${i}`}
            onClick={() => setOpen(open === i ? -1 : i)}
          >
            <span>{section.heading}</span>
            <Icon name="chevron" />
          </button>
          {open === i && (
            <div className="leaflet-body" id={`leaflet-body-${i}`}>
              {section.body}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
