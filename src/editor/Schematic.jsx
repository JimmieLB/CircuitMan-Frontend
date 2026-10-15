import { PARTS } from '../circuit/parts';

const CELL_W = 220, CELL_H = 170, MAX_COLS = 4;

// Net-label schematic: each part is drawn as its symbol, and every pin is
// tagged with the name of the net it's on. Same name (and colour) = connected.
export default function Schematic({ components, netlist, selectedId, onSelect }) {
  const parts = components.filter(c => c.type !== 'wire');
  if (!parts.length)
    return <p className="empty">Place parts on the breadboard (or scan one) and the schematic appears here.</p>;

  const cols = Math.min(MAX_COLS, parts.length);
  const rows = Math.ceil(parts.length / cols);

  return (
    <svg className="schematic" viewBox={`0 0 ${cols * CELL_W} ${rows * CELL_H}`}
      width={cols * CELL_W} onClick={() => onSelect(null)}>
      {parts.map((c, i) => (
        <SymbolCell key={c.id} c={c} netlist={netlist}
          x={(i % cols) * CELL_W} y={Math.floor(i / cols) * CELL_H}
          selected={c.id === selectedId} onSelect={() => onSelect(c.id)} />
      ))}
    </svg>
  );
}

function SymbolCell({ c, netlist, x, y, selected, onSelect }) {
  const sym = symbolFor(c);
  const [lx, ly, anchor = 'middle'] = sym.label;

  return (
    <g transform={`translate(${x},${y})`} className={`sym${selected ? ' selected' : ''}`}
      onClick={e => { e.stopPropagation(); onSelect(); }}>
      <rect className="cell" x={4} y={4} width={CELL_W - 8} height={CELL_H - 8} rx={10} />
      <g className="stroke">{sym.body}</g>
      <text x={lx} y={ly} textAnchor={anchor} className="ref">{c.ref}</text>
      <text x={lx} y={ly + 15} textAnchor={anchor} className="val">{c.value}</text>
      {sym.pins.map(([px, py], i) => {
        const net = netlist.pinNet.get(`${c.id}:${i}`);
        const [tx, ty, ta] =
          px <= 50 ? [px - 6, py + 4, 'end']
          : px >= 170 ? [px + 6, py + 4, 'start']
          : [px + 8, py + 4, 'start'];   // top/bottom pins: label beside the dot
        return (
          <g key={i} className={net?.floating ? 'netlabel floating' : 'netlabel'}>
            <circle cx={px} cy={py} r={3.5} fill={net?.color} />
            <text x={tx} y={ty} textAnchor={ta} fill={net?.color}>{net?.name}</text>
          </g>
        );
      })}
    </g>
  );
}

// Each symbol: pin endpoints (in the part's pin order), the drawing, and where its ref/value go.
function symbolFor(c) {
  const zigzag = 'M50 85H80l5-10 10 20 10-20 10 20 10-20 10 20 5-10H170';
  switch (c.type) {
    case 'resistor':
      return { pins: [[50, 85], [170, 85]], label: [110, 122], body: <path d={zigzag} /> };
    case 'pot':
      return {
        pins: [[50, 85], [110, 150], [170, 85]], label: [110, 52],
        body: <><path d={zigzag} /><path d="M110 150V99M104 106l6-8 6 8" /></>,
      };
    case 'led':
      return {
        pins: [[50, 85], [170, 85]], label: [110, 122],
        body: <>
          <path d="M50 85H95M122 85H170M122 70V100" />
          <path d="M95 70V100L122 85Z" className="fill" />
          <path d="M110 64l9-9m-5 0h5v5M120 68l9-9m-5 0h5v5" />
        </>,
      };
    case 'capacitor':
      return {
        pins: [[50, 85], [170, 85]], label: [110, 122],
        body: <><path d="M50 85H104M116 85H170M104 63V107M116 63V107" /><text x={92} y={66} className="sign">+</text></>,
      };
    case 'battery':
      return {
        pins: [[50, 85], [170, 85]], label: [110, 128],
        body: <><path d="M50 85H104M116 85H170M104 60V110M116 72V98" /><text x={92} y={62} className="sign">+</text></>,
      };
    case 'transistor':
      return {
        pins: [[150, 150], [50, 85], [150, 20]], label: [70, 40],
        body: <>
          <circle cx={128} cy={85} r={32} />
          <path d="M50 85H110M110 63V107M110 75L150 50V20M110 95L150 120V150" />
          <path d="M140 114L129.8 113.4L135.1 105Z" className="fill" />
        </>,
      };
    default:
      return boxSymbol(c);
  }
}

// Generic DIP-style box: pins down the left, then back up the right.
function boxSymbol(c) {
  const n = c.pins.length, half = Math.ceil(n / 2), s = 18;
  const h = half * s + 8, top = 85 - h / 2;
  const pinY = k => top + 4 + s / 2 + k * s;
  const pins = Array.from({ length: n }, (_, i) =>
    i < half ? [50, pinY(i)] : [170, pinY(n - 1 - i)]);
  const names = PARTS[c.type].pins;
  return {
    pins, label: [110, 82],
    body: <>
      <rect x={70} y={top} width={80} height={h} rx={3} />
      {pins.map(([px, py], i) => (
        <g key={i}>
          <path d={px < 110 ? `M50 ${py}H70` : `M150 ${py}H170`} />
          <text x={px < 110 ? 74 : 146} y={py + 3} textAnchor={px < 110 ? 'start' : 'end'} className="pinnum">{names[i]}</text>
        </g>
      ))}
    </>,
  };
}
