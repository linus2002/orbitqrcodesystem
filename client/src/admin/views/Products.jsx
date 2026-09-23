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
  TableCard, Table, KV, Timeline, TimelineItem, StatusBadge, ErrorNote,
} from '../components/ui.jsx';

export default function Products() {
  const canWrite = usePermission('products:write');
  const drawer = useDrawer();
  const { data, error, loading, reload } = useApi('/api/admin/products');

  useHeader(
    'Products',
    'The catalogue. A product SKU becomes the first segment of every code issued for it.',
    <div className="row row-wrap">
      <SpreadsheetTools entity="products" label="products" canWrite={canWrite} onImported={reload} />
      {canWrite && (
        <button className="btn btn-primary btn-sm" onClick={() => openNew(drawer, reload)}>
          New product
        </button>
      )}
    </div>,
    [canWrite]
  );

  if (error) return <ErrorNote error={error} />;

  return (
    <TableCard>
      <Table
        loading={loading}
        rows={data?.items}
        empty="No products yet."
        onRowClick={(row) => openProduct(row.id, drawer)}
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
  );
}

async function openProduct(id, drawer) {
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
