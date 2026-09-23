/**
 * Export / import controls for a list screen.
 *
 * The import is deliberately two steps. A file from somebody's desktop is
 * checked first and the result shown - how many rows would be created, how
 * many updated, and every row that cannot be, with its row number - and
 * nothing is written until that has been read and confirmed.
 *
 * The alternative, importing on selection, means the first time you learn a
 * column was mis-titled is after 300 products have been created under it.
 */
import { useRef, useState } from 'react';

import { download, upload } from '../../lib/api.js';
import { useToast } from '../../lib/hooks.jsx';
import { Icon } from '../../components/Icons.jsx';

/**
 * @param {object} props
 * @param {'products'|'batches'} props.entity
 * @param {string} props.label     what the rows are, for the messages
 * @param {boolean} props.canWrite whether to offer importing at all
 * @param {Function} [props.onImported] called after a successful write
 */
export default function SpreadsheetTools({ entity, label, canWrite, onImported }) {
  const toast = useToast();
  const fileInput = useRef(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // { file, result }

  async function exportRows() {
    setBusy(true);
    try {
      await download(`/api/admin/export/${entity}.xlsx`);
    } catch (err) {
      toast(err.formMessage ?? `Could not export the ${label}.`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function getTemplate() {
    setBusy(true);
    try {
      await download('/api/admin/import/template.xlsx');
    } catch (err) {
      toast(err.formMessage ?? 'Could not download the template.', 'error');
    } finally {
      setBusy(false);
    }
  }

  /** Step one: check the file and show what it would do. */
  async function inspect(file) {
    if (!file) return;
    setBusy(true);
    try {
      const result = await upload(`/api/admin/import/${entity}`, file, { query: { dryRun: '1' } });
      setPending({ file, result });
    } catch (err) {
      toast(err.formMessage ?? 'That file could not be read.', 'error');
    } finally {
      setBusy(false);
      // Allow the same file to be chosen again after a fix.
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  /** Step two: write it. */
  async function confirm() {
    setBusy(true);
    try {
      const result = await upload(`/api/admin/import/${entity}`, pending.file);
      const parts = [];
      if (result.created) parts.push(`${result.created} added`);
      if (result.updated) parts.push(`${result.updated} updated`);
      toast(parts.length ? `${parts.join(', ')}.` : 'Nothing to import.', 'success');
      setPending(null);
      onImported?.();
    } catch (err) {
      toast(err.formMessage ?? 'The import could not be completed.', 'error');
    } finally {
      setBusy(false);
    }
  }

  const result = pending?.result;
  const willWrite = (result?.created ?? 0) + (result?.updated ?? 0);

  return (
    <>
      <div className="row row-wrap">
        <button type="button" className="btn btn-sm" onClick={exportRows} disabled={busy}>
          <Icon name="download" />
          Export
        </button>

        {canWrite && (
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
            >
              <Icon name="upload" />
              Import
            </button>
            <button type="button" className="btn btn-sm btn-quiet" onClick={getTemplate} disabled={busy}>
              Template
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              hidden
              onChange={(e) => inspect(e.target.files?.[0])}
            />
          </>
        )}
      </div>

      {pending && (
        <div className="import-review" role="dialog" aria-label={`Review the ${label} import`}>
          <div className="import-review-panel">
            <h3>{pending.file.name}</h3>

            <p className="text-sm text-muted mt-8">
              Nothing has been saved yet. This is what the file would do.
            </p>

            <div className="import-tally mt-8">
              {result.created > 0 && (
                <span className="badge badge-good">{result.created} to add</span>
              )}
              {result.updated > 0 && (
                <span className="badge badge-info">{result.updated} to update</span>
              )}
              {result.errors.length > 0 && (
                <span className="badge badge-danger">{result.errors.length} cannot be read</span>
              )}
              {willWrite === 0 && result.errors.length === 0 && (
                <span className="badge badge-neutral">nothing to import</span>
              )}
            </div>

            {result.errors.length > 0 && (
              <div className="import-errors mt-8">
                {/* Row numbers match the spreadsheet, so each one can be
                    opened and corrected directly. */}
                <p className="text-sm">
                  These rows will be skipped. The row numbers match your spreadsheet:
                </p>
                <ul className="text-sm">
                  {result.errors.map((e) => (
                    <li key={e.row}>
                      <strong>Row {e.row}</strong> — {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="row row-between mt-8">
              <button type="button" className="btn btn-sm" onClick={() => setPending(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={confirm}
                disabled={busy || willWrite === 0}
              >
                {willWrite === 0
                  ? 'Nothing to import'
                  : `Import ${willWrite} ${willWrite === 1 ? 'row' : 'rows'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
