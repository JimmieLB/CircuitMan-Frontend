import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BOARD_W, BOARD_H, PITCH } from '../helpers/board';
import { HOLES, holeAt, holePoint, holeStrip, makeBoard, splitHole } from '../circuit/holes';
import { PARTS, LED_COLORS, ledColorName, makeComponent, dipPins } from '../circuit/parts';
import { formatCurrent } from '../sim/spice';
import { SevenSegmentBody, segStates } from './SevenSegment';

const ROW_LABELS = { a: 100, b: 120, c: 140, d: 160, e: 180, f: 240, g: 260, h: 280, i: 300, j: 320 };
const MIN_ZOOM = 0.15, MAX_ZOOM = 3;
const HANDLE_H = 26;     // board title bar above each board
const DRAG_SLOP = 4;     // px a press can move and still count as a click

// An infinite canvas of breadboards. Drag empty canvas to pan, scroll to zoom,
// drag a board by its title bar to move it. Parts and wires can go on any
// board or run between boards.
export default function BreadboardEditor({
  boards, onBoardsChange, onDeleteBoard, selectedBoard, onSelectBoard,
  components, onChange, onUpdatePart, netlist, sim, selectedId, onSelect, tool, showPhotos,
}) {
  const svgRef = useRef(null);
  const [view, setView] = useState({ x: 40, y: 40, k: 0.6 });   // screen = world × k + (x, y)
  const [hover, setHover] = useState(null);                    // hole id under the pointer
  const [pending, setPending] = useState([]);                  // holes clicked so far for the part being placed
  const gesture = useRef(null);                                // pan or board drag in progress

  const boardMap = new Map(boards.map(b => [b.id, b]));
  const occupied = new Set(components.flatMap(c => c.pins));
  const part = tool && PARTS[tool];
  const hoverStrip = hover && boardMap.has(splitHole(hover)[0]) ? holeStrip(hover) : null;

  const toWorld = (clientX, clientY) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  };

  function fit(list = boards) {
    const svg = svgRef.current;
    if (!svg || !list.length) return;
    const pad = 40;
    const x0 = Math.min(...list.map(b => b.x)), y0 = Math.min(...list.map(b => b.y)) - HANDLE_H;
    const x1 = Math.max(...list.map(b => b.x + BOARD_W)), y1 = Math.max(...list.map(b => b.y + BOARD_H));
    const { width, height } = svg.getBoundingClientRect();
    const k = Math.min(1, MAX_ZOOM, (width - 2 * pad) / (x1 - x0), (height - 2 * pad) / (y1 - y0));
    setView({ k, x: (width - (x1 - x0) * k) / 2 - x0 * k, y: (height - (y1 - y0) * k) / 2 - y0 * k });
  }
  useLayoutEffect(() => fit(), []);   // eslint-disable-line react-hooks/exhaustive-deps
  // Switching tools drops a half-placed part, but keeps the view.
  useEffect(() => setPending([]), [tool]);

  // Wheel zooms around the cursor. Needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    function onWheel(e) {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      setView(v => {
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) };
      });
    }
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  function zoomBy(f) {
    const { width, height } = svgRef.current.getBoundingClientRect();
    setView(v => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * f));
      return { k, x: width / 2 - (width / 2 - v.x) * (k / v.k), y: height / 2 - (height / 2 - v.y) * (k / v.k) };
    });
  }

  function addBoard() {
    const b = makeBoard(boards);
    const next = [...boards, b];
    onBoardsChange(next);
    onSelectBoard(b.id);
    fit(next);
  }

  // ----- pointer: pan / click on the canvas -----
  function onPointerDown(e) {
    if (e.button !== 0 && e.button !== 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, view, moved: false };
  }

  function onPointerMove(e) {
    const g = gesture.current;
    if (g) {
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      g.moved = true;
      if (g.kind === 'pan') setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
      else {
        const snap = v => Math.round(v / PITCH) * PITCH;
        const x = snap(g.bx + dx / view.k), y = snap(g.by + dy / view.k);
        onBoardsChange(bs => bs.map(b => (b.id === g.id ? { ...b, x, y } : b)));
      }
      return;
    }
    const h = holeAt(toWorld(e.clientX, e.clientY), boardMap);
    if (h !== hover) setHover(h);
  }

  function onPointerUp(e) {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.moved || g.kind !== 'pan' || e.button !== 0) return;
    click(e);
  }

  function click(e) {
    const hole = holeAt(toWorld(e.clientX, e.clientY), boardMap);
    if (!part) {
      onSelect(null);
      onSelectBoard(hole ? splitHole(hole)[0] : null);
      return;
    }
    if (!hole || occupied.has(hole) || pending.includes(hole)) return;
    const pins = part.dip ? dipPins(hole, part.pins.length) : [...pending, hole];
    if (!pins || pins.some(p => occupied.has(p))) return;
    if (pins.length < part.pins.length) return setPending(pins);
    onChange([...components, makeComponent(tool, pins, components)]);
    setPending([]);
  }

  // ----- board title bar: drag to move -----
  const startBoardDrag = b => e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectBoard(b.id);
    gesture.current = { kind: 'board', id: b.id, sx: e.clientX, sy: e.clientY, bx: b.x, by: b.y, moved: false };
  };

  let hint;
  if (!part) hint = 'Drag the canvas to pan, scroll to zoom, drag a board by its title bar. Pick a part to place it.';
  else if (part.dip) hint = `Click pin 1 of the ${part.label}: row f puts the notch on the left, row e flips it.`;
  else hint = `Click the hole for ${part.label} pin "${part.pins[pending.length]}" (${pending.length + 1}/${part.pins.length}). Pins can go on different boards. Esc cancels.`;

  return (
    <div className="board-editor">
      <div className="canvas-wrap">
        <svg ref={svgRef} className={`canvas${tool ? ' placing' : ''}`}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={() => { gesture.current = null; }} onPointerLeave={() => setHover(null)}>
          <defs>
            <filter id="seg-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" />
            </filter>
            <filter id="led-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="9" />
            </filter>
            <pattern id="canvas-grid" width={2 * PITCH} height={2 * PITCH} patternUnits="userSpaceOnUse"
              patternTransform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <circle cx={1} cy={1} r={1.5} className="grid-dot" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#canvas-grid)" />

          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {boards.map(b => (
              <g key={b.id} transform={`translate(${b.x} ${b.y})`}>
                <g className={`board-handle${b.id === selectedBoard ? ' selected' : ''}`}
                  onPointerDown={startBoardDrag(b)}>
                  <rect y={-HANDLE_H - 4} width={BOARD_W} height={HANDLE_H} rx={6} />
                  <text x={12} y={-HANDLE_H / 2 + 1}>⠿ {b.id}</text>
                </g>
                {boards.length > 1 && (
                  <g className="board-delete" role="button" tabIndex={0} aria-label={`Delete breadboard ${b.id}`}
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onDeleteBoard(b.id); }}
                    onKeyDown={e => { if (e.key === 'Enter') onDeleteBoard(b.id); }}>
                    <title>Delete {b.id}</title>
                    <rect x={BOARD_W - 30} y={-HANDLE_H - 1} width={22} height={HANDLE_H - 6} rx={4} />
                    <text x={BOARD_W - 19} y={-HANDLE_H / 2 + 1} textAnchor="middle">×</text>
                  </g>
                )}
                {showPhotos && b.photo
                  ? <image href={b.photo} width={BOARD_W} height={BOARD_H} />
                  : <BoardBackground />}
                {b.id === selectedBoard && <rect width={BOARD_W} height={BOARD_H} rx={14} className="board-outline" />}
                <BoardHoles litStrip={hoverStrip?.startsWith(`${b.id}:`) ? hoverStrip.slice(b.id.length + 1) : null} />
              </g>
            ))}

            {components.map(c => c.pins.every(p => boardMap.has(splitHole(p)[0])) && (
              <PartOnBoard key={c.id} c={c} pts={c.pins.map(p => holePoint(p, boardMap))} netlist={netlist}
                led={sim.leds.get(c.id)} segs={c.type === 'seg7' ? segStates(sim.leds, c.id) : null}
                selected={c.id === selectedId}
                interactive={!tool} onSelect={() => onSelect(c.id)}
                onUpdate={patch => onUpdatePart(c.id, patch)}
                toWorldX={clientX => toWorld(clientX, 0).x} />
            ))}

            {pending.map(id => {
              const p = holePoint(id, boardMap);
              return <circle key={id} cx={p.x} cy={p.y} r={7} className="pending" />;
            })}
          </g>
        </svg>

        <div className="canvas-tools">
          <button onClick={addBoard} title="Add another breadboard to the canvas">+ Breadboard</button>
          <button onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out">−</button>
          <span className="mono">{Math.round(view.k * 100)}%</span>
          <button onClick={() => zoomBy(1.25)} aria-label="Zoom in">+</button>
          <button onClick={() => fit()} title="Fit every board in view">Fit</button>
        </div>
      </div>
      <div className="board-status">
        <span>{hint}</span>
        {hover && <span className="mono">{hover} · {hoverStrip}</span>}
      </div>
    </div>
  );
}

