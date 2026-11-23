import { PARTS, ledColorName, SEG7_PINS, SEG7_COMMON, seg7Anode } from '../circuit/parts';
import { parseChip, chipLines } from './logic';

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

// Turns the circuit into an ngspice deck (without the analysis line).
// Returns { off } when there's nothing to simulate, { error } when the circuit
// can't be simulated, otherwise the deck plus how to map results back to parts.
// Capacitors are kept separate: they're the circuit's state, so each transient
// step writes them out with the voltage they ended the previous step with.
// Logic chips add hidden capacitors (`hidden: true`) that hold each gate's state.
export function buildDeck(components, netlist) {
  const lines = ['* breadboard circuit'], warnings = [], leds = [], supplies = [], caps = [], chips = [];
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
        if (v !== null) caps.push({ id: c.id, el: `C${i}`, a: n(0), b: n(1), farads: v });
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
      case 'seg7': {
        // Eight LEDs sharing a common pin (cathode or anode); the two COM pins are joined inside.
        const color = ledColorName(c.value);
        ledColors.add(color);
        const anode = seg7Anode(c.value), com = n(SEG7_COMMON[0]);
        lines.push(`R${i}com ${com} ${n(SEG7_COMMON[1])} 0.01`);
        for (const [seg, pin] of Object.entries(SEG7_PINS)) {
          const [from, to] = anode ? [com, n(pin)] : [n(pin), com];
          lines.push(`VS${i}${seg} ${from} x${i}${seg} 0`, `D${i}${seg} x${i}${seg} ${to} LED_${color}`);
          leds.push({ id: `${c.id}#${seg}`, el: `vs${i}${seg}` });
        }
        break;
      }
      case 'ic_dip14': {
        const chip = parseChip(c.value);
        if (!chip) {
          warnings.push(`${name}: "${c.value}" isn't a logic chip the simulator knows (e.g. 74HC00, 74LS04, CD4011), so it's left out.`);
          break;
        }
        const id = `ic${i}`;
        const { lines: chipSpice, states, vcc, gnd, vmin } = chipLines(chip, k => n(k - 1), id, i);
        lines.push(...chipSpice);
        for (const st of states) caps.push({ id: `${c.id}#${st.key}`, el: `C${id}${st.key}`, a: st.node, b: '0', farads: st.farads, hidden: true });
        chips.push({ name, vcc, gnd, vmin });
        break;
      }
      default:
        warnings.push(`${name}: ${PARTS[c.type].label} isn't simulated yet.`);
    }
  }

  if (!supplies.length) return { off: 'Add a power supply to simulate the circuit.' };

  for (const color of ledColors) lines.push(`.model LED_${color} D(${LED_MODELS[color]})`);
  lines.push('.model QNPN NPN(BF=150)', '.model QPNP PNP(BF=150)');
  // 1 GΩ to ground on every node so unconnected parts don't make the matrix singular
  for (const node of nodes.values()) if (node !== '0') lines.push(`RSH_${node} ${node} 0 1e9`);

  const circuit = lines.join('\n');
  // Identifies the circuit itself; charge on the capacitors isn't part of it.
  const key = [circuit, ...caps.map(c => `${c.el} ${c.a} ${c.b} ${c.farads}`)].join('\n');
  return { key, circuit, caps, chips, nodes, leds, supplies, warnings };
}

// DC operating point: capacitors are open circuits. Used when there are none.
export function opDeck(deck) {
  return [deck.circuit, ...deck.caps.map(c => `${c.el} ${c.a} ${c.b} ${c.farads}`), '.op', '.end'].join('\n');
}

// Transient run of `dt` seconds from `state` (as readResult returns it):
// each capacitor, hidden ones too, starts at its voltage there (missing =
// uncharged), and every other node starts where the last step left it
// ("@node" entries), which keeps the solver from having to find its way back
// to the same answer through a high-gain logic loop. UIC skips the operating
// point so these starting values are used as given.
//
// The step size ngspice starts with comes from the first .tran number. It
// has to be well under a logic gate's 1 µs delay: a longer first step turns a
// gate's state into an algebraic equation, and a bistable one (a Schmitt
// trigger, a latch) can then land on the wrong answer and lose its memory.
// ngspice doubles its step from there, so this costs only a few extra points.
const FIRST_STEP = 1e-8;
export function tranDeck(deck, state, dt) {
  const caps = deck.caps.map(c => `${c.el} ${c.a} ${c.b} ${c.farads} IC=${state.get(c.id) ?? 0}`);
  // A user capacitor's own starting voltage decides its nodes; don't fight it.
  const capNodes = new Set(deck.caps.filter(c => !c.hidden).flatMap(c => [c.a, c.b]));
  const ics = [...new Set(deck.nodes.values())]
    .filter(node => node !== '0' && !capNodes.has(node) && state.has(`@${node}`))
    .map(node => `v(${node})=${state.get(`@${node}`)}`);
  return [deck.circuit, ...caps, ...(ics.length ? [`.ic ${ics.join(' ')}`] : []),
    `.tran ${FIRST_STEP} ${dt} 0 ${dt / 20} UIC`, '.end'].join('\n');
}

export function readResult(deck, result, errors) {
  if (!result.data.length)
    return { status: 'error', message: errors.find(e => e.trim()) ?? 'The simulation failed.', warnings: deck.warnings };

  // An operating point has one value per vector; a transient run ends on its last.
  const vals = new Map(result.data.map(d => [d.name, d.values[d.values.length - 1]]));
  const volts = node => (node === '0' ? 0 : vals.get(`v(${node})`) ?? 0);
  const nets = new Map([...deck.nodes].map(([name, node]) => [name, volts(node)]));
  // `state` is what the next step starts from: every capacitor's voltage (by id)
  // and every node's ("@node"). `caps` is just the user's capacitors.
  const state = new Map(deck.caps.map(c => [c.id, volts(c.a) - volts(c.b)]));
  for (const node of deck.nodes.values()) if (node !== '0') state.set(`@${node}`, volts(node));
  const caps = new Map(deck.caps.filter(c => !c.hidden).map(c => [c.id, state.get(c.id)]));
  const warnings = [...deck.warnings];
  for (const chip of deck.chips) {
    const v = volts(chip.vcc) - volts(chip.gnd);
    if (v < chip.vmin) warnings.push(`${chip.name} isn't powered (${v.toFixed(1)} V across it): pin 14 goes to +, pin 7 to −.`);
  }
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

  return { status: 'ok', nets, leds, supplies, caps, state, warnings };
}

export function formatCurrent(a) {
  const x = Math.abs(a);
  if (x < 0.5e-6) return '0 µA';
  if (x < 1e-3) return `${(a * 1e6).toFixed(0)} µA`;
  if (x < 1) return `${(a * 1e3).toFixed(1)} mA`;
  return `${a.toFixed(2)} A`;
}

export const formatVoltage = v => `${(Math.abs(v) < 0.005 ? 0 : v).toFixed(2)} V`;
