/**
 * 巡视路线规划（纯 2D 计算，单位 mm；不依赖 DOM / three，可直接单测）。
 *
 * 思路：
 *   ① 以墙线内缩 200mm 的范围建 200mm 可行走网格，机柜/空调/柱/灭火器等按外轮廓
 *      + 人身余量（clear=380mm）膨胀占位，墙体按线段距离占位；
 *   ② 取设备「柜面外 560mm」的可走点作为通道引路点，按 merge 半径合并；
 *   ③ 从入口（机房门内侧，无门则西南角）出发，按网格最短路距离贪心串联引路点；
 *   ④ 每段 BFS 最短路 → 视线拉直 → 弧长化，末尾回到入口闭合成可无限循环的环线。
 *
 * 预设路线共用同一张网格与入口，只更换落脚点集合：
 *   all / row-<a..h> / inspection / cabinet-<名称|id>。
 */

/** 规划默认参数（planTour / planRoute / buildWalkGrid 的 opts 可逐项覆盖） */
export const TOUR_PLAN = Object.freeze({
  cell: 200,         // 网格边长 mm
  clear: 380,        // 障碍外扩（人身余量）mm
  front: 560,        // 柜面到引路点的距离 mm
  merge: 1400,       // 引路点合并半径 mm
  entryGap: 1600,    // 入口点距门内侧 mm
  maxCells: 400000,  // 网格格数上限（超出则放大格子）
  maxWaypoints: 140, // 引路点上限（超出则加大合并半径）
  rowBand: 1000,     // 同一排设备的法向投影容差 mm
  maxRows: 16,       // 路线清单最多展示的排数
});

/** 地面障碍（通道/桥架/风口/门窗不挡人） */
const OBSTACLE = new Set(['cabinet', 'pdu', 'ups', 'battery', 'ac', 'column', 'extinguisher']);
/** 可以引出通道引路点的对象（柜面外即人走的位置） */
const WAYPOINT = new Set(['cabinet', 'pdu', 'ups', 'battery', 'ac', 'extinguisher']);

const TYPE_SIZE = {
  cabinet: [600, 1200], pdu: [600, 1200], ups: [800, 800], battery: [800, 800],
  ac: [1000, 800], extingisher: [400, 400], extinguisher: [400, 400], column: [600, 600],
};

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 对象平面尺寸（mm），缺省按类型兜底 */
function size2(o) {
  const p = o.props || {};
  const dflt = TYPE_SIZE[o.type] || [600, 600];
  return [p.w > 0 ? p.w : dflt[0], p.d > 0 ? p.d : dflt[1]];
}

