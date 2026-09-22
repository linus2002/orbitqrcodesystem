/**
 * Shipments - the distribution leg.
 *
 * Useful during an investigation: when flags cluster in one region, the
 * shipment records say which batches actually went there and via whom.
 */
import { useState } from 'react';

import { api } from '../../lib/api.js';
import { useApi, usePermission, useToast } from '../../lib/hooks.jsx';
import { fmtDate, fmtNumber } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { useDrawer } from '../components/Drawer.jsx';
import { TableCard, Table, Pager, StatusBadge, ErrorNote } from '../components/ui.jsx';

export default function Shipments() {
  const canWrite = usePermission('batches:write');
  const drawer = useDrawer();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState(null);

  const { data, error, loading, reload } = useApi('/api/admin/shipments', {
    query: { page, pageSize: 25 },
  });

  useHeader(
    'Shipments',
    'Where each batch was sent. Helps narrow a cluster of flags to a distribution route.',
    canWrite ? (
      <button className="btn btn-primary btn-sm" onClick={() => openNew(drawer, reload, toast)}>
        New shipment
      </button>
    ) : null,
    [canWrite]
  );

  async function receive(id) {
    setBusyId(id);
    try {
      await api(`/api/admin/shipments/${id}/receive`, { method: 'PATCH' });
      toast('Shipment marked received.', 'success');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <ErrorNote error={error} />;

  return (
    <TableCard
      title={`${fmtNumber(data?.total ?? 0)} shipments`}
      footer={
        data && (
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        )
      }
    >
      <Table
        loading={loading}
        rows={data?.items}
        empty="No shipments recorded."
        columns={[
          { label: 'Reference', className: 'code', render: (r) => r.reference },
          {
            label: 'Batch',
            render: (r) => (
              <>
                <span className="mono">{r.batch_number}</span>
                <br />
                <span className="text-muted text-sm">{r.product_name}</span>
              </>
            ),
          },
          { label: 'Units', className: 'num', render: (r) => fmtNumber(r.quantity) },
          {
            label: 'Destination',
            render: (r) => (
              <>
                {r.to_name}
                <br />
                <span className="text-muted text-sm">
                  {r.to_type}
                  {r.to_region ? `, ${r.to_region}` : ''}
                </span>
              </>
            ),
          },
          { label: 'Shipped', render: (r) => fmtDate(r.shipped_at) },
          { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          {
            label: '',
            render: (r) =>
              canWrite && r.status === 'in_transit' ? (
                <button
                  className="btn btn-sm"
                  disabled={busyId === r.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    receive(r.id);
                  }}
                >
                  Mark received
                </button>
              ) : null,
          },
        ]}
      />
    </TableCard>
  );
}

async function openNew(drawer, reload, toast) {
  // Only released or distributed batches may legitimately ship.
  const batches = await api('/api/admin/batches', { query: { pageSize: 100 } });
  const shippable = batches.items.filter((b) => ['released', 'distributed'].includes(b.status));

  if (!shippable.length) {
    toast('No batch has been released yet. Release one before shipping.', 'error');
    return;
  }

  drawer.open({
    title: 'New shipment',
    body: <NewShipmentForm batches={shippable} drawer={drawer} reload={reload} />,
  });
}

function NewShipmentForm({ batches, drawer, reload }) {
  const toast = useToast();
  const [form, setForm] = useState({
    batchId: batches[0].id,
    reference: '',
    quantity: 100,
    fromSite: '',
    toName: '',
    toType: 'pharmacy',
    toRegion: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/api/admin/shipments', {
        method: 'POST',
        body: {
          batchId: Number(form.batchId),
          reference: form.reference.trim(),
          quantity: Number(form.quantity),
          fromSite: form.fromSite.trim(),
          toName: form.toName.trim(),
          toType: form.toType,
          toRegion: form.toRegion.trim() || undefined,
        },
      });
      toast('Shipment created.', 'success');
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
        <label className="label" htmlFor="sBatch">Batch</label>
        <select className="select" id="sBatch" value={form.batchId} onChange={set('batchId')}>
          {batches.map((b) => (
            <option value={b.id} key={b.id}>
              {b.batch_number} - {b.product_name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="sRef">Reference</label>
        <input className="input" id="sRef" value={form.reference} onChange={set('reference')}
               maxLength={40} placeholder="SHP-1042" />
      </div>
      <div className="field">
        <label className="label" htmlFor="sQty">Units</label>
        <input className="input" id="sQty" type="number" min={1} value={form.quantity} onChange={set('quantity')} />
      </div>
      <div className="field">
        <label className="label" htmlFor="sFrom">From site</label>
        <input className="input" id="sFrom" value={form.fromSite} onChange={set('fromSite')}
               maxLength={120} placeholder="Northbridge Plant 2" />
      </div>
      <div className="field">
        <label className="label" htmlFor="sTo">Destination name</label>
        <input className="input" id="sTo" value={form.toName} onChange={set('toName')} maxLength={160} />
      </div>
      <div className="field">
        <label className="label" htmlFor="sType">Destination type</label>
        <select className="select" id="sType" value={form.toType} onChange={set('toType')}>
          <option value="pharmacy">Pharmacy</option>
          <option value="distributor">Distributor</option>
          <option value="hospital">Hospital</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="sRegion">Region</label>
        <input className="input" id="sRegion" value={form.toRegion} onChange={set('toRegion')} maxLength={120} />
      </div>

      {error && <p className="field-error" role="alert">{error}</p>}

      <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
        {busy ? 'Creating...' : 'Create shipment'}
      </button>
    </form>
  );
}
