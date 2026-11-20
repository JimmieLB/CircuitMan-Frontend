import { LED_COLORS, ledColorName, SEG7_PINS, seg7Anode, PARTS } from '../circuit/parts';

export const SEGMENTS = Object.keys(SEG7_PINS);   // a b c d e f g dp

// The simulator's reading for each segment ({ on, brightness, over, current }), or undefined.
export const segStates = (leds, id) => Object.fromEntries(SEGMENTS.map(s => [s, leds.get(`${id}#${s}`)]));

// Digit geometry, centred on 0,0 (before the slant): W × H with segments T thick.
const W = 50, H = 96, T = 10, GAP = 2.5;
const pts = list => list.map(([x, y]) => `${x},${y}`).join(' ');
const hSeg = y => pts([
  [-W / 2 + GAP, y], [-W / 2 + GAP + T / 2, y - T / 2], [W / 2 - GAP - T / 2, y - T / 2],
  [W / 2 - GAP, y], [W / 2 - GAP - T / 2, y + T / 2], [-W / 2 + GAP + T / 2, y + T / 2],
]);
const vSeg = (x, y0, y1) => pts([
  [x, y0 + GAP], [x + T / 2, y0 + GAP + T / 2], [x + T / 2, y1 - GAP - T / 2],
  [x, y1 - GAP], [x - T / 2, y1 - GAP - T / 2], [x - T / 2, y0 + GAP + T / 2],
]);
const SHAPES = {
  a: hSeg(-H / 2), g: hSeg(0), d: hSeg(H / 2),
  f: vSeg(-W / 2, -H / 2, 0), b: vSeg(W / 2, -H / 2, 0),
  e: vSeg(-W / 2, 0, H / 2), c: vSeg(W / 2, 0, H / 2),
};
const DP = { cx: W / 2 + 11, cy: H / 2, r: 5.5 };

function Segment({ seg, fill, state, glow }) {
  const lit = state?.on;
  const props = lit
    ? { fill, opacity: 0.45 + 0.55 * state.brightness }
    : { className: 'seg-off' };
  return (
    <g {...props} filter={glow && lit ? 'url(#seg-glow)' : undefined}>
      {seg === 'dp' ? <circle {...DP} /> : <polygon points={SHAPES[seg]} />}
    </g>
  );
}

// The display as it sits on the board. `pts` are its 10 pin positions; it's
// drawn upright when pin 1 is on the bottom row, and turned round otherwise.
export function SevenSegmentBody({ c, pts, segs, selected }) {
  const part = PARTS.seg7;
  const fill = LED_COLORS[ledColorName(c.value)];
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const flipped = pts[0].y < cy;
  const over = Object.values(segs).some(s => s?.over);

  return (
    <>
      <g transform={`translate(${cx} ${cy}) rotate(${flipped ? 180 : 0})`}>
        <rect x={-50} y={-75} width={100} height={150} rx={4} fill={part.color} className="body seg-case" />
        <rect x={-44} y={-69} width={88} height={138} rx={2} className="seg-face" />
        <g transform="skewX(-8)" style={{ '--seg': fill }}>
          {/* Glow layer under the crisp segments */}
          {SEGMENTS.map(s => segs[s]?.on && <Segment key={`g${s}`} seg={s} fill={fill} state={segs[s]} glow />)}
          {SEGMENTS.map(s => <Segment key={s} seg={s} fill={fill} state={segs[s]} />)}
        </g>
      </g>
      <text x={cx - 45} y={cy - 63} className="seg-ref" fill={part.ink}>{c.ref}</text>
      <text x={cx + 45} y={cy - 63} textAnchor="end" className="seg-ref" fill={part.ink}>
        {seg7Anode(c.value) ? 'CA' : 'CC'}
      </text>
      {over && <text x={cx} y={cy - 84} textAnchor="middle" className="warn">⚠ segment overcurrent</text>}
      {selected && pts.map((p, i) => (
        <text key={i} x={p.x} y={p.y + (p.y > cy ? 18 : -10)} textAnchor="middle" className="seg-pin">
          {part.pins[i]}
        </text>
      ))}
    </>
  );
}

// A small digit for the schematic, lit the same way.
export function SevenSegmentGlyph({ c, segs, x, y, scale = 0.5 }) {
  const fill = LED_COLORS[ledColorName(c.value)];
  return (
    <g transform={`translate(${x} ${y}) scale(${scale}) skewX(-8)`}>
      {SEGMENTS.map(s => <Segment key={s} seg={s} fill={fill} state={segs[s]} />)}
    </g>
  );
}
