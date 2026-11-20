/**
 * Product catalogue and patient information leaflets.
 *
 * The SKU is immutable once created: it is embedded in every code already
 * printed on packs, so changing it would orphan them.
 */
import { useState } from 'react';

import { api, upload } from '../../lib/api.js';
import { useApi, useDebounced, usePermission, useToast } from '../../lib/hooks.jsx';
import { fmtDate, fmtNumber } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { useDrawer } from '../components/Drawer.jsx';
import { useViewer } from '../components/FileViewer.jsx';
import { QrZipButtons, openCodeQr } from '../components/CodeDownloads.jsx';
import SpreadsheetTools from '../components/SpreadsheetTools.jsx';
import { Icon } from '../../components/Icons.jsx';
import {
  TableCard, Table, Toolbar, Spacer, KV, StatusBadge, ErrorNote, Pager,
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
      <TableCard
        toolbar={
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
        }>
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
            {
              label: 'Actions',
              render: (r) => (
                <button
                  type="button"
                  className="btn-pill"
                  onClick={(e) => {
                    // The row opens the product too; one open is enough.
                    e.stopPropagation();
                    openProduct(r.id, drawer, reload, canWrite);
                  }}
                >
                  View
                </button>
              ),
            },
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
    subtitle: [p.strength, p.dosage_form].filter(Boolean).join(' · ') || p.sku,
    body: <ProductPanel product={p} canWrite={canWrite} drawer={drawer} reload={reload} />,
  });
}

const plural = (n, one, many = `${one}s`) => `${fmtNumber(n)} ${n === 1 ? one : many}`;

/**
 * One product, at a glance: its picture and identity, its specification as
 * an icon grid, three counts, then its leaflet and its batches - each batch
 * one row, with its codes' actions as icons (named on hover and to screen
 * readers). What used to be paragraphs of explanation is a hover on the (i).
 */
