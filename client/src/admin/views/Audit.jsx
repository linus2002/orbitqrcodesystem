/**
 * Audit log - who did what in the admin surface.
 *
 * Append-only: nothing in the system updates or deletes these rows, which is
 * what makes the trail usable during a regulatory inspection.
 */
import { useState } from 'react';

import { useApi } from '../../lib/hooks.jsx';
import { fmtDate, fmtNumber } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { TableCard, Table, Pager, Toolbar, Spacer, Select, ErrorNote } from '../components/ui.jsx';

/** Group the dotted action names into readable filter options. */
const ACTION_GROUPS = [
  { value: 'auth', label: 'Sign in and out' },
  { value: 'batch', label: 'Batches' },
  { value: 'codes', label: 'Code exports' },
  { value: 'product', label: 'Products' },
  { value: 'leaflet', label: 'Leaflets' },
  { value: 'alert', label: 'Alerts' },
  { value: 'user', label: 'User accounts' },
  { value: 'shipment', label: 'Shipments' },
  { value: 'compliance', label: 'Compliance exports' },
  { value: 'settings', label: 'Settings' },
];

/** Flatten a detail object into a short readable string. */
function summarise(detail) {
  return Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ');
}

export default function Audit() {
  const [filters, setFilters] = useState({ page: 1, action: '' });

  useHeader(
    'Audit log',
    'Every state-changing action taken in the dashboard. This log is append-only.'
  );

  const { data, error, loading } = useApi('/api/admin/audit', {
    query: { ...filters, pageSize: 30 },
  });

  if (error) return <ErrorNote error={error} />;

  return (
    <>
      <Toolbar>
        <Select
          label="Filter by action"
          allLabel="All activity"
          value={filters.action}
          onChange={(action) => setFilters({ page: 1, action })}
          options={ACTION_GROUPS}
        />
        <Spacer />
        <span className="text-sm text-muted">{fmtNumber(data?.total ?? 0)} entries</span>
      </Toolbar>

      <TableCard
        title="Activity"
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
          empty="No activity recorded yet."
          columns={[
            { label: 'When', render: (r) => fmtDate(r.created_at, { withTime: true }) },
            { label: 'Who', render: (r) => r.actor_email ?? 'system' },
            { label: 'Action', render: (r) => <span className="mono text-sm">{r.action}</span> },
            {
              label: 'Target',
              render: (r) => (r.entity_type ? `${r.entity_type} #${r.entity_id ?? ''}` : '-'),
            },
            {
              label: 'Detail',
              render: (r) =>
                r.detail ? (
                  <span className="text-sm text-muted">{summarise(r.detail)}</span>
                ) : null,
            },
          ]}
        />
      </TableCard>
    </>
  );
}
