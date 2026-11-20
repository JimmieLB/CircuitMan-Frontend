// Digital logic chips (7400 and 4000 series gates and inverters in DIP-14),
// modelled for ngspice with behavioural sources.
//
// Each gate has a hidden state node that follows its logic function with a
// 1 µs lag (a stand-in for propagation delay). The state is stored on a
// hidden capacitor, so it carries between transient steps like any other
// capacitor's charge, which is what lets latches and flip-flops built from
// gates remember. Inputs are read against the chip's GND pin with the
// family's threshold, and outputs are a high-side and a low-side switch with
// the family's output resistance, drawing their current through the chip's
// VCC and GND pins. A chip without power leaves its outputs floating.

const g = (fn, inputs, out, extra) => ({ fn, inputs, out, ...extra });

// Pin layouts, as gate lists (pin numbers are 1-based). VCC is pin 14 and GND pin 7 on all of them.
const LAYOUT = {
  // 7400: 1A1 1B2 1Y3 2A4 2B5 2Y6 | 3Y8 3A9 3B10 4Y11 4A12 4B13
  quad00: fn => [g(fn, [1, 2], 3), g(fn, [4, 5], 6), g(fn, [9, 10], 8), g(fn, [12, 13], 11)],
  // 7402: 1Y1 1A2 1B3 2Y4 2A5 2B6 | 3A8 3B9 3Y10 4A11 4B12 4Y13
  quad02: fn => [g(fn, [2, 3], 1), g(fn, [5, 6], 4), g(fn, [8, 9], 10), g(fn, [11, 12], 13)],
  // 4001 / 4011 / 4081 / 74LS266: A1 B2 J3 K4 C5 D6 | E8 F9 L10 M11 G12 H13
  quad4001: fn => [g(fn, [1, 2], 3), g(fn, [5, 6], 4), g(fn, [8, 9], 10), g(fn, [12, 13], 11)],
  // 7404 / 4069: 1A1 1Y2 2A3 2Y4 3A5 3Y6 | 4Y8 4A9 5Y10 5A11 6Y12 6A13
  hex04: fn => [g(fn, [1], 2), g(fn, [3], 4), g(fn, [5], 6), g(fn, [9], 8), g(fn, [11], 10), g(fn, [13], 12)],
  // 7410: 1A1 1B2 2A3 2B4 2C5 2Y6 | 3Y8 3A9 3B10 3C11 1Y12 1C13
  triple10: fn => [g(fn, [1, 2, 13], 12), g(fn, [3, 4, 5], 6), g(fn, [9, 10, 11], 8)],
  // 4023 / 4025 / 4073 / 4075: A1 B2 D3 E4 F5 K6 | C8 J9 L10 I11 H12 G13
  triple4023: fn => [g(fn, [1, 2, 8], 9), g(fn, [3, 4, 5], 6), g(fn, [11, 12, 13], 10)],
  // 7420: 1A1 1B2 NC3 1C4 1D5 1Y6 | 2Y8 2A9 2B10 NC11 2C12 2D13
  dual20: fn => [g(fn, [1, 2, 4, 5], 6), g(fn, [9, 10, 12, 13], 8)],
  // 4002 / 4012 / 4072 / 4082: J1 A2 B3 C4 D5 NC6 | NC8 E9 F10 G11 H12 K13
  dual4012: fn => [g(fn, [2, 3, 4, 5], 1), g(fn, [9, 10, 11, 12], 13)],
  // 7430: A1 B2 C3 D4 E5 F6 | Y8 NC9 NC10 G11 H12 NC13
  single30: fn => [g(fn, [1, 2, 3, 4, 5, 6, 11, 12], 8)],
  // 4068: K1 (NAND) A2 B3 C4 D5 NC6 | NC8 E9 F10 G11 H12 J13 (AND)
  eight4068: () => [g('nand', [2, 3, 4, 5, 9, 10, 11, 12], 1), g('and', [2, 3, 4, 5, 9, 10, 11, 12], 13)],
  // 74125 / 74126: 1OE1 1A2 1Y3 2OE4 2A5 2Y6 | 3Y8 3A9 3OE10 4Y11 4A12 4OE13
  quad125: activeLow => [[1, 2, 3], [4, 5, 6], [10, 9, 8], [13, 12, 11]]
    .map(([oe, a, y]) => g('buf', [a], y, { oe, activeLow })),
};

const NAMES = {
  and: 'AND', nand: 'NAND', or: 'OR', nor: 'NOR', xor: 'XOR', xnor: 'XNOR', not: 'inverter', buf: 'buffer',
};

