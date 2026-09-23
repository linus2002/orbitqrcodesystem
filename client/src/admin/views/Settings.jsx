/**
 * Settings.
 *
 * Two kinds of value, and the difference matters:
 *   - runtime configuration, read-only here because it comes from environment
 *     variables and changing it needs a deploy;
 *   - stored settings, which the team can change live.
 */
import { useState } from 'react';

import { api } from '../../lib/api.js';
import { useApi, usePermission, useToast } from '../../lib/hooks.jsx';
import { fmtNumber } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { Card, TableCard, Table, ErrorNote, Loading } from '../components/ui.jsx';
import ProfileEditor from '../components/ProfileEditor.jsx';

export default function Settings() {
  const canWrite = usePermission('settings:write');
  const { data, error, loading } = useApi('/api/admin/settings');

  useHeader(
    'Settings',
    'Runtime configuration and the values the team can change without a deploy.'
  );

  if (error) return <ErrorNote error={error} />;
  if (loading || !data) return <Loading />;

  const rt = data.runtime;
  const runtimeRows = [
    ['Environment', rt.environment],
    ['Public base URL', rt.publicBaseUrl],
    ['SMS provider', rt.smsProvider],
    ['Session lifetime', `${rt.sessionTtlHours} hours`],
    [
      'Verification limit',
      `${fmtNumber(rt.rateLimits.verifyPerMin)} per minute, ${fmtNumber(
        rt.rateLimits.verifyPerHour
      )} per hour, per source`,
    ],
    ['Sign-in limit', `${fmtNumber(rt.rateLimits.loginPer15Min)} attempts per 15 minutes`],
    ['Report limit', `${fmtNumber(rt.rateLimits.reportPerHour)} per hour, per source`],
    [
      'Code-guessing alert at',
      `${fmtNumber(rt.rateLimits.guessAlertThreshold)} failed lookups in an hour`,
    ],
  ].map(([k, v]) => ({ k, v }));

  return (
    <>
      {/* Your own account first: it is the only thing on this page a
          non-administrator can change. */}
      <Card title="Your profile">
        <ProfileEditor />
      </Card>

      <TableCard title="Adjustable settings">
        <Table
          rows={data.items}
          rowKey={(s) => s.key}
          empty="No stored settings."
          columns={[
            { label: 'Key', render: (s) => <span className="mono text-sm">{s.key}</span> },
            {
              label: 'Value',
              render: (s) =>
                canWrite ? (
                  <SettingInput setting={s} />
                ) : (
                  <span className="mono text-sm">{s.value || '(empty)'}</span>
                ),
            },
            {
              label: 'What it does',
              render: (s) => <span className="text-sm text-muted">{s.description ?? ''}</span>,
            },
          ]}
        />
      </TableCard>

      <TableCard
        title="Runtime configuration"
        footer={
          <div className="card-foot text-sm text-muted">
            These come from environment variables and cannot be changed from the browser. The public
            base URL in particular is baked into every printed QR code - changing it after printing
            would break every pack already in circulation.
          </div>
        }
      >
        <Table
          rows={runtimeRows}
          rowKey={(r) => r.k}
          columns={[
            { label: 'Setting', render: (r) => r.k },
            { label: 'Value', render: (r) => <span className="mono text-sm">{r.v}</span> },
          ]}
        />
      </TableCard>
    </>
  );
}

/** Saves on blur, so typing does not fire a request per keystroke. */
function SettingInput({ setting }) {
  const toast = useToast();
  const [value, setValue] = useState(setting.value);
  const [saved, setSaved] = useState(setting.value);

  async function save() {
    if (value === saved) return;
    try {
      await api(`/api/admin/settings/${encodeURIComponent(setting.key)}`, {
        method: 'PATCH',
        body: { value },
      });
      setSaved(value);
      toast('Setting saved.', 'success');
    } catch (err) {
      toast(err.message, 'error');
      setValue(saved);
    }
  }

  return (
    <input
      className="input input-inline"
      value={value}
      maxLength={500}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}
