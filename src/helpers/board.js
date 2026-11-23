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
  // Top rails checked against a scan; the bottom ones mirror them, since scans are flipped (FLIP_SCAN).
  rails: { topPlus: 1, topMinus: 2, botPlus: 19, botMinus: 20 },
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
  // Rail holes are named after the terminal column they line up with, so
  // topPlus12 sits directly above a12. Rails skip a column between groups of 5.
  for (const [rail, y] of Object.entries(LAYOUT.rails)) {
    for (let g = 0; g < LAYOUT.railGroups; g++)
      for (let k = 0; k < LAYOUT.railGroupSize; k++) {
        const pos = LAYOUT.railX0 + g * LAYOUT.railGroupStride + k;
        holes.push({
          id: `${rail}${pos - LAYOUT.x0 + 1}`,
          x: pos * PITCH,
          y: y * PITCH,
          strip: rail,
        });
      }
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

// Frame → board-pixel perspective transform. `calib` is either { H }, a row-major 3×3
// matrix fitted to the holes (see autoCalibrate), or { corners }, the board's 4 clicked corners.
function boardTransform(cv, calib) {
  if (calib.H) return cv.matFromArray(3, 3, cv.CV_64F, calib.H);
  const [tl, tr, br, bl] = calib.corners;
  const from = cv.matFromArray(4, 1, cv.CV_32FC2,
    [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, BOARD_W, 0, BOARD_W, BOARD_H, 0, BOARD_H]);
  const M = cv.getPerspectiveTransform(from, to);
  from.delete(); to.delete();
  return M;
}

// Seen from the camera, the board's + and − rails are the other way up from the app's layout,
// so the flattened scan is flipped top to bottom. Columns still run left to right.
export const FLIP_SCAN = true;

export function warpBoard(cv, src, calib) {
  const M = boardTransform(cv, calib);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(BOARD_W, BOARD_H));
  if (FLIP_SCAN) cv.flip(dst, dst, 0);   // 0 = around the horizontal axis
  M.delete();
  return dst;
}