/**
 * Compliance reporting - the regulator's view.
 *
 * Aggregates only. There is deliberately no path from this screen to an
 * individual patient scan: a regulator's account has no 'scans:read'
 * permission, and the endpoint behind this page is built from aggregate
 * queries rather than filtered scan rows.
 */
import { useState } from 'react';

import { useApi } from '../../lib/hooks.jsx';
import { fmtDate, fmtNumber, humanise } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { Icon } from '../../components/Icons.jsx';
import {
  TableCard, Table, Tiles, Toolbar, Spacer, StatusBadge, ErrorNote, Loading,
} from '../components/ui.jsx';

export default function Compliance() {
  const [range, setRange] = useState({
    from: new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
  });

  useHeader(
    'Compliance',
    'Serialization and verification totals for track-and-trace reporting. No individual patient data is included.'
  );

  const { data, error, loading } = useApi('/api/admin/compliance', { query: range });

  if (error) return <ErrorNote error={error} />;

  return (
    <>
      <Toolbar>
        <label className="text-sm text-muted" htmlFor="cFrom">From</label>
        <input
          className="input"
          id="cFrom"
          type="date"
          value={range.from}
          onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
        />
        <label className="text-sm text-muted" htmlFor="cTo">To</label>
        <input
          className="input"
          id="cTo"
          type="date"
          value={range.to}
          onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
        />
        <Spacer />
        <a
          className="btn btn-sm"
          href={`/api/admin/compliance.csv?from=${range.from}&to=${range.to}`}
          download
        >
          <Icon name="down" /> Export CSV
        </a>
      </Toolbar>

      {loading || !data ? (
        <Loading />
      ) : (
        <>
          <Tiles
            items={[
              { label: 'Batches in period', value: fmtNumber(data.serialization.batches), tone: 'blue' },
              {
                label: 'Units serialized',
                tone: 'green',
                value: fmtNumber(data.serialization.unitsSerialized),
                meta: `${fmtNumber(data.serialization.unitsPlanned)} planned`,
              },
              {
                label: 'Verification checks',
                tone: 'violet',
                value: fmtNumber(data.verification.totalChecks),
              },
              {
                label: 'Flagged checks',
                tone: 'red',
                value: fmtNumber(data.verification.flagged),
              },
              {
                label: 'Recalled batches',
                tone: 'blue',
                value: fmtNumber(data.serialization.recalledBatches),
              },
            ]}
          />

          <TableCard
            title={`Batch register: ${fmtDate(`${data.period.from}T00:00:00Z`)} to ${fmtDate(
              `${data.period.to}T00:00:00Z`
            )}`}
          >
            <Table
              rows={data.batches}
              rowKey={(b) => b.batch_number}
              empty="No batches were created in this period."
              columns={[
                { label: 'Batch', className: 'code', render: (b) => b.batch_number },
                {
                  label: 'Product',
                  render: (b) => (
                    <>
                      {b.product_name}
                      <br />
                      <span className="text-muted text-sm">{b.manufacturer}</span>
                    </>
                  ),
                },
                { label: 'Manufactured', render: (b) => fmtDate(b.mfg_date) },
                { label: 'Expires', render: (b) => fmtDate(b.expiry_date) },
                { label: 'Planned', className: 'num', render: (b) => fmtNumber(b.quantity) },
                { label: 'Serialized', className: 'num', render: (b) => fmtNumber(b.codes_issued) },
                { label: 'Status', render: (b) => <StatusBadge status={b.status} /> },
              ]}
            />
          </TableCard>

          {data.alerts?.length > 0 && (
            <TableCard title="Alert summary">
              <Table
                rows={data.alerts}
                rowKey={(a) => `${a.type}-${a.status}`}
                columns={[
                  { label: 'Type', render: (a) => humanise(a.type) },
                  { label: 'Status', render: (a) => <StatusBadge status={a.status} /> },
                  { label: 'Count', className: 'num', render: (a) => fmtNumber(a.n) },
                ]}
              />
            </TableCard>
          )}
        </>
      )}
    </>
  );
}
