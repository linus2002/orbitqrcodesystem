/**
 * Code lookup - the investigation starting point.
 *
 * An analyst has a code (from a patient report, a pharmacist's call, or a
 * flagged alert) and needs its whole story: which batch, how many times it has
 * been checked, from where, and what alerts it raised.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '../../lib/api.js';
import { fmtDate, fmtNumber, humanise } from '../../lib/format.js';
import { useHeader } from '../components/PageHeader.jsx';
import { Icon } from '../../components/Icons.jsx';
import {
  Card, KV, Timeline, TimelineItem, ResultBadge, StatusBadge, Empty,
} from '../components/ui.jsx';

export default function Lookup() {
  const [params] = useSearchParams();
  const [query, setQuery] = useState(params.get('code') ?? '');
  const [record, setRecord] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useHeader('Code lookup', 'Trace a single unit code through its entire history.');

  async function lookup(code) {
    if (!code?.trim()) return;
    setBusy(true);
    setError(null);
    setRecord(null);
    try {
      setRecord(await api('/api/admin/codes/lookup', { query: { code: code.trim() } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Deep link support: /admin/lookup?code=...
  useEffect(() => {
    const preset = params.get('code');
    if (preset) lookup(preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Card title="Find a code">
        <div className="card-body">
          <form
            className="toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              lookup(query);
            }}
          >
            <input
              className="input search grow mono"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="AMX25-260812-088159-BM"
              autoComplete="off"
              spellCheck="false"
            />
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Looking up...' : 'Look up'}
            </button>
          </form>
          <p className="hint mt-8">
            Case and separators do not matter. A full QR URL also works.
          </p>
        </div>
      </Card>

      {error && (
        <div className="alert alert-warn">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      )}

      {record && <CodeRecord code={record} />}
    </>
  );
}

function CodeRecord({ code }) {
  return (
    <>
      <Card title={code.code}>
        <div className="card-body">
          <KV
            rows={[
              ['Product', `${code.product_name} ${code.strength ?? ''}`],
              ['SKU', <span className="mono">{code.sku}</span>],
              [
                'Batch',
                <>
                  <span className="mono">{code.batch_number}</span>{' '}
                  <StatusBadge status={code.batch_status} />
                </>,
              ],
              ['Code status', <StatusBadge status={code.status} />],
              ['Unit number', `#${fmtNumber(code.unit_index + 1)} in the run`],
              ['Manufactured', fmtDate(code.mfg_date)],
              ['Expires', fmtDate(code.expiry_date)],
              ['Total checks', fmtNumber(code.scan_count)],
              ['Successful verifications', fmtNumber(code.verified_count ?? 0)],
              ['First checked', code.first_scan_at ? fmtDate(code.first_scan_at, { withTime: true }) : 'never'],
              ['Last checked', code.last_scan_at ? fmtDate(code.last_scan_at, { withTime: true }) : 'never'],
              code.is_test === 1 && ['Pilot batch', 'Yes'],
              ['QR payload', <span className="mono text-sm">{code.qrPayload}</span>],
            ]}
          />
        </div>
      </Card>

      {code.alerts?.length > 0 && (
        <Card title={`Alerts raised (${code.alerts.length})`}>
          <div className="card-body">
            <Timeline>
              {code.alerts.map((a) => (
                <TimelineItem
                  key={a.id}
                  tone="flagged"
                  title={a.title}
                  meta={`${a.severity} · ${a.status} · ${fmtDate(a.created_at)}`}
                />
              ))}
            </Timeline>
          </div>
        </Card>
      )}

      <Card title={`Scan history (${code.scans.length})`}>
        {code.scans.length ? (
          <div className="card-body">
            <Timeline>
              {code.scans.map((s) => (
                <TimelineItem
                  key={s.id}
                  tone={s.result}
                  title={
                    <>
                      <ResultBadge result={s.result} /> {humanise(s.reason)}
                    </>
                  }
                  meta={
                    <>
                      {fmtDate(s.created_at, { withTime: true })} &middot; {s.channel}
                      {[s.city, s.country].filter(Boolean).length > 0 &&
                        ` · ${[s.city, s.country].filter(Boolean).join(', ')}`}
                      {s.signature_state && ` · QR signature ${s.signature_state}`}
                    </>
                  }
                />
              ))}
            </Timeline>
          </div>
        ) : (
          <Empty message="This code has never been checked." />
        )}
      </Card>
    </>
  );
}
