/**
 * Camera QR scanner.
 *
 * Layout, top to bottom: a status circle (turning while the camera starts and
 * scans, a check once the code is read), the live camera inside a bracketed
 * box, what is happening in words, and one way out.
 *
 * Five UX laws shape it:
 *
 *   - Jakob's law: it looks like the scanner people already know from their
 *     phone's camera and from GCash - live picture, corner brackets, a moving
 *     scan line - so nobody has to learn it.
 *   - Doherty threshold (answer within 0.4 s): every state shows at once. The
 *     status changes the moment the camera starts and the moment a code is
 *     read; the scan line shows it is working even before anything is found.
 *   - Hick's law: while scanning there is exactly one other choice - type the
 *     code instead. No torch, no settings, no gallery.
 *   - Fitts's law: that choice is a full-width button directly under the box,
 *     where the thumb already is.
 *   - Peak-end rule: the moment that is remembered is the code being read, so
 *     it gets a clear check and a short vibration, and the check stays on
 *     screen, over the frozen picture, until the answer is ready (the parent
 *     unmounts the scanner then - see PortalPage). The check starts at once,
 *     so that wait costs nothing.
 *
 * The check means "the code was read", not "the pack is genuine" - the
 * verdict comes from the server, after. So it is drawn in the brand blue, and
 * green stays reserved for the Genuine result.
 *
 * jsQR is bundled rather than loaded from a CDN, which is what lets the app
 * keep `script-src 'self'` with no CDN allowance in its Content-Security-Policy.
 *
 * The component owns the MediaStream and guarantees it is released: on
 * unmount, on cancel, on a successful scan, and when the tab is hidden. A
 * leaked camera stream leaves the phone's camera light on, which is alarming
 * on a page about trust.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icons.jsx';

// No code read after this long: the advice changes to what usually helps.
const SLOW_MS = 9000;

const STATUS = {
  starting: { title: 'Starting the camera...', hint: 'Allow the camera if your phone asks.' },
  scanning: { title: 'Scanning...', hint: 'Fit the QR code on the pack inside the box.' },
  slow: {
    title: 'Still looking...',
    hint: 'Hold steady, a hand away from the pack, in good light.',
  },
  found: { title: 'QR code read', hint: 'Checking the pack...' },
};

export default function Scanner({ onScan, onCancel, onError }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const canvasRef = useRef(null);
  // Guards against firing onScan twice if a frame decodes while we are
  // already tearing down.
  const doneRef = useRef(false);
  // The latest handlers, read when they are called. The camera effect below
  // runs once: if it depended on the handlers, every redraw of the page that
  // passes new ones would stop and restart the camera.
  const on = useRef({});
  on.current = { scan: onScan, cancel: onCancel, error: onError };
  const [phase, setPhase] = useState('starting');
  const [still, setStill] = useState(null);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let slowTimer = null;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        on.current.error('This browser cannot open the camera. Please type the code instead.');
        return;
      }

      // The decoder is ~100 kB, and most patients type the code rather than
      // scan it. Loading it only when the camera actually opens keeps that
      // weight out of the initial page download, which matters on 2G.
      const { default: jsQR } = await import('jsqr');
      if (cancelled) return;

      let stream;
      try {
        // facingMode 'environment' asks for the rear camera - the one pointed
        // at the pack.
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 1280 },
          },
          audio: false,
        });
      } catch (err) {
        on.current.error(
          err.name === 'NotAllowedError'
            ? 'Camera access was blocked. Allow it in your browser settings, or type the code instead.'
            : err.name === 'NotFoundError'
              ? 'No camera was found on this device. Please type the code instead.'
              : 'Could not start the camera. Please type the code instead.'
        );
        return;
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* autoplay can reject if the element unmounted mid-start */
      }
      if (cancelled) return;
      setPhase('scanning');
      slowTimer = setTimeout(() => !cancelled && !doneRef.current && setPhase('slow'), SLOW_MS);

      const canvas = (canvasRef.current ??= document.createElement('canvas'));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const tick = () => {
        if (cancelled || doneRef.current || !streamRef.current) return;

        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          // Downscale before decoding. jsQR is pure JavaScript, and running it
          // on a full 1280px frame every tick drops the preview to single-digit
          // fps on a mid-range phone.
          const size = 480;
          canvas.width = size;
          canvas.height = size;

          // Centre-crop the square the box shows, so what the patient aims
          // at is what actually gets decoded.
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const side = Math.min(vw, vh);
          if (side > 0) {
            ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, size, size);
            const image = ctx.getImageData(0, 0, size, size);
            const found = jsQR(image.data, image.width, image.height, {
              inversionAttempts: 'dontInvert',
            });

            if (found?.data) {
              doneRef.current = true;
              clearTimeout(slowTimer);
              // The camera goes off now, but the box keeps the picture it
              // read (the square just decoded), under the check - it does
              // not go black at the moment of success.
              setStill(canvas.toDataURL('image/jpeg', 0.8));
              stop();
              setPhase('found');
              // Only after a real tap; browsers block (and log) it otherwise.
              if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(60);
              on.current.scan(found.data);
              return;
            }
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    }

    start();

    // Releasing the camera when the tab is hidden is both polite and
    // battery-safe.
    const onVisibility = () => {
      if (document.hidden && !doneRef.current) {
        stop();
        on.current.cancel();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [stop]);

  const status = STATUS[phase];
  const found = phase === 'found';

  return (
    <div className={`scanner active is-${phase}`}>
      {/* On top, the circle: turning while it works, a check once read. */}
      <div className="scan-badge" aria-hidden="true">
        {found ? (
          <svg viewBox="0 0 52 52" className="scan-check">
            <circle cx="26" cy="26" r="23" />
            <path d="M15 27l7 7 15-16" />
          </svg>
        ) : (
          <span className="scan-ring" />
        )}
      </div>

      <div className="scanner-frame">
        <video ref={videoRef} playsInline muted aria-label="Camera view for scanning a QR code" />
        {still && <img className="scanner-still" src={still} alt="" />}
        <div className="reticle" aria-hidden="true">
          <div className="reticle-box">
            <i className="corner tl" />
            <i className="corner tr" />
            <i className="corner bl" />
            <i className="corner br" />
            {!found && phase !== 'starting' && <i className="scan-line" />}
          </div>
        </div>
      </div>

      {/* Under the box, where the eye goes next: what is happening, in words. */}
      <p className="scan-status" role="status" aria-live="polite">
        <strong>{status.title}</strong>
        <span>{status.hint}</span>
      </p>

      <button
        className="btn btn-lg btn-block mt-12"
        type="button"
        onClick={onCancel}
        disabled={found}
      >
        <Icon name="keyboard" />
        Type the code instead
      </button>
    </div>
  );
}
