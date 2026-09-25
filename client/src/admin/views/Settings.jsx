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
            {
              label: 'Setting',
              render: (s) => (
                <>
                  {s.label}
                  <br />
                  <span className="mono text-sm text-muted">{s.key}</span>
                </>
              ),
            },
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
              render: (s) => (
                <span className="text-sm text-muted">
                  {s.description ?? ''}
                  {/* Stated where the change is made, not only in the docs:
                      this is the one setting that weakens detection. */}
                  {s.key === 'alerts.duplicate_threshold' && Number(s.value) > 1 && (
                    <>
                      <br />
                      <strong className="bl-flag">
                        Currently {s.value}: a pack can be verified on {s.value} devices before it
                        is flagged.
                      </strong>
                    </>
                  )}
                </span>
              ),
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

/**
 * Text settings save on blur, so typing does not fire a request per
 * keystroke. Whole-number settings are a picker over their allowed range, so
 * an out-of-range value cannot be typed at all, and a choice is a picker over
 * its options; the server checks both anyway.
 */
function SettingInput({ setting }) {
  const toast = useToast();
  const [value, setValue] = useState(setting.value);
  const [saved, setSaved] = useState(setting.value);

  async function save(next = value) {
    if (next === saved) return;
    try {
      const updated = await api(`/api/admin/settings/${encodeURIComponent(setting.key)}`, {
        method: 'PATCH',
        body: { value: next },
      });
      // The server normalises (trims, parses), so show what it stored.
      setValue(updated.value);
      setSaved(updated.value);
      toast('Setting saved.', 'success');
    } catch (err) {
      toast(err.message, 'error');
      setValue(saved);
    }
  }

  if (setting.kind === 'choice') {
    return (
      <select
        className="select input-inline"
        id={`setting-${setting.key}`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          save(e.target.value);
        }}
      >
        {setting.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  if (setting.kind === 'int') {
    const options = [];
    for (let n = setting.min; n <= setting.max; n++) options.push(String(n));
    return (
      <select
        className="select input-inline"
        id={`setting-${setting.key}`}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (
            setting.key === 'alerts.duplicate_threshold' &&
            Number(next) > Number(saved) &&
            !window.confirm(
              `Allow a pack to be verified on ${next} devices before it is flagged? ` +
                'A cloned pack would pass more checks before anyone is alerted.'
            )
          ) {
            return;
          }
          setValue(next);
          save(next);
        }}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      className="input input-inline"
      value={value}
      maxLength={500}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => save()}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}