// The holes of one board. Memoised: there are ~830 per board, and only the hovered board's strip changes.
const BoardHoles = memo(function BoardHoles({ litStrip }) {
  return HOLES.map(h => (
    <rect key={h.id} x={h.x - 5} y={h.y - 5} width={10} height={10} rx={2}
      className={h.strip === litStrip ? 'hole lit' : 'hole'} />
  ));
});

const BoardBackground = memo(function BoardBackground() {
  return (
    <g className="board-bg">
      <rect width={BOARD_W} height={BOARD_H} rx={14} className="plastic" />
      <rect x={0} y={200} width={BOARD_W} height={20} className="channel" />
      <line x1={50} x2={1250} y1={8} y2={8} className="rail-plus" />
      <line x1={50} x2={1250} y1={52} y2={52} className="rail-minus" />
      <line x1={50} x2={1250} y1={368} y2={368} className="rail-plus" />
      <line x1={50} x2={1250} y1={412} y2={412} className="rail-minus" />
      {Object.entries(ROW_LABELS).map(([r, y]) => (
        <text key={r} x={12} y={y + 4} className="label">{r}</text>
      ))}
      {Array.from({ length: 13 }, (_, i) => i * 5 + 1).map(n => (
        <text key={n} x={(n + 0.5) * 20} y={84} textAnchor="middle" className="label">{n}</text>
      ))}
    </g>
  );
});

