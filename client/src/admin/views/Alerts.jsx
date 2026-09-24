/**
 * Alert queue - the security team's actual working surface.
 *
 * Open work sorts to the top, then by severity. Closing an alert requires a
 * note, because that note is the investigation record a regulator may later
 * ask to see.
 */
import { useState } from 'react';

import { api } from '../../lib/api.js';
import { useApi, useToast } from '../../lib/hooks.jsx';
import { fmtDate, fmtNumber, fmtRelative, humanise } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { useDrawer } from '../components/Drawer.jsx';
import {
  TableCard, Table, Pager, Toolbar, Spacer, Select, KV, Timeline, TimelineItem, SeverityBadge, StatusBadge, ErrorNote,
} from '../components/ui.jsx';

const TYPES = [
  'duplicate_scan', 'unknown_code', 'recalled_scan', 'expired_scan',
  'guess_attack', 'consumer_report', 'batch_anomaly',
];

export default function Alerts() {
  const [filters, setFilters] = useState({ page: 1, status: 'open', severity: '', type: '' });
  const drawer = useDrawer();

  useHeader(
    'Alerts',
    'Suspicious verifications queued for review. Flagging never triggers an automatic recall.'
  );

  const { data, error, loading, reload } = useApi('/api/admin/alerts', {
    query: { ...filters, pageSize: 20 },
  });

  const set = (patch) => setFilters((f) => ({ ...f, page: 1, ...patch }));

  if (error) return <ErrorNote error={error} />;

  return (
    <>
      <Toolbar>
        <Select
          label="Filter by status"
          allLabel="All statuses"
          value={filters.status}
          onChange={(status) => set({ status })}
          options={['open', 'investigating', 'resolved', 'dismissed']}
        />
        <Select
          label="Filter by severity"
          allLabel="All severities"
          value={filters.severity}
          onChange={(severity) => set({ severity })}
          options={['critical', 'high', 'medium', 'low']}
        />
        <Select
          label="Filter by type"
          allLabel="All types"
          value={filters.type}
          onChange={(type) => set({ type })}
          options={TYPES}
        />
        <Spacer />
        <span className="text-sm text-muted">{fmtNumber(data?.total ?? 0)} matching</span>
      </Toolbar>

      <TableCard
        title="Queue"
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
          empty={
            filters.status === 'open'
              ? 'Nothing open. Every alert has been reviewed.'
              : 'No alerts match these filters.'
          }
          onRowClick={(row) => openAlert(row.id, drawer, reload)}
          columns={[
            { label: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
            {
              label: 'Alert',
              render: (r) => (
                <>
                  {r.title}
                  <br />
                  <span className="text-muted text-sm">
                    {humanise(r.type)}
                    {r.detail?.occurrences > 1 && ` · ${r.detail.occurrences} occurrences`}
                  </span>
                </>
              ),
            },
            { label: 'Product', render: (r) => r.product_name ?? '-' },
            { label: 'Batch', className: 'code', render: (r) => r.batch_number ?? '-' },
            { label: 'Raised', render: (r) => fmtRelative(r.created_at) },
            { label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      </TableCard>
    </>
  );
}

/** Load one alert and show its full detail in the drawer. */
async function openAlert(id, drawer, reload) {
  const alert = await api(`/api/admin/alerts/${id}`);
  drawer.open({
    title: alert.title,
    subtitle: `Alert #${alert.id}`,
    body: <AlertDetail alert={alert} />,
    footer: <AlertActions alert={alert} drawer={drawer} reload={reload} />,
  });
}

function AlertDetail({ alert }) {
  const closed = alert.status === 'resolved' || alert.status === 'dismissed';

  return (
    <>
      <KV
        rows={[
          ['Type', humanise(alert.type)],
          ['Severity', <SeverityBadge severity={alert.severity} />],
          ['Status', <StatusBadge status={alert.status} />],
          alert.code && ['Code', <span className="mono">{alert.code}</span>],
          alert.product_name && ['Product', alert.product_name],
          alert.batch_number && ['Batch', <span className="mono">{alert.batch_number}</span>],
          alert.detail?.occurrences && ['Occurrences', alert.detail.occurrences],
          alert.scan_count != null && ['Total checks on code', alert.scan_count],
          ['Raised', fmtDate(alert.created_at, { withTime: true })],
          alert.resolved_at && ['Closed', fmtDate(alert.resolved_at, { withTime: true })],
          alert.resolution_note && ['Resolution', alert.resolution_note],
        ]}
      />

      <div>
        <h3 className="mb-8">Scan history</h3>
        {alert.scans?.length ? (
          <Timeline>
            {alert.scans.map((s) => (
              <TimelineItem
                key={s.id}
                tone={s.result}
                title={`${humanise(s.reason)} via ${s.channel}`}
                meta={
                  <>
                    {fmtDate(s.created_at, { withTime: true })}
                    {[s.city, s.region, s.country].filter(Boolean).length > 0 &&
                      ` · ${[s.city, s.region, s.country].filter(Boolean).join(', ')}`}
                  </>
                }
              />
            ))}
          </Timeline>
        ) : (
          <p className="text-muted text-sm">No scan history is linked to this alert.</p>
        )}
      </div>

      {!closed && (
        <div className="field">
          <label className="label" htmlFor="alertNote">
            Investigation note
          </label>
          <textarea
            className="textarea"
            id="alertNote"
            maxLength={2000}
            placeholder="What did you find? Required before resolving or dismissing."
          />
        </div>
      )}
    </>
  );
}

function AlertActions({ alert, drawer, reload }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (alert.status === 'resolved' || alert.status === 'dismissed') {
    return <p className="text-sm text-muted">This alert is closed.</p>;
  }

  /*
   * Acting on the code closes the alert in the same step, server-side and in
   * one transaction. The investigation note doubles as the reason, so these
   * need a real one - five characters, the same floor as any code change.
   */
  async function actOnCode(kind) {
    const reason = document.getElementById('alertNote')?.value.trim() ?? '';
    if (reason.length < 5) {
      toast('Write in the investigation note why - it is recorded as the reason.', 'error');
      document.getElementById('alertNote')?.focus();
      return;
    }
    if (
      kind === 'void-code' &&
      !window.confirm('Void this code? Every future scan of it will be refused. This cannot be undone here.')
    ) {
      return;
    }

    setBusy(true);
    try {
      await api(`/api/admin/alerts/${alert.id}/${kind}`, { method: 'POST', body: { reason } });
      toast(kind === 'void-code' ? 'Code voided and alert resolved.' : 'Resolved as a false positive.', 'success');
      drawer.close();
      reload();
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  }

  // Only offered where they mean something: the alert must point at a code,
  // and a voided code cannot be cleared.
  const hasCode = Boolean(alert.code_id);
  const canClear = hasCode && alert.code_status !== 'void';
  const canVoid = hasCode && alert.code_status !== 'void';

  async function act(status) {
    // The note lives in the drawer body, which is a sibling subtree; reading
    // it from the DOM keeps the textarea uncontrolled and avoids re-rendering
    // the whole panel on every keystroke.
    const note = document.getElementById('alertNote')?.value.trim() ?? '';

    if ((status === 'resolved' || status === 'dismissed') && note.length < 3) {
      toast('Add a note explaining how this alert was resolved.', 'error');
      document.getElementById('alertNote')?.focus();
      return;
    }

    setBusy(true);
    try {
      await api(`/api/admin/alerts/${alert.id}`, {
        method: 'PATCH',
        body: { status, note: note || undefined },
      });
      toast(`Alert marked ${status}.`, 'success');
      drawer.close();
      reload();
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  }

  return (
    <div className="row row-wrap">
      <button className="btn btn-sm" disabled={busy} onClick={() => act('investigating')}>
        Mark investigating
      </button>
      <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('resolved')}>
        Resolve
      </button>
      <button className="btn btn-sm" disabled={busy} onClick={() => act('dismissed')}>
        Dismiss
      </button>
      {canClear && (
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={() => actOnCode('false-positive')}
          title="The pack is genuine. Clears the code's flag and resolves this alert. A later scan from another device is still flagged as a duplicate."
        >
          Resolve as false positive
        </button>
      )}
      {canVoid && (
        <button
          className="btn btn-sm btn-danger"
          disabled={busy}
          onClick={() => actOnCode('void-code')}
          title="The pack is counterfeit, destroyed or stolen. Every future scan of this code is refused."
        >
          Void this code
        </button>
      )}
    </div>
  );
}
