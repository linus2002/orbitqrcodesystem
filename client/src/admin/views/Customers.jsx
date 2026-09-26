/**
 * Customers - the people who gave their details on the public portal.
 *
 * The portal asks, once per browser, who is checking: name, mobile number,
 * email, and whether they are the patient, a pharmacist and so on. This is
 * where the security team finds them - to follow up a flagged pack with the
 * person holding it, or to see who has been checking a batch.
 *
 * Security-team only: behind 'scans:read', like the scan log, because every
 * row names an individual. A regulator sees aggregates only.
 */
import { useState } from 'react';

import { api } from '../../lib/api.js';
import { useApi, useDebounced, usePermission, useToast } from '../../lib/hooks.jsx';
import { fmtDate, fmtNumber, fmtRelative } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { useDrawer } from '../components/Drawer.jsx';
import { Icon } from '../../components/Icons.jsx';
import {
  TableCard, Table, Pager, Toolbar, Spacer, Select, KV, ResultBadge, ErrorNote, Loading,
} from '../components/ui.jsx';

/** The same choices the portal form offers, in the same words. */
const ROLES = [
  { value: 'patient', label: 'Patient' },
  { value: 'caregiver', label: 'Caregiver or family member' },
  { value: 'pharmacist', label: 'Pharmacist' },
  { value: 'health_worker', label: 'Doctor, nurse or health worker' },
  { value: 'retailer', label: 'Retailer or distributor' },
  { value: 'other', label: 'Other' },
];
const roleLabel = (role) => ROLES.find((r) => r.value === role)?.label ?? role;

/** What a removed person's name, mobile and email read as (services/verifiers.js). */
const REMOVED = '(removed)';

export default function Customers() {
  const [filters, setFilters] = useState({ page: 1, role: '' });
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const drawer = useDrawer();

  useHeader('Customers', 'Who has been checking medicines on the portal, and how to reach them.');

  const { data, error, loading, reload } = useApi('/api/admin/customers', {
    query: { ...filters, search: debounced, pageSize: 25 },
  });

  const exportParams = new URLSearchParams();
  if (filters.role) exportParams.set('role', filters.role);
  if (debounced) exportParams.set('search', debounced);

  if (error) return <ErrorNote error={error} />;

  return (
    <>
      <Toolbar>
        <input
          className="input input-inline"
          type="search"
          placeholder="Search name, number or email"
          aria-label="Search customers"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setFilters((f) => ({ ...f, page: 1 }));
          }}
        />
        <Select
          label="Filter by who they are"
          allLabel="Everyone"
          value={filters.role}
          onChange={(role) => setFilters({ page: 1, role })}
          options={ROLES}
        />
        <Spacer />
        <a className="btn btn-sm" href={`/api/admin/customers.csv?${exportParams}`} download>
          <Icon name="down" /> Export CSV
        </a>
      </Toolbar>

      <TableCard
        title={`${fmtNumber(data?.total ?? 0)} people`}
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
          empty="Nobody has given their details yet."
          onRowClick={(row) =>
            drawer.open({
              title: row.full_name,
              subtitle: roleLabel(row.role),
              body: <CustomerDetail id={row.id} />,
              footer: <CustomerActions person={row} drawer={drawer} reload={reload} />,
            })
          }
          columns={[
            {
              label: 'Name',
              render: (r) => (
                <>
                  {r.full_name}
                  <br />
                  <span className="text-muted text-sm">{roleLabel(r.role)}</span>
                </>
              ),
            },
            { label: 'Mobile', className: 'code', render: (r) => r.phone },
            { label: 'Email', render: (r) => r.email },
            { label: 'City', render: (r) => r.city ?? '-' },
            {
              label: 'Checks',
              render: (r) => (
                <>
                  {fmtNumber(r.check_count)}
                  {r.flagged_count > 0 && (
                    <>
                      {' '}
                      <span className="badge badge-danger">{fmtNumber(r.flagged_count)} flagged</span>
                    </>
                  )}
                </>
              ),
            },
            {
              label: 'Last check',
              render: (r) =>
                r.last_check_at ? fmtRelative(r.last_check_at) : <span className="text-muted">none yet</span>,
            },
            { label: 'Since', render: (r) => fmtDate(r.created_at) },
          ]}
        />
      </TableCard>
    </>
  );
}

