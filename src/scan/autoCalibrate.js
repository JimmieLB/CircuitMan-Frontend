import { HOLES, HOLE_BY_ID } from '../circuit/holes';
import { PITCH } from '../helpers/board';

// Finds the breadboard from its holes, so no corner clicking is needed:
// 1. Small, dark, evenly sized blobs in the frame are hole candidates.
// 2. Candidates one pitch apart along the grid are linked. Walking out from the best-linked
//    hole gives its neighbours a column and row index.
// 3. A homography from the frame to those indices predicts where the grid continues. It's
//    grown outwards a few steps at a time: snap the candidates that land near a grid point,
//    refit, reach further. Stray spots, part edges and the rails (which sit between grid rows)
//    fall away, and the channel is a whole number of rows, so both halves land on the grid.
// 4. The board is where the rows go 5 full, 2 empty, 5 full, across 63 columns.
// 5. A RANSAC homography from those holes to their board positions is the calibration.
// Like corner calibration, it assumes the board is upright in the frame: row a at the top,
// column 1 on the left. Only terminal holes are used, so the rail layout doesn't matter.

const ROWS = 'abcdefghij';
const ROW_OFFSETS = [...ROWS].map(r => Math.round((HOLE_BY_ID.get(`${r}1`).y - HOLE_BY_ID.get('a1').y) / PITCH));
const COLS = HOLES.filter(h => /^a\d+$/.test(h.id)).length;
const CHANNEL = [ROW_OFFSETS[4] + 1, ROW_OFFSETS[4] + 2];   // empty grid rows between e and f

const BLOCK = 21, OFFSET = 12;   // adaptive threshold: neighbourhood (px), and how much darker than it a hole must be
const LINK = [0.7, 1.6];         // neighbour distance range, in local pitches (perspective stretches one axis)
const SNAP = 0.2;               // how close to a grid point a candidate must land, in pitches
const MIN_HOLES = 150;
const SEED = 40;                 // walk indices to start the grid from (a patch about 8 × 5 holes)
const MAX_PASSES = 15;

const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];

function findCandidates(cv, src) {
  const gray = new cv.Mat(), bin = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
  cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, BLOCK, OFFSET);
  const contours = new cv.MatVector(), hierarchy = new cv.Mat();
  // Every contour, not just outer ones: a bright board on a dark table thresholds to a ring
  // around the board, and outer-only would drop every hole inside it.
  cv.findContours(bin, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const maxSide = src.cols / 40, blobs = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const r = cv.boundingRect(c), area = cv.contourArea(c);
    c.delete();
    const aspect = r.width / r.height;
    if (r.width < 2 || r.height < 2 || r.width > maxSide || r.height > maxSide) continue;
    if (aspect < 0.5 || aspect > 2 || area < 0.3 * r.width * r.height) continue;
    blobs.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, area, size: Math.max(r.width, r.height) });
  }
  gray.delete(); bin.delete(); contours.delete(); hierarchy.delete();

  if (!blobs.length) return [];
  const typical = median(blobs.map(b => b.area));   // holes outnumber everything else
  // A hole with a lighter middle gives an inner outline too; keep only the bigger of the two.
  const kept = [];
  for (const b of blobs.filter(b => b.area > typical / 3 && b.area < typical * 3).sort((a, b) => b.area - a.area))
    if (!kept.some(k => Math.hypot(k.x - b.x, k.y - b.y) < k.size / 2)) kept.push(b);
  return kept;
}

// Links candidates about one pitch apart. Perspective makes the pitch change across the
// board, so each point's nearest-neighbour distance is its local pitch. Returns adjacency lists.
function link(pts) {
  const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const local = pts.map((p, i) => Math.sqrt(Math.min(...pts.map((q, j) => (i === j ? Infinity : d2(p, q))))));
  const adj = pts.map(() => []);
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      // it has to be about one pitch for both ends, or an isolated stray spot would link far away
      const d = Math.sqrt(d2(pts[i], pts[j]));
      const fits = pitch => d >= LINK[0] * pitch && d <= LINK[1] * pitch;
      if (fits(local[i]) && fits(local[j])) { adj[i].push(j); adj[j].push(i); }
    }
  return adj;
}

// Connected groups of points with at least `minLinks` links, biggest first.
function groups(adj, minLinks) {
  const ok = adj.map(a => a.length >= minLinks), seen = new Set(), out = [];
  for (let s = 0; s < adj.length; s++) {
    if (!ok[s] || seen.has(s)) continue;
    const g = [s];
    seen.add(s);
    for (let k = 0; k < g.length; k++)
      for (const q of adj[g[k]]) if (ok[q] && !seen.has(q)) { seen.add(q); g.push(q); }
    out.push(g);
  }
  return out.sort((a, b) => b.length - a.length);
}

