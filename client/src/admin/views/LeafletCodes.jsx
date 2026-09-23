/**
 * Leaflet QR codes - one per medicine.
 *
 * These are not the pack codes. A pack code is serialized and signed and
 * proves one particular unit is genuine; a leaflet code is an unsigned link to
 * that medicine's patient information, for a shelf talker, a poster or a
 * carton. The screen says so, because printing the wrong one is an expensive
 * mistake to discover after a print run.
 *
 * Products with no published leaflet are listed rather than hidden: a QR
 * printed for one of them would take a patient to a dead end, so the gap has
 * to be visible here, where it can still be fixed.
 */
import { useState } from 'react';

import { useApi, usePermission } from '../../lib/hooks.jsx';
import { api, download } from '../../lib/api.js';
import { fmtDate } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { Icon } from '../../components/Icons.jsx';
import { TableCard, Table, ErrorNote } from '../components/ui.jsx';

export default function LeafletCodes() {
  const canWrite = usePermission('products:write');
  const { data, error, loading } = useApi('/api/admin/leaflet-codes');
  const [preview, setPreview] = useState(null);

  useHeader(
    'Leaflet QR codes',
    'One code per medicine, opening its patient information leaflet. These are not pack codes and make no claim that a pack is genuine.',
    <button className="btn btn-sm" onClick={() => printSheet()} disabled={loading}>
      <Icon name="qr" />
      Print sheet
    </button>,
    [loading]
  );

  if (error) return <ErrorNote error={error} />;

  const missing = data?.missing ?? 0;

  return (
    <>
      {missing > 0 && (
        <div className="alert alert-warn">
          <Icon name="alert" />
          <span>
            {missing} {missing === 1 ? 'medicine has' : 'medicines have'} no published leaflet. A
            QR printed for {missing === 1 ? 'it' : 'them'} would open a page saying so - publish
            the leaflet first.
          </span>
        </div>
      )}

      <TableCard>
        <Table
          loading={loading}
          rows={data?.items}
          rowKey={(r) => r.sku}
          empty="No products yet. Add a product before printing leaflet codes."
          columns={[
            {
              label: 'Medicine',
              render: (r) => (
                <>
                  <strong>{r.name}</strong> {r.strength ?? ''}
                  <br />
                  <span className="text-muted text-sm">
                    {r.sku}
                    {r.dosage_form ? ` · ${r.dosage_form}` : ''}
                  </span>
                </>
              ),
            },
            {
              label: 'Leaflet',
              render: (r) =>
                r.hasLeaflet ? (
                  <>
                    v{r.leaflet_version}
                    <br />
                    <span className="text-muted text-sm">
                      since {fmtDate(r.effective_from)}
                      {r.leaflet_versions > 1 ? ` · ${r.leaflet_versions} versions` : ''}
                    </span>
                  </>
                ) : (
                  <span className="badge badge-warn">Not published</span>
                ),
            },
            {
              label: 'Opens',
              render: (r) => (
                <a href={r.url} target="_blank" rel="noreferrer" className="text-sm">
                  {r.url.replace(/^https?:\/\//, '')}
                </a>
              ),
            },
            {
              label: 'QR',
              render: (r) => (
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-sm btn-quiet"
                    onClick={() => setPreview(r)}
                  >
                    View
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-quiet"
                    onClick={() =>
                      download(`/api/admin/leaflet-codes/${r.sku}.svg?download=1&width=512`, {
                        filename: `leaflet-${r.sku}.svg`,
                      })
                    }
                  >
                    <Icon name="download" />
                    SVG
                  </button>
                </div>
              ),
            },
          ]}
        />
      </TableCard>

      {preview && <QrPreview row={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

/** The QR at a size somebody can actually scan from the screen to test it. */
function QrPreview({ row, onClose }) {
  return (
    <div className="import-review" role="dialog" aria-label={`Leaflet QR for ${row.name}`}>
      <div className="import-review-panel qr-preview">
        <h3>
          {row.name} {row.strength ?? ''}
        </h3>
        <p className="text-sm text-muted">{row.sku}</p>

        {/*
          Rendered from the endpoint rather than drawn here, so what is shown
          is exactly what downloads and what prints - one generator, not two.
        */}
        <img
          className="qr-preview-image mt-16"
          src={`/api/admin/leaflet-codes/${row.sku}.svg?width=320`}
          alt={`QR code opening the leaflet for ${row.name}`}
          width="320"
          height="320"
        />

        <p className="text-sm text-muted mt-8">{row.url}</p>

        {!row.hasLeaflet && (
          <div className="alert alert-warn mt-8">
            <Icon name="alert" />
            <span>This medicine has no published leaflet, so this code opens a dead end.</span>
          </div>
        )}

        <div className="row row-between mt-16">
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
          <a className="btn btn-sm btn-primary" href={row.url} target="_blank" rel="noreferrer">
            Open the leaflet
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * Open a print-ready sheet in a new window.
 *
 * Built as a standalone document rather than a styled region of the dashboard:
 * a print sheet that inherits the app's stylesheet picks up its sidebar, its
 * theme and its font loading, none of which belong on a sheet of labels.
 */
async function printSheet() {
  const { items } = await api('/api/admin/leaflet-codes/sheet');
  const win = window.open('', '_blank');
  if (!win) return;

  const cards = items
    .map(
      (i) => `
      <figure class="cell">
        <img src="${i.qr}" alt="">
        <figcaption>
          <strong>${escapeHtml(i.name)}</strong>${i.strength ? ` ${escapeHtml(i.strength)}` : ''}
          <span>${escapeHtml(i.sku)} · leaflet v${escapeHtml(i.version)}</span>
        </figcaption>
      </figure>`
    )
    .join('');

  win.document.write(`<!doctype html><html><head><meta charset="utf-8">
    <title>Leaflet QR codes</title>
    <style>
      body { font: 13px/1.4 system-ui, sans-serif; margin: 18mm; color: #111; }
      h1 { font-size: 16px; margin: 0 0 14px; }
      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14mm 10mm; }
      .cell { margin: 0; text-align: center; break-inside: avoid; }
      .cell img { width: 34mm; height: 34mm; }
      figcaption { margin-top: 4px; }
      figcaption span { display: block; color: #555; font-size: 11px; }
    </style></head><body>
    <h1>Leaflet QR codes — ${items.length} ${items.length === 1 ? 'medicine' : 'medicines'}</h1>
    <div class="grid">${cards}</div>
    </body></html>`);
  win.document.close();
}

/** Product names reach this through a document.write, so they are escaped. */
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