// [layout, function, description, options]. oc = open-collector/open-drain outputs, schmitt = hysteresis on the inputs.
const C = (layout, fn, desc, opts = {}) => ({ layout, fn, desc, ...opts });
const CHIPS_7400 = {
  '00': C('quad00', 'nand', 'Quad 2-input NAND'),
  '01': C('quad02', 'nand', 'Quad 2-input NAND, open-collector', { oc: true }),
  '02': C('quad02', 'nor', 'Quad 2-input NOR'),
  '03': C('quad00', 'nand', 'Quad 2-input NAND, open-collector', { oc: true }),
  '04': C('hex04', 'not', 'Hex inverter'),
  '05': C('hex04', 'not', 'Hex inverter, open-collector', { oc: true }),
  '06': C('hex04', 'not', 'Hex inverter, open-collector high-voltage', { oc: true }),
  '07': C('hex04', 'buf', 'Hex buffer, open-collector high-voltage', { oc: true }),
  '08': C('quad00', 'and', 'Quad 2-input AND'),
  '09': C('quad00', 'and', 'Quad 2-input AND, open-collector', { oc: true }),
  '10': C('triple10', 'nand', 'Triple 3-input NAND'),
  '11': C('triple10', 'and', 'Triple 3-input AND'),
  '12': C('triple10', 'nand', 'Triple 3-input NAND, open-collector', { oc: true }),
  '13': C('dual20', 'nand', 'Dual 4-input NAND Schmitt trigger', { schmitt: true }),
  '14': C('hex04', 'not', 'Hex Schmitt-trigger inverter', { schmitt: true }),
  '15': C('triple10', 'and', 'Triple 3-input AND, open-collector', { oc: true }),
  '16': C('hex04', 'not', 'Hex inverter, open-collector high-voltage', { oc: true }),
  '17': C('hex04', 'buf', 'Hex buffer, open-collector high-voltage', { oc: true }),
  '18': C('dual20', 'nand', 'Dual 4-input NAND Schmitt trigger', { schmitt: true }),
  '20': C('dual20', 'nand', 'Dual 4-input NAND'),
  '21': C('dual20', 'and', 'Dual 4-input AND'),
  '22': C('dual20', 'nand', 'Dual 4-input NAND, open-collector', { oc: true }),
  '27': C('triple10', 'nor', 'Triple 3-input NOR'),
  '30': C('single30', 'nand', '8-input NAND'),
  '32': C('quad00', 'or', 'Quad 2-input OR'),
  '34': C('hex04', 'buf', 'Hex buffer'),
  '37': C('quad00', 'nand', 'Quad 2-input NAND buffer'),
  '38': C('quad00', 'nand', 'Quad 2-input NAND buffer, open-collector', { oc: true }),
  '40': C('dual20', 'nand', 'Dual 4-input NAND buffer'),
  '86': C('quad00', 'xor', 'Quad 2-input XOR'),
  '125': C('quad125', true, 'Quad tri-state buffer, active-low enable'),
  '126': C('quad125', false, 'Quad tri-state buffer, active-high enable'),
  '132': C('quad00', 'nand', 'Quad 2-input NAND Schmitt trigger', { schmitt: true }),
  '136': C('quad00', 'xor', 'Quad 2-input XOR, open-collector', { oc: true }),
  '266': C('quad4001', 'xnor', 'Quad 2-input XNOR, open-collector', { oc: true }),
};
const CHIPS_4000 = {
  '4001': C('quad4001', 'nor', 'Quad 2-input NOR'),
  '4002': C('dual4012', 'nor', 'Dual 4-input NOR'),
  '4011': C('quad4001', 'nand', 'Quad 2-input NAND'),
  '4012': C('dual4012', 'nand', 'Dual 4-input NAND'),
  '4023': C('triple4023', 'nand', 'Triple 3-input NAND'),
  '4025': C('triple4023', 'nor', 'Triple 3-input NOR'),
  '4030': C('quad4001', 'xor', 'Quad 2-input XOR'),
  '4068': C('eight4068', null, '8-input NAND/AND'),
  '4069': C('hex04', 'not', 'Hex inverter'),
  '4070': C('quad4001', 'xor', 'Quad 2-input XOR'),
  '4071': C('quad4001', 'or', 'Quad 2-input OR'),
  '4072': C('dual4012', 'or', 'Dual 4-input OR'),
  '4073': C('triple4023', 'and', 'Triple 3-input AND'),
  '4075': C('triple4023', 'or', 'Triple 3-input OR'),
  '4077': C('quad4001', 'xnor', 'Quad 2-input XNOR'),
  '4081': C('quad4001', 'and', 'Quad 2-input AND'),
  '4082': C('dual4012', 'and', 'Dual 4-input AND'),
  '4093': C('quad4001', 'nand', 'Quad 2-input NAND Schmitt trigger', { schmitt: true }),
  '4584': C('hex04', 'not', 'Hex Schmitt-trigger inverter', { schmitt: true }),
  '40106': C('hex04', 'not', 'Hex Schmitt-trigger inverter', { schmitt: true }),
};