/** 旋转后的世界轴对齐半尺寸 */
function footprint(o) {
  const [w, d] = size2(o);
  const a = ((o.rotation || 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return { hx: (w * c + d * s) / 2, hy: (w * s + d * c) / 2 };
}

/** 点到线段距离（墙体占位） */
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

/** 2D 平面方向 (dx,dy) → 绕 Y 的 yaw（x→x，y→-z） */
export const yaw2d = (dx, dy) => Math.atan2(-dx, dy);

/* ======================= 可行走网格 ======================= */

class WalkGrid {
  constructor(minx, miny, maxx, maxy, cell) {
    this.cell = cell;
    this.minx = minx;
    this.miny = miny;
    this.nx = Math.max(2, Math.ceil((maxx - minx) / cell));
    this.ny = Math.max(2, Math.ceil((maxy - miny) / cell));
    this.occ = new Uint8Array(this.nx * this.ny);
  }

  ci(x) { return Math.floor((x - this.minx) / this.cell); }
  cj(y) { return Math.floor((y - this.miny) / this.cell); }
  x(i) { return this.minx + (i + .5) * this.cell; }
  y(j) { return this.miny + (j + .5) * this.cell; }
  id(i, j) { return j * this.nx + i; }
  bi(id) { return id % this.nx; }
  bj(id) { return (id - (id % this.nx)) / this.nx; }
  inside(i, j) { return i >= 0 && j >= 0 && i < this.nx && j < this.ny; }
  freeId(id) { return this.occ[id] === 0; }
  point(id) { return { x: this.x(this.bi(id)), y: this.y(this.bj(id)) }; }

  freeAt(x, y) {
    const i = this.ci(x), j = this.cj(y);
    return this.inside(i, j) && this.occ[this.id(i, j)] === 0;
  }

  /** 矩形占位：格心落在「外扩 pad 后的矩形」内即封 */
  blockRect(minx, miny, maxx, maxy, pad = 0) {
    const x0 = minx - pad, x1 = maxx + pad, y0 = miny - pad, y1 = maxy + pad;
    const i0 = Math.max(0, this.ci(x0)), i1 = Math.min(this.nx - 1, this.ci(x1));
    const j0 = Math.max(0, this.cj(y0)), j1 = Math.min(this.ny - 1, this.cj(y1));
    for (let j = j0; j <= j1; j++) {
      const cy = this.y(j);
      if (cy < y0 || cy > y1) continue;
      for (let i = i0; i <= i1; i++) {
        const cx = this.x(i);
        if (cx >= x0 && cx <= x1) this.occ[this.id(i, j)] = 1;
      }
    }
  }

  /** 线段占位：距线段 ≤ rad 的格心封死 */
  blockSeg(x1, y1, x2, y2, rad) {
    const i0 = Math.max(0, this.ci(Math.min(x1, x2) - rad));
    const i1 = Math.min(this.nx - 1, this.ci(Math.max(x1, x2) + rad));
    const j0 = Math.max(0, this.cj(Math.min(y1, y2) - rad));
    const j1 = Math.min(this.ny - 1, this.cj(Math.max(y1, y2) + rad));
    for (let j = j0; j <= j1; j++) {
      const cy = this.y(j);
      for (let i = i0; i <= i1; i++) {
        if (distToSeg(this.x(i), cy, x1, y1, x2, y2) <= rad) this.occ[this.id(i, j)] = 1;
      }
    }
  }

  /** 由 (i,j) 向外按切比雪夫环找最近可走格，返回格号（-1 = 无） */
  nearestFree(i, j, maxR = 8) {
    const ok = (a, b) => this.inside(a, b) && this.occ[this.id(a, b)] === 0;
    if (ok(i, j)) return this.id(i, j);
    for (let r = 1; r <= maxR; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          if (ok(i + di, j + dj)) return this.id(i + di, j + dj);
        }
      }
    }
    return -1;
  }

  /** 世界坐标 → 最近可走格号 */
  cellAt(x, y, maxR = 8) { return this.nearestFree(this.ci(x), this.cj(y), maxR); }
}

/* ======================= BFS 最短路 ======================= */

function bfs(grid, start) {
  const { nx, ny, occ } = grid;
  const n = nx * ny;
  const dist = new Int32Array(n).fill(-1);
  const par = new Int32Array(n).fill(-1);
  if (start < 0 || occ[start]) return { dist, par };
  const q = new Int32Array(n);
  let head = 0, tail = 0;
  dist[start] = 0;
  q[tail++] = start;
  while (head < tail) {
    const k = q[head++];
    const i = k % nx, j = (k - i) / nx;
    const d = dist[k] + 1;
    let nk;
    if (i > 0) { nk = k - 1; if (occ[nk] === 0 && dist[nk] < 0) { dist[nk] = d; par[nk] = k; q[tail++] = nk; } }
    if (i < nx - 1) { nk = k + 1; if (occ[nk] === 0 && dist[nk] < 0) { dist[nk] = d; par[nk] = k; q[tail++] = nk; } }
    if (j > 0) { nk = k - nx; if (occ[nk] === 0 && dist[nk] < 0) { dist[nk] = d; par[nk] = k; q[tail++] = nk; } }
    if (j < ny - 1) { nk = k + nx; if (occ[nk] === 0 && dist[nk] < 0) { dist[nk] = d; par[nk] = k; q[tail++] = nk; } }
  }
  return { dist, par };
}

/** 由前驱回溯成折线（格心点） */
function tracePath(grid, par, end) {
  if (end < 0 || par[end] < 0) return end >= 0 && par[end] === -1 ? [grid.point(end)] : [];
  const out = [];
  for (let k = end; k !== -1; k = par[k]) out.push(grid.point(k));
  return out.reverse();
}

/** 沿线采样判断两点是否互见（端点本身不检查） */
function sees(grid, a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(2, Math.ceil(d / (grid.cell * 0.5)));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (!grid.freeAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
  }
  return true;
}

/** 视线拉直：把 BFS 直角折线换成自然斜线 */
function pull(grid, pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = i + 1;
    while (j + 1 < pts.length && sees(grid, pts[i], pts[j + 1])) j++;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/* ======================= 弧长路径 ======================= */

function makePath(pts) {
  const list = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = list[list.length - 1], b = pts[i];
    if (Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.y - b.y) > 1e-6) list.push(b);
  }
  const cum = new Float64Array(list.length);
  for (let i = 1; i < list.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(list[i].x - list[i - 1].x, list[i].y - list[i - 1].y);
  }
  return { pts: list, cum, len: cum[list.length - 1] };
}

