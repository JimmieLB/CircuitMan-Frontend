import { useEffect, useRef, useState } from 'react';
import { loadCv } from '../helpers/opencv';
import { useCamera } from '../helpers/useCamera';
import { orderCorners, warpBoard, BOARD_W, BOARD_H } from '../helpers/board';
import { HOLES } from '../circuit/holes';
import { detectParts, detectionsToComponents } from './detect';

const KEY = 'breadboard-corners';

function loadCorners() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}

export default function ScanView({ onScanned }) {
  const videoRef = useCamera();
  const snapRef = useRef(null);   // full camera frame, used for calibration clicks
  const outRef = useRef(null);    // warped board with hole overlay
  const cleanRef = useRef(null);  // warped board without overlay (for detection / saving)
  const [cv, setCv] = useState(null);
  const [videoReady, setVideoReady] = useState(false);
  const [corners, setCorners] = useState(loadCorners);
  const [clicks, setClicks] = useState([]);
  const [calibrating, setCalibrating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => { loadCv().then(setCv); }, []);

  function grabFrame() {
    const v = videoRef.current, c = snapRef.current;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return c;
  }

  function startCalibration() {
    grabFrame();
    setClicks([]);
    setCalibrating(true);
  }

  function onSnapClick(e) {
    if (!calibrating) return;
    const c = snapRef.current, r = c.getBoundingClientRect();
    // convert from displayed size to the canvas's real pixel size
    const p = {
      x: ((e.clientX - r.left) * c.width) / r.width,
      y: ((e.clientY - r.top) * c.height) / r.height,
    };
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill();

    const next = [...clicks, p];
    if (next.length < 4) return setClicks(next);

    const ordered = orderCorners(next);
    localStorage.setItem(KEY, JSON.stringify(ordered));
    setCorners(ordered);
    setClicks([]);
    setCalibrating(false);
  }

  // Warps the current frame flat; returns the clean canvas and shows an annotated preview.
  function capture() {
    const src = cv.imread(grabFrame());
    const warped = warpBoard(cv, src, corners);

    cleanRef.current ??= document.createElement('canvas');
    cv.imshow(cleanRef.current, warped);

    for (const h of HOLES)
      cv.circle(warped, new cv.Point(h.x, h.y), 3, [255, 0, 0, 255], -1);
    cv.imshow(outRef.current, warped);

    src.delete();
    warped.delete();
    return cleanRef.current;
  }

  async function scan() {
    setBusy(true);
    setStatus('Detecting parts…');
    try {
      const board = capture();
      const photo = board.toDataURL('image/jpeg', 0.85);
      const detections = await detectParts(board);
      setStatus('');
      if (!detections)
        return onScanned({
          photo, components: [],
          note: 'No detector is configured (set VITE_DETECT_URL), so the photo was loaded for you to trace the parts over.',
        });
      const { components, skipped } = detectionsToComponents(detections);
      onScanned({
        photo, components,
        note: `Found ${components.length} part(s).` + (skipped
          ? ` ${skipped} detection(s) couldn't be matched to holes — add those by hand.`
          : ' Check them against the photo and fix anything that\'s wrong.'),
      });
    } catch (err) {
      setStatus(`Scan failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  // Downloads the clean flattened image, for building the training dataset.
  function saveTrainingImage() {
    capture().toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `board_${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  const ready = cv && corners && videoReady && !calibrating && !busy;

  return (
    <div className="scan">
      <p className="help">
        Point the camera at the breadboard. Calibrate once by clicking its four corners,
        then scan to turn it into an editable circuit.
      </p>
      <div className="camera">
        <video ref={videoRef} muted playsInline onLoadedMetadata={() => setVideoReady(true)}
          style={{ display: calibrating ? 'none' : 'block' }} />
        <canvas ref={snapRef} onClick={onSnapClick}
          style={{ cursor: 'crosshair', display: calibrating ? 'block' : 'none' }} />
      </div>

      <div className="toolbar">
        <button onClick={startCalibration} disabled={!videoReady || busy}>
          {corners ? 'Recalibrate' : 'Calibrate'}
        </button>
        <button className="primary" onClick={scan} disabled={!ready}>Scan board</button>
        <button onClick={saveTrainingImage} disabled={!ready}>Save training image</button>
        {calibrating && <span>Click the board's 4 corners ({clicks.length}/4)</span>}
        {!cv && <span>Loading OpenCV…</span>}
        {!videoReady && <span>Waiting for camera…</span>}
        {cv && videoReady && !corners && !calibrating && <span>Calibrate before scanning.</span>}
        {status && <span>{status}</span>}
      </div>

      <canvas ref={outRef} width={BOARD_W} height={BOARD_H} className="preview" />
    </div>
  );
}
