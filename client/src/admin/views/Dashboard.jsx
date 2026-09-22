/**
 * Overview: the screen a security analyst opens first each morning.
 *
 * Ordered by decision value, not data availability:
 *   1. is anything on fire right now      (urgent tiles)
 *   2. what does normal look like today   (volume + flag rate)
 *   3. where is it happening              (trend, geography, worst batches)
 */
import { useNavigate } from 'react-router-dom';

import { useApi, usePermission } from '../../lib/hooks.jsx';
import { fmtNumber, fmtRelative, humanise } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { TrendChart, BarList } from '../components/Charts.jsx';
import {
  Card, TableCard, Table, Tiles, Loading, ErrorNote, ResultBadge, StatusBadge,
} from '../components/ui.jsx';

const DAYS = 30;

export default function Dashboard() {
  const navigate = useNavigate();
  const canScans = usePermission('scans:read');
  const canAlerts = usePermission('alerts:read');
  const canReports = usePermission('reports:read');

  useHeader(
    'Overview',
    `Last ${DAYS} days. Pilot and sandbox batches are excluded from every figure on this page.`
  );

  const { data, error, loading } = useApi('/api/admin/overview', { query: { days: DAYS } });

  // Checked before the request is made, not caught afterwards: a regulator has
  // no 'scans:read', and firing a request we know will be refused just logs a
  // 403 in their console and wastes a round trip.
  const recent = useApi(
    '/api/admin/scans',
    { query: { result: 'flagged', pageSize: 8 }, skip: !canScans }
  );

  if (loading) return <Loading />;
  if (error) return <ErrorNote error={error} />;

  const o = data.overview;

  return (
    <>
      {/* The flag rate is the number the team actually watches: raw counts
          rise with traffic, so the rate is what says whether things are
          getting worse. Tiles leading to a section the viewer cannot open are
          omitted rather than shown-and-dead. */}
      <Tiles
        items={[
          {
            label: 'Checks',
            value: fmtNumber(o.scans.total),
            meta: `${fmtNumber(o.scans.today)} today`,
            icon: 'scan',
          },
          {
            label: 'Flagged',
            value: fmtNumber(o.scans.flagged),
            meta: `${o.scans.flagRatePerThousand} per 1,000 checks`,
            accent: o.scans.flagged > 0 ? 'danger' : undefined,
            icon: 'alert',
          },
          canAlerts && {
            label: 'Needs attention',
            value: fmtNumber(o.alerts.open + o.alerts.investigating),
            meta: `${fmtNumber(o.alerts.urgent)} high or critical`,
            accent: o.alerts.urgent > 0 ? 'danger' : undefined,
            icon: 'flag',
          },
          canReports && {
            label: 'Patient reports',
            value: fmtNumber(o.reports.new),
            meta: 'awaiting review',
            accent: o.reports.new > 0 ? 'warn' : undefined,
            icon: 'report',
          },
          {
            label: 'Units serialized',
            value: fmtNumber(o.codes.total),
            meta: `${fmtNumber(o.codes.verified)} verified by a patient`,
            icon: 'qr',
          },
          {
            label: 'Active batches',
            value: fmtNumber(o.batches.active),
            meta: o.batches.recalled
              ? `${fmtNumber(o.batches.recalled)} recalled`
              : 'none recalled',
            accent: o.batches.recalled > 0 ? 'warn' : undefined,
            icon: 'box',
          },
        ]}
      />

      <Card title="Verification volume" className="chart-card">
        <TrendChart series={data.trend} />
      </Card>

      <div className="two-up">
        <Card title="Where checks come from">
          <BarList
            rows={data.geo.map((g) => ({
              label: [g.region, g.country].filter(Boolean).join(', ') || 'Unknown',
              total: g.total,
              flagged: g.flagged,
            }))}
          />
        </Card>

        <TableCard title="Batches with the most flags">
          <Table
            rows={data.topBatches}
            onRowClick={() => navigate('/admin/batches')}
            empty="No batch has produced a flagged scan in this period. That is the result you want."
            columns={[
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
              { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              { label: 'Checks', className: 'num', render: (r) => fmtNumber(r.scans) },
              { label: 'Flagged', className: 'num', render: (r) => <strong>{fmtNumber(r.flagged)}</strong> },
            ]}
          />
        </TableCard>
      </div>

      {/* Only flagged rows: a feed of genuine scans would bury the signal. */}
      {canScans && recent.data && (
        <TableCard
          title="Most recent flagged checks"
          actions={
            <button className="btn btn-sm" onClick={() => navigate('/admin/scans')}>
              View all
            </button>
          }
        >
          <Table
            rows={recent.data.items}
            empty="No flagged checks recorded."
            columns={[
              { label: 'When', render: (r) => fmtRelative(r.created_at) },
              { label: 'Code', className: 'code', render: (r) => r.code_text },
              { label: 'Product', render: (r) => r.product_name ?? 'Unknown code' },
              {
                label: 'Reason',
                render: (r) => <span className="text-sm">{humanise(r.reason)}</span>,
              },
              {
                label: 'Where',
                render: (r) => [r.city, r.country].filter(Boolean).join(', ') || '-',
              },
              { label: 'Result', render: (r) => <ResultBadge result={r.result} /> },
            ]}
          />
        </TableCard>
      )}
    </>
  );
}
