/**
 * Camera QR scanner.
 *
 * jsQR is bundled rather than loaded from a CDN, which is what lets the app
 * keep `script-src 'self'` with no CDN allowance in its Content-Security-Policy.
 *
 * The component owns the MediaStream and guarantees it is released: on
 * unmount, on cancel, on a successful scan, and when the tab is hidden. A
 * leaked camera stream leaves the phone's camera light on, which is alarming
 * on a page about trust.
 */
import { useCallback, useEffect, useRef } from 'react';

export default function Scanner({ onScan, onCancel, onError }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const canvasRef = useRef(null);
  // Guards against firing onScan twice if a frame decodes while we are
  // already tearing down.
  const doneRef = useRef(false);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        onError('This browser cannot open the camera. Please type the code instead.');
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
        onError(
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

          // Centre-crop the square the reticle shows, so what the patient aims
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
              stop();
              onScan(found.data);
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
      if (document.hidden) {
        stop();
        onCancel();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [onScan, onError, onCancel, stop]);

  return (
    <div className="scanner active">
      <div className="scanner-frame">
        <video ref={videoRef} playsInline muted aria-label="Camera view for scanning a QR code" />
        <div className="reticle">
          <div className="reticle-box" />
        </div>
        <p className="scanner-hint">Point the camera at the QR code on the pack</p>
      </div>
      <button className="btn btn-block mt-12" type="button" onClick={onCancel}>
        Cancel scanning
      </button>
    </div>
  );
}
