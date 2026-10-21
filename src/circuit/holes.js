import { buildHoles, PITCH } from '../helpers/board';

export const HOLES = buildHoles();
export const HOLE_BY_ID = new Map(HOLES.map(h => [h.id, h]));

// Nearest hole within half a pitch of a point in warped-board pixels, or null.
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
