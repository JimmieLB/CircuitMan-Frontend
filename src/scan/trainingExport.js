import { BOARD_W, BOARD_H, PITCH } from '../helpers/board';
import { HOLE_BY_ID } from '../circuit/holes';
import { PARTS } from '../circuit/parts';

// YOLO-pose training labels made from parts placed over a scanned photo.
// Every class has KEYPOINTS slots; parts with fewer pins mark the rest invisible,
// and DIP ICs only label pin 1 (dipPins() rebuilds the rest from it).
export const CLASS_NAMES = Object.keys(PARTS);
export const KEYPOINTS = 4;

const f = n => n.toFixed(6);
const clamp = (v, max) => Math.min(max, Math.max(0, v));

// A photo can't show these parts' pins apart (an inserted LED hides which leg is longer),
// so their keypoints go left to right, then top to bottom, whatever order they were placed in.
// Scans work out each LED's direction from the circuit instead (see orientLeds in detect.js).
const UNORDERED = new Set(['wire', 'resistor', 'led']);

function labelPins(c) {
  if (PARTS[c.type].dip) return c.pins.slice(0, 1);
  if (!UNORDERED.has(c.type)) return c.pins;
  return [...c.pins].sort((a, b) => {
    const p = HOLE_BY_ID.get(a), q = HOLE_BY_ID.get(b);
    return p.x - q.x || p.y - q.y;
  });
}

// One line per part: class cx cy w h, then x y visibility for each keypoint, all normalised 0–1.
// The box is the pins' extent padded by one pitch, since only pin positions are known.
export function yoloLabels(components) {
  return components.map(c => {
    const pts = c.pins.map(id => HOLE_BY_ID.get(id));
    const x0 = clamp(Math.min(...pts.map(p => p.x)) - PITCH, BOARD_W);
    const x1 = clamp(Math.max(...pts.map(p => p.x)) + PITCH, BOARD_W);
    const y0 = clamp(Math.min(...pts.map(p => p.y)) - PITCH, BOARD_H);
    const y1 = clamp(Math.max(...pts.map(p => p.y)) + PITCH, BOARD_H);
    const box = [(x0 + x1) / 2 / BOARD_W, (y0 + y1) / 2 / BOARD_H, (x1 - x0) / BOARD_W, (y1 - y0) / BOARD_H];

    const kpts = labelPins(c).map(id => HOLE_BY_ID.get(id));
    const slots = Array.from({ length: KEYPOINTS }, (_, i) => {
      const p = kpts[i];
      return p ? `${f(p.x / BOARD_W)} ${f(p.y / BOARD_H)} 2` : '0 0 0';
    });
    return [CLASS_NAMES.indexOf(c.type), ...box.map(f), ...slots].join(' ');
  }).join('\n') + '\n';
}

// Train with fliplr=0: a mirrored image would swap LED/capacitor polarity and pin order.
export function datasetYaml() {
  return [
    'path: .',
    'train: images/train',
    'val: images/val',
    `kpt_shape: [${KEYPOINTS}, 3]`,
    `flip_idx: [${Array.from({ length: KEYPOINTS }, (_, i) => i).join(', ')}]`,
    'names:',
    ...CLASS_NAMES.map((n, i) => `  ${i}: ${n}`),
    '',
  ].join('\n');
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const toBase64 = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result.slice(r.result.indexOf(',') + 1));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// Saves files into TRAINING_DIR (set in .env.local) through the dev server and returns that
// folder. When it isn't set, or there's no dev server, the browser downloads them and this returns null.
export async function saveTrainingFiles(files) {
  const body = JSON.stringify({
    files: await Promise.all(files.map(async f => ({ name: f.name, data: await toBase64(f.blob) }))),
  });
  const res = await fetch('/api/training', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    .catch(() => null);
  // A static host may answer an unknown path with index.html, so only trust a JSON reply.
  if (res?.ok && res.headers.get('Content-Type')?.includes('json')) return (await res.json()).dir;
  if (res && !res.ok && res.status !== 404) throw new Error(await res.text() || `server error ${res.status}`);
  files.forEach(f => download(f.blob, f.name));
  return null;
}

// Saves board_<time>.png (the photo at board resolution) and a matching board_<time>.txt.
export async function exportTrainingSample(photo, components) {
  const img = new Image();
  img.src = photo;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = BOARD_W;
  canvas.height = BOARD_H;
  canvas.getContext('2d').drawImage(img, 0, 0, BOARD_W, BOARD_H);
  const png = await new Promise(r => canvas.toBlob(r, 'image/png'));

  const name = `board_${Date.now()}`;
  return saveTrainingFiles([
    { name: `${name}.png`, blob: png },
    { name: `${name}.txt`, blob: new Blob([yoloLabels(components)], { type: 'text/plain' }) },
  ]);
}

export const saveDatasetYaml = () =>
  saveTrainingFiles([{ name: 'dataset.yaml', blob: new Blob([datasetYaml()], { type: 'text/yaml' }) }]);
