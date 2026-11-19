/**
 * Audit log - who did what in the admin surface.
 *
 * Append-only: nothing in the system updates or deletes these rows, which is
 * what makes the trail usable during a regulatory inspection.
 */
import { useState } from 'react';

import { download } from '../../lib/api.js';
import { useApi, useToast } from '../../lib/hooks.jsx';
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
  { value: 'customer', label: 'Customers' },
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
              className: 'td-wrap',
              render: (r) =>
                r.detail ? (
                  <span className="text-sm text-muted">{summarise(r.detail)}</span>
                ) : null,
            },
          ]}
        />
      </TableCard>

      <StoredSpreadsheets />
    </>
  );
}

const KIND_LABELS = { import: 'Imports', export: 'Exports' };

/**
 * A copy of every spreadsheet imported or exported, kept in the database with
 * who did it - so "what exactly was in that file?" has an answer later.
 */
function StoredSpreadsheets() {
  const [kind, setKind] = useState('export');
  const [page, setPage] = useState(1);
  const toast = useToast();
  const { data, error, loading } = useApi('/api/admin/files', { query: { kind, page, pageSize: 20 } }, [kind, page]);

  async function save(f) {
    try {
      await download(f.downloadUrl, { filename: f.filename });
    } catch (err) {
      toast(err.message ?? 'Could not download that file.', 'error');
    }
  }

  return (
    <>
      <Toolbar>
        {Object.entries(KIND_LABELS).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`btn btn-sm${kind === value ? ' btn-primary' : ''}`}
            onClick={() => {
              setKind(value);
              setPage(1);
            }}
          >
            {label}
          </button>
        ))}
        <Spacer />
        <span className="text-sm text-muted">{fmtNumber(data?.total ?? 0)} files</span>
      </Toolbar>
      <ErrorNote error={error} />
      <TableCard
        title="Stored spreadsheets"
        footer={
          data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        }
      >
        <Table
          loading={loading}
          rows={data?.items}
          empty={kind === 'import' ? 'No imports kept yet.' : 'No exports kept yet.'}
          columns={[
            { label: 'When', render: (f) => fmtDate(f.createdAt, { withTime: true }) },
            { label: 'Who', render: (f) => f.createdByName ?? '-' },
            { label: 'File', className: 'td-wrap', render: (f) => f.filename },
            {
              label: kind === 'import' ? 'Result' : 'Rows',
              render: (f) =>
                kind === 'import'
                  ? `${fmtNumber(f.meta?.created ?? 0)} new, ${fmtNumber(f.meta?.updated ?? 0)} updated`
                  : fmtNumber(f.meta?.rows ?? 0),
            },
            { label: 'Size', className: 'num', render: (f) => `${Math.max(1, Math.round(f.size / 1024))} KB` },
            {
              label: '',
              render: (f) => (
                <button type="button" className="btn-pill" onClick={() => save(f)}>
                  Download
                </button>
              ),
            },
          ]}
        />
      </TableCard>
    </>
  );
}
