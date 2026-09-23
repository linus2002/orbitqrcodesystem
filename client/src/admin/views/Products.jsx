/**
 * Product catalogue and patient information leaflets.
 *
 * The SKU is immutable once created: it is embedded in every code already
 * printed on packs, so changing it would orphan them.
 */
import { useState } from 'react';

import { api } from '../../lib/api.js';
import { useApi, usePermission, useToast } from '../../lib/hooks.jsx';
import { fmtDate, fmtNumber } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { useDrawer } from '../components/Drawer.jsx';
import SpreadsheetTools from '../components/SpreadsheetTools.jsx';
import {
  TableCard, Table, Toolbar, Spacer, KV, Timeline, TimelineItem, StatusBadge, ErrorNote,
} from '../components/ui.jsx';

export default function Products() {
  const canWrite = usePermission('products:write');
  const drawer = useDrawer();
  const { data, error, loading, reload } = useApi('/api/admin/products');

  useHeader(
    'Products',
    'The catalogue. A product SKU becomes the first segment of every code issued for it.'
  );

  if (error) return <ErrorNote error={error} />;

  const count = data?.items?.length;

  return (
    <>
      {/*
        The actions sit above the table rather than in the page header strip.
        They act on the catalogue below them - importing a spreadsheet or
        adding a product changes these rows - so they belong beside it. In the
        header they shared a line with the shell's own controls (theme, sign
        out, the clock), which read as one undifferentiated row of buttons
        where only some had anything to do with the page.
      */}
      <Toolbar>
        {count !== undefined && (
          <span className="text-sm text-muted">
            {fmtNumber(count)} {count === 1 ? 'product' : 'products'}
          </span>
        )}
        <Spacer />
        <SpreadsheetTools entity="products" label="products" canWrite={canWrite} onImported={reload} />
        {canWrite && (
          <button className="btn btn-primary btn-sm" onClick={() => openNew(drawer, reload)}>
            New product
          </button>
        )}
      </Toolbar>

      <TableCard>
        <Table
          loading={loading}
          rows={data?.items}
          empty="No products yet."
          onRowClick={(row) => openProduct(row.id, drawer, reload, canWrite)}
          columns={[
            {
              label: 'Product',
              render: (r) => (
                <>
                  <strong>{r.name}</strong> {r.strength ?? ''}
                  <br />
                  <span className="text-muted text-sm">{r.generic_name ?? r.dosage_form ?? ''}</span>
                </>
              ),
            },
            { label: 'SKU', className: 'code', render: (r) => r.sku },
            { label: 'Manufacturer', render: (r) => r.manufacturer },
            { label: 'Batches', className: 'num', render: (r) => fmtNumber(r.batch_count) },
            { label: 'Codes', className: 'num', render: (r) => fmtNumber(r.code_count) },
            { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      </TableCard>
    </>
  );
}

async function openProduct(id, drawer, reload, canWrite) {
  const p = await api(`/api/admin/products/${id}`);
  drawer.open({
    title: p.name,
    subtitle: `${p.sku} - ${p.strength ?? ''}`,
    body: (
      <>
        <KV
          rows={[
            ['SKU', <span className="mono">{p.sku}</span>],
            ['Generic name', p.generic_name ?? '-'],
            ['Strength', p.strength ?? '-'],
            ['Form', p.dosage_form ?? '-'],
            ['Pack size', p.pack_size ?? '-'],
            ['Manufacturer', p.manufacturer],
            ['Category', p.category ?? '-'],
            ['Status', <StatusBadge status={p.status} />],
          ]}
        />

        <div>
          <h3 className="mb-8">Leaflets</h3>
          {p.leaflets.length ? (
            p.leaflets.map((l) => (
              <div className="tl-body" key={l.id}>
                v{l.version} ({l.language}){' '}
                <span className="meta">from {fmtDate(l.effective_from)}</span>
              </div>
            ))
          ) : (
            <p className="text-muted text-sm">
              No leaflet published. Patients will see no dosing information on a genuine result.
            </p>
          )}
          {canWrite && (
            <button
              className="btn btn-sm mt-8"
              onClick={() => openPublishLeaflet(p, drawer, reload)}
            >
              {p.leaflets.length ? 'Publish new version' : 'Publish leaflet'}
            </button>
          )}
        </div>

        <div>
          <h3 className="mb-8">Batches</h3>
          {p.batches.length ? (
            <Timeline>
              {p.batches.map((b) => (
                <TimelineItem
                  key={b.id}
                  tone={b.status === 'recalled' ? 'flagged' : 'genuine'}
                  title={
                    <>
                      <span className="mono">{b.batch_number}</span> <StatusBadge status={b.status} />
                    </>
                  }
                  meta={`${fmtNumber(b.quantity)} units · expires ${fmtDate(b.expiry_date)}`}
                />
              ))}
            </Timeline>
          ) : (
            <p className="text-muted text-sm">No batches yet.</p>
          )}
        </div>
      </>
    ),
  });
}

function openNew(drawer, reload) {
  drawer.open({
    title: 'New product',
    subtitle: 'The SKU cannot be changed once codes are issued',
    body: <NewProductForm drawer={drawer} reload={reload} />,
  });
}

const FIELDS = [
  { key: 'sku', label: 'SKU', max: 12, mono: true, placeholder: 'AMX25',
    hint: 'Letters and digits only, 2-12 characters. Becomes the first segment of every code.' },
  { key: 'name', label: 'Product name', max: 160, placeholder: 'Amoxicillin' },
  { key: 'genericName', label: 'Generic name', max: 160 },
  { key: 'strength', label: 'Strength', max: 60, placeholder: '250 mg' },
  { key: 'dosageForm', label: 'Dosage form', max: 60, placeholder: 'Capsule' },
  { key: 'packSize', label: 'Pack size', max: 60, placeholder: '21 capsules' },
  { key: 'manufacturer', label: 'Manufacturer', max: 160 },
  { key: 'category', label: 'Category', max: 60, placeholder: 'Antibiotic' },
];

function NewProductForm({ drawer, reload }) {
  const toast = useToast();
  const [form, setForm] = useState(Object.fromEntries(FIELDS.map((f) => [f.key, ''])));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, v.trim() || undefined])
      );
      await api('/api/admin/products', { method: 'POST', body });
      toast('Product created.', 'success');
      drawer.close();
      reload();
    } catch (err) {
      setError(err.formMessage);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {FIELDS.map((f) => (
        <div className="field" key={f.key}>
          <label className="label" htmlFor={`p-${f.key}`}>
            {f.label}
          </label>
          <input
            className={`input${f.mono ? ' mono' : ''}`}
            id={`p-${f.key}`}
            value={form[f.key]}
            onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
            maxLength={f.max}
            placeholder={f.placeholder}
            autoCapitalize={f.mono ? 'characters' : undefined}
            spellCheck={f.mono ? false : undefined}
          />
          {f.hint && <p className="hint">{f.hint}</p>}
        </div>
      ))}

      {error && <p className="field-error" role="alert">{error}</p>}

      <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
        {busy ? 'Creating...' : 'Create product'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Publishing a leaflet
//
// The endpoint this posts to has existed since the leaflet QR landed; until
// now nothing called it, so a leaflet could only be created by the seed. A
// leaflet QR printed for a medicine with no leaflet opens a page saying there
// is none, which is why the Leaflet QR screen counts those separately.
// ---------------------------------------------------------------------------

function openPublishLeaflet(product, drawer, reload) {
  drawer.open({
    title: `Publish a leaflet for ${product.name}`,
    subtitle: `${product.sku} - this becomes what the leaflet QR opens`,
    body: <PublishLeafletForm product={product} drawer={drawer} reload={reload} />,
  });
}

/** One empty section. Kept as a factory so each row gets its own object. */
const emptySection = () => ({ heading: '', body: '' });

function PublishLeafletForm({ product, drawer, reload }) {
  const toast = useToast();
  const [version, setVersion] = useState('');
  const [language, setLanguage] = useState('en');
  const [sections, setSections] = useState([emptySection()]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const setSection = (i, key, value) =>
    setSections((s) => s.map((row, n) => (n === i ? { ...row, [key]: value } : row)));

  async function submit(e) {
    e.preventDefault();
    setError(null);

    const cleaned = sections
      .map((s) => ({ heading: s.heading.trim(), body: s.body.trim() }))
      .filter((s) => s.heading || s.body);

    // Checked here as well as on the server: the server's message names the
    // fault but not which section, and a half-filled row is the likely slip.
    if (!cleaned.length) {
      setError('A leaflet needs at least one section.');
      return;
    }
    if (cleaned.some((s) => !s.heading || !s.body)) {
      setError('Every section needs both a heading and a body.');
      return;
    }

    setBusy(true);
    try {
      await api(`/api/admin/products/${product.id}/leaflets`, {
        method: 'POST',
        body: { version: version.trim(), language: language.trim() || 'en', sections: cleaned },
      });
      toast('Leaflet published.', 'success');
      drawer.close();
      reload();
    } catch (err) {
      setError(err.formMessage);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="field">
        <label className="label" htmlFor="lf-version">Version</label>
        <input
          className="input mono"
          id="lf-version"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          maxLength={20}
          placeholder="1.0"
          spellCheck={false}
        />
        <p className="hint">
          Your own reference for this revision. A product may not have two leaflets with the same
          version and language.
        </p>
      </div>

      <div className="field">
        <label className="label" htmlFor="lf-language">Language</label>
        <input
          className="input mono"
          id="lf-language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          maxLength={8}
          placeholder="en"
          spellCheck={false}
        />
        <p className="hint">
          A short language code. English is what the QR opens by default; any other code is reached
          only through a language link.
        </p>
      </div>

      <div className="field">
        <label className="label">Sections</label>
        <p className="hint mb-8">
          Each becomes one heading a patient can open. Write them in the order they should be read.
        </p>

        {sections.map((s, i) => (
          <div className="stack mb-8" key={i}>
            <input
              className="input"
              value={s.heading}
              onChange={(e) => setSection(i, 'heading', e.target.value)}
              maxLength={160}
              placeholder={i === 0 ? 'What this medicine is for' : 'Heading'}
              aria-label={`Section ${i + 1} heading`}
            />
            <textarea
              className="textarea"
              value={s.body}
              onChange={(e) => setSection(i, 'body', e.target.value)}
              placeholder="The text a patient reads under this heading."
              aria-label={`Section ${i + 1} body`}
            />
            {sections.length > 1 && (
              <button
                className="btn btn-sm btn-quiet"
                type="button"
                onClick={() => setSections((all) => all.filter((_, n) => n !== i))}
              >
                Remove this section
              </button>
            )}
          </div>
        ))}

        {sections.length < 40 && (
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => setSections((all) => [...all, emptySection()])}
          >
            Add a section
          </button>
        )}
      </div>

      <p className="hint">
        Publishing takes effect immediately: the leaflet QR already printed for this medicine points
        at a fixed address, so it will start opening this version. Existing versions are kept.
      </p>

      {error && <p className="field-error" role="alert">{error}</p>}

      <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
        {busy ? 'Publishing...' : 'Publish leaflet'}
      </button>
    </form>
  );
}
