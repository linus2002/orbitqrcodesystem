/**
 * The Getmeds lockup: the logo itself, then the name and the system line
 * beside it as plain text.
 *
 * The two text lines stay real text - they scale with the user's font size,
 * they are searchable, and the system line stays legible at sidebar width,
 * which is exactly where a bitmap wordmark falls apart.
 *
 * The image is the company logo as supplied (brand/getmeds-logo.png, served
 * web-sized as /img/getmeds-lockup.png), with its intrinsic size declared so
 * the browser reserves the space before the file arrives and nothing shifts
 * on load. The square cross alone is kept for the favicon, the home-screen
 * icon and the loading animation, which need a square.
 */
/**
 * @param {boolean} [text] false shows the logo alone, with no name or system
 *   line beside it - the customer page, where the logo's own wordmark is
 *   large enough to carry the brand by itself.
 */
export function Logo({ size = 'md', className = '', text = true }) {
  return (
    <span className={`logo logo-${size} ${className}`}>
      <img
        className="logo-mark"
        src="/img/getmeds-lockup.png"
        alt={text ? '' : 'Getmeds'}
        width="1000"
        height="548"
      />
      {text && (
        <span className="logo-text">
          <span className="logo-name">Getmeds</span>
          <span className="logo-sub">QR Counterfeit System</span>
        </span>
      )}
    </span>
  );
}
