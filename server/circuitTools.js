// Tools the circuit agent can call. They work on a copy of the user's circuit
// (the same component list the editor uses) and reuse the app's netlist and
// SPICE code, so the agent sees exactly what the user sees.
import { PARTS, makeComponent, dipPins, nextRef, pinLabel } from '../src/circuit/parts';
import { HOLES, HOLE_BY_ID, RAIL_COLUMNS } from '../src/circuit/holes';
import { buildNetlist } from '../src/circuit/netlist';
import { buildDeck, readResult } from '../src/sim/spice';
import { runSpice } from '../src/sim/engine';

const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const PART_TYPES = Object.keys(PARTS);

export const TOOLS = [
  {
    name: 'get_circuit',
    description: 'Returns every part on the breadboard (ref, type, value, and the hole each pin is in) and the nets that connect them.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'add_part',
    description: 'Places a new part on the breadboard. `holes` lists one hole per pin in the part type\'s pin order. For DIP ICs you may instead pass only the pin-1 hole. Returns the new part\'s ref.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: PART_TYPES },
        holes: { type: 'array', items: { type: 'string' } },
        value: nullable({ type: 'string', description: 'e.g. "220Ω", "10kΩ", "green", "9V". Null for the type\'s default.' }),
      },
      required: ['type', 'holes', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_part',
    description: 'Changes an existing part. Pass null for anything that should stay the same. `holes` moves the part (same rules as add_part).',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        value: nullable({ type: 'string' }),
        holes: nullable({ type: 'array', items: { type: 'string' } }),
        pressed: nullable({ type: 'boolean', description: 'Push buttons only.' }),
        wiper: nullable({ type: 'number', description: 'Potentiometers only: 0 = at pin 1, 1 = at pin 2.' }),
      },
      required: ['ref', 'value', 'holes', 'pressed', 'wiper'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_part',
    description: 'Removes one part (or jumper wire) by ref.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'clear_circuit',
    description: 'Removes every part from the breadboard. Only use this when the user wants to start over.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'simulate',
    description: 'Runs a SPICE DC operating-point simulation of the current circuit. Returns net voltages, each LED\'s current and whether it is lit, supply currents, and warnings.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
].map(t => ({ ...t, strict: true }));

// "3–7, 9–13, …" — the columns that have rail holes, as ranges.
const railRanges = RAIL_COLUMNS
  .reduce((runs, col) => {
    const last = runs.at(-1);
    if (last && col === last[1] + 1) last[1] = col;
    else runs.push([col, col]);
    return runs;
  }, [])
  .map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`))
  .join(', ');

const partList = Object.entries(PARTS)
  .map(([type, p]) => `- ${type}: ${p.label}; pins in order: ${p.pins.join(', ')}${p.value ? `; default value "${p.value}"` : ''}`)
  .join('\n');

export const SYSTEM_PROMPT = `You are the circuit assistant inside Breadboard Studio, an app where students build circuits on a virtual breadboard and see them simulated. You change the user's circuit by calling tools; the editor updates live as you work.

## The breadboard
- The main area has columns 1–63 and rows a–j. A hole is named row + column, e.g. "a12" or "h40".
- In each column, holes a–e are connected to each other, and holes f–j are connected to each other. The two halves are not connected across the centre channel (between e and f).
- There are four power rails, each a single connected strip along the whole board: topPlus and topMinus above row a, botPlus and botMinus below row j. The top and bottom rails are separate unless a jumper wire joins them.
- Rail holes are numbered by the terminal column they line up with: topPlus12 is directly above a12, and botMinus12 directly below j12. To connect a rail to column N, use the rail hole and terminal hole with the same number (e.g. topPlus12 → a12, j30 → botMinus30) so the wire or part runs straight.
- Rails only have holes at columns ${railRanges}. They skip one column between groups of five, so when a part needs a rail connection, put it in a column that has a rail hole.
- Each hole holds one lead. Two pins in the same strip are connected; a two-pin part with both pins in one strip is shorted out.

## Parts
${partList}

Notes:
- Jumper wires join the strips their two ends are in.
- LED pin A is the anode (+) and K the cathode (−). An LED needs a series resistor: about 220Ω–1kΩ at 5V.
- A push button's pins 1–2 are always connected, and pins 3–4 are always connected; pressing it connects the two pairs.
- A potentiometer's W pin is the wiper.
- DIP ICs straddle the centre channel: give the pin-1 hole in row f (notch left, pins run left to right along f, then back along e) or in row e (rotated 180°).
- The power supply's + and − pins usually go in topPlus and topMinus. Nets touching the supply's + pin are named VCC and its − pin GND.
- When adding a push button, always set pin 1 and pin 4 on row e with 1 column between them, and pin 2 and pin 3 on row f with 1 column between them.

## Simulation
The simulator finds the DC operating point only: capacitors act as open circuits and ICs aren't simulated. An LED counts as lit above 0.5 mA, and above 30 mA it would burn out.

## How to work
- Each user message includes the current circuit, which reflects any edits the user made since your last turn. Build on it; don't remove or move the user's parts unless asked.
- Lay circuits out the way a person would: power on the rails, parts in free columns, leaving a column or two between unrelated parts.
- After changing a circuit that has a power supply, call simulate and check the result does what the user asked. Fix problems you find before finishing.
- Finish with a short plain-language summary of what you built or changed and what the simulation shows. Use part refs (R1, D1, W2) so the user can find them.
- If the user asks a question that doesn't need changes, answer it without calling the editing tools.`;

const HOLE_BY_LOWER = new Map(HOLES.map(h => [h.id.toLowerCase(), h.id]));

function holeError(h) {
  const rail = /^(topPlus|topMinus|botPlus|botMinus)(\d+)$/i.exec(h);
  if (!rail) return `"${h}" isn't a hole. Use a1–j63, or a rail name plus a column (rail holes are at columns ${railRanges}).`;
  const name = ['topPlus', 'topMinus', 'botPlus', 'botMinus'].find(r => r.toLowerCase() === rail[1].toLowerCase());
  const col = Number(rail[2]);
  const below = RAIL_COLUMNS.filter(c => c < col).at(-1), above = RAIL_COLUMNS.find(c => c > col);
  const nearest = [below, above].filter(c => c !== undefined).map(c => `${name}${c}`).join(' or ');
  return `There's no rail hole at column ${col}; rails only have holes at columns ${railRanges}. The nearest is ${nearest}.`;
}

export function createSession(initial) {
  // Older saves have jumper wires without refs; name them so the agent can refer to them.
  let components = [];
  for (const c of initial)
    components.push(c.ref || !PARTS[c.type]?.prefix ? c : { ...c, ref: nextRef(c.type, components) });

  function find(ref) {
    const c = components.find(x => x.ref.toLowerCase() === String(ref).toLowerCase());
    if (!c) throw new Error(`There's no part called "${ref}". Call get_circuit to see the parts.`);
    return c;
  }

  function resolveHoles(type, holes, movingId) {
    const part = PARTS[type], n = part.pins.length;
    let pins = holes.map(h => {
      const id = HOLE_BY_LOWER.get(String(h).trim().toLowerCase());
      if (!id) throw new Error(holeError(String(h).trim()));
      return id;
    });
    if (part.dip && pins.length === 1) {
      pins = dipPins(pins[0], n);
      if (!pins) throw new Error(`Pin 1 of a ${part.label} must be in row e or f, with ${n / 2} columns of room.`);
    }
    if (pins.length !== n)
      throw new Error(`A ${part.label} needs ${n} holes in pin order (${part.pins.join(', ')}); got ${pins.length}.`);
    if (new Set(pins).size !== n) throw new Error('Each pin needs its own hole.');
    for (const p of pins) {
      const owner = components.find(c => c.id !== movingId && c.pins.includes(p));
      if (owner) throw new Error(`Hole ${p} is already used by ${owner.ref || PARTS[owner.type].label}.`);
    }
    return pins;
  }

  function shortWarning(c) {
    if (c.pins.length !== 2) return undefined;
    const [a, b] = c.pins.map(id => HOLE_BY_ID.get(id).strip);
    if (a !== b) return undefined;
    return c.type === 'wire'
      ? `Both ends of ${c.ref} are in the same strip (${a}), so it connects nothing.`
      : `Both pins of ${c.ref} are in the same strip (${a}), so it's shorted out.`;
  }

  function describe() {
    const netlist = buildNetlist(components);
    return {
      parts: components.map(c => ({
        ref: c.ref,
        type: c.type,
        value: c.value,
        pins: Object.fromEntries(PARTS[c.type].pins.map((p, i) => [p, c.pins[i]])),
        ...(c.type === 'button' && { pressed: !!c.pressed }),
        ...(c.type === 'pot' && { wiper: c.wiper ?? 0.5 }),
      })),
      nets: netlist.nets.map(net => ({ name: net.name, pins: net.pins.map(p => pinLabel(p.comp, p.pin)) })),
    };
  }

  async function simulate() {
    const netlist = buildNetlist(components);
    const deck = buildDeck(components, netlist);
    if (deck.off) return { status: 'off', message: deck.off };
    if (deck.error) return { status: 'error', message: deck.error };
    const { result, errors } = await runSpice(deck.netlist);
    const r = readResult(deck, result, errors);
    if (r.status !== 'ok') return { status: r.status, message: r.message, warnings: r.warnings };
    const ref = id => components.find(c => c.id === id).ref;
    return {
      status: 'ok',
      net_voltages: Object.fromEntries([...r.nets].map(([name, v]) => [name, Number(v.toFixed(3))])),
      leds: [...r.leds].map(([id, l]) => ({
        ref: ref(id), current_mA: Number((l.current * 1e3).toFixed(2)),
        lit: l.on, brightness_pct: Math.round(l.brightness * 100), overcurrent: l.over,
      })),
      supplies: [...r.supplies].map(([id, a]) => ({ ref: ref(id), current_mA: Number((a * 1e3).toFixed(2)) })),
      warnings: r.warnings,
    };
  }

  // Each handler returns { result, summary }: the result goes back to Claude,
  // the summary is the one-line note shown in the chat.
  const handlers = {
    get_circuit: () => ({ result: describe(), summary: 'Read the circuit' }),

    add_part({ type, holes, value }) {
      const pins = resolveHoles(type, holes);
      const c = makeComponent(type, pins, components);
      if (value !== null) c.value = value;
      components = [...components, c];
      return {
        result: { ref: c.ref, pins: Object.fromEntries(PARTS[type].pins.map((p, i) => [p, pins[i]])), warning: shortWarning(c) },
        summary: `Added ${c.ref} (${PARTS[type].label}${c.value ? ` ${c.value}` : ''}) at ${pins.join(', ')}`,
      };
    },

    update_part({ ref, value, holes, pressed, wiper }) {
      const old = find(ref);
      const patch = {};
      if (value !== null) patch.value = value;
      if (holes !== null) patch.pins = resolveHoles(old.type, holes, old.id);
      if (pressed !== null) patch.pressed = patch.latched = pressed;   // stays down until the user releases it
      if (wiper !== null) patch.wiper = Math.min(1, Math.max(0, wiper));
      const c = { ...old, ...patch };
      components = components.map(x => (x.id === c.id ? c : x));
      const changes = [
        patch.value !== undefined && `value ${c.value}`,
        patch.pins && `moved to ${c.pins.join(', ')}`,
        patch.pressed !== undefined && (c.pressed ? 'pressed' : 'released'),
        patch.wiper !== undefined && `wiper ${Math.round(c.wiper * 100)}%`,
      ].filter(Boolean);
      return { result: { ok: true, warning: shortWarning(c) }, summary: `Updated ${c.ref}: ${changes.join(', ') || 'no changes'}` };
    },

    remove_part({ ref }) {
      const c = find(ref);
      components = components.filter(x => x.id !== c.id);
      return { result: { ok: true }, summary: `Removed ${c.ref}` };
    },

    clear_circuit() {
      components = [];
      return { result: { ok: true }, summary: 'Cleared the breadboard' };
    },

    async simulate() {
      const result = await simulate();
      const leds = result.leds?.map(l => `${l.ref} ${l.lit ? `on (${l.current_mA} mA)` : 'off'}${l.overcurrent ? ' ⚠ overcurrent' : ''}`);
      return {
        result,
        summary: `Simulated: ${result.status === 'ok' ? (leds.length ? leds.join(', ') : 'no LEDs') : result.message}`,
      };
    },
  };

  return {
    get components() { return components; },
    describe,
    async run(name, input) {
      const handler = handlers[name];
      if (!handler) throw new Error(`Unknown tool ${name}`);
      return handler(input);
    },
  };
}
