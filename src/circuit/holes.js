import { buildHoles, PITCH, BOARD_W, BOARD_H } from '../helpers/board';

// The holes of one breadboard, in that board's own pixels. The scan pipeline
// works in these local ids ("a12", "topPlus3") since it sees one board at a time.
export const HOLES = buildHoles();
export const HOLE_BY_ID = new Map(HOLES.map(h => [h.id, h]));

// Nearest hole within half a pitch of a point in board pixels, or null.
export function snapToHole(p) {
  let best = null, bestD = PITCH / 2;
  for (const h of HOLES) {
    const d = Math.hypot(h.x - p.x, h.y - p.y);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

// Columns that have rail holes (rails skip a column between groups of 5).
export const RAIL_COLUMNS = HOLES
  .filter(h => h.id.startsWith('topPlus'))
  .map(h => Number(h.id.slice('topPlus'.length)));

// Saves from before rail holes were named by column numbered them 1–50 along the rail.
export function migrateRailId(id) {
  const m = /^(topPlus|topMinus|botPlus|botMinus)(\d+)$/.exec(id);
  return m ? `${m[1]}${RAIL_COLUMNS[Number(m[2]) - 1]}` : id;
}

// ---------- many boards on one canvas ----------
// A circuit has any number of breadboards ({ id: "B1", x, y, photo? }, x/y in
// canvas pixels). Component pins name holes as "<board>:<hole>", e.g. "B2:a12",
// so a part or wire can sit on one board or run between two.

export const holeId = (board, local) => `${board}:${local}`;

// "B2:a12" → ["B2", "a12"]; a bare "a12" → [null, "a12"].
export function splitHole(id) {
  const i = id.indexOf(':');
  return i < 0 ? [null, id] : [id.slice(0, i), id.slice(i + 1)];
}

export const localHole = id => HOLE_BY_ID.get(splitHole(id)[1]);

// The conductor a hole belongs to. Strips are per board: a12 on B1 and a12 on B2 aren't connected.
export function holeStrip(id) {
  const [board, local] = splitHole(id);
  return `${board}:${HOLE_BY_ID.get(local).strip}`;
}

// Where a hole is on the canvas. `boards` is a Map from board id to board.
export function holePoint(id, boards) {
  const [board, local] = splitHole(id);
  const h = HOLE_BY_ID.get(local), b = boards.get(board);
  return { x: b.x + h.x, y: b.y + h.y };
}

// The hole under a canvas point (within half a pitch), as a full id, or null.
export function holeAt(p, boards) {
  for (const b of [...boards.values()].reverse()) {   // topmost board first
    if (p.x < b.x || p.y < b.y || p.x > b.x + BOARD_W || p.y > b.y + BOARD_H) continue;
    const h = snapToHole({ x: p.x - b.x, y: p.y - b.y });
    return h ? holeId(b.id, h.id) : null;
  }
  return null;
}

export function nextBoardId(boards) {
  const used = boards.map(b => parseInt(b.id.slice(1), 10) || 0);
  return `B${Math.max(0, ...used) + 1}`;
}

const GAP = 3 * PITCH;
// A spot for a new board: below the lowest one, lined up with the leftmost.
export function freeBoardSpot(boards) {
  if (!boards.length) return { x: 0, y: 0 };
  return {
    x: Math.min(...boards.map(b => b.x)),
    y: Math.max(...boards.map(b => b.y)) + BOARD_H + GAP,
  };
}

export function makeBoard(boards, extra) {
  return { id: nextBoardId(boards), ...freeBoardSpot(boards), ...extra };
}
