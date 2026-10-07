import { useEffect, useRef, useState } from 'react';
import { loadCv } from './helpers/opencv';
import { useCamera } from './helpers/useCamera';
import { buildHoles, orderCorners, warpBoard, BOARD_W, BOARD_H } from './helpers/board';

const KEY = 'breadboard-corners';
const holes = buildHoles();

export default function App() {
  const videoRef = useCamera();
  const snapRef = useRef(null);   // full camera frame, used for calibration clicks
  const outRef = useRef(null);    // warped board with hole overlay
  const [cv, setCv] = useState(null);
  const [corners, setCorners] = useState(() =>
    JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  const [clicks, setClicks] = useState([]);
  const [calibrating, setCalibrating] = useState(false);

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

  function capture() {
    if (!cv || !corners) return;
    const src = cv.imread(grabFrame());
    const warped = warpBoard(cv, src, corners);
    for (const h of holes)
      cv.circle(warped, new cv.Point(h.x, h.y), 3, [255, 0, 0, 255], -1);
    cv.imshow(outRef.current, warped);
    src.delete();
    warped.delete();
  }

  return (
    <div style={{ padding: 16 }}>
      <video ref={videoRef} muted playsInline
             style={{ width: 640, display: calibrating ? 'none' : 'block' }} />
      <canvas ref={snapRef} onClick={onSnapClick}
              style={{ width: 640, cursor: 'crosshair',
                       display: calibrating ? 'block' : 'none' }} />

      <div style={{ margin: '8px 0' }}>
        <button onClick={startCalibration}>
          {corners ? 'Recalibrate' : 'Calibrate'}
        </button>{' '}
        <button onClick={capture} disabled={!cv || !corners}>Capture</button>{' '}
        {calibrating && <span>Click the board's 4 corners ({clicks.length}/4)</span>}
        {!cv && <span> Loading OpenCV…</span>}
      </div>

      <canvas ref={outRef} width={BOARD_W} height={BOARD_H}
              style={{ maxWidth: '100%' }} />
    </div>
  );
}