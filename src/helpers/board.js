export const PITCH = 20; // output px per 0.1"
export const BOARD_W = 65 * PITCH;
export const BOARD_H = 21 * PITCH;


/*
    TODO: Measure Breadboard and get correct values for rows.
*/
const LAYOUT = {
  cols: 63, x0: 1.5,
  rowY: { a: 5, b: 6, c: 7, d: 8, e: 9,
          f: 12, g: 13, h: 14, i: 15, j: 16 },
  rails: { topPlus: 1.5, topMinus: 2.4, botPlus: 18.7, botMinus: 19.7 },
  railGroups: 10, railGroupSize: 5, railX0: 3.5, railGroupStride: 6,
};

export function buildHoles() {
  const holes = [];
  for (let c = 0; c < LAYOUT.cols; c++) {
    for (const [row, y] of Object.entries(LAYOUT.rowY)) {
      holes.push({
        id: `${row}${c + 1}`,
        x: (LAYOUT.x0 + c) * PITCH,
        y: y * PITCH,
        strip: `col${c + 1}-${'abcde'.includes(row) ? 'top' : 'bottom'}`,
      });
    }
  }
  for (const [rail, y] of Object.entries(LAYOUT.rails)) {
    for (let g = 0; g < LAYOUT.railGroups; g++)
      for (let k = 0; k < LAYOUT.railGroupSize; k++)
        holes.push({
          id: `${rail}${g * LAYOUT.railGroupSize + k + 1}`,
          x: (LAYOUT.railX0 + g * LAYOUT.railGroupStride + k) * PITCH,
          y: y * PITCH,
          strip: rail,
        });
  }
  return holes;
}

export function orderCorners(p) {
  const s = q => q.x + q.y, d = q => q.x - q.y;
  const tl = p.reduce((a, b) => (s(a) < s(b) ? a : b));
  const br = p.reduce((a, b) => (s(a) > s(b) ? a : b));
  const tr = p.reduce((a, b) => (d(a) > d(b) ? a : b));
  const bl = p.reduce((a, b) => (d(a) < d(b) ? a : b));
  return [tl, tr, br, bl];
}

export function warpBoard(cv, src, [tl, tr, br, bl]) {
  const from = cv.matFromArray(4, 1, cv.CV_32FC2,
    [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, BOARD_W, 0, BOARD_W, BOARD_H, 0, BOARD_H]);
  const M = cv.getPerspectiveTransform(from, to);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(BOARD_W, BOARD_H));
  from.delete(); to.delete(); M.delete();
  return dst;
}