import { useEffect, useRef, useState } from 'react';
import { loadCv } from '../helpers/opencv';
import { useCamera } from '../helpers/useCamera';
import { orderCorners, warpBoard, BOARD_W, BOARD_H } from '../helpers/board';
import { HOLES } from '../circuit/holes';
import { detectParts, detectionsToComponents, orientLeds } from './detect';
import { saveTrainingFiles } from './trainingExport';
import { autoCalibrate } from './autoCalibrate';

// Calibration is { H, auto: true } from the holes, or { corners } from clicking.
const KEY = 'breadboard-calibration';
const OLD_KEY = 'breadboard-corners';   // corner-only saves from before auto-calibration

function loadCalibration() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved) return saved;
    const corners = JSON.parse(localStorage.getItem(OLD_KEY));
    return corners && { corners };
  } catch {
    return null;
  }
}

function saveCalibration(calib) {
  try { localStorage.setItem(KEY, JSON.stringify(calib)); } catch { /* storage full or blocked */ }
}

export default function ScanView({ onScanned }) {
  const videoRef = useCamera();
  const snapRef = useRef(null);   // full camera frame, used for calibration clicks
  const outRef = useRef(null);    // warped board with hole overlay
  const cleanRef = useRef(null);  // warped board without overlay (for detection / saving)
  const [cv, setCv] = useState(null);
  const [videoReady, setVideoReady] = useState(false);
  const [calib, setCalib] = useState(loadCalibration);
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
    setStatus('');
    setCalibrating(true);
  }

  // Fits the board from its holes in the current frame and shows the result in the preview.
  function runAutoCalibration() {
    const src = cv.imread(grabFrame());
    const fit = autoCalibrate(cv, src);
    if (fit.H) {
      const next = { H: fit.H, auto: true };
      saveCalibration(next);
      setCalib(next);
      showWarp(src, next);
      setStatus(`Calibrated from ${fit.holes} holes. Check that the red dots in the preview sit on the holes.`);
    } else {
      for (const p of fit.candidates) cv.circle(src, new cv.Point(p.x, p.y), 4, [0, 255, 0, 255], 1);
      cv.imshow(outRef.current, src);
      setStatus(`Auto-calibration failed: ${fit.error} The preview circles what looked like holes. Try more even light, or calibrate by corners.`);
    }
    src.delete();
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

    const corners = { corners: orderCorners(next) };
    saveCalibration(corners);
    setCalib(corners);
    setClicks([]);
    setCalibrating(false);
  }

  // Warps a frame flat; returns the clean canvas and shows an annotated preview.
  function showWarp(src, using) {
    const warped = warpBoard(cv, src, using);

    cleanRef.current ??= document.createElement('canvas');
    cv.imshow(cleanRef.current, warped);

    for (const h of HOLES)
      cv.circle(warped, new cv.Point(h.x, h.y), 3, [255, 0, 0, 255], -1);
    cv.imshow(outRef.current, warped);

    warped.delete();
    return cleanRef.current;
  }

  // Auto calibration re-fits on every capture, so a nudged board or camera is followed;
  // the saved fit is the fallback when this frame's holes can't be fitted.
  function capture() {
    const src = cv.imread(grabFrame());
    const fit = calib.auto ? autoCalibrate(cv, src) : null;
    const board = showWarp(src, fit?.H ? { H: fit.H, auto: true } : calib);
    src.delete();
    return board;
  }

  async function scan() {
    setBusy(true);
    setStatus('Detecting parts…');
    try {
      const board = capture();
      const photo = board.toDataURL('image/png');   // lossless, since it may become a training image
      const detections = await detectParts(board);
      setStatus('');
      if (!detections)
        return onScanned({
          photo, components: [],
          note: 'No detector is configured (set VITE_DETECT_URL), so the photo was loaded for you to trace the parts over.',
        });
      const found = detectionsToComponents(detections);
      const { components, unsure } = await orientLeds(found.components);
      onScanned({
        photo, components,
        note: `Found ${components.length} part(s).` + (found.skipped
          ? ` ${found.skipped} detection(s) couldn't be matched to holes — add those by hand.`
          : ' Check them against the photo and fix anything that\'s wrong.')
          + (unsure ? ` ${unsure} LED(s) may be backwards: select one and use "Reverse direction" if so.` : ''),
      });
    } catch (err) {
      setStatus(`Scan failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  // Saves the clean flattened image (to TRAINING_DIR, or downloads), for building the training dataset.
  async function saveTrainingImage() {
    try {
      const blob = await new Promise(r => capture().toBlob(r, 'image/png'));
      const dir = await saveTrainingFiles([{ name: `board_${Date.now()}.png`, blob }]);
      setStatus(dir ? `Saved to ${dir}` : '');
    } catch (err) {
      setStatus(`Save failed: ${err.message}`);
    }
  }

  const ready = cv && calib && videoReady && !calibrating && !busy;

  return (
    <div className="scan">
      <p className="help">
        Point the camera at the breadboard, upright with row a at the top. Auto-calibrate to find
        the board from its holes (or click its four corners), then scan to turn it into an editable circuit.
      </p>
      <div className="camera">
        <video ref={videoRef} muted playsInline onLoadedMetadata={() => setVideoReady(true)}
          style={{ display: calibrating ? 'none' : 'block' }} />
        <canvas ref={snapRef} onClick={onSnapClick}
          style={{ cursor: 'crosshair', display: calibrating ? 'block' : 'none' }} />
      </div>

      <div className="toolbar">
        <button onClick={runAutoCalibration} disabled={!cv || !videoReady || calibrating || busy}>
          Auto-calibrate
        </button>
        <button onClick={startCalibration} disabled={!videoReady || busy}>Calibrate by corners</button>
        <button className="primary" onClick={scan} disabled={!ready}>Scan board</button>
        <button onClick={saveTrainingImage} disabled={!ready}>Save training image</button>
        {calibrating && <span>Click the board's 4 corners ({clicks.length}/4)</span>}
        {!cv && <span>Loading OpenCV…</span>}
        {!videoReady && <span>Waiting for camera…</span>}
        {cv && videoReady && !calib && !calibrating && <span>Calibrate before scanning.</span>}
        {status && <span>{status}</span>}
      </div>

      <canvas ref={outRef} width={BOARD_W} height={BOARD_H} className="preview" />
    </div>
  );
}
