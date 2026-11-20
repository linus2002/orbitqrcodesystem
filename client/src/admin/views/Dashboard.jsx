/**
 * Overview: the screen a security analyst opens first each morning.
 *
 * Ordered by decision value, not data availability:
 *   1. is anything on fire right now      (the four figures)
 *   2. what does normal look like today   (volume, and how much was flagged)
 *   3. where is it happening              (places, worst batches, latest flags)
 *
 * Laid out like the rest of the dashboard (after Studio Admin): figure cards
 * with an icon and a change pill, then cards with a title and a line under
 * it. The legend for the badges and colours is in the top bar now.
 */
import { useNavigate } from 'react-router-dom';

import { useApi, usePermission } from '../../lib/hooks.jsx';
import { fmtNumber, fmtRelative, humanise } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { TrendChart, BarList } from '../components/Charts.jsx';
import { Card, TableCard, Table, Tiles, Loading, ErrorNote, ResultBadge, StatusBadge } from '../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';

const DAYS = 30;

export default function Dashboard() {
  const navigate = useNavigate();
  const canScans = usePermission('scans:read');
  const canAlerts = usePermission('alerts:read');

  useHeader(
    'Overview',
    `The last ${DAYS} days. Pilot and sandbox batches are left out of every figure here.`
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
  const flaggedShare = o.scans.total ? (o.scans.flagged / o.scans.total) * 100 : 0;

  return (
    <>
      {/* The flag rate is the number the team actually watches: raw counts
          rise with traffic, so the rate is what says whether things are
          getting worse. Cards leading to a section the viewer cannot open
          are left out rather than shown and dead. */}
      <Tiles
        items={[
          {
            label: 'Checks',
            icon: 'activity',
            value: fmtNumber(o.scans.total),
            meta: `${fmtNumber(o.scans.today)} today · ${fmtNumber(o.scans.previousTotal)} the ${DAYS} days before`,
            change: o.scans.changePct,
            changeGood: 'up',
            to: canScans ? '/admin/scans' : undefined,
          },
          {
            label: 'Flagged',
            icon: 'flag',
            value: fmtNumber(o.scans.flagged),
            // A rise here is bad news, which is why changeGood is inverted.
            meta: `${o.scans.flagRatePerThousand} per 1,000 checks`,
            change: o.scans.flaggedChangePct,
            changeGood: 'down',
            to: canScans ? '/admin/scans?result=flagged' : undefined,
          },
          canAlerts && {
            label: 'Needs attention',
            icon: 'bell',
            value: fmtNumber(o.alerts.open + o.alerts.investigating),
            meta: `${fmtNumber(o.alerts.urgent)} high or critical`,
            to: '/admin/alerts',
          },
          {
            label: 'Units serialized',
            icon: 'layers',
            value: fmtNumber(o.codes.total),
            meta: `${fmtNumber(o.codes.verified)} verified by a patient`,
            to: '/admin/batches',
          },
        ]}
      />

      {/* The volume, and beside it what it adds up to: how many checks, and
          how much of that was flagged - the bar makes the share visible. */}
      <Card
        title="Verification volume"
        description={`Genuine and flagged checks per day, the last ${DAYS} days.`}
        className="chart-card"
      >
        <div className="volume">
          <div className="volume-chart">
            <TrendChart series={data.trend} />
          </div>
          <div className="volume-summary">
            <div className="volume-big">
              <strong>{fmtNumber(o.scans.total)}</strong>
              <span>checks</span>
            </div>
            <p className="volume-note">
              Every pack checked in the last {DAYS} days, {fmtNumber(o.scans.today)} of them today.
            </p>
            <div className="volume-box">
              <span className="volume-box-k">Flagged</span>
              <div className="volume-big">
                <strong>{fmtNumber(o.scans.flagged)}</strong>
                <span>checks</span>
              </div>
              <p className="volume-note">
                {flaggedShare.toFixed(1)}% of all checks: {o.scans.flagRatePerThousand} in every 1,000.
              </p>
              <div
                className="volume-bar"
                role="img"
                aria-label={`${flaggedShare.toFixed(1)}% of checks were flagged`}
              >
                <i style={{ width: `${Math.min(100, flaggedShare)}%` }} />
              </div>
              <div className="volume-bar-k">
                <span>
                  <b>{fmtNumber(o.scans.flagged)}</b> flagged
                </span>
                <span>{fmtNumber(o.scans.total)} checks</span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <div className="two-up">
        <Card title="Where checks come from" description="Checks by place; the red end is the flagged share.">
          <BarList
            rows={data.geo.map((g) => ({
              label: [g.region, g.country].filter(Boolean).join(', ') || 'Unknown',
              total: g.total,
              flagged: g.flagged,
            }))}
          />
        </Card>

        <TableCard title="Batches with the most flags" description="Open the batch list to act on one.">
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
          description="The latest checks that came back flagged, newest first."
          actions={
            <button className="btn btn-sm" onClick={() => navigate('/admin/scans?result=flagged')}>
              View all
              <Icon name="chev-right" />
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