/** 环线上按里程取点（自动取模，首尾相连） */
export function posAt(path, s) {
  const { pts, cum, len } = path;
  if (!pts || pts.length < 2 || !(len > 0)) {
    return pts && pts[0] ? { x: pts[0].x, y: pts[0].y } : { x: 0, y: 0 };
  }
  let d = s % len;
  if (d < 0) d += len;
  let lo = 0, hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const seg = cum[lo + 1] - cum[lo];
  const t = seg > 1e-9 ? clamp01((d - cum[lo]) / seg) : 0;
  return {
    x: pts[lo].x + (pts[lo + 1].x - pts[lo].x) * t,
    y: pts[lo].y + (pts[lo + 1].y - pts[lo].y) * t,
  };
}

/* ======================= 通道引路点 ======================= */

/** 设备正面方向（2D 局部 -y 旋转 rotation）：rot=0 → 南(0,-1)，rot=90 → 东(1,0) */
function frontDir(o) {
  const a = ((o.rotation || 0) * Math.PI) / 180;
  return { x: Math.sin(a), y: -Math.cos(a) };
}

/** 单台设备的柜前引路点（正面外 front 处 → 最近可走格） */
function frontWaypoint(o, grid, cfg) {
  if (!(o.x !== undefined && o.y !== undefined)) return null;
  const [, d] = size2(o);
  const dir = frontDir(o);
  const dist = d / 2 + cfg.front;
  const cell = grid.cellAt(o.x + dir.x * dist, o.y + dir.y * dist, 8);
  if (cell < 0) return null;
  const p = grid.point(cell);
  return {
    ...p,
    cell,
    id: o.id,
    type: o.type,
    name: (o.props && o.props.name) || o.id || '',
  };
}