/** One person: how to reach them, what they agreed to, and their recent checks. */
function CustomerDetail({ id }) {
  const { data, error, loading } = useApi(`/api/admin/customers/${id}`);

  if (error) return <ErrorNote error={error} />;
  if (loading || !data) return <Loading />;

  return (
    <>
      <KV
        rows={[
          ['Mobile', <span className="mono">{data.phone}</span>],
          ['Email', data.email],
          ['Who', roleLabel(data.role)],
          ['City', data.city ?? 'not given'],
          ['Got the medicine from', data.purchase_location ?? 'not given'],
          ['Consent given', fmtDate(data.consent_at, { withTime: true })],
          ['Checks', fmtNumber(data.check_count)],
          ['First seen', fmtDate(data.created_at, { withTime: true })],
        ]}
      />
      <div>
        <h3 className="mb-8">Recent checks</h3>
        <Table
          rows={data.scans}
          empty="No checks yet."
          columns={[
            { label: 'When', render: (s) => fmtDate(s.created_at, { withTime: true }) },
            { label: 'Code', className: 'code', render: (s) => s.code_text },
            {
              label: 'Product',
              render: (s) => s.product_name ?? <span className="text-muted">not in registry</span>,
            },
            { label: 'Result', render: (s) => <ResultBadge result={s.result} /> },
          ]}
        />
      </div>
    </>
  );
}

/**
 * What an administrator can do on a person's request, under the privacy
 * notice: correct their details, or remove them. Admin only - the server
 * checks the same permission.
 */
function CustomerActions({ person, drawer, reload }) {
  const canWrite = usePermission('customers:write');
  if (!canWrite || person.full_name === REMOVED) return null;

  const open = (title, body) => drawer.open({ title, subtitle: person.full_name, body });

  return (
    <div className="row row-wrap">
      <button
        className="btn btn-sm"
        type="button"
        onClick={() => open('Correct details', <CorrectForm person={person} drawer={drawer} reload={reload} />)}
      >
        Correct details
      </button>
      <button
        className="btn btn-sm btn-danger"
        type="button"
        onClick={() =>
          open("Remove this person's details", <RemoveForm person={person} drawer={drawer} reload={reload} />)
        }
      >
        Remove details
      </button>
    </div>
  );
}

/** The reason box both forms end with: it goes into the audit log. */
function ReasonField({ id, value, onChange, hint }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        Reason <span className="text-muted">(required)</span>
      </label>
      <textarea className="textarea" id={id} value={value} onChange={onChange} maxLength={300} />
      <p className="hint">{hint}</p>
    </div>
  );
}

function CorrectForm({ person, drawer, reload }) {
  const toast = useToast();
  const initial = {
    fullName: person.full_name ?? '',
    phone: person.phone ?? '',
    email: person.email ?? '',
    city: person.city ?? '',
    purchaseLocation: person.purchase_location ?? '',
  };
  const [form, setForm] = useState(initial);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    // Only what was changed is sent, so nothing else is touched or logged.
    const changed = Object.fromEntries(
      Object.entries(form).filter(([key, value]) => value.trim() !== initial[key].trim())
    );
    if (!Object.keys(changed).length) {
      setError('Nothing has been changed.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/admin/customers/${person.id}`, {
        method: 'PATCH',
        body: { ...changed, reason: reason.trim() },
      });
      toast('Details corrected.', 'success');
      drawer.close();
      reload();
    } catch (err) {
      setError(err.formMessage);
      setBusy(false);
    }
  }

  const field = (key, label, props = {}) => (
    <div className="field">
      <label className="label" htmlFor={`c-${key}`}>{label}</label>
      <input className="input" id={`c-${key}`} value={form[key]} onChange={set(key)} {...props} />
    </div>
  );

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {field('fullName', 'Full name', { maxLength: 120 })}
      {field('phone', 'Mobile number', { maxLength: 32, type: 'tel' })}
      {field('email', 'Email address', { type: 'email' })}
      {field('city', 'City or municipality', { maxLength: 120 })}
      {field('purchaseLocation', 'Where they got the medicine', { maxLength: 200 })}
      <ReasonField
        id="cReason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        hint="For example: the person called on 26 Sept to correct their mobile number."
      />
      {error && <p className="field-error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
        {busy ? 'Saving...' : 'Save the correction'}
      </button>
    </form>
  );
}

function RemoveForm({ person, drawer, reload }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api(`/api/admin/customers/${person.id}/remove`, {
        method: 'POST',
        body: { reason: reason.trim() },
      });
      toast("The person's details have been removed.", 'success');
      drawer.close();
      reload();
    } catch (err) {
      setError(err.formMessage);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="alert alert-warn">
        <Icon name="alert" />
        <span>
          This cannot be undone. Their name, mobile number, email, city and where they got the
          medicine are removed, as are the name and contact they typed into reports. Their
          phone will be asked for details again. Their past checks stay in the scan log without
          their name, so the record of what was checked, when and where is kept.
        </span>
      </div>
      <ReasonField
        id="rReason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        hint="For example: the person asked by phone on 26 Sept for their details to be removed."
      />
      {error && <p className="field-error" role="alert">{error}</p>}
      <button className="btn btn-danger btn-block" type="submit" disabled={busy}>
        {busy ? 'Removing...' : 'Remove their details'}
      </button>
    </form>
  );
}
