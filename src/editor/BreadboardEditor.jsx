import { useRef, useState } from 'react';
import { BOARD_W, BOARD_H } from '../helpers/board';
import { HOLES, HOLE_BY_ID, snapToHole } from '../circuit/holes';
import { PARTS, makeComponent, dipPins } from '../circuit/parts';

const ROW_LABELS = { a: 100, b: 120, c: 140, d: 160, e: 180, f: 240, g: 260, h: 280, i: 300, j: 320 };

export default function BreadboardEditor({
  components, onChange, netlist, selectedId, onSelect, tool, photo,
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
        {photo
          ? <image href={photo} width={BOARD_W} height={BOARD_H} />
          : <BoardBackground />}

        {HOLES.map(h => (
          <rect key={h.id} x={h.x - 5} y={h.y - 5} width={10} height={10} rx={2}
            className={hover && h.strip === hover.strip ? 'hole lit' : 'hole'} />
        ))}

        {components.map(c => (
          <PartOnBoard key={c.id} c={c} netlist={netlist} selected={c.id === selectedId}
            interactive={!tool} onSelect={() => onSelect(c.id)} />
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

function PartOnBoard({ c, netlist, selected, interactive, onSelect }) {
  const part = PARTS[c.type];
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
  } else {
    body = (
      <>
        {pts.map((p, i) => <line key={i} x1={p.x} y1={p.y} x2={cx} y2={cy} className="lead" />)}
        <rect x={cx - 24} y={cy - 12} width={48} height={24} rx={6} fill={part.color} className="body" />
        <text x={cx} y={cy + 5} textAnchor="middle" fill={part.ink} className="part-text">{c.ref}</text>
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
