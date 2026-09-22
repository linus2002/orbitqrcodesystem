/**
 * "Report a problem with this pack".
 *
 * Available whatever the scan said, including on a genuine result - the pack
 * may verify correctly while the packaging is obviously wrong, and that is
 * exactly the signal the security team wants.
 */
import { useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icons.jsx';

export default function ReportForm({ result }) {
  const [fields, setFields] = useState({
    description: '',
    purchaseLocation: '',
    reporterName: '',
    reporterContact: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);

  const set = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);

    if (fields.description.trim().length < 10) {
      setError('Please describe the problem in a little more detail (at least 10 characters).');
      return;
    }

    setBusy(true);
    try {
      const res = await api('/api/report', {
        method: 'POST',
        body: {
          code: result.code ?? null,
          scanId: result.scanId ?? null,
          description: fields.description.trim(),
          purchaseLocation: fields.purchaseLocation.trim() || null,
          reporterName: fields.reporterName.trim() || null,
          reporterContact: fields.reporterContact.trim() || null,
        },
      });
      setSent(res);
    } catch (err) {
      setError(
        err.status === 429
          ? 'You have sent several reports recently. Please try again later.'
          : err.message
      );
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="card-body">
        <div className="alert alert-success">
          <Icon name="check" />
          <span>
            <strong>Report sent.</strong> {sent.message}
            <br />
            Your reference is <span className="mono">{sent.reference}</span>.
          </span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card-head">
        <h3>Report this pack</h3>
      </div>
      <div className="card-body">
        <form className="report-form" onSubmit={submit} noValidate>
          <div className="field">
            <label className="label" htmlFor="rDesc">
              What looks wrong? <span className="text-muted">(required)</span>
            </label>
            <textarea
              className="textarea"
              id="rDesc"
              value={fields.description}
              onChange={set('description')}
              maxLength={2000}
              autoFocus
              placeholder="For example: the seal was already broken, the printing is blurry, the tablets look different from last time."
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="rWhere">
              Where did you buy it?
            </label>
            <input
              className="input"
              id="rWhere"
              value={fields.purchaseLocation}
              onChange={set('purchaseLocation')}
              maxLength={200}
              placeholder="Pharmacy or shop name and town"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="rName">
              Your name <span className="text-muted">(optional)</span>
            </label>
            <input
              className="input"
              id="rName"
              value={fields.reporterName}
              onChange={set('reporterName')}
              maxLength={120}
              autoComplete="name"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="rContact">
              Email or phone <span className="text-muted">(optional)</span>
            </label>
            <input
              className="input"
              id="rContact"
              value={fields.reporterContact}
              onChange={set('reporterContact')}
              maxLength={160}
              autoComplete="email"
            />
            <p className="hint">
              Only used if the security team needs to ask you a follow-up question.
            </p>
          </div>

          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}

          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? (
              <>
                <span className="spinner" aria-hidden="true" /> Sending...
              </>
            ) : (
              'Send report'
            )}
          </button>
        </form>
      </div>
    </>
  );
}