/** 引路点按半径去重（3×3 桶哈希加速） */
function mergePoints(list, radius) {
  const kept = [];
  const buckets = new Map();
  for (const p of list) {
    const bx = Math.floor(p.x / radius), by = Math.floor(p.y / radius);
    let dup = false;
    for (let dy = -1; dy <= 1 && !dup; dy++) {
      for (let dx = -1; dx <= 1 && !dup; dx++) {
        const arr = buckets.get(`${bx + dx}:${by + dy}`);
        if (!arr) continue;
        for (const q of arr) {
          if (Math.hypot(q.x - p.x, q.y - p.y) <= radius) { dup = true; break; }
        }
      }
    }
    if (dup) continue;
    kept.push(p);
    const k = `${bx}:${by}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  return kept;
}

/** 收集通道引路点（超出上限时逐步加大合并半径） */
function collectWaypoints(objs, grid, cfg) {
  const raw = [];
  for (const o of objs) {
    if (!WAYPOINT.has(o.type)) continue;
    const w = frontWaypoint(o, grid, cfg);
    if (w) raw.push(w);
  }
  let radius = cfg.merge;
  let kept = mergePoints(raw, radius);
  while (kept.length > cfg.maxWaypoints && radius < 8000) {
    radius *= 1.5;
    kept = mergePoints(raw, radius);
  }
  return kept;
}

/* ======================= 入口 ======================= */

function findEntry(objs, walls, grid, frame, cfg) {
  const cx = (frame.minx + frame.maxx) / 2;
  const cy = (frame.miny + frame.maxy) / 2;
  for (const d of objs) {
    if (d.type !== 'door') continue;
    const w = walls.find(x => x.id === d.wallId);
    if (!w) continue;
    const L = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    if (L < 1) continue;
    const t = clamp01(+d.t || 0);
    const px = w.x1 + (w.x2 - w.x1) * t;
    const py = w.y1 + (w.y2 - w.y1) * t;
    let dx = cx - px, dy = cy - py;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    const cell = grid.cellAt(px + dx * cfg.entryGap, py + dy * cfg.entryGap, 24);
    if (cell >= 0) return { cell, fromDoor: true };
  }
  // 无门：西南角内侧起步
  const cell = grid.cellAt(frame.minx + 900, frame.miny + 900, 40);
  return { cell: cell >= 0 ? cell : grid.nearestFree(1, 1, 40), fromDoor: false };
}

/* ======================= 主流程 ======================= */

/** 房间可行走范围：有墙按墙线内缩 200，无墙按设备轮廓外扩 1200 */
function frameOf(walls, objs) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const ext = (x, y) => {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  };
  if (walls.length) {
    for (const w of walls) { ext(w.x1, w.y1); ext(w.x2, w.y2); }
  } else {
    for (const o of objs) {
      if (!(o.x !== undefined && o.y !== undefined)) continue;
      const f = footprint(o);
      ext(o.x - f.hx, o.y - f.hy);
      ext(o.x + f.hx, o.y + f.hy);
    }
  }
  if (!Number.isFinite(minx)) return { minx: -4000, miny: -3000, maxx: 4000, maxy: 3000 };
  const pad = walls.length ? -200 : 1200;
  const box = { minx: minx - pad, miny: miny - pad, maxx: maxx + pad, maxy: maxy + pad };
  // 范围过小时按中心撑到最小可走尺寸，避免网格退化
  const grow = (lo, hi, min) => (hi - lo >= min ? [lo, hi]
    : [(lo + hi) / 2 - min / 2, (lo + hi) / 2 + min / 2]);
  [box.minx, box.maxx] = grow(box.minx, box.maxx, 4000);
  [box.miny, box.maxy] = grow(box.miny, box.maxy, 3000);
  return box;
}

/** 规划上下文：范围 + 网格 + 障碍占位 + 入口（所有路线共用） */
function preparePlan(project, opts) {
  const cfg = { ...TOUR_PLAN, ...(opts || {}) };
  const objs = project && Array.isArray(project.objects) ? project.objects : [];
  const walls = objs.filter(o => o.type === 'wall'
    && Number.isFinite(o.x1) && Number.isFinite(o.x2));
  const frame = frameOf(walls, objs);

  let cell = cfg.cell;
  while (((frame.maxx - frame.minx) / cell) * ((frame.maxy - frame.miny) / cell) > cfg.maxCells) {
    cell *= 1.4;
  }

  const grid = new WalkGrid(frame.minx, frame.miny, frame.maxx, frame.maxy, cell);
  for (const w of walls) {
    const th = (w.props && w.props.thickness) || 240;
    grid.blockSeg(w.x1, w.y1, w.x2, w.y2, th / 2 + cfg.clear);
  }
  for (const o of objs) {
    if (!OBSTACLE.has(o.type) || !(o.x !== undefined && o.y !== undefined)) continue;
    const f = footprint(o);
    grid.blockRect(o.x - f.hx, o.y - f.hy, o.x + f.hx, o.y + f.hy, cfg.clear);
  }

  const entry = findEntry(objs, walls, grid, frame, cfg);
  return { cfg, objs, walls, frame, grid, entry };
}

/** 追加折线（去掉与上一点重合的起点） */
function appendPoly(pts, poly) {
  if (!poly || !poly.length) return pts.length;
  let k = 0;
  const prev = pts[pts.length - 1];
  if (poly.length > 1 && Math.hypot(poly[0].x - prev.x, poly[0].y - prev.y) < 1) k = 1;
  for (; k < poly.length; k++) pts.push(poly[k]);
  return pts.length;
}

/**
 * 规划全场巡视环线。
 * @returns {null|{path:object, entry:{x:number,y:number}, stats:object}}
 */
export function planTour(project, opts) {
  const prep = preparePlan(project, opts);
  if (!(prep.entry.cell >= 0)) return null;
  return planAllRoute(prep);
}

/** 全场环线：入口 → 贪心串联所有连通引路点 → 回入口 */
function planAllRoute(prep) {
  const { cfg, objs, grid, entry, frame } = prep;

  const base = bfs(grid, entry.cell);
  const waypoints = collectWaypoints(objs, grid, cfg).filter(t => base.dist[t.cell] >= 0);
  if (!waypoints.length) return fallbackLoop(grid, entry.cell, frame, cfg);

  const pts = [grid.point(entry.cell)];
  let cur = entry.cell;
  const rest = waypoints.slice();
  let guard = 0;

  while (rest.length && guard++ < 600) {
    const field = bfs(grid, cur);
    let pick = -1, best = Infinity;
    for (let k = 0; k < rest.length; k++) {
      const d = field.dist[rest[k].cell];
      if (d >= 0 && d < best) { best = d; pick = k; }
    }
    if (pick < 0) break; // 剩下都被隔断
    const tgt = rest.splice(pick, 1)[0];
    appendPoly(pts, pull(grid, tracePath(grid, field.par, tgt.cell)));
    cur = tgt.cell;
  }

  const back = bfs(grid, cur);
  const backPath = pull(grid, tracePath(grid, back.par, entry.cell));
  if (backPath.length) appendPoly(pts, backPath);
  appendPoly(pts, [pts[0]]);

  const path = makePath(pts);
  return {
    path,
    entry: grid.point(entry.cell),
    stops: [],
    stats: {
      cell: grid.cell, nx: grid.nx, ny: grid.ny,
      waypoints: waypoints.length,
      length: Math.round(path.len), fromDoor: entry.fromDoor,
      route: 'all', kind: 'all', fallback: null, targets: [],
    },
  };
}

/** 无引路点时的兜底：沿房间内圈走一圈 */
function fallbackLoop(grid, entryCell, frame, cfg) {
  const m = 700 + cfg.clear;
  const corners = [
    [frame.minx + m, frame.miny + m], [frame.maxx - m, frame.miny + m],
    [frame.maxx - m, frame.maxy - m], [frame.minx + m, frame.maxy - m],
  ].map(([x, y]) => grid.cellAt(x, y, 60)).filter(c => c >= 0);
  if (!corners.length) return null;

  const pts = [grid.point(entryCell)];
  let cur = entryCell;
  for (const c of [...corners, entryCell]) {
    const f = bfs(grid, cur);
    if (f.dist[c] < 0) continue;
    for (const p of pull(grid, tracePath(grid, f.par, c))) pts.push(p);
    cur = c;
  }
  pts.push(pts[0]);
  return {
    path: makePath(pts),
    entry: grid.point(entryCell),
    stats: { cell: grid.cell, nx: grid.nx, ny: grid.ny, waypoints: 0, length: 0, fallback: true },
  };
}

/* ======================= 预设路线 ======================= */

/** 巡检线区域顺序（入口 → UPS → 蓄电池 → 空调 → 入口；缺项跳过） */
export const INSPECTION_TYPES = Object.freeze([
  { type: 'ups', label: 'UPS' },
  { type: 'battery', label: '蓄电池' },
  { type: 'ac', label: '空调' },
]);

/** 路线 id 归一化：trim + 小写，允许 Unicode 字母/数字；非法或空返回 null */
export function normalizeRouteId(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return s && /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(s) ? s : null;
}

/** 机柜名称前缀：`A01` → A、`AB-12` → AB；无「字母前缀 + 数字」结构返回空串 */
export function cabinetRowKey(o) {
  const name = String((o && o.props && o.props.name) || '');
  const m = /^([A-Za-z]{1,2})\s*[-_]?\s*(?=\d)/.exec(name);
  return m ? m[1].toUpperCase() : '';
}

const letterAt = i => (i < 26 ? String.fromCharCode(65 + i) : 'X' + (i + 1));

/**
 * 派生「空间排」：按朝向分组 → 法向投影聚类 → 沿排轴排序 → 名称前缀命名。
 * 名称前缀只用于命名；成排判断以几何为准，同名不同排不会合并。
 */
export function detectRows(project) {
  const objs = project && Array.isArray(project.objects) ? project.objects : [];
  const cabs = objs.filter(o => (o.type === 'cabinet' || o.type === 'pdu')
    && Number.isFinite(o.x) && Number.isFinite(o.y));
  if (!cabs.length) return [];

  // ① 朝向分组（5° 步长）
  const groups = new Map();
  for (const o of cabs) {
    const deg = (Math.round(((((o.rotation || 0) % 360) + 360) % 360) / 5) * 5) % 360;
    const key = String(deg);
    if (!groups.has(key)) groups.set(key, { deg, list: [] });
    groups.get(key).list.push(o);
  }

  // ② 沿前向投影聚类（差 ≤ rowBand 视为同一排）
  const bands = [];
  for (const g of groups.values()) {
    const normal = frontDir({ rotation: g.deg });
    const proj = o => o.x * normal.x + o.y * normal.y;
    const sorted = g.list.slice().sort((a, b) => proj(a) - proj(b));
    let band = null;
    for (const o of sorted) {
      const t = proj(o);
      if (band && t - band.tMax <= TOUR_PLAN.rowBand) {
        band.list.push(o);
        band.tMax = t;
      } else {
        band = { normal, tMin: t, tMax: t, list: [o] };
        bands.push(band);
      }
    }
  }

  // ③ 每排：排轴 = 前向旋转 90°；只有含机柜的排才成立
  const rows = [];
  for (const band of bands) {
    const cabinets = band.list.filter(o => o.type === 'cabinet');
    if (!cabinets.length) continue;

    const axis = { x: -band.normal.y, y: band.normal.x };
    const along = o => o.x * axis.x + o.y * axis.y;
    const objects = band.list.slice().sort((a, b) => along(a) - along(b));
    cabinets.sort((a, b) => along(a) - along(b));

    // 前缀需占多数才用于命名，否则退回「第 N 排」
    const counts = new Map();
    for (const o of cabinets) {
      const k = cabinetRowKey(o);
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    let key = '', best = 0;
    for (const [k, n] of counts) if (n > best) { best = n; key = k; }
    if (best < Math.ceil(cabinets.length * 0.6)) key = '';

    const a0 = along(cabinets[0]);
    const a1 = along(cabinets[cabinets.length - 1]);
    const tMid = (band.tMin + band.tMax) / 2;
    const aMid = (a0 + a1) / 2;
    rows.push({
      key,
      label: key ? key + ' 排' : '',
      axis,
      normal: band.normal,
      center: {
        x: band.normal.x * tMid + axis.x * aMid,
        y: band.normal.y * tMid + axis.y * aMid,
      },
      range: { min: a0, max: a1 },
      objects,
      count: cabinets.length,
      source: key ? 'name' : 'space',
    });
  }

  // ④ 稳定排序 + 唯一 id
  rows.sort((a, b) => (a.key || 'ZZZ').localeCompare(b.key || 'ZZZ')
    || a.center.y - b.center.y || a.center.x - b.center.x);
  const used = new Set();
  rows.forEach((row, i) => {
    const base = row.key ? 'row-' + row.key.toLowerCase() : 'row-' + letterAt(i).toLowerCase();
    let id = base, n = 2;
    while (used.has(id)) id = base + '-' + (n++);
    used.add(id);
    row.id = id;
    if (!row.label) row.label = '第 ' + (i + 1) + ' 排';
  });
  return rows;
}

/** 路线清单（抽屉路线组与 __dcxd.routes() 共用；不规划，只读数据） */
export function listRoutes(project) {
  const objs = project && Array.isArray(project.objects) ? project.objects : [];
  const rows = detectRows(project).slice(0, TOUR_PLAN.maxRows);
  const present = INSPECTION_TYPES.filter(t =>
    objs.some(o => o.type === t.type && Number.isFinite(o.x) && Number.isFinite(o.y)));

  const list = [{
    id: 'all', kind: 'all', label: '全场环线',
    hint: '沿机柜通道自动走一圈', available: true,
  }];
  for (const r of rows) {
    list.push({
      id: r.id, kind: 'row', label: r.label,
      hint: r.count + ' 台机柜 · 单排通道', available: true,
      count: r.count, key: r.key,
    });
  }
  list.push({
    id: 'inspection', kind: 'inspection', label: '巡检线',
    hint: present.length
      ? '入口 → ' + present.map(t => t.label).join(' → ')
      : '无 UPS / 电池 / 空调：回退全场',
    available: present.length > 0,
    types: present.map(t => t.type),
  });
  return list;
}

/** 用 BFS 折线串起落脚点并闭环，同时把落脚点标记到里程 s */
function buildRoutePath(grid, entryCell, stops) {
  const pts = [grid.point(entryCell)];
  let cur = entryCell;

  for (const st of stops) {
    if (st.cell === cur) continue;
    const field = bfs(grid, cur);
    if (field.dist[st.cell] < 0) continue;
    appendPoly(pts, pull(grid, tracePath(grid, field.par, st.cell)));
    cur = st.cell;
  }

  if (cur !== entryCell) {
    const back = bfs(grid, cur);
    if (back.dist[entryCell] >= 0) {
      appendPoly(pts, pull(grid, tracePath(grid, back.par, entryCell)));
    }
  }

  const first = pts[0], last = pts[pts.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) > 1) pts.push(first);

  const path = makePath(pts);
  const at = new Map();
  path.pts.forEach((p, i) => at.set(p.x.toFixed(3) + ',' + p.y.toFixed(3), path.cum[i]));
  const marked = [];
  for (const st of stops) {
    const s = at.get(st.x.toFixed(3) + ',' + st.y.toFixed(3));
    if (s != null) marked.push({ ...st, s: Math.round(s) });
  }
  return { path, stops: marked };
}

/** 单排路线：入口 → 近端排头 → 沿排走到排尾 → 回入口 */
function planRowRoute(prep, routeId) {
  const { cfg, objs, grid, entry } = prep;
  const rows = detectRows({ objects: objs });
  const row = rows.find(r => r.id === routeId)
    || rows.find(r => r.key && 'row-' + r.key.toLowerCase() === routeId);
  if (!row) return null;

  const base = bfs(grid, entry.cell);
  const stops = [];
  const seen = new Set();
  for (const o of row.objects) {
    const w = frontWaypoint(o, grid, cfg);
    if (!w || w.cell < 0 || seen.has(w.cell)) continue;
    if (base.dist[w.cell] < 0) continue;
    seen.add(w.cell);
    stops.push(w);
  }
  if (!stops.length) return null;

  const along = p => p.x * row.axis.x + p.y * row.axis.y;
  stops.sort((a, b) => along(a) - along(b));
  if (base.dist[stops[stops.length - 1].cell] < base.dist[stops[0].cell]) stops.reverse();

  const built = buildRoutePath(grid, entry.cell, stops);
  if (!built.path.pts.length) return null;
  return {
    path: built.path,
    entry: grid.point(entry.cell),
    stops: built.stops,
    stats: {
      cell: grid.cell, nx: grid.nx, ny: grid.ny,
      waypoints: stops.length, length: Math.round(built.path.len), fromDoor: entry.fromDoor,
      route: routeId, kind: 'row', fallback: null, targets: [],
      row: { id: row.id, key: row.key, label: row.label },
    },
  };
}

/** 巡检线：入口 → UPS → 蓄电池 → 空调 → 入口；不可达类型跳过，全缺返回 null */
function planInspectionRoute(prep) {
  const { cfg, objs, grid, entry } = prep;
  const targets = [];
  const skipped = [];
  let cur = entry.cell;

  for (const typeDef of INSPECTION_TYPES) {
    const candidates = objs.filter(o => o.type === typeDef.type
      && Number.isFinite(o.x) && Number.isFinite(o.y));
    if (!candidates.length) { skipped.push({ type: typeDef.type, reason: 'missing' }); continue; }

    const field = bfs(grid, cur);
    let best = null, bd = Infinity;
    for (const o of candidates) {
      const w = frontWaypoint(o, grid, cfg);
      if (!w || w.cell < 0) continue;
      const d = field.dist[w.cell];
      if (d >= 0 && d < bd) { bd = d; best = w; }
    }
    if (!best) { skipped.push({ type: typeDef.type, reason: 'unreachable' }); continue; }
    targets.push({ ...best, label: typeDef.label });
    cur = best.cell;
  }

  if (!targets.length) return null;

  const built = buildRoutePath(grid, entry.cell, targets);
  if (!built.path.pts.length) return null;
  return {
    path: built.path,
    entry: grid.point(entry.cell),
    stops: built.stops,
    stats: {
      cell: grid.cell, nx: grid.nx, ny: grid.ny,
      waypoints: targets.length, length: Math.round(built.path.len), fromDoor: entry.fromDoor,
      route: 'inspection', kind: 'inspection', fallback: null,
      targets: targets.map(t => ({
        type: t.type, label: t.label, id: t.id, name: t.name,
        x: Math.round(t.x), y: Math.round(t.y),
        s: (built.stops.find(s => s.cell === t.cell) || {}).s,
      })),
      skipped,
    },
  };
}

/** 指定机柜路线：入口 → 柜前 → 入口（名称不区分大小写，也支持对象 id） */
function planCabinetRoute(prep, key) {
  const { cfg, objs, grid, entry } = prep;
  const want = String(key || '').trim().toUpperCase();
  if (!want) return null;

  const byName = o => String((o.props && o.props.name) || '').toUpperCase() === want;
  const byId = o => String(o.id || '').toUpperCase() === want;
  const target = objs.find(byName) || objs.find(byId);
  if (!target) return null;

  const stop = frontWaypoint(target, grid, cfg);
  if (!stop || stop.cell < 0) return null;

  const base = bfs(grid, entry.cell);
  if (base.dist[stop.cell] < 0) return null;

  const built = buildRoutePath(grid, entry.cell, [stop]);
  if (!built.path.pts.length) return null;
  const name = (target.props && target.props.name) || target.id;
  return {
    path: built.path,
    entry: grid.point(entry.cell),
    stops: built.stops,
    stats: {
      cell: grid.cell, nx: grid.nx, ny: grid.ny,
      waypoints: 1, length: Math.round(built.path.len), fromDoor: entry.fromDoor,
      route: 'cabinet-' + String(name).toLowerCase(), kind: 'cabinet', fallback: null,
      targets: [], skipped: [],
      target: { id: target.id, name: String(name), type: target.type },
    },
  };
}

/**
 * 规划一条预设路线。
 *
 * @param {{objects:Array}} project
 * @param {string} routeId `all` / `row-a` / `inspection` / `cabinet-A01`
 * @param {object} [opts] 覆盖 TOUR_PLAN
 * @returns {null|{path:object, entry:object, stops:Array, stats:object}}
 *   目标不存在时回退全场，`stats.fallback` 记录原因，不抛错。
 */
export function planRoute(project, routeId, opts) {
  const id = normalizeRouteId(routeId) || 'all';
  const prep = preparePlan(project, opts);
  if (!(prep.entry.cell >= 0)) return null;

  let plan = null;
  let fallback = null;
  if (id === 'all') return planAllRoute(prep);

  if (id.startsWith('row-')) {
    plan = planRowRoute(prep, id);
    if (!plan) fallback = 'row-missing';
  } else if (id === 'inspection') {
    plan = planInspectionRoute(prep);
    if (!plan) fallback = 'inspection-no-target';
  } else if (id.startsWith('cabinet-')) {
    plan = planCabinetRoute(prep, id.slice(8));
    if (!plan) fallback = 'target-missing';
  } else {
    fallback = 'unknown-route';
  }

  if (!plan) {
    plan = planAllRoute(prep);
    if (plan) {
      plan.stats.requested = id;
      plan.stats.fallback = fallback;
    }
  }
  return plan;
}

/**
 * 构建可行走模型（手动步行）：与巡视共用同一张网格与人身间隙。
 * 返回的 grid 附带 entry / entryCell / fromDoor / frame / cfg / free 字段。
 */
export function buildWalkGrid(project, opts) {
  const prep = preparePlan(project, opts);
  const grid = prep.grid;
  grid.frame = prep.frame;
  grid.cfg = prep.cfg;
  grid.entryCell = prep.entry.cell;
  grid.entry = prep.entry.cell >= 0 ? grid.point(prep.entry.cell) : null;
  grid.fromDoor = !!prep.entry.fromDoor;
  let free = 0;
  for (let i = 0; i < grid.occ.length; i++) if (grid.occ[i] === 0) free++;
  grid.free = free;
  return grid;
}

/** 世界坐标（mm）是否落在可走格内（纯网格查询，不含身体半径） */
export function isWalkable(grid, x, y) {
  return !!(grid && Number.isFinite(x) && Number.isFinite(y) && grid.freeAt(x, y));
}

/**
 * 世界坐标（mm）→ 最近可走格心。
 * @returns {{x:number,y:number,cell:number}|null}
 */
export function nearestFree(grid, x, y, maxR = 8) {
  if (!grid || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cell = grid.cellAt(x, y, maxR);
  if (cell < 0) return null;
  return { ...grid.point(cell), cell };
}

/* ======================= 展示文案 ======================= */

/** 回退原因 → 中文短句 */
export const ROUTE_FALLBACK_TEXT = Object.freeze({
  'row-missing': '该排不存在或不可达',
  'inspection-no-target': '无可达的 UPS / 电池 / 空调',
  'target-missing': '目标机柜不存在或不可达',
  'unknown-route': '未知路线',
});

/** 路线显示名（只读 plan.stats） */
export function routeLabelOf(plan) {
  const st = plan && plan.stats ? plan.stats : null;
  if (!st) return '全场环线';
  if (st.kind === 'row') return (st.row && st.row.label) || '单排路线';
  if (st.kind === 'inspection') return '巡检线';
  if (st.kind === 'cabinet') return st.target && st.target.name ? '到 ' + st.target.name : '指定机柜';
  return '全场环线';
}

/** 路线摘要：落脚点 / 长度 / 跳过 / 回退原因 */
export function routeHintOf(plan) {
  const st = plan && plan.stats ? plan.stats : null;
  if (!st) return '';
  const parts = [];
  if (st.waypoints) parts.push(st.waypoints + ' 个落脚点');
  if (plan.path) parts.push(Math.round(plan.path.len / 1000) + ' m');
  if (st.kind === 'inspection' && st.skipped && st.skipped.length) {
    parts.push('跳过 ' + st.skipped.length + ' 类设备');
  }
  if (st.fallback) parts.push('已回退全场（' + (ROUTE_FALLBACK_TEXT[st.fallback] || st.fallback) + '）');
  return parts.join(' · ');
}