// Electrical behaviour per logic family.
//   th: input threshold, abs volts or (rel) fraction of VCC; hyst: Schmitt thresholds [low, high] the same way
//   rh/rl: output resistance high/low side (Ω); drop: how far below VCC a high output sits
//   pullup: TTL input pull-up to VCC (Ω); iq: quiescent supply resistance (Ω); vmin: lowest VCC that works
const FAMILY = {
  ttl:   { label: 'TTL',  th: 1.4, hyst: [0.8, 1.6], rel: false, rh: 120, rl: 25, drop: 1.6, pullup: 12.5e3, iq: 2.5e3, vmin: 4 },
  hct:   { label: 'CMOS, TTL-level inputs', th: 1.4, hyst: [0.9, 1.6], rel: false, rh: 50, rl: 50, drop: 0, vmin: 4 },
  hc:    { label: 'CMOS', th: 0.5, hyst: [0.4, 0.6], rel: true, rh: 50, rl: 50, drop: 0, vmin: 2 },
  ac:    { label: 'CMOS, high drive', th: 0.5, hyst: [0.4, 0.6], rel: true, rh: 15, rl: 15, drop: 0, vmin: 1.5 },
  cd4000:{ label: 'CMOS 4000-series', th: 0.5, hyst: [0.4, 0.6], rel: true, rh: 600, rl: 600, drop: 0, vmin: 3 },
};
const familyOf = letters => {
  if (/^(|L|H|S|LS|AS|ALS|F)$/.test(letters)) return 'ttl';
  if (/T$/.test(letters)) return 'hct';                      // HCT, ACT, AHCT, VHCT, FCT, ABT, LVT, BCT
  if (/^(AC|ALVC|LVC|AUC|AUP)$/.test(letters)) return 'ac';
  return 'hc';                                               // HC, AHC, VHC, LV, LVX, C, …
};

// "74HC00", "SN74LS08N", "CD4011BE", "HEF4093BP", "MC14001B", "74HC4075" → { chip, family, name }.
// Returns null for anything that isn't a supported logic chip.
export function parseChip(value) {
  const v = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  const m74 = /^[A-Z]*74([A-Z]*)(\d{2,5})/.exec(v);
  if (m74) {
    const [, letters, num] = m74;
    if (/^40\d{2,3}$/.test(num) || /^4584$/.test(num)) {   // 74HC4xxx: 4000-series pinout, 74-family electricals
      const chip = CHIPS_4000[num];
      return chip ? { ...chip, family: familyOf(letters), name: `74${letters}${num}` } : null;
    }
    const chip = CHIPS_7400[num.replace(/^0+(?=\d{2})/, '')];
    return chip ? { ...chip, family: familyOf(letters), name: `74${letters}${num}` } : null;
  }
  const m40 = /^([A-Z]*)(\d{4,5})/.exec(v);
  if (m40) {
    let num = m40[2];
    if (/^MC$/.test(m40[1]) && /^14\d{3}$/.test(num)) num = num.slice(1);   // Motorola MC14011 = 4011
    const chip = CHIPS_4000[num];
    return chip ? { ...chip, family: 'cd4000', name: num } : null;
  }
  return null;
}

export const describeChip = chip =>
  `${chip.desc} (${chip.name}, ${FAMILY[chip.family].label})`;

export function gatesOf(chip) {
  const gates = LAYOUT[chip.layout](chip.fn);
  return gates;
}

// Reference for people and the agent: every supported part number grouped by pinout.
export function chipReference() {
  const groups = new Map();
  for (const [series, table] of [['74', CHIPS_7400], ['', CHIPS_4000]])
    for (const [num, chip] of Object.entries(table)) {
      const pins = gatesOf(chip).map(gt => `${gt.inputs.join('+')}→${gt.out}${gt.oe ? ` (enable ${gt.oe}, active ${gt.activeLow ? 'low' : 'high'})` : ''}`).join(', ');
      const key = pins;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(`${series}x${num} ${chip.desc}`.replace(/^x/, ''));
    }
  return [...groups].map(([pins, parts]) => `- ${parts.join('; ')}. Gates (inputs→output): ${pins}.`).join('\n');
}

