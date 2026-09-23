/**
 * Batches and their serialized codes.
 *
 * Drives the physical workflow from the field guide:
 *   plan a batch -> issue codes -> hand the code list to the packaging line
 *   -> mark printed -> release -> distribute (-> recall)
 *
 * The lifecycle buttons only offer transitions the server will accept, so an
 * operator is never told "no" after the fact.
 */
import { useState } from 'react';

import { api } from '../../lib/api.js';
import { useApi, useDebounced, usePermission, useToast } from '../../lib/hooks.jsx';
import { fmtDate, fmtNumber } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { useDrawer } from '../components/Drawer.jsx';
import SpreadsheetTools from '../components/SpreadsheetTools.jsx';
import { Icon } from '../../components/Icons.jsx';
import {
  TableCard, Table, Pager, Toolbar, Spacer, Select, KV, StatusBadge, ErrorNote, Loading,
} from '../components/ui.jsx';

/** Which transition each status offers next - mirrors services/serialization.js */
const NEXT = {
  planned: [],
  codes_issued: [{ to: 'printed', label: 'Mark printed' }],
  printed: [
    { to: 'released', label: 'Release batch' },
    { to: 'recalled', label: 'Recall', danger: true },
  ],
  released: [
    { to: 'distributed', label: 'Mark distributed' },
    { to: 'recalled', label: 'Recall', danger: true },
  ],
  distributed: [
    { to: 'recalled', label: 'Recall', danger: true },
    { to: 'closed', label: 'Close' },
  ],
  recalled: [{ to: 'closed', label: 'Close' }],
  closed: [],
};

const STATUSES = ['planned', 'codes_issued', 'printed', 'released', 'distributed', 'recalled', 'closed'];

export default function Batches() {
  const canWrite = usePermission('batches:write');
  const drawer = useDrawer();

  const [filters, setFilters] = useState({ page: 1, status: '', includeTest: false });
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);

  const { data, error, loading, reload } = useApi('/api/admin/batches', {
    query: {
      ...filters,
      search: debouncedSearch,
      includeTest: filters.includeTest ? 'true' : undefined,
      pageSize: 20,
    },
  });

  useHeader(
    'Batches & codes',
    'Every production run, the codes issued for it, and where it sits in its lifecycle.',
    <>
      <SpreadsheetTools entity="batches" label="batches" canWrite={canWrite} onImported={reload} />
      {canWrite && (
        <button className="btn btn-primary btn-sm" onClick={() => openNewBatch(drawer, reload)}>
          New batch
        </button>
      )}
    </>,
    [canWrite]
  );

  if (error) return <ErrorNote error={error} />;

  return (
    <>
      <Toolbar>
        <input
          className="input search"
          type="search"
          placeholder="Search batch or product"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setFilters((f) => ({ ...f, page: 1 }));
          }}
        />
        <Select
          label="Filter by status"
          allLabel="All statuses"
          value={filters.status}
          onChange={(status) => setFilters((f) => ({ ...f, status, page: 1 }))}
          options={STATUSES}
        />
        <label className="row text-sm">
          <input
            type="checkbox"
            checked={filters.includeTest}
            onChange={(e) => setFilters((f) => ({ ...f, includeTest: e.target.checked, page: 1 }))}
          />{' '}
          Include pilot batches
        </label>
        <Spacer />
        <span className="text-sm text-muted">{fmtNumber(data?.total ?? 0)} batches</span>
      </Toolbar>

      <TableCard
        title="Production batches"
        footer={
          data && (
            <Pager
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={(page) => setFilters((f) => ({ ...f, page }))}
            />
          )
        }
      >
        <Table
          loading={loading}
          rows={data?.items}
          empty="No batches yet. Create one to start issuing codes."
          onRowClick={(row) => openBatch(row.id, drawer, reload, canWrite)}
          columns={[
            {
              label: 'Batch',
              render: (r) => (
                <>
                  <span className="mono">{r.batch_number}</span>
                  {r.is_test === 1 && <span className="badge badge-neutral"> pilot</span>}
                  <br />
                  <span className="text-muted text-sm">
                    {r.product_name} {r.sku}
                  </span>
                </>
              ),
            },
            { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { label: 'Units', className: 'num', render: (r) => fmtNumber(r.quantity) },
            {
              label: 'Codes',
              className: 'num',
              render: (r) =>
                r.codes_issued ? (
                  fmtNumber(r.codes_issued)
                ) : (
                  <span className="text-muted">not issued</span>
                ),
            },
            {
              label: 'Flags',
              className: 'num',
              render: (r) =>
                r.flagged_scans ? (
                  <strong className="bl-flag">{fmtNumber(r.flagged_scans)}</strong>
                ) : (
                  '-'
                ),
            },
            { label: 'Expires', render: (r) => fmtDate(r.expiry_date) },
          ]}
        />
      </TableCard>
    </>
  );
}