// `pts` are the part's pin positions on the canvas.
function PartOnBoard({ c, pts, netlist, led, segs, selected, interactive, onSelect, onUpdate, toWorldX }) {
  const part = PARTS[c.type];
  const fill = c.type === 'led' ? LED_COLORS[ledColorName(c.value)] : part.color;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;

  const click = e => { e.stopPropagation(); onSelect(); };
  const cls = `part${selected ? ' selected' : ''}`;
  const style = { pointerEvents: interactive ? 'auto' : 'none' };
  // Parts take their own clicks, so pressing on one doesn't start a pan.
  const down = e => e.stopPropagation();
  const pinDots = pts.map((p, i) => (
    <circle key={i} cx={p.x} cy={p.y} r={5} className="pin"
      fill={netlist.pinNet.get(`${c.id}:${i}`)?.color} />
  ));

  if (c.type === 'wire') {
    return (
      <g className={cls} onClick={click} onPointerDown={down} style={style}>
        <line x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y}
          stroke={part.color} strokeWidth={7} strokeLinecap="round" className="body" />
        {pinDots}
      </g>
    );
  }

  const leads = pts.map((p, i) => <line key={i} x1={p.x} y1={p.y} x2={cx} y2={cy} className="lead" />);

  let body;
  if (c.type === 'seg7') {
    // The package covers its pins, as a real one does; selecting it shows them with their names.
    return (
      <g className={cls} onClick={click} onPointerDown={down} style={style}>
        <title>{`${c.ref} ${part.label} ${c.value}`}</title>
        <SevenSegmentBody c={c} pts={pts} segs={segs} selected={selected} />
        {selected && pinDots}
      </g>
    );
  }

  if (part.dip) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x0 = Math.min(...xs) - 10, x1 = Math.max(...xs) + 10;
    const y0 = Math.min(...ys) + 6, y1 = Math.max(...ys) - 6;
    body = (
      <>
        <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={3} fill={part.color} className="body" />
        <circle cx={pts[0].x} cy={pts[0].y < cy ? y0 + 8 : y1 - 8} r={3} fill={part.ink} />
        <text x={cx} y={cy - 3} textAnchor="middle" fill={part.ink} className="part-text">{c.ref}</text>
        <text x={cx} y={cy + 12} textAnchor="middle" fill={part.ink} className="part-sub">{c.value}</text>
      </>
    );
  } else if (c.type === 'button') {
    body = (
      <>
        {leads}
        <rect x={cx - 22} y={cy - 22} width={44} height={44} rx={5} fill={fill} className="body" />
        <ButtonCap cx={cx} cy={cy} pressed={!!c.pressed} latched={!!c.latched} label={c.ref}
          onPress={pressed => onUpdate({ pressed })}
          onLatch={latched => onUpdate({ latched, pressed: latched })} />
        <text x={cx} y={cy - 28} textAnchor="middle" className="part-label">{c.ref}</text>
      </>
    );
  } else if (c.type === 'pot') {
    body = (
      <>
        {leads}
        <rect x={cx - 36} y={cy - 18} width={72} height={36} rx={6} fill={fill} className="body" />
        <text x={cx} y={cy - 3} textAnchor="middle" fill={part.ink} className="part-text">{c.ref}</text>
        <PotSlider cx={cx} cy={cy + 9} wiper={c.wiper ?? 0.5} label={c.ref}
          onChange={wiper => onUpdate({ wiper })} toWorldX={toWorldX} />
      </>
    );
  } else {
    body = (
      <>
        {led?.on && (
          <circle cx={cx} cy={cy} r={22 + 22 * led.brightness} fill={fill}
            opacity={0.35 + 0.55 * led.brightness} filter="url(#led-glow)" className="glow" />
        )}
        {leads}
        <rect x={cx - 24} y={cy - 12} width={48} height={24} rx={6} fill={fill} className="body"
          opacity={c.type === 'led' && !led?.on ? 0.5 : 1} />
        <text x={cx} y={cy + 5} textAnchor="middle" fill={part.ink} className="part-text">{c.ref}</text>
        {led?.over && (
          <text x={cx} y={cy - 20} textAnchor="middle" className="warn">⚠ {formatCurrent(led.current)}</text>
        )}
      </>
    );
  }

  return (
    <g className={cls} onClick={click} onPointerDown={down} style={style}>
      <title>{`${c.ref} ${part.label} ${c.value}`}</title>
      {body}
      {pinDots}
    </g>
  );
}

