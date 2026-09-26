/**
 * Patient reports.
 *
 * These come from the "report a problem" form on the public portal - the field
 * guide's direct-report path that bypasses the scan result. A human taking the
 * trouble to write one is a stronger signal than most automated flags, so they
 * get their own queue rather than being folded into alerts.
 */
import { useState } from 'react';

import { api } from '../../lib/api.js';
import { useApi, usePermission, useToast } from '../../lib/hooks.jsx';
import { fmtDate, fmtNumber, fmtRelative } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { useDrawer } from '../components/Drawer.jsx';
import {
  TableCard, Table, Pager, Toolbar, Spacer, Select, KV, StatusBadge, ErrorNote,
} from '../components/ui.jsx';

export default function Reports() {
  const [filters, setFilters] = useState({ page: 1, status: '' });
  const drawer = useDrawer();

  useHeader('Patient reports', 'Suspect packs reported directly by patients and pharmacists.');

  const { data, error, loading, reload } = useApi('/api/admin/reports', {
    query: { ...filters, pageSize: 20 },
  });

  if (error) return <ErrorNote error={error} />;

  return (
    <>
      <Toolbar>
        <Select
          label="Filter by status"
          allLabel="All"
          value={filters.status}
          onChange={(status) => setFilters({ page: 1, status })}
          options={['new', 'reviewing', 'closed']}
        />
        <Spacer />
        <span className="text-sm text-muted">{fmtNumber(data?.total ?? 0)} reports</span>
      </Toolbar>

      <TableCard
        title="Reports"
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
          empty="No patient reports."
          onRowClick={(row) =>
            drawer.open({
              title: `Report #${row.id}`,
              subtitle: fmtDate(row.created_at, { withTime: true }),
              body: <ReportDetail report={row} />,
              footer: <ReportActions report={row} drawer={drawer} reload={reload} />,
            })
          }
          columns={[
            { label: 'Received', render: (r) => fmtRelative(r.created_at) },
            {
              label: 'What was reported',
              render: (r) =>
                r.description.length > 90 ? `${r.description.slice(0, 90)}...` : r.description,
            },
            {
              label: 'Code',
              className: 'code',
              render: (r) =>
                r.code_text ? r.code_text : <span className="text-muted">none given</span>,
            },
            { label: 'Product', render: (r) => r.product_name ?? '-' },
            { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      </TableCard>
    </>
  );
}

function ReportDetail({ report }) {
  return (
    <>
      <KV
        rows={[
          ['Status', <StatusBadge status={report.status} />],
          ['Code given', report.code_text ? <span className="mono">{report.code_text}</span> : 'none'],
          ['In registry', report.registry_code ? 'Yes' : 'No - the code is not one of ours'],
          ['Product', report.product_name ?? '-'],
          ['Batch', report.batch_number ? <span className="mono">{report.batch_number}</span> : '-'],
          ['Bought at', report.purchase_location ?? 'not stated'],
          ['Reporter', report.reporter_name ?? 'anonymous'],
          ['Contact', report.reporter_contact ?? 'none given'],
          // From the details they gave before checking, not typed into the
          // report - the part to trust if the two differ.
          [
            'Checked by',
            report.checker
              ? [report.checker.name, report.checker.phone, report.checker.email, report.checker.role]
                  .filter(Boolean)
                  .join(' · ')
              : 'not linked to a registered check',
          ],
        ]}
      />
      <div>
        <h3 className="mb-8">In their words</h3>
        {/* React escapes this automatically - it is untrusted free text from
            the public portal. */}
        <p className="report-quote">{report.description}</p>
      </div>
    </>
  );
}

function ReportActions({ report, drawer, reload }) {
  const canWrite = usePermission('reports:write');
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!canWrite || report.status === 'closed') return null;

  async function setStatus(status) {
    setBusy(true);
    try {
      await api(`/api/admin/reports/${report.id}`, { method: 'PATCH', body: { status } });
      toast(`Report marked ${status}.`, 'success');
      drawer.close();
      reload();
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  }

  return (
    <div className="row row-wrap">
      {report.status === 'new' && (
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setStatus('reviewing')}>
          Start review
        </button>
      )}
      <button className="btn btn-sm" disabled={busy} onClick={() => setStatus('closed')}>
        Close report
      </button>
    </div>
  );
}