// ---------------------------------------------------------------------------
// Batch detail
// ---------------------------------------------------------------------------

async function openBatch(id, drawer, reload, canWrite) {
  const batch = await api(`/api/admin/batches/${id}`);
  drawer.open({
    title: batch.batch_number,
    subtitle: batch.product_name,
    body: <BatchDetail batch={batch} drawer={drawer} reload={reload} canWrite={canWrite} />,
    footer: canWrite ? (
      <BatchActions batch={batch} drawer={drawer} reload={reload} />
    ) : null,
  });
}

function BatchDetail({ batch, drawer, reload, canWrite }) {
  const toast = useToast();
  const [issuing, setIssuing] = useState(false);
  const s = batch.stats;

  async function issueCodes() {
    setIssuing(true);
    try {
      const res = await api(`/api/admin/batches/${batch.id}/issue-codes`, { method: 'POST' });
      toast(`Issued ${fmtNumber(res.issued)} codes in ${res.durationMs} ms.`, 'success');
      drawer.close();
      reload();
    } catch (err) {
      toast(err.message, 'error');
      setIssuing(false);
    }
  }

  return (
    <>
      <KV
        rows={[
          ['Product', `${batch.product_name} ${batch.strength ?? ''}`],
          ['SKU', <span className="mono">{batch.sku}</span>],
          ['Status', <StatusBadge status={batch.status} />],
          ['Manufactured', fmtDate(batch.mfg_date)],
          ['Expires', fmtDate(batch.expiry_date)],
          ['Planned units', fmtNumber(batch.quantity)],
          ['Codes issued', fmtNumber(s.totalCodes)],
          [
            'Checks',
            <>
              {fmtNumber(s.scans.total)} total, <strong>{fmtNumber(s.scans.flagged)}</strong> flagged
            </>,
          ],
          ['Open alerts', fmtNumber(batch.openAlerts)],
          batch.is_test === 1 && ['Pilot batch', 'Yes - excluded from live dashboards'],
          batch.recall_reason && ['Recall reason', batch.recall_reason],
          batch.notes && ['Notes', batch.notes],
        ]}
      />

      <div>
        <h3 className="mb-8">Code status</h3>
        <div className="row row-wrap">
          {Object.keys(s.codes ?? {}).length ? (
            Object.entries(s.codes).map(([status, n]) => (
              <span key={status}>
                <StatusBadge status={status} /> {fmtNumber(n)}
              </span>
            ))
          ) : (
            <span className="text-muted">No codes issued yet.</span>
          )}
        </div>
      </div>

      <div>
        <h3 className="mb-8">Serialization</h3>
        {batch.status === 'planned' ? (
          <>
            <p className="text-sm text-muted mb-8">
              No codes exist yet. Issuing generates one unique, non-sequential code per unit. This
              runs once and cannot be repeated - the codes may already be printed on packs.
            </p>
            {canWrite && (
              <button className="btn btn-primary btn-block" onClick={issueCodes} disabled={issuing}>
                {issuing ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Generating...
                  </>
                ) : (
                  `Issue codes for ${fmtNumber(batch.quantity)} units`
                )}
              </button>
            )}
          </>
        ) : (
          <>
            <div className="row row-wrap">
              <button className="btn btn-sm" onClick={() => openLabels(batch.id, drawer)}>
                Print labels
              </button>
              <a className="btn btn-sm" href={`/api/admin/batches/${batch.id}/codes.csv`} download>
                <Icon name="down" /> Code list (CSV)
              </a>
            </div>
            <p className="text-sm text-muted mt-8">
              The CSV is the hand-off file for the packaging line&apos;s printer.
            </p>
          </>
        )}
      </div>
    </>
  );
}