// Unit vector along a group's long axis (the direction the columns count in).
function longAxis(pts, g) {
  const mx = g.reduce((s, i) => s + pts[i].x, 0) / g.length, my = g.reduce((s, i) => s + pts[i].y, 0) / g.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const i of g) {
    const dx = pts[i].x - mx, dy = pts[i].y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const a = Math.atan2(2 * sxy, sxx - syy) / 2;
  return { x: Math.cos(a), y: Math.sin(a) };
}

// A link's step along the columns (du) and rows (dv).
function step(pts, p, q, u, v) {
  const dx = pts[q].x - pts[p].x, dy = pts[q].y - pts[p].y;
  return [dx * u.x + dy * u.y, dx * v.x + dy * v.y];
}

// Keeps only links that run along a grid line; diagonal links come from stray spots.
function alongGrid(pts, adj, u, v) {
  return adj.map((qs, p) => qs.filter(q => {
    const [du, dv] = step(pts, p, q, u, v).map(Math.abs);
    return Math.min(du, dv) <= 0.5 * Math.max(du, dv);
  }));
}

// Gives each point in the group a [column, row] index by stepping one pitch at a time,
// starting from its best-linked point (an inner hole, not a stray spot).
function walk(pts, adj, g, u, v) {
  const start = g.reduce((a, b) => (adj[b].length > adj[a].length ? b : a));
  const inGroup = new Set(g), lab = new Map([[start, [0, 0]]]), queue = [start];
  for (let k = 0; k < queue.length; k++) {
    const p = queue[k], [i, j] = lab.get(p);
    for (const q of adj[p]) {
      if (lab.has(q) || !inGroup.has(q)) continue;
      const [du, dv] = step(pts, p, q, u, v);
      lab.set(q, Math.abs(du) > Math.abs(dv) ? [i + Math.sign(du), j] : [i, j + Math.sign(dv)]);
      queue.push(q);
    }
  }
  return lab;
}

const toMat = (cv, xys) => cv.matFromArray(xys.length, 1, cv.CV_32FC2, xys.flat());

// Homography from frame pixels to grid indices. RANSAC keeps the consistent majority, so a
// wrong step in the walk (which shifts everything reached through it) doesn't spoil it.
function fitGrid(cv, pts, lab) {
  const ids = [...lab.keys()];
  if (ids.length < 4) return null;   // a homography needs 4 points
  const from = toMat(cv, ids.map(k => [pts[k].x, pts[k].y])), to = toMat(cv, ids.map(k => lab.get(k)));
  const mask = new cv.Mat();
  const M = cv.findHomography(from, to, cv.RANSAC, SNAP, mask);
  from.delete(); to.delete(); mask.delete();
  if (M.empty()) { M.delete(); return null; }
  return M;
}

// Candidates that land near a grid point inside `bounds` ([i0, i1, j0, j1]),
// as candidate index → [column, row].
function snap(cv, M, pts, [i0, i1, j0, j1]) {
  const from = toMat(cv, pts.map(p => [p.x, p.y])), at = new cv.Mat(), out = new Map();
  cv.perspectiveTransform(from, at, M);
  pts.forEach((_, n) => {
    const i = at.data32F[2 * n], j = at.data32F[2 * n + 1];
    const ri = Math.round(i), rj = Math.round(j);
    if (ri < i0 || ri > i1 || rj < j0 || rj > j1) return;
    if (Math.abs(i - ri) < SNAP && Math.abs(j - rj) < SNAP) out.set(n, [ri, rj]);
  });
  from.delete(); at.delete();
  return out;
}

// The indexed area plus a margin of half its size (at least 3, to reach across the channel).
function reach(lab) {
  const ls = [...lab.values()], out = [];
  for (const axis of [0, 1]) {
    const lo = Math.min(...ls.map(l => l[axis])), hi = Math.max(...ls.map(l => l[axis]));
    const m = Math.max(3, Math.ceil((hi - lo) / 2));
    out.push(lo - m, hi + m);
  }
  return out;
}

function countBy(values) {
  const count = new Map();
  for (const x of values) count.set(x, (count.get(x) ?? 0) + 1);
  return count;
}

