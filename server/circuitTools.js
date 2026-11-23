// Tools the circuit agent can call. They work on a copy of the user's circuit
// (the same component list the editor uses) and reuse the app's netlist and
// SPICE code, so the agent sees exactly what the user sees.
import { PARTS, makeComponent, dipPins, nextRef, pinLabel } from '../src/circuit/parts';
import { HOLES, RAIL_COLUMNS, holeId, holeStrip, makeBoard, splitHole } from '../src/circuit/holes';
import { buildNetlist } from '../src/circuit/netlist';
import { buildDeck, opDeck, tranDeck, readResult } from '../src/sim/spice';
import { runSpice } from '../src/sim/engine';
import { parseChip, describeChip, chipReference } from '../src/sim/logic';

const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const PART_TYPES = Object.keys(PARTS);

export const TOOLS = [
  {
    name: 'get_circuit',
    description: 'Returns the breadboards, every part (ref, type, value, and the hole each pin is in) and the nets that connect them.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'add_part',
    description: 'Places a new part. `holes` lists one hole per pin in the part type\'s pin order, each as "<board>:<hole>" (e.g. "B1:a12"); the pins may be on different boards. For DIP ICs you may instead pass only the pin-1 hole. Returns the new part\'s ref.',
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
    name: 'add_breadboard',
    description: 'Adds an empty breadboard to the canvas, below the others. Returns its id (e.g. "B2"). Its strips and rails are separate from every other board\'s until wires connect them.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'remove_breadboard',
    description: 'Removes a breadboard and every part or wire with a pin on it. Only when the user asks.',
    input_schema: {
      type: 'object',
      properties: { board: { type: 'string', description: 'Board id, e.g. "B2".' } },
      required: ['board'],
      additionalProperties: false,
    },
  },
  {
    name: 'clear_circuit',
    description: 'Removes every part from every breadboard (the boards stay). Only use this when the user wants to start over.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'simulate',
    description: 'Simulates the current circuit with SPICE. Without capacitors or logic chips it finds the DC operating point. Otherwise it runs time forward by `duration_s` from the capacitors\' present charge, and their charge carries over to the next simulate call, so you can step through a scenario: e.g. press a button, simulate 1 s, release it, simulate 3 s. Returns the state at the end (net voltages, LED currents and whether each is lit, supply currents, capacitor voltages, warnings) plus, for timed runs, a timeline of capacitor voltages and LED currents and whether the circuit had settled.',
    input_schema: {
      type: 'object',
      properties: {
        duration_s: nullable({ type: 'number', description: 'Seconds of circuit time to simulate (0.001–60). Null for 2 s. Ignored when there are no capacitors or logic chips.' }),
      },
      required: ['duration_s'],
      additionalProperties: false,
    },
  },
  {
    name: 'discharge_capacitors',
    description: 'Empties every capacitor, in your simulation and on the user\'s breadboard. Use it to start a timing test from a known state, or when the user asks.',
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

export const SYSTEM_PROMPT = `You are the circuit assistant inside Circuit Max, an app where students build circuits on virtual breadboards and see them simulated. You change the user's circuit by calling tools; the editor updates live as you work.

## Breadboards
The circuit sits on a canvas that holds one or more identical breadboards, with ids B1, B2, …. A hole is named "<board>:<hole>", e.g. "B1:a12" or "B2:topPlus3". Every board's strips and rails are its own: B1:a12 and B2:a12 are not connected, and neither are the two boards' power rails, until a jumper wire joins them. To power a second board, run wires from one board's rails to the other's (e.g. "B1:topPlus3" → "B2:topPlus3" and "B1:topMinus4" → "B2:topMinus4"). A wire or part can span two boards, but keep each part on one board unless there's a reason not to. Only add a board when the circuit doesn't fit or the user asks for one.

Each board:
- The main area has columns 1–63 and rows a–j. Within a board, a hole is row + column, e.g. "a12" or "h40".
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
- seg7 is a single-digit 7-segment display, placed like a DIP (pin-1 hole in row f; pins 1–5 run along f, 6–10 back along e). Pins: 1 E, 2 D, 3 COM1, 4 C, 5 DP, 6 B, 7 A, 8 COM2, 9 F, 10 G; COM1 and COM2 are joined inside, so either works. Its value says the type and colour, e.g. "common cathode red" or "common anode green". Each segment is an LED: for common cathode, connect COM to GND and drive each segment high through its own resistor (about 330Ω at 5V); for common anode, COM goes to + and a segment lights when pulled low through its resistor. Never share one resistor on COM (the brightness would change with the digit). Segments a–g are top, upper right, lower right, bottom, lower left, upper left and middle; the simulator reports each one as an LED named like DS1.a, so you can check which digit shows. The package covers rows c–h of its five columns, so make connections in rows a, b, i and j.
- The power supply's + and − pins usually go in topPlus and topMinus. Nets touching the supply's + pin are named VCC and its − pin GND.
- When adding a push button, always set pin 1 and pin 4 on row e with 1 column between them, and pin 2 and pin 3 on row f with 1 column between them.

## Logic chips (ic_dip14)
An ic_dip14's value is its part number, e.g. "74HC00", "74LS08", "74HCT04", "CD4011", "CD40106". The family letters set its electrical behaviour: 74 / 74LS / 74S / 74F are TTL (need about 5 V; a high output sits near 3.4 V; an unconnected input reads high), 74HC / 74AC are CMOS (2–6 V, thresholds at half the supply), 74HCT / 74ACT are CMOS with TTL-level inputs, and the 4000 series (CD4xxx, HEF4xxx) is CMOS for 3–18 V with weak outputs (about 600 Ω). On every one of these chips pin 14 is VCC (+) and pin 7 is GND (−); a chip without power does nothing. Unconnected CMOS inputs read low here, but tell the user real ones should be tied high or low. Open-collector chips can only pull their outputs low, so they need a pull-up resistor. Schmitt-trigger chips (7414, 74132, 4093, 40106) have input hysteresis: an inverter with a resistor from its output back to its input and a capacitor from the input to GND makes an oscillator (period roughly R × C).

Supported chips, grouped by pinout. In the series names, x stands for the family letters, e.g. 74x00 covers 74HC00 and 74LS00; 4000-series numbers may have any prefix or suffix (CD4011BE, HEF4011BP, MC14011B, and 74HC4xxx versions):
${chipReference()}
Other chips (counters, flip-flops, 555 timers, analog switches like the 4066) aren't simulated.

## Simulation
The app simulates the breadboard in real time with SPICE: capacitors charge and discharge over time, and keep their charge while the user presses buttons or edits the circuit. Logic gates have a short delay and remember their output, so latches built from gates (e.g. an SR latch from two NANDs) hold their state. A circuit with neither capacitors nor logic chips has no time behaviour, so it's solved once per change. A circuit that switches very fast is shown in slow motion. The only ICs simulated are the logic chips listed above. An LED counts as lit above 0.5 mA, and above 30 mA it would burn out.

Your simulate tool starts from the capacitor voltages on the user's board when they sent their message (charged_to_V in the current circuit) and keeps its own clock. Simulated time passing doesn't change the user's board, but discharge_capacitors does. To check timing (how long an LED stays on, how fast a capacitor charges), discharge first if a known starting point matters, then simulate in steps, pressing buttons or moving pots between steps the way the user would. An RC time constant is R × C; a capacitor is about 63% charged after one and nearly full after five.

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

const round = (v, d = 3) => Number(v.toFixed(d));

// "DS1 shows a,b,c" for each 7-segment display, from its per-segment LED readings.
function displaySummaries(leds) {
  const byDisplay = new Map();
  for (const l of leds) {
    const [ref, seg] = l.ref.split('.');
    if (!seg) continue;
    if (!byDisplay.has(ref)) byDisplay.set(ref, { lit: [], over: [] });
    if (l.lit) byDisplay.get(ref).lit.push(seg);
    if (l.overcurrent) byDisplay.get(ref).over.push(seg);
  }
  return [...byDisplay].map(([ref, d]) =>
    `${ref} ${d.lit.length ? `shows ${d.lit.join(',')}` : 'dark'}${d.over.length ? ` ⚠ overcurrent in ${d.over.join(',')}` : ''}`);
}
const STEPS = 20;   // timeline points per timed simulate call
const MAX_WALL_MS = 15000;   // real time one simulate call may take

// `capVoltages` is { component id: volts } from the user's board; `initialBoards` the canvas's boards.
export function createSession(initial, capVoltages = {}, initialBoards = [{ id: 'B1', x: 0, y: 0 }]) {
  let boards = initialBoards.length ? initialBoards : [{ id: 'B1', x: 0, y: 0 }];
  let capV = new Map(Object.entries(capVoltages).filter(([, v]) => Number.isFinite(v)));
  let clock = 0;   // seconds of circuit time simulated this turn
  // Older saves have jumper wires without refs; name them so the agent can refer to them.
  let components = [];
  for (const c of initial)
    components.push(c.ref || !PARTS[c.type]?.prefix ? c : { ...c, ref: nextRef(c.type, components) });

  function find(ref) {
    const c = components.find(x => x.ref.toLowerCase() === String(ref).toLowerCase());
    if (!c) throw new Error(`There's no part called "${ref}". Call get_circuit to see the parts.`);
    return c;
  }

  // "B2:a12" → "B2:a12" (case fixed). A bare "a12" is fine while there's only one board.
  function resolveHole(text) {
    const [boardText, localText] = splitHole(String(text).trim());
    let board;
    if (boardText === null) {
      if (boards.length > 1) throw new Error(`"${text}" needs a board: there are ${boards.length} breadboards (${boards.map(b => b.id).join(', ')}), so write e.g. "${boards[0].id}:${localText}".`);
      board = boards[0];
    } else {
      board = boards.find(b => b.id.toLowerCase() === boardText.trim().toLowerCase());
      if (!board) throw new Error(`There's no breadboard "${boardText}". The boards are ${boards.map(b => b.id).join(', ')}.`);
    }
    const local = HOLE_BY_LOWER.get(localText.trim().toLowerCase());
    if (!local) throw new Error(holeError(localText.trim()));
    return holeId(board.id, local);
  }

  function resolveHoles(type, holes, movingId) {
    const part = PARTS[type], n = part.pins.length;
    let pins = holes.map(resolveHole);
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
    const [a, b] = c.pins.map(holeStrip);
    if (a !== b) return undefined;
    return c.type === 'wire'
      ? `Both ends of ${c.ref} are in the same strip (${a}), so it connects nothing.`
      : `Both pins of ${c.ref} are in the same strip (${a}), so it's shorted out.`;
  }

  function describe() {
    const netlist = buildNetlist(components);
    return {
      breadboards: boards.map(b => b.id),
      parts: components.map(c => ({
        ref: c.ref,
        type: c.type,
        value: c.value,
        pins: Object.fromEntries(PARTS[c.type].pins.map((p, i) => [p, c.pins[i]])),
        ...(c.type === 'button' && { pressed: !!c.pressed }),
        ...(c.type === 'pot' && { wiper: c.wiper ?? 0.5 }),
        ...(c.type === 'capacitor' && { charged_to_V: round(capV.get(c.id) ?? 0) }),
        ...(c.type === 'ic_dip14' && { chip: parseChip(c.value) ? describeChip(parseChip(c.value)) : 'not a supported logic chip, so not simulated' }),
      })),
      nets: netlist.nets.map(net => ({ name: net.name, pins: net.pins.map(p => pinLabel(p.comp, p.pin)) })),
    };
  }

  // Results are keyed by component id; a 7-segment display's segments by "<id>#<segment>" (reported as DS1.a).
  const refOf = id => {
    const [cid, sub] = id.split('#');
    const ref = components.find(c => c.id === cid).ref;
    return sub ? `${ref}.${sub}` : ref;
  };

  function snapshot(r) {
    return {
      net_voltages: Object.fromEntries([...r.nets].map(([name, v]) => [name, round(v)])),
      leds: [...r.leds].map(([id, l]) => ({
        ref: refOf(id), current_mA: round(l.current * 1e3, 2),
        lit: l.on, brightness_pct: Math.round(l.brightness * 100), overcurrent: l.over,
      })),
      supplies: [...r.supplies].map(([id, a]) => ({ ref: refOf(id), current_mA: round(a * 1e3, 2) })),
      ...(r.caps.size && { capacitors: [...r.caps].map(([id, v]) => ({ ref: refOf(id), volts: round(v) })) }),
    };
  }

  async function simulate(duration) {
    const netlist = buildNetlist(components);
    const deck = buildDeck(components, netlist);
    if (deck.off) return { status: 'off', message: deck.off };
    if (deck.error) return { status: 'error', message: deck.error };

    if (!deck.caps.length) {
      const { result, errors } = await runSpice(opDeck(deck));
      const r = readResult(deck, result, errors);
      if (r.status !== 'ok') return { status: r.status, message: r.message, warnings: r.warnings };
      return { status: 'ok', mode: 'dc', ...snapshot(r), warnings: r.warnings };
    }

    // Run in STEPS chunks, each starting from the capacitor voltages the last one ended on.
    const total = Math.min(60, Math.max(1e-3, duration ?? 2)), dt = total / STEPS, start = clock;
    const timeline = [], began = Date.now();
    let r, lastDv = 0, stoppedEarly = false;
    for (let i = 0; i < STEPS; i++) {
      // Something oscillating very fast can take the solver ages: give back what we have.
      if (i && Date.now() - began > MAX_WALL_MS) { stoppedEarly = true; break; }
      const { result, errors } = await runSpice(tranDeck(deck, capV, dt));
      r = readResult(deck, result, errors);
      if (r.status !== 'ok') return { status: r.status, message: r.message, warnings: r.warnings, at_time_s: round(clock, 4) };
      lastDv = Math.max(0, ...deck.caps.map(c => Math.abs(r.state.get(c.id) - (capV.get(c.id) ?? 0))));
      capV = new Map([...capV, ...r.state]);   // includes logic-gate states
      clock += dt;
      timeline.push({
        t_s: round(clock - start, 4),
        capacitors_V: Object.fromEntries([...r.caps].map(([id, v]) => [refOf(id), round(v)])),
        ...(r.leds.size && { leds_mA: Object.fromEntries([...r.leds].map(([id, l]) => [refOf(id), round(l.current * 1e3, 2)])) }),
      });
    }
    return {
      status: 'ok', mode: 'transient',
      started_at_s: round(start, 4), duration_s: round(total, 4),
      settled: lastDv < 1e-3,   // capacitors moved less than 1 mV in the last step
      ...(stoppedEarly && { stopped_early: `Only ${round(clock - start, 6)} s simulated: the circuit switches too fast to simulate for longer in one call. Use a shorter duration_s.` }),
      final: snapshot(r),
      timeline,
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

    add_breadboard() {
      const b = makeBoard(boards);
      boards = [...boards, b];
      return { result: { board: b.id }, summary: `Added breadboard ${b.id}` };
    },

    remove_breadboard({ board }) {
      const b = boards.find(x => x.id.toLowerCase() === String(board).trim().toLowerCase());
      if (!b) throw new Error(`There's no breadboard "${board}". The boards are ${boards.map(x => x.id).join(', ')}.`);
      if (boards.length === 1) throw new Error('That\'s the only breadboard; the canvas needs at least one.');
      const gone = components.filter(c => c.pins.some(p => splitHole(p)[0] === b.id));
      boards = boards.filter(x => x !== b);
      components = components.filter(c => !gone.includes(c));
      return {
        result: { ok: true, removed_parts: gone.map(c => c.ref) },
        summary: `Removed breadboard ${b.id}${gone.length ? ` and ${gone.map(c => c.ref).join(', ')}` : ''}`,
      };
    },

    clear_circuit() {
      components = [];
      return { result: { ok: true }, summary: 'Cleared the breadboard' };
    },

    async simulate({ duration_s }) {
      const result = await simulate(duration_s);
      if (result.status !== 'ok') return { result, summary: `Simulated: ${result.message}` };
      const end = result.final ?? result;
      const parts = [
        ...end.leds.filter(l => !l.ref.includes('.')).map(l => `${l.ref} ${l.lit ? `on (${l.current_mA} mA)` : 'off'}${l.overcurrent ? ' ⚠ overcurrent' : ''}`),
        ...displaySummaries(end.leds),
        ...(end.capacitors ?? []).map(c => `${c.ref} ${c.volts} V`),
      ];
      const head = result.mode === 'transient' ? `Simulated ${result.duration_s} s` : 'Simulated';
      return { result, summary: `${head}: ${parts.length ? parts.join(', ') : 'no LEDs'}` };
    },

    discharge_capacitors() {
      capV = new Map([...capV].filter(([id]) => id.includes('#')));   // logic-gate states stay
      clock = 0;
      return { result: { ok: true }, summary: 'Discharged the capacitors', discharge: true };
    },
  };

  return {
    get components() { return components; },
    get boards() { return boards; },
    describe,
    async run(name, input) {
      const handler = handlers[name];
      if (!handler) throw new Error(`Unknown tool ${name}`);
      return handler(input);
    },
  };
}
