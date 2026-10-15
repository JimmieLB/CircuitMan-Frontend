import { snapToHole } from '../circuit/holes';
import { PARTS, makeComponent } from '../circuit/parts';

const DETECT_URL = import.meta.env.VITE_DETECT_URL;

// Sends the flattened board image to the detector backend.
// Expected response (pin coords in warped-board pixels, keypoint order from PARTS):
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
    const holes = part && d.pins.slice(0, part.pins.length).map(([x, y]) => snapToHole({ x, y })?.id);
    const ok = holes && holes.length === part.pins.length
      && holes.every(h => h && !used.has(h)) && new Set(holes).size === holes.length;
    if (!ok) { skipped++; continue; }
    holes.forEach(h => used.add(h));
    components.push(makeComponent(d.type, holes, components));
  }
  return { components, skipped };
}
