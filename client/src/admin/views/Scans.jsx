/**
 * Scan log - every verification attempt, filterable.
 *
 * Security-team only: the regulator role has no 'scans:read', so this view is
 * not in their navigation and the API refuses it directly.
 *
 * Raw IP addresses are never returned by the API - only a keyed one-way digest
 * held server-side - so nothing identifying a patient appears in this table.
 */
import { useState } from 'react';

import { useApi } from '../../lib/hooks.jsx';
import { fmtDate, fmtNumber, humanise } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { Icon } from '../../components/Icons.jsx';
import {
  TableCard, Table, Pager, Toolbar, Spacer, Select, ResultBadge, ErrorNote,
} from '../components/ui.jsx';

export default function Scans() {
  const [filters, setFilters] = useState({ page: 1, result: '', channel: '', includeTest: false });

  useHeader(
    'Scan log',
    'Every verification attempt. Locations are approximate and no patient identity is stored.'
  );

  const { data, error, loading } = useApi('/api/admin/scans', {
    query: {
      ...filters,
      includeTest: filters.includeTest ? 'true' : undefined,
      pageSize: 25,
    },
  });

  const exportParams = new URLSearchParams();
  if (filters.result) exportParams.set('result', filters.result);
  if (filters.includeTest) exportParams.set('includeTest', 'true');

  if (error) return <ErrorNote error={error} />;

  return (
    <>
      <Toolbar>
        <Select
          label="Filter by result"
          allLabel="All results"
          value={filters.result}
          onChange={(result) => setFilters((f) => ({ ...f, result, page: 1 }))}
          options={['genuine', 'flagged', 'invalid']}
        />
        <Select
          label="Filter by channel"
          allLabel="All channels"
          value={filters.channel}
          onChange={(channel) => setFilters((f) => ({ ...f, channel, page: 1 }))}
          options={['web', 'sms', 'api']}
        />
        <label className="row text-sm">
          <input
            type="checkbox"
            checked={filters.includeTest}
            onChange={(e) => setFilters((f) => ({ ...f, includeTest: e.target.checked, page: 1 }))}
          />{' '}
          Include pilot scans
        </label>
        <Spacer />
        <a className="btn btn-sm" href={`/api/admin/scans.csv?${exportParams}`} download>
          <Icon name="down" /> Export CSV
        </a>
      </Toolbar>

      <TableCard
        title={`${fmtNumber(data?.total ?? 0)} checks`}
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
          empty="No scans match these filters."
          columns={[
            { label: 'When', render: (r) => fmtDate(r.created_at, { withTime: true }) },
            { label: 'Code', className: 'code', render: (r) => r.code_text },
            {
              label: 'Product',
              render: (r) =>
                r.product_name ? (
                  <>
                    {r.product_name}
                    <br />
                    <span className="text-muted text-sm mono">{r.batch_number ?? ''}</span>
                  </>
                ) : (
                  <span className="text-muted">not in registry</span>
                ),
            },
            { label: 'Result', render: (r) => <ResultBadge result={r.result} /> },
            { label: 'Reason', render: (r) => <span className="text-sm">{humanise(r.reason)}</span> },
            { label: 'Channel', render: (r) => r.channel },
            {
              label: 'Where',
              render: (r) => [r.city, r.region, r.country].filter(Boolean).join(', ') || '-',
            },
          ]}
        />
      </TableCard>
    </>
  );
}
