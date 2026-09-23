/**
 * The Orbit lockup: the mark, the name, and the system line beneath it.
 *
 * Kept as a component rather than a flat image so the two text lines stay real
 * text - they scale with the user's font size, they are searchable, and the
 * system line stays legible at sidebar width, which is exactly where a bitmap
 * wordmark falls apart.
 *
 * The mark itself is a bitmap with its intrinsic size declared, so the browser
 * reserves the space before the file arrives and nothing shifts on load.
 */
export function Logo({ size = 'md', className = '' }) {
  return (
    <span className={`logo logo-${size} ${className}`}>
      <img className="logo-mark" src="/img/logo-mark-192.png" alt="" width="192" height="192" />
      <span className="logo-text">
        <span className="logo-name">Orbit</span>
        <span className="logo-sub">QR Counterfeit System</span>
      </span>
    </span>
  );
}
