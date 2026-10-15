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
