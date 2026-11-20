// Part catalog. `pins` lists pin names in keypoint order — the same order the
// detection model is trained with, so detections map straight onto parts.
const range = n => Array.from({ length: n }, (_, i) => String(i + 1));

export const PARTS = {
  wire:       { label: 'Jumper wire',   pins: ['1', '2'], prefix: 'W',  color: '#e0a800' },
  resistor:   { label: 'Resistor',      pins: ['1', '2'], prefix: 'R',  value: '220Ω',  color: '#d8b98a', ink: '#3b2a12' },
  led:        { label: 'LED',           pins: ['A', 'K'], prefix: 'D',  value: 'red',   color: '#ff5a5a', ink: '#1b1b1b' },
  capacitor:  { label: 'Capacitor',     pins: ['+', '−'], prefix: 'C',  value: '10µF',  color: '#3d7fd1', ink: '#fff' },
  button:     { label: 'Push button',   pins: range(4),   prefix: 'SW', value: '',      color: '#4a4a4a', ink: '#fff' },
  transistor: { label: 'Transistor',    pins: ['E', 'B', 'C'], prefix: 'Q', value: 'NPN', color: '#2b2b2b', ink: '#fff' },
  pot:        { label: 'Potentiometer', pins: ['1', 'W', '2'], prefix: 'RV', value: '10kΩ', color: '#2d5f9e', ink: '#fff' },
  battery:    { label: 'Power supply',  pins: ['+', '−'], prefix: 'BT', value: '5V',    color: '#c0392b', ink: '#fff' },
  ic_dip8:    { label: 'IC (DIP-8)',    pins: range(8),   prefix: 'U',  value: 'NE555',  color: '#1e1e1e', ink: '#eee', dip: true },
  ic_dip14:   { label: 'IC (DIP-14)',   pins: range(14),  prefix: 'U',  value: '74HC00', color: '#1e1e1e', ink: '#eee', dip: true },
  // Standard 10-pin single digit (e.g. 5161AS/BS). Pins 1–5 run along the bottom, 6–10 back along the top.
  // Keep new parts at the end: training labels use each part's position here as its class id.
  seg7:       { label: '7-segment display', pins: ['E', 'D', 'COM1', 'C', 'DP', 'B', 'A', 'COM2', 'F', 'G'],
                prefix: 'DS', value: 'common cathode red', color: '#1c1c1f', ink: '#d8d8d8', dip: true },
};

// 7-segment display: which pin drives each segment, and how it's wired inside.
export const SEG7_PINS = { a: 6, b: 5, c: 3, d: 1, e: 0, f: 8, g: 9, dp: 4 };
export const SEG7_COMMON = [2, 7];
export const seg7Anode = value => /anode|\bCA\b/i.test(value);

// An LED's colour comes from its value text ("red", "green 5mm", …).
export const LED_COLORS = {
  red: '#ff3b30', orange: '#ff9f0a', yellow: '#ffd60a',
  green: '#30d158', blue: '#0a84ff', white: '#f2f2f2',
};
export const ledColorName = value =>
  Object.keys(LED_COLORS).find(k => value.toLowerCase().includes(k)) ?? 'red';

export function nextRef(type, components) {
  const prefix = PARTS[type].prefix;
  if (!prefix) return '';
  const used = components
    .filter(c => PARTS[c.type].prefix === prefix)
    .map(c => parseInt(c.ref.slice(prefix.length), 10) || 0);
  return prefix + (Math.max(0, ...used) + 1);
}

export function makeComponent(type, pins, components) {
  return {
    id: crypto.randomUUID(),
    type,
    ref: nextRef(type, components),
    value: PARTS[type].value ?? '',
    pins,
  };
}

export const pinLabel = (c, i) =>
  `${c.ref || PARTS[c.type].label}.${PARTS[c.type].pins[i]}`;

// A DIP chip straddles the centre channel. Clicking pin 1 in row f places it
// notch-left (pins 1..n/2 run left→right along f); in row e it's rotated 180°.
// Works with board-qualified ids ("B2:f10") and bare ones ("f10"), keeping the board.
export function dipPins(holeId, n) {
  const colon = holeId.indexOf(':');
  const board = colon < 0 ? '' : holeId.slice(0, colon + 1);
  const m = /^([ef])(\d+)$/.exec(holeId.slice(colon + 1));
  if (!m) return null;
  const [, row, col] = m;
  const c = Number(col), half = n / 2;
  const dir = row === 'f' ? 1 : -1, other = row === 'f' ? 'e' : 'f';
  const end = c + dir * (half - 1);
  if (end < 1 || end > 63) return null;
  return Array.from({ length: n }, (_, i) =>
    board + (i < half ? `${row}${c + dir * i}` : `${other}${c + dir * (n - 1 - i)}`));
}