const clamp01 = x => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
const isPressKey = e => e.key === ' ' || e.key === 'Enter';

// Momentary push button: pressed while the pointer (or Space/Enter) is held down.
// Double-click latches it down; double-click again to release.
function ButtonCap({ cx, cy, pressed, latched, label, onPress, onLatch }) {
  const set = down => e => {
    e.stopPropagation();
    if (latched) return;   // a latched button ignores single presses
    if (down) e.currentTarget.setPointerCapture(e.pointerId);
    if (down !== pressed) onPress(down);
  };
  const cls = ['cap', pressed && 'pressed', latched && 'latched'].filter(Boolean).join(' ');
  return (
    <g className={cls} role="button" tabIndex={0}
      aria-label={`Press ${label}`} aria-pressed={pressed}
      onPointerDown={set(true)} onPointerUp={set(false)} onPointerCancel={set(false)}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => { e.stopPropagation(); onLatch(!latched); }}
      onKeyDown={e => { if (isPressKey(e) && !latched) { e.preventDefault(); if (!e.repeat) onPress(true); } }}
      onKeyUp={e => { if (isPressKey(e) && !latched) onPress(false); }}
      onBlur={() => { if (pressed && !latched) onPress(false); }}>
      <title>{latched ? `${label} is latched: double-click to release` : `Hold to press ${label}, double-click to keep it pressed`}</title>
      <circle cx={cx} cy={cy} r={15} className="cap-ring" />
      <circle cx={cx} cy={cy} r={pressed ? 10 : 12} className="cap-top" />
    </g>
  );
}

const TRACK = 52;

// Drag the knob (or click the track, or use the arrow keys) to move the wiper.
function PotSlider({ cx, cy, wiper, label, onChange, toWorldX }) {
  const x0 = cx - TRACK / 2;
  const setFrom = e => onChange(clamp01((toWorldX(e.clientX) - x0) / TRACK));
  const steps = { ArrowLeft: -0.05, ArrowDown: -0.05, ArrowRight: 0.05, ArrowUp: 0.05 };
  return (
    <g className="slider" role="slider" tabIndex={0} aria-label={`${label} wiper`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(wiper * 100)}
      onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setFrom(e); }}
      onPointerMove={e => { e.stopPropagation(); if (e.currentTarget.hasPointerCapture(e.pointerId)) setFrom(e); }}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        if (!(e.key in steps)) return;
        e.preventDefault();
        onChange(clamp01(wiper + steps[e.key]));
      }}>
      <rect x={x0 - 8} y={cy - 8} width={TRACK + 16} height={16} className="hit" />
      <line x1={x0} x2={x0 + TRACK} y1={cy} y2={cy} className="track" />
      <line x1={x0} x2={x0 + wiper * TRACK} y1={cy} y2={cy} className="track-fill" />
      <circle cx={x0 + wiper * TRACK} cy={cy} r={6} className="knob" />
    </g>
  );
}
