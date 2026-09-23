/**
 * Leaflet QR codes - one per medicine.
 *
 * These are not the pack codes. A pack code is serialized and signed and
 * proves one particular unit is genuine; a leaflet code is an unsigned link to
 * that medicine's patient information, for a shelf talker, a poster or a
 * carton. The screen says so, because printing the wrong one is an expensive
 * mistake to discover after a print run.
 *
 * Two layouts, because two jobs bring people here. The grid shows the codes
 * themselves, which is what matters when you are checking one scans before a
 * print run. The table compares versions and dates down a column, which is
 * what matters across a long catalogue. The choice is remembered.
 *
 * Products with no published leaflet are shown rather than hidden - a QR
 * printed for one would take a patient to a dead end, so the gap has to be
 * visible here, where it can still be fixed.
 */
import { useEffect, useState } from 'react';

import { useApi } from '../../lib/hooks.jsx';
import { api, download } from '../../lib/api.js';
import { fmtDate } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { Icon } from '../../components/Icons.jsx';
import { TableCard, Table, ErrorNote, Loading, Toolbar, Spacer } from '../components/ui.jsx';

/*
 * Remembered per browser. Which layout suits depends on what the person does
 * here - four medicines and a printer wants the grid, two hundred and a
 * question about versions wants the table - and that does not change between
 * visits, so asking again every time would be noise.
 */
const VIEW_KEY = 'qrshield.leaflet-view';

function useRememberedView() {
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'grid';
    } catch {
      return 'grid'; // private windows and blocked storage
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* the choice simply will not persist; the screen still works */
    }
  }, [view]);

  return [view, setView];
}

export default function LeafletCodes() {
  const { data, error, loading } = useApi('/api/admin/leaflet-codes');
  const [preview, setPreview] = useState(null);
  const [view, setView] = useRememberedView();

  useHeader(
    'Leaflet QR codes',
    'One code per medicine, opening its patient information leaflet. These are not pack codes and make no claim that a pack is genuine.',
    <button className="btn btn-sm btn-quiet" onClick={() => printSheet()} disabled={loading}>
      <Icon name="qr" />
      Print sheet
    </button>,
    [loading]
  );

  if (error) return <ErrorNote error={error} />;
  if (loading) return <Loading message="Loading leaflet codes..." />;

  const items = data?.items ?? [];
  const missing = data?.missing ?? 0;

  if (!items.length) {
    return (
      <div className="card">
        <div className="empty">
          <Icon name="qr" />
          <p>No products yet. Add a product before printing leaflet codes.</p>
        </div>
      </div>
    );
  }

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

      <Toolbar>
        <span className="text-sm text-muted">
          {items.length} {items.length === 1 ? 'medicine' : 'medicines'}
        </span>
        <Spacer />
        <ViewToggle view={view} onChange={setView} />
      </Toolbar>

      {view === 'grid' ? (
        <div className="qr-grid">
          {items.map((row) => (
            <QrCard key={row.sku} row={row} onEnlarge={() => setPreview(row)} />
          ))}
        </div>
      ) : (
        <LeafletTable items={items} onEnlarge={setPreview} />
      )}

      {preview && <QrPreview row={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

/**
 * Grid or table.
 *
 * A radiogroup rather than two buttons: they are one choice with two states,
 * and a screen reader should say which is currently selected rather than
 * offering two commands that look unrelated.
 */
function ViewToggle({ view, onChange }) {
  return (
    <div className="view-toggle" role="radiogroup" aria-label="How to show the codes">
      {[
        { id: 'grid', icon: 'grid', label: 'Grid' },
        { id: 'table', icon: 'menu', label: 'Table' },
      ].map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={view === option.id}
          /* The label is carried by aria-label and title now that the text is
             gone: without it the control announces as an unnamed radio, and a
             pointer user gets no way to learn what the icon means. */
          aria-label={`${option.label} view`}
          title={`${option.label} view`}
          className={`view-toggle-option${view === option.id ? ' is-active' : ''}`}
          onClick={() => onChange(option.id)}
        >
          <Icon name={option.icon} />
        </button>
      ))}
    </div>
  );
}

/** The same rows as the grid, for comparing versions across a long catalogue. */
function LeafletTable({ items, onEnlarge }) {
  return (
    <TableCard>
      <Table
        rows={items}
        rowKey={(r) => r.sku}
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
                <button type="button" className="btn btn-sm btn-quiet" onClick={() => onEnlarge(r)}>
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
  );
}

function QrCard({ row, onEnlarge }) {
  return (
    <figure className={`qr-card${row.hasLeaflet ? '' : ' qr-card-gap'}`}>
      {/*
        The code is a button: the most likely next action on this screen is
        "make it bigger so I can scan it and check it works".

        `loading="lazy"` because each card fetches its own QR - a catalogue of
        two hundred medicines would otherwise open two hundred requests before
        showing anything.
      */}
      <button
        type="button"
        className="qr-card-code"
        onClick={onEnlarge}
        aria-label={`Enlarge the leaflet QR for ${row.name}`}
      >
        <img
          src={`/api/admin/leaflet-codes/${row.sku}.svg?width=200`}
          alt=""
          width="200"
          height="200"
          loading="lazy"
        />
      </button>

      <figcaption className="qr-card-body">
        <h3 className="qr-card-name">
          {row.name} {row.strength ?? ''}
        </h3>
        <p className="qr-card-meta">
          {row.sku}
          {row.dosage_form ? ` · ${row.dosage_form}` : ''}
        </p>

        {row.hasLeaflet ? (
          <p className="qr-card-meta">
            Leaflet v{row.leaflet_version} · since {fmtDate(row.effective_from)}
          </p>
        ) : (
          <p className="qr-card-meta">
            <span className="badge badge-warn">Not published</span>
          </p>
        )}
      </figcaption>

      <div className="qr-card-actions">
        <button
          type="button"
          className="btn btn-sm btn-quiet"
          onClick={() =>
            download(`/api/admin/leaflet-codes/${row.sku}.svg?download=1&width=512`, {
              filename: `leaflet-${row.sku}.svg`,
            })
          }
        >
          <Icon name="download" />
          SVG
        </button>
        <a className="btn btn-sm btn-quiet" href={row.url} target="_blank" rel="noreferrer">
          Open
        </a>
      </div>
    </figure>
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
