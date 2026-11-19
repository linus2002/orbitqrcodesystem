/**
 * Pack-code QR downloads, shared by the product and batch screens.
 *
 *   QrZipButtons  a whole batch as one ZIP of print files (SVG or PNG)
 *   openCodeQr    one code's QR in the file viewer, with SVG/PNG downloads
 */
import { useState } from 'react';

import { download } from '../../lib/api.js';
import { useToast } from '../../lib/hooks.jsx';
import { Icon } from '../../components/Icons.jsx';

/**
 * Every QR of a batch as one ZIP of print files (SVG or PNG), named in packing
 * order, with a codes.csv inside. Exported for the batch screen too.
 */
export function QrZipButtons({ batch }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  async function get(format) {
    setBusy(format);
    try {
      await download(`/api/admin/batches/${batch.id}/qr.zip?format=${format}`, {
        filename: `${batch.batch_number}-qr-${format}.zip`,
      });
    } catch (err) {
      toast(err.message ?? 'Could not prepare the QR codes.', 'error');
    } finally {
      setBusy(null);
    }
  }
  return ['svg', 'png'].map((format) => (
    <button key={format} type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => get(format)}>
      <Icon name="download" /> {busy === format ? 'Preparing...' : `QRs (${format.toUpperCase()})`}
    </button>
  ));
}

/** A pack code's QR, in the file viewer, with its print downloads. */
export function openCodeQr(viewer, code, { batchNumber } = {}) {
  viewer.open({
    kind: 'qr',
    title: `QR for ${code.code}`,
    subtitle: [batchNumber && `Batch ${batchNumber}`, code.unit_index != null && `unit ${code.unit_index + 1}`]
      .filter(Boolean)
      .join(' · '),
    code: code.code,
    src: `/api/admin/codes/${code.id}/qr.svg?width=320`,
    downloads: [
      { label: 'SVG', url: `/api/admin/codes/${code.id}/qr.svg?download=1`, filename: `${code.code}.svg` },
      { label: 'PNG', url: `/api/admin/codes/${code.id}/qr.png?download=1`, filename: `${code.code}.png` },
    ],
    note: 'Print files: SVG for artwork (vector), PNG at 1024 px. Keep the white border around the code.',
  });
}