// The start position whose window scores best, trying every start that overlaps the data.
function bestStart(count, width, score) {
  const keys = [...count.keys()];
  let best = null, bestScore = -Infinity;
  for (let s = Math.min(...keys) - width + 1; s <= Math.max(...keys); s++) {
    const sc = score(k => count.get(s + k) ?? 0);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return best;
}

// Returns { H, holes, candidates } on success, where H is the frame → board-pixel homography
// (row-major 3×3) and holes is how many holes agreed with it; otherwise { error, candidates }.
export function autoCalibrate(cv, src) {
  try {
    return fit(cv, src);
  } catch (err) {   // OpenCV throws a pointer to its exception
    return { error: typeof err === 'number' ? cv.exceptionFromPtr(err).msg : err.message, candidates: [] };
  }
}

function fit(cv, src) {
  const pts = findCandidates(cv, src);
  const fail = error => ({ error, candidates: pts });
  if (pts.length < MIN_HOLES) return fail(`Only found ${pts.length} hole-like spots.`);

  // The board's direction comes from the biggest linked group, even if stray spots joined
  // it to other things; then only links along that grid are kept.
  const links = link(pts);
  const [rough] = groups(links, 2);
  if (!rough) return fail('Couldn\'t find a grid of holes.');
  const u = longAxis(pts, rough);
  if (u.x < 0) { u.x = -u.x; u.y = -u.y; }   // columns count left to right
  const v = { x: -u.y, y: u.x };             // rows count downwards
  const adj = alongGrid(pts, links, u, v);
  // Holes away from the corners have 3–4 grid links; stray spots rarely do.
  const [g] = groups(adj, 3);
  if (!g || g.length < MIN_HOLES / 2) return fail('Couldn\'t find a grid of holes.');

  // Seed with the walk's indices near its start, before a wrong step can have crept in,
  // then grow the grid until it stops finding more holes.
  const walked = walk(pts, adj, g, u, v);
  const start = pts[walked.keys().next().value];
  const near = [...walked.keys()].sort((a, b) =>
    Math.hypot(pts[a].x - start.x, pts[a].y - start.y) - Math.hypot(pts[b].x - start.x, pts[b].y - start.y));
  let lab = new Map(near.slice(0, SEED).map(k => [k, walked.get(k)]));
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const M = fitGrid(cv, pts, lab);
    if (!M) return fail('Couldn\'t line up a grid of holes.');
    const next = snap(cv, M, pts, reach(lab));
    M.delete();
    const grown = next.size > lab.size;
    lab = next;
    if (!grown && pass > 0) break;
  }

  // Rows: 5 full, the 2-row channel, 5 full.
  const rowCount = countBy([...lab.values()].map(l => l[1]));
  const r0 = bestStart(rowCount, ROW_OFFSETS.at(-1) + 1,
    c => ROW_OFFSETS.reduce((s, o) => s + c(o), 0) - 3 * CHANNEL.reduce((s, o) => s + c(o), 0));
  const rowHoles = ROW_OFFSETS.map(o => rowCount.get(r0 + o) ?? 0);
  if (Math.min(...rowHoles) < 5)
    return fail(`Found holes in ${rowHoles.filter(n => n >= 5).length} of the 10 rows. Make sure the whole board is in view.`);
  if (Math.max(...CHANNEL.map(o => rowCount.get(r0 + o) ?? 0)) > Math.min(...rowHoles) / 4)
    return fail('Couldn\'t find the centre channel between rows e and f.');

  // Columns: the 63 in a row with the most holes, with holes at both ends and none just outside.
  const onRow = l => ROW_OFFSETS.includes(l[1] - r0);
  const colCount = countBy([...lab.values()].filter(onRow).map(l => l[0]));
  const c0 = bestStart(colCount, COLS, c => Array.from({ length: COLS }, (_, k) => c(k)).reduce((a, b) => a + b));
  const col = k => colCount.get(c0 + k) ?? 0;
  const typical = median(Array.from({ length: COLS }, (_, k) => col(k)));
  if (col(0) < 2 || col(COLS - 1) < 2)
    return fail(`Couldn't find all ${COLS} columns. Make sure the whole board is in view.`);
  if (Math.max(col(-1), col(COLS)) > typical / 2)
    return fail(`Found more than ${COLS} columns of holes, so the board's ends are unclear.`);

  const pairs = [];
  for (const [n, [i, j]] of lab) {
    const row = ROW_OFFSETS.indexOf(j - r0);
    if (row >= 0 && i >= c0 && i < c0 + COLS) pairs.push([pts[n], HOLE_BY_ID.get(`${ROWS[row]}${i - c0 + 1}`)]);
  }

  const from = toMat(cv, pairs.map(([p]) => [p.x, p.y])), to = toMat(cv, pairs.map(([, h]) => [h.x, h.y]));
  const mask = new cv.Mat();
  const M = cv.findHomography(from, to, cv.RANSAC, 3, mask);
  const H = M.empty() ? null : Array.from(M.data64F);
  const holes = H ? cv.countNonZero(mask) : 0;
  from.delete(); to.delete(); mask.delete(); M.delete();

  if (holes < MIN_HOLES) return fail(`Only ${holes} holes lined up with the board layout.`);
  return { H, holes, candidates: pts };
}
