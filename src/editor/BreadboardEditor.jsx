import { useRef, useState } from 'react';
import { BOARD_W, BOARD_H } from '../helpers/board';
import { HOLES, HOLE_BY_ID, snapToHole } from '../circuit/holes';
import { PARTS, LED_COLORS, ledColorName, makeComponent, dipPins } from '../circuit/parts';
import { formatCurrent } from '../sim/spice';

const ROW_LABELS = { a: 100, b: 120, c: 140, d: 160, e: 180, f: 240, g: 260, h: 280, i: 300, j: 320 };

export default function BreadboardEditor({
  components, onChange, onUpdatePart, netlist, sim, selectedId, onSelect, tool, photo,
}) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [pending, setPending] = useState([]);   // holes clicked so far for the part being placed

  const occupied = new Set(components.flatMap(c => c.pins));
  const part = tool && PARTS[tool];

  function holeAt(e) {
    const pt = new DOMPoint(e.clientX, e.clientY)
      .matrixTransform(svgRef.current.getScreenCTM().inverse());
    return snapToHole(pt);
  }

  const toBoardX = clientX =>
    new DOMPoint(clientX, 0).matrixTransform(svgRef.current.getScreenCTM().inverse()).x;

  function onMove(e) {
    const h = holeAt(e);
    if (h?.id !== hover?.id) setHover(h);
  }

  function onClick(e) {
    if (!part) return onSelect(null);
    const hole = holeAt(e);
    if (!hole || occupied.has(hole.id) || pending.includes(hole.id)) return;

    const pins = part.dip ? dipPins(hole.id, part.pins.length) : [...pending, hole.id];
    if (!pins || pins.some(p => occupied.has(p))) return;
    if (pins.length < part.pins.length) return setPending(pins);

    const c = makeComponent(tool, pins, components);
    onChange([...components, c]);
    setPending([]);
  }

  let hint;
  if (!part) hint = 'Pick a part to place it, or click a part to edit it.';
  else if (part.dip) hint = `Click pin 1 of the ${part.label}: row f puts the notch on the left, row e flips it.`;
  else hint = `Click the hole for ${part.label} pin "${part.pins[pending.length]}" (${pending.length + 1}/${part.pins.length}). Esc cancels.`;

  return (
    <div className="board-editor">
      <svg ref={svgRef} viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} className={tool ? 'board placing' : 'board'}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)} onClick={onClick}>
        <defs>
          <filter id="led-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
        </defs>
        {photo
          ? <image href={photo} width={BOARD_W} height={BOARD_H} />
          : <BoardBackground />}

        {HOLES.map(h => (
          <rect key={h.id} x={h.x - 5} y={h.y - 5} width={10} height={10} rx={2}
            className={hover && h.strip === hover.strip ? 'hole lit' : 'hole'} />
        ))}

        {components.map(c => (
          <PartOnBoard key={c.id} c={c} netlist={netlist} led={sim.leds.get(c.id)} selected={c.id === selectedId}
            interactive={!tool} onSelect={() => onSelect(c.id)}
            onUpdate={patch => onUpdatePart(c.id, patch)} toBoardX={toBoardX} />
        ))}

        {pending.map(id => {
          const h = HOLE_BY_ID.get(id);
          return <circle key={id} cx={h.x} cy={h.y} r={7} className="pending" />;
        })}
      </svg>
      <div className="board-status">
        <span>{hint}</span>
        {hover && <span className="mono">{hover.id} · {hover.strip}</span>}
      </div>
    </div>
  );
}

function BoardBackground() {
  return (
    <g className="board-bg">
      <rect width={BOARD_W} height={BOARD_H} rx={14} className="plastic" />
      <rect x={0} y={200} width={BOARD_W} height={20} className="channel" />
      <line x1={50} x2={1250} y1={16} y2={16} className="rail-plus" />
      <line x1={50} x2={1250} y1={62} y2={62} className="rail-minus" />
      <line x1={50} x2={1250} y1={360} y2={360} className="rail-plus" />
      <line x1={50} x2={1250} y1={408} y2={408} className="rail-minus" />
      {Object.entries(ROW_LABELS).map(([r, y]) => (
        <text key={r} x={12} y={y + 4} className="label">{r}</text>
      ))}
      {Array.from({ length: 13 }, (_, i) => i * 5 + 1).map(n => (
        <text key={n} x={(n + 0.5) * 20} y={84} textAnchor="middle" className="label">{n}</text>
      ))}
    </g>
  );
}

function PartOnBoard({ c, netlist, led, selected, interactive, onSelect, onUpdate, toBoardX }) {
  const part = PARTS[c.type];
  const fill = c.type === 'led' ? LED_COLORS[ledColorName(c.value)] : part.color;
  const pts = c.pins.map(id => HOLE_BY_ID.get(id));
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;

  const click = e => { e.stopPropagation(); onSelect(); };
  const cls = `part${selected ? ' selected' : ''}`;
  const pinDots = pts.map((p, i) => (
    <circle key={i} cx={p.x} cy={p.y} r={5} className="pin"
      fill={netlist.pinNet.get(`${c.id}:${i}`)?.color} />
  ));

  if (c.type === 'wire') {
    return (
      <g className={cls} onClick={click} style={{ pointerEvents: interactive ? 'auto' : 'none' }}>
        <line x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y}
          stroke={part.color} strokeWidth={7} strokeLinecap="round" className="body" />
        {pinDots}
      </g>
    );
  }

  const leads = pts.map((p, i) => <line key={i} x1={p.x} y1={p.y} x2={cx} y2={cy} className="lead" />);

  let body;
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
          onChange={wiper => onUpdate({ wiper })} toBoardX={toBoardX} />
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
    <g className={cls} onClick={click} style={{ pointerEvents: interactive ? 'auto' : 'none' }}>
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
function PotSlider({ cx, cy, wiper, label, onChange, toBoardX }) {
  const x0 = cx - TRACK / 2;
  const setFrom = e => onChange(clamp01((toBoardX(e.clientX) - x0) / TRACK));
  const steps = { ArrowLeft: -0.05, ArrowDown: -0.05, ArrowRight: 0.05, ArrowUp: 0.05 };
  return (
    <g className="slider" role="slider" tabIndex={0} aria-label={`${label} wiper`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(wiper * 100)}
      onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setFrom(e); }}
      onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setFrom(e); }}
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
