import { PARTS, ledColorName } from '../circuit/parts';

// Diode models tuned for a typical forward voltage at ~10 mA.
const LED_MODELS = {
  red:    'IS=1e-18 N=2 RS=2',      // ≈1.9 V
  orange: 'IS=1e-18 N=2.05 RS=2',   // ≈2.0 V
  yellow: 'IS=1e-18 N=2.1 RS=2',    // ≈2.0 V
  green:  'IS=9e-19 N=2.2 RS=2',    // ≈2.1 V
  blue:   'IS=1.6e-19 N=3 RS=5',    // ≈3.0 V
  white:  'IS=1.6e-19 N=3 RS=5',    // ≈3.0 V
};

const LED_ON = 0.5e-3;     // A — below this it's too dim to notice
const LED_FULL = 15e-3;    // A — full brightness
const LED_MAX = 30e-3;     // A — above this a standard 5 mm LED burns out

const SCALE = { T: 1e12, G: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };

// "220Ω" → 220, "10kΩ" → 10000, "4.7µF" → 4.7e-6, "1M" → 1e6 (capital M means mega,
// as people write it, unlike SPICE). Returns null if it can't be read.
export function parseValue(text) {
  const s = text.trim().replace(/[µμ]/g, 'u').replace(/\s*(ohms?|Ω|F|V|A)$/i, '');
  const m = /^(\d*\.?\d+(?:e[-+]?\d+)?)\s*(meg|Meg|MEG|[TGMkKmunpf])?$/.exec(s);
  if (!m) return null;
  let unit = m[2];
  if (unit === 'M' || unit?.toLowerCase() === 'meg') unit = 'meg';
  else if (unit === 'K') unit = 'k';
  return Number(m[1]) * (unit ? SCALE[unit] : 1);
}

// Turns the circuit into an ngspice operating-point deck.
// Returns { off } when there's nothing to simulate, { error } when the circuit
// can't be simulated, otherwise the deck plus how to map results back to parts.
export function buildDeck(components, netlist) {
  const lines = ['* breadboard circuit'], warnings = [], leds = [], supplies = [];
  const nodes = new Map(netlist.nets.map(net => [net.name, net.name === 'GND' ? '0' : net.name.toLowerCase()]));
  const ledColors = new Set();

  for (const [i, c] of components.entries()) {
    const n = k => nodes.get(netlist.pinNet.get(`${c.id}:${k}`).name);
    const name = c.ref || PARTS[c.type].label;
    const value = () => {
      const v = parseValue(c.value);
      if (v === null) warnings.push(`${name}: can't read the value "${c.value}", so it's left out.`);
      return v;
    };

    switch (c.type) {
      case 'wire':
        break;   // wires are already merged into the nets
      case 'resistor': {
        const v = value();
        if (v !== null) lines.push(`R${i} ${n(0)} ${n(1)} ${Math.max(v, 1e-3)}`);
        break;
      }
      case 'capacitor': {
        const v = value();
        if (v !== null) lines.push(`C${i} ${n(0)} ${n(1)} ${v}`);
        break;
      }
      case 'battery': {
        const v = value();
        if (v === null) break;
        if (n(0) === n(1)) return { error: `${name} is shorted: its + and − end up on the same net.` };
        lines.push(`V${i} ${n(0)} ${n(1)} DC ${v}`);
        supplies.push({ id: c.id, el: `v${i}` });
        break;
      }
      case 'led': {
        const color = ledColorName(c.value);
        ledColors.add(color);
        // 0 V source in series so ngspice reports the LED's current
        lines.push(`VS${i} ${n(0)} x${i} 0`, `D${i} x${i} ${n(1)} LED_${color}`);
        leds.push({ id: c.id, el: `vs${i}` });
        break;
      }
      case 'button':
        // pins 1–2 and 3–4 are always joined; pressing joins the two pairs
        lines.push(`R${i}a ${n(0)} ${n(1)} 0.01`, `R${i}b ${n(2)} ${n(3)} 0.01`,
          `R${i}s ${n(0)} ${n(2)} ${c.pressed ? 0.01 : 1e12}`);
        break;
      case 'pot': {
        const v = value();
        if (v === null) break;
        const w = c.wiper ?? 0.5;
        lines.push(`R${i}a ${n(0)} ${n(1)} ${v * w + 0.01}`, `R${i}b ${n(1)} ${n(2)} ${v * (1 - w) + 0.01}`);
        break;
      }
      case 'transistor':
        lines.push(`Q${i} ${n(2)} ${n(1)} ${n(0)} ${/pnp/i.test(c.value) ? 'QPNP' : 'QNPN'}`);
        break;
      default:
        warnings.push(`${name}: ${PARTS[c.type].label} isn't simulated yet.`);
    }
  }

  if (!supplies.length) return { off: 'Add a power supply to simulate the circuit.' };

  for (const color of ledColors) lines.push(`.model LED_${color} D(${LED_MODELS[color]})`);
  lines.push('.model QNPN NPN(BF=150)', '.model QPNP PNP(BF=150)');
  // 1 GΩ to ground on every node so unconnected parts don't make the matrix singular
  for (const node of nodes.values()) if (node !== '0') lines.push(`RSH_${node} ${node} 0 1e9`);
  lines.push('.op', '.end');

  return { netlist: lines.join('\n'), nodes, leds, supplies, warnings };
}

export function readResult(deck, result, errors) {
  if (!result.data.length)
    return { status: 'error', message: errors.find(e => e.trim()) ?? 'The simulation failed.', warnings: deck.warnings };

  const vals = new Map(result.data.map(d => [d.name, d.values[0]]));
  const nets = new Map([...deck.nodes].map(([name, node]) =>
    [name, node === '0' ? 0 : vals.get(`v(${node})`) ?? 0]));
  const leds = new Map(deck.leds.map(({ id, el }) => {
    const current = vals.get(`i(${el})`) ?? 0;
    return [id, {
      current,
      on: current > LED_ON,
      brightness: Math.min(1, Math.max(0, current) / LED_FULL),
      over: current > LED_MAX,
    }];
  }));
  // ngspice reports source current flowing in at +, so flip it to "current supplied"
  const supplies = new Map(deck.supplies.map(({ id, el }) => [id, -(vals.get(`i(${el})`) ?? 0)]));

  return { status: 'ok', nets, leds, supplies, warnings: deck.warnings };
}

export function formatCurrent(a) {
  const x = Math.abs(a);
  if (x < 0.5e-6) return '0 µA';
  if (x < 1e-3) return `${(a * 1e6).toFixed(0)} µA`;
  if (x < 1) return `${(a * 1e3).toFixed(1)} mA`;
  return `${a.toFixed(2)} A`;
}

export const formatVoltage = v => `${(Math.abs(v) < 0.005 ? 0 : v).toFixed(2)} V`;