function ProductPanel({ product: p, canWrite, drawer, reload }) {
  const codes = p.batches.reduce((n, b) => n + (b.codes_issued || 0), 0);
  const latest = p.leaflets[0];
  const specs = [
    ['pill', 'Generic name', p.generic_name],
    ['activity', 'Strength', p.strength],
    ['box', 'Form', p.dosage_form],
    ['layers', 'Pack size', p.pack_size],
    ['building', 'Manufacturer', p.manufacturer],
    ['tag', 'Category', p.category],
  ].filter(([, , v]) => v);

  return (
    <div className="pp">
      <div className="pp-hero">
        <ProductImage product={p} canWrite={canWrite} reload={reload} />
        <div className="pp-id">
          <span className="pp-sku mono" title="SKU - the first part of every code for this product">
            {p.sku}
          </span>
          <div className="row row-wrap">
            <StatusBadge status={p.status} />
            {p.category && <span className="pp-chip">{p.category}</span>}
          </div>
        </div>
      </div>

      <dl className="pp-specs">
        {specs.map(([icon, label, value]) => (
          <div key={label}>
            <dt>
              <Icon name={icon} />
              {label}
            </dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <div className="pp-stats">
        <div>
          <Icon name="box" />
          <strong>{fmtNumber(p.batches.length)}</strong>
          <span>{p.batches.length === 1 ? 'batch' : 'batches'}</span>
        </div>
        <div>
          <Icon name="qr" />
          <strong>{fmtNumber(codes)}</strong>
          <span>{codes === 1 ? 'pack code' : 'pack codes'}</span>
        </div>
        <div className={latest ? undefined : 'is-warn'}>
          <Icon name={latest ? 'log' : 'alert'} />
          <strong>{latest ? `v${latest.version}` : 'None'}</strong>
          <span>leaflet</span>
        </div>
      </div>

      <section className="pp-section">
        <header>
          <h3>
            <Icon name="log" /> Leaflet
          </h3>
          {canWrite && (
            <div className="pp-actions">
              <button
                type="button"
                className="btn btn-sm btn-quiet"
                onClick={() => openPublishLeaflet(p, drawer, reload)}
                title={p.leaflets.length ? 'Publish a new version' : 'Publish a leaflet'}
              >
                <Icon name="upload" /> {p.leaflets.length ? 'New version' : 'Publish'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-quiet pp-icon"
                onClick={() => openUseLeaflet(p, drawer, reload)}
                title="Use another product's leaflet"
                aria-label="Use another product's leaflet"
              >
                <Icon name="copy" />
              </button>
            </div>
          )}
        </header>
        {p.leaflets.length ? (
          <LeafletVersions product={p} />
        ) : (
          <p className="pp-empty is-warn">
            <Icon name="alert" /> None yet: a genuine result shows no dosing information.
          </p>
        )}
      </section>

      <BatchRows product={p} />
    </div>
  );
}

/**
 * Every leaflet version, newest first, one line each; a version published as
 * a PDF opens in the file viewer, without leaving the product.
 */
function LeafletVersions({ product }) {
  const viewer = useViewer();
  return (
    <ul className="pp-list">
      {product.leaflets.map((l, i) => {
        const q = new URLSearchParams({ version: l.version });
        if (l.language !== 'en') q.set('lang', l.language);
        const pdf = `/api/product/${encodeURIComponent(product.sku)}/leaflet.pdf?${q}`;
        return (
          <li key={l.id}>
            <span className="pp-list-main">
              <strong>v{l.version}</strong>
              <span className="pp-chip">{l.language.toUpperCase()}</span>
              {i === 0 && <span className="pp-chip is-on">Current</span>}
            </span>
            <span className="pp-meta">
              <Icon name="calendar" /> {fmtDate(l.effective_from)}
            </span>
            {l.file_id && (
              <button
                type="button"
                className="btn btn-sm btn-quiet pp-icon"
                title="View the PDF"
                aria-label={`View leaflet v${l.version} (${l.language})`}
                onClick={() =>
                  viewer.open({
                    kind: 'pdf',
                    title: `${product.name} leaflet v${l.version} (${l.language})`,
                    subtitle: product.sku,
                    src: pdf,
                    downloads: [{ label: 'PDF', url: pdf, filename: `${product.sku}-leaflet-v${l.version}.pdf` }],
                  })
                }
              >
                <Icon name="eye" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The product's picture, as the panel's thumbnail: tap to view it large; for
 * someone who may edit products, small icons to add, replace or remove it.
 * JPEG, PNG or WebP up to 2 MB; the server checks the bytes, not just the
 * type the browser reports.
 */
function ProductImage({ product, canWrite, reload }) {
  const [url, setUrl] = useState(product.image_url ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();
  const viewer = useViewer();

  async function choose(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError(new Error('That image is too large. Choose one under 2 MB.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await upload(`/api/admin/products/${product.id}/image`, file, { method: 'PUT' });
      setUrl(updated.image_url);
      toast('Picture saved.', 'success');
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/products/${product.id}/image`, { method: 'DELETE' });
      setUrl(null);
      toast('Picture removed.', 'success');
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pp-pic-wrap">
      {url ? (
        <button
          type="button"
          className="pp-pic"
          onClick={() =>
            viewer.open({
              kind: 'image',
              title: product.name,
              subtitle: product.sku,
              src: url,
              downloads: [{ label: 'Download', url, filename: `${product.sku}-picture` }],
            })
          }
          aria-label={`View the picture of ${product.name}`}
          title="View the picture"
        >
          <img src={url} alt="" />
        </button>
      ) : (
        <span className="pp-pic is-empty" title="No picture yet">
          <Icon name="image" />
        </span>
      )}
      {canWrite && (
        <div className="pp-pic-tools">
          <label
            className={`pp-pic-tool${busy ? ' is-busy' : ''}`}
            title={url ? 'Replace the picture' : 'Add a picture'}
            aria-label={url ? 'Replace the picture' : 'Add a picture'}
          >
            <Icon name={busy ? 'more' : 'upload'} />
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              disabled={busy}
              onChange={(e) => {
                choose(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {url && (
            <button
              type="button"
              className="pp-pic-tool"
              disabled={busy}
              onClick={remove}
              title="Remove the picture"
              aria-label="Remove the picture"
            >
              <Icon name="x" />
            </button>
          )}
        </div>
      )}
      {error && <p className="field-error pp-pic-error">{error.message}</p>}
    </div>
  );
}

/**
 * The product's batches and their pack codes, one row per batch: number and
 * state, units / expiry / codes as icon facts, and the codes' actions (list,
 * CSV, QR files) as icons on the right. One list where there were two - the
 * batches, and the same batches again under "Pack codes". The code actions
 * are hidden from a role without codes:read (the regulator).
 */
function BatchRows({ product }) {
  const canRead = usePermission('codes:read');
  const canExport = usePermission('codes:export');
  const [open, setOpen] = useState(null);

  return (
    <section className="pp-section">
      <header>
        <h3>
          <Icon name="box" /> Batches &amp; pack codes
        </h3>
        <span
          className="pp-hint"
          tabIndex={0}
          title="Codes are made per batch, one per pack, under Batches & codes. Until a batch is released, every scan of its codes says do not use. Label sheets are printed from Batches & codes."
          aria-label="About batches and pack codes: codes are made per batch, one per pack. Until a batch is released, every scan of its codes says do not use."
        >
          <Icon name="info" />
        </span>
      </header>
      {!product.batches.length ? (
        <p className="pp-empty">
          <Icon name="info" /> No batches yet. Create one under Batches &amp; codes.
        </p>
      ) : (
        <ul className="pp-list pp-batches">
          {product.batches.map((b) => {
            const hasCodes = canRead && b.codes_issued > 0;
            return (
              <li key={b.id}>
                <div className="pp-batch">
                  <span className="pp-list-main">
                    <strong className="mono">{b.batch_number}</strong>
                    <StatusBadge status={b.status} />
                  </span>
                  <span className="pp-facts">
                    <span title="Units planned">
                      <Icon name="layers" /> {plural(b.quantity, 'unit')}
                    </span>
                    <span title="Expires">
                      <Icon name="calendar" /> {fmtDate(b.expiry_date)}
                    </span>
                    {canRead && (
                      <span title="Pack codes issued">
                        <Icon name="qr" /> {plural(b.codes_issued || 0, 'code')}
                      </span>
                    )}
                  </span>
                  {hasCodes && (
                    <span className="pp-actions">
                      <button
                        type="button"
                        className={`btn btn-sm btn-quiet pp-icon${open === b.id ? ' is-on' : ''}`}
                        onClick={() => setOpen(open === b.id ? null : b.id)}
                        title={open === b.id ? 'Hide the codes' : 'Show the codes'}
                        aria-label={`${open === b.id ? 'Hide' : 'Show'} the codes of ${b.batch_number}`}
                        aria-expanded={open === b.id}
                      >
                        <Icon name="eye" />
                      </button>
                      {canExport && (
                        <>
                          <a
                            className="btn btn-sm btn-quiet"
                            href={`/api/admin/batches/${b.id}/codes.csv`}
                            download
                            title={`The code list of ${b.batch_number}, for the packaging line (CSV)`}
                            aria-label={`Download the code list of ${b.batch_number} (CSV)`}
                          >
                            <Icon name="download" /> CSV
                          </a>
                          <QrZipButtons batch={b} compact />
                        </>
                      )}
                    </span>
                  )}
                </div>
                {open === b.id && <BatchCodeList batchId={b.id} batchNumber={b.batch_number} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** One batch's codes, paged, with a QR for each and a copy button. */
function BatchCodeList({ batchId, batchNumber }) {
  const toast = useToast();
  const viewer = useViewer();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const term = useDebounced(search, 300);
  const { data, error, loading } = useApi(`/api/admin/batches/${batchId}/codes`, {
    query: { page, pageSize: 10, search: term || undefined },
  });

  async function copy(code) {
    try {
      await navigator.clipboard.writeText(code);
      toast(`Copied ${code}`, 'success');
    } catch {
      toast('Could not copy - select the code and copy it by hand.', 'error');
    }
  }

  if (error) return <ErrorNote error={error} />;

  return (
    <div className="mt-8">
      <input
        className="input input-inline mb-8"
        type="search"
        placeholder="Find a code or serial"
        aria-label="Find a code"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
      />
      <Table
        loading={loading}
        rows={data?.items}
        empty="No codes match."
        columns={[
          {
            label: 'Code',
            className: 'code',
            render: (c) => (
              <span className="row">
                <span className="mono">{c.code}</span>
                <button
                  className="btn btn-sm btn-quiet"
                  type="button"
                  onClick={() => copy(c.code)}
                  aria-label={`Copy ${c.code}`}
                  title="Copy the code"
                >
                  <Icon name="copy" />
                </button>
              </span>
            ),
          },
          { label: 'Unit', render: (c) => fmtNumber(c.unit_index + 1) },
          {
            label: 'Status',
            render: (c) => (
              <>
                <StatusBadge status={c.status} />
                {c.scan_count > 0 && (
                  <span className="text-sm text-muted"> {fmtNumber(c.scan_count)} scans</span>
                )}
              </>
            ),
          },
          {
            label: 'QR',
            render: (c) => (
              <span className="row">
                <button
                  type="button"
                  className="btn btn-sm btn-quiet"
                  onClick={() => openCodeQr(viewer, c, { batchNumber })}
                  aria-label={`View the QR for ${c.code}`}
                  // The viewer has the SVG and PNG downloads, so the row needs
                  // only this one control.
                  title="View the QR, and download it as SVG or PNG"
                >
                  <Icon name="qr" />
                </button>
              </span>
            ),
          },
        ]}
      />
      {data && data.total > data.pageSize && (
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
      )}
    </div>
  );
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

/** The server's limit for a leaflet PDF (services/leaflets.js), checked here first. */
const PDF_MAX_BYTES = 25 * 1024 * 1024;

const fmtSize = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function PublishLeafletForm({ product, drawer, reload }) {
  const toast = useToast();
  const [version, setVersion] = useState('');
  const [language, setLanguage] = useState('en');
  const [sections, setSections] = useState([emptySection()]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  /*
   * The PDF, if one is attached: { name, size, fileId, progress }. It is
   * uploaded the moment it is chosen, in pieces the server can accept one
   * request at a time (a file may be 25 MB; a request may not), and the
   * publish then points at the finished upload by id. Until fileId is set
   * the upload is still in flight and the form will not publish.
   */
  const [pdf, setPdf] = useState(null);
  // Bumped on "Remove" to remount the file input: nothing else clears the
  // browser's own picker, which would otherwise keep showing the old name.
  const [pickerKey, setPickerKey] = useState(0);
  const removePdf = () => {
    setPdf(null);
    setPickerKey((k) => k + 1);
  };
  async function choosePdf(file) {
    setError(null);
    if (!file) {
      setPdf(null);
      return;
    }
    if (file.size > PDF_MAX_BYTES) {
      setError(`That PDF is ${fmtSize(file.size)}; the limit is 25 MB.`);
      setPickerKey((k) => k + 1);
      return;
    }
    setPdf({ name: file.name, size: file.size, fileId: null, progress: 0 });
    try {
      const { fileId, chunkBytes } = await api('/api/admin/leaflet-files', {
        method: 'POST',
        body: { name: file.name, size: file.size },
      });
      for (let seq = 0, offset = 0; offset < file.size; seq++, offset += chunkBytes) {
        const piece = file.slice(offset, offset + chunkBytes, 'application/pdf');
        await upload(`/api/admin/leaflet-files/${fileId}/chunks/${seq}`, piece, { method: 'PUT' });
        const done = Math.min(file.size, offset + chunkBytes);
        setPdf((p) => (p ? { ...p, progress: done / file.size } : p));
      }
      setPdf((p) => (p ? { ...p, fileId, progress: 1 } : p));
    } catch (err) {
      setPdf(null);
      setPickerKey((k) => k + 1);
      setError(err.formMessage ?? err.message);
    }
  }
  const uploading = Boolean(pdf && !pdf.fileId);

  /*
   * The other products this document covers. One leaflet usually spans every
   * strength of a medicine, so the list shows each product's current version
   * to help the person choose.
   *
   * Nothing is ticked for them. The form used to pre-tick every product
   * sharing this one's current version, but a version number is all that
   * guess had to go on - unrelated medicines that each happen to be on "1.0"
   * came pre-ticked too, and a publish that goes out with a box nobody
   * noticed puts one medicine's leaflet on another. Every product a publish
   * covers is now one the person chose.
   */
  const [selected, setSelected] = useState(() => new Set());
  const lang = useDebounced(language.trim() || 'en');
  const { data: list, error: listError, loading: listLoading } = useApi(
    '/api/admin/leaflet-codes',
    { query: { lang } },
    [lang]
  );

  const toggle = (id, on) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

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
    if (!cleaned.length && !pdf) {
      setError('Attach a PDF, or add at least one section.');
      return;
    }
    if (uploading) {
      setError('The PDF is still uploading - wait for it to finish.');
      return;
    }
    if (cleaned.some((s) => !s.heading || !s.body)) {
      setError('Every section needs both a heading and a body.');
      return;
    }
    if (reason.trim().length < 5) {
      setError('Say why this version is being published - it goes in the audit log.');
      return;
    }

    setBusy(true);
    try {
      await api(`/api/admin/products/${product.id}/leaflets`, {
        method: 'POST',
        body: {
          version: version.trim(),
          language: language.trim() || 'en',
          sections: cleaned,
          reason: reason.trim(),
          alsoApplyTo: [...selected],
          pdf: pdf ? { fileId: pdf.fileId } : undefined,
        },
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
      {/* The mistake this saves: publishing a new version to both products
          just to give a new strength the leaflet its sister already has. */}
      <p className="hint">
        Is {product.sku} covered by a leaflet another product already has - a new strength of the
        same medicine, say? Then use that leaflet as it is instead of publishing a new version.{' '}
        <button
          className="btn btn-sm btn-quiet"
          type="button"
          onClick={() => openUseLeaflet(product, drawer, reload)}
        >
          Use another product&apos;s leaflet
        </button>
      </p>

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
        <label className="label" htmlFor="lf-pdf">
          Leaflet PDF <span className="text-muted">(optional)</span>
        </label>
        <input
          className="input"
          id="lf-pdf"
          key={pickerKey}
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => choosePdf(e.target.files?.[0] ?? null)}
        />
        {pdf && (
          <p className="text-sm" aria-live="polite">
            {uploading ? (
              <>
                <span className="spinner" aria-hidden="true" /> Uploading <strong>{pdf.name}</strong>{' '}
                ({fmtSize(pdf.size)}) - {Math.round(pdf.progress * 100)}%
              </>
            ) : (
              <>
                Attached: <strong>{pdf.name}</strong> ({fmtSize(pdf.size)}){' '}
                <button className="btn btn-sm btn-quiet" type="button" onClick={removePdf}>
                  Remove
                </button>
              </>
            )}
          </p>
        )}
        <p className="hint">
          Up to 25 MB; it uploads as soon as you choose it. With a PDF attached, the leaflet page
          the carton&apos;s QR opens offers it as a button and the sections below become optional -
          but they are what a screen reader can read, so keep them where you can.
        </p>
      </div>

      <div className="field">
        <label className="label">
          Sections {pdf && <span className="text-muted">(optional with a PDF)</span>}
        </label>
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

      <div className="field">
        <label className="label">Also applies to</label>
        <p className="hint mb-8">
          One leaflet usually covers every strength of a medicine. Tick the other products this
          document covers and they all receive this version together, so no two strengths can end
          up saying different things. Nothing is ticked for you - check each one yourself.
        </p>
        {listLoading && !list && <p className="text-sm text-muted">Loading products...</p>}
        {listError && (
          <p className="text-sm text-muted">
            The product list could not be loaded, so this publishes to {product.sku} only.
          </p>
        )}
        {list &&
          list.items
            .filter((p) => p.id !== product.id)
            .map((p) => (
              <label className="row text-sm" key={p.id}>
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={(e) => toggle(p.id, e.target.checked)}
                />{' '}
                <span className="mono">{p.sku}</span> {p.name}
                {p.strength ? ` ${p.strength}` : ''}
                <span className="text-muted">
                  {p.leaflet_version ? ` - currently v${p.leaflet_version}` : ' - no leaflet yet'}
                </span>
              </label>
            ))}
        {/* The whole reach of this publish in one line, read back before
            the button - what the ticks add up to, not what they might be. */}
        <p className="text-sm mt-8">
          <strong>Publishes to:</strong> {product.sku}
          {list?.items
            .filter((p) => selected.has(p.id))
            .map((p) => `, ${p.sku}`)
            .join('')}
          {selected.size === 0 && <span className="text-muted"> only</span>}
        </p>
      </div>

      <div className="field">
        <label className="label" htmlFor="lf-reason">Reason for this version</label>
        <textarea
          className="textarea"
          id="lf-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
          placeholder="What changed and why - a corrected dose, a new warning, a regulatory update."
        />
        <p className="hint">
          Recorded in the audit log against your account. It is what an inspector will read.
        </p>
      </div>

      <p className="hint">
        Publishing takes effect immediately: the leaflet QR already printed for this medicine points
        at a fixed address, so it will start opening this version. Existing versions are kept and
        stay readable, marked as superseded.
      </p>

      {error && <p className="field-error" role="alert">{error}</p>}

      {/* Held until the product list has loaded (or failed), so nobody
          publishes before they could see which other products to tick. */}
      <button
        className="btn btn-primary btn-block"
        type="submit"
        disabled={busy || (listLoading && !list && !listError)}
      >
        {busy ? 'Publishing...' : 'Publish leaflet'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Using another product's leaflet
//
// For a product covered by the leaflet another product already has - a new
// strength of a medicine, usually. It takes that product's current version
// as it stands, where publishing would put a new version on both (see the
// adopt route in routes/admin.js). Everything needed to be sure it is the
// right leaflet is on screen before the button: what will be copied, what
// this product shows now and after, and a warning when the two products are
// different medicines.
// ---------------------------------------------------------------------------

function openUseLeaflet(product, drawer, reload) {
  drawer.open({
    title: `Use another product's leaflet for ${product.name}`,
    subtitle: `${product.sku} - takes that leaflet as it is, without publishing a new version`,
    body: <UseLeafletForm product={product} drawer={drawer} reload={reload} />,
  });
}

/** "Eltrombopag 25 mg (ELT25)" */
const productLabel = (p) => `${p.name}${p.strength ? ` ${p.strength}` : ''} (${p.sku})`;

/** Two strengths of one medicine share its name; that is the usual case. */
const sameMedicine = (a, b) => a.name.trim().toLowerCase() === b.name.trim().toLowerCase();

function UseLeafletForm({ product, drawer, reload }) {
  const toast = useToast();
  const viewer = useViewer();
  const [fromId, setFromId] = useState('');
  const [language, setLanguage] = useState('en');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const lang = useDebounced(language.trim() || 'en');
  const { data: list, error: listError } = useApi(
    '/api/admin/leaflet-codes',
    { query: { lang } },
    [lang]
  );

  const items = list?.items ?? [];
  const mine = items.find((p) => p.id === product.id);
  // Only a product with a leaflet in this language has one to give. The same
  // medicine's other strengths come first: they are almost always the answer.
  const candidates = items.filter((p) => p.id !== product.id && p.hasLeaflet);
  const siblings = candidates.filter((p) => sameMedicine(p, product));
  const others = candidates.filter((p) => !sameMedicine(p, product));
  const source = candidates.find((p) => String(p.id) === fromId) ?? null;

  // The source's leaflet as a patient reads it. What is shown here is what
  // is copied: its version goes with the request, and the server refuses if
  // the source has been revised since.
  const { data: preview, error: previewError, loading: previewLoading } = useApi(
    source ? `/api/product/${encodeURIComponent(source.sku)}/leaflet` : '',
    { query: { lang }, skip: !source },
    [source?.sku, lang]
  );
  // Only the chosen product's: just after the choice changes, the previous
  // one's preview is still held until the new fetch begins.
  const shown = source && preview?.product?.sku === source.sku ? preview.leaflet : null;

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!source || !shown) {
      setError('Choose the product whose leaflet this one should use.');
      return;
    }
    if (reason.trim().length < 5) {
      setError('Say why - it goes in the audit log.');
      return;
    }
    if (
      !window.confirm(
        `From now on, ${product.sku}'s leaflet QR and genuine scan results show ` +
          `${source.sku}'s leaflet v${shown.version}.` +
          (mine?.hasLeaflet
            ? ` ${product.sku}'s own v${mine.leaflet_version} is kept in its history, marked superseded.`
            : '') +
          '\n\nContinue?'
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      await api(`/api/admin/products/${product.id}/leaflets/adopt`, {
        method: 'POST',
        body: { fromProductId: source.id, language: lang, version: shown.version, reason: reason.trim() },
      });
      toast(`${product.sku} now uses ${source.sku}'s leaflet v${shown.version}.`, 'success');
      drawer.close();
      reload();
    } catch (err) {
      setError(err.formMessage ?? err.message);
      setBusy(false);
    }
  }

  const option = (p) => (
    <option key={p.id} value={p.id}>
      {productLabel(p)} - leaflet v{p.leaflet_version}
    </option>
  );

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <p className="hint">
        For a product covered by the same leaflet as another. {product.sku} gets that product&apos;s
        current leaflet as it is - the same text and the same PDF - and no new version is published
        for either.
      </p>

      <div className="field">
        <label className="label" htmlFor="ul-from">Use the leaflet of</label>
        <select
          className="select"
          id="ul-from"
          value={fromId}
          onChange={(e) => setFromId(e.target.value)}
          disabled={!list}
        >
          <option value="">{list ? 'Choose a product' : 'Loading products...'}</option>
          {siblings.length > 0 && (
            <optgroup label={`Other strengths of ${product.name}`}>{siblings.map(option)}</optgroup>
          )}
          {others.length > 0 && <optgroup label="Other products">{others.map(option)}</optgroup>}
        </select>
        {list && !candidates.length && (
          <p className="hint">
            No other product has a leaflet in &quot;{lang}&quot; yet. Publish one instead.
          </p>
        )}
        {listError && <p className="field-error">The product list could not be loaded.</p>}
      </div>

      <div className="field">
        <label className="label" htmlFor="ul-language">Language</label>
        <input
          className="input mono"
          id="ul-language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          maxLength={8}
          placeholder="en"
          spellCheck={false}
        />
        <p className="hint">The leaflet in this language is the one used.</p>
      </div>

      {source && (
        <div className="field">
          <label className="label">Check this is the right leaflet</label>
          {previewLoading && <p className="text-sm text-muted">Loading {source.sku}&apos;s leaflet...</p>}
          {previewError && (
            <p className="field-error">{source.sku}&apos;s leaflet could not be loaded to check.</p>
          )}
          {shown && !previewLoading && (
            <div className="stack-sm">
              {!sameMedicine(source, product) && (
                <div className="alert alert-warn">
                  <Icon name="alert" />
                  <span>
                    {source.sku} is <strong>{source.name}</strong>, not {product.name}. Continue
                    only if this leaflet really covers {product.sku}.
                  </span>
                </div>
              )}

              <KV
                rows={[
                  ['Leaflet of', productLabel(source)],
                  ['Version', `v${shown.version} (${shown.language}), effective ${fmtDate(shown.effectiveFrom)}`],
                  ['PDF', shown.pdf ? `${shown.pdf.filename ?? 'leaflet.pdf'} (${fmtSize(shown.pdf.size ?? 0)})` : 'None - text only'],
                  [
                    'Sections',
                    shown.sections.length
                      ? shown.sections.map((s) => s.heading).join(' · ')
                      : 'None - PDF only',
                  ],
                ]}
              />
              <p className="text-sm row row-wrap">
                {shown.pdf && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      viewer.open({
                        kind: 'pdf',
                        title: `${source.name} leaflet v${shown.version} (${shown.language})`,
                        subtitle: source.sku,
                        src: shown.pdf.url,
                        downloads: [{ label: 'PDF', url: shown.pdf.url, filename: shown.pdf.filename ?? 'leaflet.pdf' }],
                      })
                    }
                  >
                    <Icon name="eye" /> View the PDF
                  </button>
                )}
                <a
                  href={`/leaflet/${encodeURIComponent(source.sku)}${lang !== 'en' ? `?lang=${encodeURIComponent(lang)}` : ''}`}
                  target="_blank"
                  rel="noopener"
                >
                  Open it as patients see it
                </a>
              </p>

              <div className="alert alert-info">
                <Icon name="help" />
                <span>
                  {mine?.hasLeaflet ? (
                    <>
                      {product.sku} shows its own leaflet v{mine.leaflet_version} now. After this, its
                      leaflet QR and genuine scan results show {source.sku}&apos;s v{shown.version}{' '}
                      instead, and v{mine.leaflet_version} stays in its history, marked superseded.
                    </>
                  ) : (
                    <>
                      {product.sku} has no leaflet yet. After this, its leaflet QR and genuine scan
                      results show this one.
                    </>
                  )}{' '}
                  When either is revised later, tick the other under &quot;Also applies to&quot; so
                  they keep saying the same thing.
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="field">
        <label className="label" htmlFor="ul-reason">Reason</label>
        <textarea
          className="textarea"
          id="ul-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
          placeholder={
            source
              ? `${product.sku} is covered by the same leaflet as ${source.sku}.`
              : 'Why this product uses that leaflet.'
          }
        />
        <p className="hint">Recorded in the audit log against your account.</p>
      </div>

      {error && <p className="field-error" role="alert">{error}</p>}

      <button
        className="btn btn-primary btn-block"
        type="submit"
        disabled={busy || !shown || previewLoading}
      >
        {busy
          ? 'Saving...'
          : source
            ? `Use ${source.sku}'s leaflet for ${product.sku}`
            : 'Choose a product first'}
      </button>
    </form>
  );
}