// Logic function of fuzzy logic values (expressions in 0…1) as an expression.
function logicExpr(fn, xs) {
  const prod = list => list.map(x => `(${x})`).join('*');
  switch (fn) {
    case 'and': return prod(xs);
    case 'nand': return `1-${prod(xs)}`;
    case 'or': return `1-${prod(xs.map(x => `1-(${x})`))}`;
    case 'nor': return prod(xs.map(x => `1-(${x})`));
    case 'xor': return `(${xs[0]})+(${xs[1]})-2*(${xs[0]})*(${xs[1]})`;
    case 'xnor': return `1-((${xs[0]})+(${xs[1]})-2*(${xs[0]})*(${xs[1]}))`;
    case 'not': return `1-(${xs[0]})`;
    case 'buf': return xs[0];
    default: throw new Error(`unknown gate ${fn}`);
  }
}
const INVERTING = new Set(['nand', 'nor', 'not', 'xnor']);

// SPICE lines for one chip. `pin(k)` gives the node on 1-based pin k; `id` is
// unique per chip and `seed` a small number that differs between chips.
// Returns { lines, states } where states are hidden capacitors
// ({ key, node, farads }) holding each gate's output state.
export function chipLines(chip, pin, id, seed = 0) {
  const f = FAMILY[chip.family];
  const vcc = pin(14), gnd = pin(7);
  const supply = `V(${vcc},${gnd})`;
  const W = 0.1;    // V — how sharp the input threshold is (smooth, so Newton converges)
  const level = (frac, abs) => (f.rel ? `${frac}*${supply}` : `${abs}`);
  const read = (node, th) => `(0.5+0.5*tanh((V(${node},${gnd})-(${th}))/${W}))`;
  const powered = `(0.5+0.5*tanh((${supply}-${f.vmin})/0.2))`;

  const lines = [], states = [];
  if (f.iq) lines.push(`R${id}q ${vcc} ${gnd} ${f.iq}`);
  if (f.pullup) {
    const inputs = new Set(gatesOf(chip).flatMap(gt => [...gt.inputs, ...(gt.oe ? [gt.oe] : [])]));
    for (const k of inputs) if (pin(k) !== vcc) lines.push(`R${id}p${k} ${vcc} ${pin(k)} ${f.pullup}`);
  }

  // High side of an output: a CMOS output is a MOSFET (linear in both directions);
  // a TTL one sits `drop` below VCC and can't sink into VCC, so it's a smooth one-way version.
  const highSide = out => (f.drop
    ? `0.05*ln(1+exp((V(${vcc},${out})-${f.drop})/0.05))`
    : `V(${vcc},${out})`);

  gatesOf(chip).forEach((gt, n) => {
    const s = `${id}s${n}`;                 // hidden state node: 0…1 V (it relaxes towards a 0…1 target)
    const q = `V(${s})`;
    // An inverting Schmitt gate whose output is high needs its input above the upper threshold to switch.
    // The smooth input makes the feedback snap over about SNAP volts before the nominal threshold,
    // so the thresholds are widened by that much to switch where the datasheet says.
    const SNAP = 0.15;
    const th = chip.schmitt
      ? `(${level(f.hyst[0], f.hyst[0])}-${SNAP})+(${level(f.hyst[1] - f.hyst[0], f.hyst[1] - f.hyst[0])}+${2 * SNAP})*${INVERTING.has(gt.fn) ? q : `(1-${q})`}`
      : level(f.th, f.th);
    const target = logicExpr(gt.fn, gt.inputs.map(k => read(pin(k), th)));
    lines.push(
      `B${id}g${n} 0 ${s} I=((${target})-V(${s}))*1e-3`,
      `R${id}g${n} ${s} 0 1e9`,
    );
    // Gate delay ≈ R·C = 1–2.2 µs. Gates differ slightly, as real ones do, so a
    // symmetric loop (an SR latch powering up) settles one way instead of racing forever.
    states.push({ key: `g${n}`, node: s, farads: 1e-9 * (1 + 0.3 * ((seed * 3 + n) % 5)) });

    const out = pin(gt.out);
    const enable = gt.oe ? (gt.activeLow ? `(1-${read(pin(gt.oe), level(f.th, f.th))})` : read(pin(gt.oe), level(f.th, f.th))) : '1';
    const on = `${powered}*${enable}`;
    if (!chip.oc && out !== vcc)
      lines.push(`B${id}h${n} ${vcc} ${out} I=${on}*${q}*${highSide(out)}/${f.rh}`);
    if (out !== gnd)
      lines.push(`B${id}l${n} ${out} ${gnd} I=${on}*(1-${q})*V(${out},${gnd})/${f.rl}`);
  });
  return { lines, states, vcc, gnd, vmin: f.vmin };
}
