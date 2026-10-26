import { snapToHole } from '../circuit/holes';
import { PARTS, makeComponent, dipPins } from '../circuit/parts';
import { buildNetlist } from '../circuit/netlist';
import { buildDeck, readResult } from '../sim/spice';
import { runSpice } from '../sim/engine';

const DETECT_URL = import.meta.env.VITE_DETECT_URL;

// Sends the flattened board image to the detector backend.
// Expected response (pin coords in warped-board pixels, keypoint order from PARTS;
// extra padded keypoints are ignored, and DIP ICs only need pin 1):
//   { "detections": [{ "type": "resistor", "confidence": 0.93, "pins": [[x, y], [x, y]] }] }
// Returns null when no detector is configured.
export async function detectParts(canvas) {
  if (!DETECT_URL) return null;
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const form = new FormData();
  form.append('image', blob, 'board.png');
  const res = await fetch(DETECT_URL, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`detector returned ${res.status}`);
  return (await res.json()).detections;
}

// Snaps each detection's pins to holes. Most-confident detections claim holes
// first; anything with a pin off the grid or on a taken hole is skipped.
export function detectionsToComponents(detections) {
  const components = [], used = new Set();
  let skipped = 0;
  const sorted = [...detections].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  for (const d of sorted) {
    const part = PARTS[d.type];
    // The model is trained with padded keypoints (see trainingExport.js); DIP ICs only have pin 1.
    let holes = part && d.pins.slice(0, part.dip ? 1 : part.pins.length).map(([x, y]) => snapToHole({ x, y })?.id);
    if (part?.dip && holes[0]) holes = dipPins(holes[0], part.pins.length);
    const ok = holes && holes.length === part.pins.length
      && holes.every(h => h && !used.has(h)) && new Set(holes).size === holes.length;
    if (!ok) { skipped++; continue; }
    holes.forEach(h => used.add(h));
    components.push(makeComponent(d.type, holes, components));
  }
  return { components, skipped };
}

// The detector can't tell an LED's anode from its cathode, so its pin order is arbitrary.
// Probe the circuit with every LED swapped for 1 GΩ, then point each anode at the higher voltage.
// LEDs with no clear voltage across them (no supply, an open switch, …) are left as found.
export async function orientLeds(components) {
  const leds = components.filter(c => c.type === 'led').length;
  if (!leds) return { components, unsure: 0 };

  const probe = components.map(c => (c.type === 'led' ? { ...c, type: 'resistor', value: '1G' } : c));
  const netlist = buildNetlist(probe);
  const deck = buildDeck(probe, netlist);
  let nets = new Map();
  if (deck.netlist) {
    try {
      const { result, errors } = await runSpice(deck.netlist);
      const r = readResult(deck, result, errors);
      if (r.status === 'ok') nets = r.nets;
    } catch { /* leave every LED as found */ }
  }

  let unsure = 0;
  const volts = (c, pin) => nets.get(netlist.pinNet.get(`${c.id}:${pin}`).name);
  const oriented = components.map(c => {
    if (c.type !== 'led') return c;
    const a = volts(c, 0), k = volts(c, 1);
    if (a === undefined || k === undefined || Math.abs(a - k) < 0.1) { unsure++; return c; }
    return a > k ? c : { ...c, pins: [...c.pins].reverse() };
  });
  return { components: oriented, unsure };
}