function BatchActions({ batch, drawer, reload }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const actions = NEXT[batch.status] ?? [];

  if (!actions.length) return null;

  async function transition(to) {
    let reason = null;
    if (to === 'recalled') {
      reason = window.prompt('Recall reason (shown to every patient who scans this batch):');
      if (!reason?.trim()) return;
    }

    setBusy(true);
    try {
      await api(`/api/admin/batches/${batch.id}/transition`, {
        method: 'POST',
        body: { to, reason: reason ?? undefined },
      });
      toast(`Batch marked ${to.replace(/_/g, ' ')}.`, 'success');
      drawer.close();
      reload();
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  }

  return (
    <div className="row row-wrap">
      {actions.map((a) => (
        <button
          key={a.to}
          className={`btn btn-sm ${a.danger ? 'btn-danger' : 'btn-primary'}`}
          disabled={busy}
          onClick={() => transition(a.to)}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Printable label sheet
// ---------------------------------------------------------------------------

async function openLabels(batchId, drawer) {
  const data = await api(`/api/admin/batches/${batchId}/labels`, { query: { limit: 24 } });
  drawer.open({
    title: 'Label sheet',
    subtitle: `${data.batch.batchNumber} - first ${data.items.length} of ${fmtNumber(data.total)} units`,
    body: <Labels data={data} />,
    footer: (
      <button className="btn btn-sm btn-primary" onClick={() => window.print()}>
        Print
      </button>
    ),
  });
}

function Labels({ data }) {
  return (
    <>
      <p className="text-sm text-muted no-print">
        These are real, scannable codes. Print this panel to test the full loop: print, scan with a
        phone, and watch the check appear in the scan log.
      </p>
      <div className="labels">
        {data.items.map((item) => (
          <div className="label-cell" key={item.id}>
            {/* The SVG comes from our own server-side QR renderer, not from
                user input, and must be injected as markup to render. */}
            <div dangerouslySetInnerHTML={{ __html: item.svg }} />
            <div className="lc">{item.code}</div>
            <div className="lp">
              {data.batch.sku} &middot; exp {data.batch.expiryDate}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// New batch
// ---------------------------------------------------------------------------

async function openNewBatch(drawer, reload) {
  const products = await api('/api/admin/products');
  drawer.open({
    title: 'New batch',
    subtitle: 'Create a production run, then issue its codes',
    body: <NewBatchForm products={products.items} drawer={drawer} reload={reload} />,
  });
}

function NewBatchForm({ products, drawer, reload }) {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const inTwoYears = new Date(Date.now() + 730 * 86400000).toISOString().slice(0, 10);

  const [form, setForm] = useState({
    productId: products[0]?.id ?? '',
    batchNumber: '',
    quantity: 1000,
    mfgDate: today,
    expiryDate: inTwoYears,
    isTest: false,
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/api/admin/batches', {
        method: 'POST',
        body: {
          productId: Number(form.productId),
          batchNumber: form.batchNumber.trim(),
          quantity: Number(form.quantity),
          mfgDate: form.mfgDate,
          expiryDate: form.expiryDate,
          isTest: form.isTest,
        },
      });
      toast('Batch created. Open it to issue codes.', 'success');
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
        <label className="label" htmlFor="bProduct">Product</label>
        <select className="select" id="bProduct" value={form.productId} onChange={set('productId')}>
          {products.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name} {p.strength ?? ''} ({p.sku})
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="bNumber">Batch number</label>
        <input className="input" id="bNumber" value={form.batchNumber} onChange={set('batchNumber')}
               maxLength={40} placeholder="AMX25-2610A" />
        <p className="hint">Letters, digits and hyphens. Must match what the packaging line prints.</p>
      </div>
      <div className="field">
        <label className="label" htmlFor="bQty">Units in this run</label>
        <input className="input" id="bQty" type="number" min={1} max={500000}
               value={form.quantity} onChange={set('quantity')} />
        <p className="hint">The serial space is sized automatically to at least 100x this number.</p>
      </div>
      <div className="field">
        <label className="label" htmlFor="bMfg">Manufacturing date</label>
        <input className="input" id="bMfg" type="date" value={form.mfgDate} onChange={set('mfgDate')} />
      </div>
      <div className="field">
        <label className="label" htmlFor="bExp">Expiry date</label>
        <input className="input" id="bExp" type="date" value={form.expiryDate} onChange={set('expiryDate')} />
      </div>
      <label className="row text-sm">
        <input type="checkbox" checked={form.isTest} onChange={set('isTest')} /> Pilot / sandbox batch
        (excluded from live dashboards)
      </label>

      {error && <p className="field-error" role="alert">{error}</p>}

      <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
        {busy ? 'Creating...' : 'Create batch'}
      </button>
    </form>
  );
}
