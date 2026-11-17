/** 几何计算与通用工具（世界坐标单位：毫米 mm） */

import { pipeOutline } from './pipe-geometry.js';

let seq = 0;
export function uid() {
  return 'o' + Date.now().toString(36) + (seq++).toString(36) +
    Math.floor(Math.random() * 1296).toString(36);
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 点到线段的最短距离及投影参数 t（0~1） */
export function dist2seg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return { d: Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)), t };
}

export const wallLen = w => Math.hypot(w.x2 - w.x1, w.y2 - w.y1);

/** 框架梁端点（世界坐标）：端点附着柱子（col1/col2 为柱 id）时以柱心为准并随柱移动；
 * 柱被删除/引用失效或未附着时回退到存储坐标 x1,y1,x2,y2（自由端）。
 * resolve 为按 id 取对象的函数（编辑器内即 getObj）。返回 { x1, y1, x2, y2, c1, c2 }。 */
export function beamEnds(o, resolve) {
  let x1 = o.x1, y1 = o.y1, x2 = o.x2, y2 = o.y2, c1 = null, c2 = null;
  if (o.col1 && resolve) { c1 = resolve(o.col1); if (c1) { x1 = c1.x; y1 = c1.y; } }
  if (o.col2 && resolve) { c2 = resolve(o.col2); if (c2) { x2 = c2.x; y2 = c2.y; } }
  return { x1, y1, x2, y2, c1, c2 };
}

/** 框架梁长度（随附着柱动态求解；同 wallLen 之于墙） */
export function beamLen(o, resolve) {
  const e = beamEnds(o, resolve);
  return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
}

/** 桥架菱形交叉网格斜线段（局部坐标：t 沿桥架方向 0..L，v 横向 ±w/2）。
 * 两族 45° 斜线（\ 与 /），格宽 = 桥架宽 w（菱形为正方形），分别从左端上/下角起锚，
 * 与矩形 [0,L]×[-w/2,w/2] 解析求交裁剪，端部不足一格自动截断；恰过角点的退化线剔除。
 * 返回 [ [[t1,v1],[t2,v2]], ... ]，2D 画布渲染与 DXF 导出共用，保证两处图面一致。 */
export function trayDiamonds(L, w) {
  const h = w / 2, segs = [];
  const clip = (m, c) => { // 直线 v = m·t + c 与矩形求交，保留线段两端点
    const pts = [];
    for (const t of [0, L]) { const v = m * t + c; if (Math.abs(v) <= h + 1e-6) pts.push([t, v]); }
    for (const v of [-h, h]) { const t = (v - c) / m; if (t >= -1e-6 && t <= L + 1e-6) pts.push([t, v]); }
    if (pts.length < 2) return;
    pts.sort((a, b) => a[0] - b[0]);
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.01) segs.push([a, b]);
  };
  for (let c = h; c <= L + h + 1e-6; c += w) clip(-1, c);     // \\ 族：过左上角 (0,+h) 起锚
  for (let c = -h; c >= -(L + h) - 1e-6; c -= w) clip(1, c); // / 族：过左下角 (0,-h) 起锚
  return segs;
}

/** 按实测内空尺寸生成矩形房间四面墙（西南角内表面为原点 (0,0)，X 向东、Y 向北）。
 * 墙中心线向外偏移半墙厚，使四面墙内表面恰好落在 0 / L 与 0 / Wd 上——
 * 内空尺寸 = 输入尺寸，双选对向墙的净距标尺（内表面间距）也等于输入尺寸。
 * 返回 4 个墙对象（顺序：南→东→北→西）；name 由调用方分配。 */
export function roomWalls(L, Wd, th) {
  const h = th / 2;
  const mk = (x1, y1, x2, y2) => ({
    id: uid(), type: 'wall', x1, y1, x2, y2,
    props: { thickness: th, height: 3000, material: '砖墙' },
  });
  return [
    mk(-h, -h, L + h, -h),        // 南墙
    mk(L + h, -h, L + h, Wd + h), // 东墙
    mk(L + h, Wd + h, -h, Wd + h),// 北墙
    mk(-h, Wd + h, -h, -h),       // 西墙
  ];
}

/**
 * 判定墙的内侧（房间内部）位于该墙绘制方向（起点→终点）的哪一侧。
 * @param {object} wall 目标墙
 * @param {object[]} walls 全部墙对象
 * @returns {number|null} +1=内部在墙方向左侧、-1=右侧、null=无法判定（墙少于 3 段）
 * 策略：① 墙端点相接连成闭合环 → 用有向面积判断环绕向（世界坐标 Y 向上，面积为正=逆时针=内部在左）；
 *       ② 不成环或环过小（<包围盒矩形面积 1/4）→ 以"朝向墙包围盒中心的一侧为内侧"启发式。
 */
export function roomInwardSign(wall, walls) {
  if (!wall || walls.length < 3) return null;
  const eps = 10; // 端点相接容差(mm)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of walls) {
    minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
  }
  const minArea = (maxX - minX) * (maxY - minY) / 2; // 环面积下限 = 包围盒矩形面积 1/4（2倍面积计）
  // 沿端点链步进：从 (sx,sy) 出发找下一条相接未访问的墙，返回顶点序列（不含起点）
  const chain = (sx, sy) => {
    const used = new Set([wall.id]);
    const out = [];
    let cx = sx, cy = sy, guard = 0;
    while (guard++ <= walls.length) {
      const n = walls.find(w => w.id !== wall.id && !used.has(w.id) &&
        (Math.hypot(w.x1 - cx, w.y1 - cy) < eps || Math.hypot(w.x2 - cx, w.y2 - cy) < eps));
      if (!n) break;
      used.add(n.id);
      if (Math.hypot(n.x1 - cx, n.y1 - cy) < eps) { cx = n.x2; cy = n.y2; }
      else { cx = n.x1; cy = n.y1; }
      out.push([cx, cy]);
    }
    return out;
  };
  const ringArea2 = pts => { // 鞋带公式（2倍有向面积）
    let a2 = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      a2 += x1 * y2 - x2 * y1;
    }
    return a2;
  };
  // 正向走：终点出发回起点（目标墙保持 x1→x2 方向）
  let pts = [[wall.x1, wall.y1], [wall.x2, wall.y2], ...chain(wall.x2, wall.y2)];
  let a2 = ringArea2(pts);
  if (pts.length >= 4 && Math.hypot(pts[pts.length - 1][0] - wall.x1, pts[pts.length - 1][1] - wall.y1) < eps
      && Math.abs(a2) >= minArea) return a2 > 0 ? 1 : -1;
  // 反向走：起点出发回终点（目标墙被反向遍历，环向符号取反）
  pts = [[wall.x2, wall.y2], [wall.x1, wall.y1], ...chain(wall.x1, wall.y1)];
  a2 = ringArea2(pts);
  if (pts.length >= 4 && Math.hypot(pts[pts.length - 1][0] - wall.x2, pts[pts.length - 1][1] - wall.y2) < eps
      && Math.abs(a2) >= minArea) return a2 < 0 ? 1 : -1;
  // 启发式：墙中点两侧探针（100mm），距包围盒中心近的一侧为内侧
  const L = wallLen(wall);
  if (!L) return null;
  const pcx = (minX + maxX) / 2, pcy = (minY + maxY) / 2;
  const mx = (wall.x1 + wall.x2) / 2, my = (wall.y1 + wall.y2) / 2;
  const ux = (wall.x2 - wall.x1) / L, uy = (wall.y2 - wall.y1) / L;
  const dl = Math.hypot(mx - uy * 100 - pcx, my + ux * 100 - pcy); // 左侧探针
  const dr = Math.hypot(mx + uy * 100 - pcx, my - ux * 100 - pcy); // 右侧探针
  return dl <= dr ? 1 : -1;
}

/** 线段是否与轴对齐矩形相交（含端点在矩形内；矩形需已规范化 rx0≤rx1, ry0≤ry1） */
export function segIntersectsRect(x1, y1, x2, y2, rx0, ry0, rx1, ry1) {
  const inR = (x, y) => x >= rx0 && x <= rx1 && y >= ry0 && y <= ry1;
  if (inR(x1, y1) || inR(x2, y2)) return true;
  return segSeg(x1, y1, x2, y2, rx0, ry0, rx1, ry0) ||
    segSeg(x1, y1, x2, y2, rx1, ry0, rx1, ry1) ||
    segSeg(x1, y1, x2, y2, rx1, ry1, rx0, ry1) ||
    segSeg(x1, y1, x2, y2, rx0, ry1, rx0, ry0);
}

/** 两线段是否相交（跨立实验 + 端点接触/共线重叠也算相交） */
function segSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  const cross = (ox, oy, px, py, qx, qy) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = cross(cx, cy, dx, dy, ax, ay), d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy), d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSeg = (x1, y1, x2, y2, px, py) =>
    Math.min(x1, x2) <= px && px <= Math.max(x1, x2) &&
    Math.min(y1, y2) <= py && py <= Math.max(y1, y2);
  if (d1 === 0 && onSeg(cx, cy, dx, dy, ax, ay)) return true;
  if (d2 === 0 && onSeg(cx, cy, dx, dy, bx, by)) return true;
  if (d3 === 0 && onSeg(ax, ay, bx, by, cx, cy)) return true;
  if (d4 === 0 && onSeg(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

/** 点是否落在以 (x,y) 为中心、按 rotation 旋转的 w×d 矩形内（机柜/柱子） */
export function pointInRotRect(px, py, o) {
  const r = -(o.rotation || 0) * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const lx = (px - o.x) * c - (py - o.y) * s;
  const ly = (px - o.x) * s + (py - o.y) * c;
  return Math.abs(lx) <= o.props.w / 2 && Math.abs(ly) <= o.props.d / 2;
}

/* ---------- 对象互斥（推挤）几何 ----------
 * 实体对象（机柜/柱子/空调/UPS/蓄电池/灭火器/风口/列头柜）之间不允许重叠：新放置/拖动的对象为“固定锚”，
 * 与锚重叠的旧对象被推开，级联传播。墙/桥架/门窗/通道带为结构或标注，不参与。 */

/** 参与互斥的“实体”类型 */
const SOLID_TYPES = new Set(['cabinet', 'column', 'ac', 'vent', 'pdu', 'dbox', 'ups', 'battery', 'extinguisher']);
export function isSolid(o) {
  return !!o && SOLID_TYPES.has(o.type) && !!o.props && o.props.w > 0 && o.props.d > 0;
}

/** 旋转矩形 4 角点（世界坐标） */
function rotCorners(o) {
  const rad = (o.rotation || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const hw = o.props.w / 2, hd = o.props.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]
    .map(([lx, ly]) => ({ x: o.x + lx * c - ly * s, y: o.y + lx * s + ly * c }));
}

/** 空调→格栅磁吸贴合：空调放置/拖动靠近墙上格栅时，吸附到“格栅正前方、后缘贴墙面”的机位——
 * 空调与格栅为贴合关系，不允许叠加在格栅上。
 * 命中条件（以空调拟定中心 (cx,cy) 判定）：
 * - 法向：中心距墙中心线 ≤ 墙半厚 + 空调法向半宽 + tol（覆盖“压墙/压格栅”与“贴墙附近”两种情形）；
 * - 沿墙：中心落在格栅跨度 + 空调沿墙半宽 + tol 范围内（靠近格栅即被吸至格栅中心）。
 * 多个格栅同时命中时取贴合偏差最小者。
 * acW/acD=空调宽深，rot=旋转角（度），tol=容差 mm；objects=全部对象（格栅经 wallId 找所属墙）。
 * 返回 {x, y, gx, gy}（贴合机位中心 + 格栅中心，gx/gy 供预览画吸附连线）；未命中返回 null。 */
export function grilleSnapAC(objects, cx, cy, acW, acD, rot, tol) {
  const rad = (rot || 0) * Math.PI / 180;
  const ax = Math.cos(rad), ay = Math.sin(rad); // 空调局部 X 轴（世界方向）
  let best = null;
  for (const o of objects) {
    if (o.type !== 'grille') continue;
    const w = objects.find(q => q.id === o.wallId);
    if (!w) continue;
    const L = wallLen(w);
    if (L < 1) continue;
    const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
    const nx = -uy, ny = ux;
    const th = w.props.thickness || 240;
    const gx = w.x1 + (w.x2 - w.x1) * o.t, gy = w.y1 + (w.y2 - w.y1) * o.t; // 格栅中心（墙中心线上）
    // 空调旋转后包围盒在墙法向 / 沿墙方向的半宽
    const extN = (acW * Math.abs(nx * ax + ny * ay) + acD * Math.abs(-nx * ay + ny * ax)) / 2;
    const extU = (acW * Math.abs(ux * ax + uy * ay) + acD * Math.abs(-ux * ay + uy * ax)) / 2;
    const pN = (cx - gx) * nx + (cy - gy) * ny; // 中心距墙中心线的法向投影
    const dU = (cx - gx) * ux + (cy - gy) * uy; // 中心相对格栅中心的沿墙偏差
    if (Math.abs(pN) > th / 2 + extN + tol) continue;
    if (Math.abs(dU) > (o.props.width || 900) / 2 + extU + tol) continue;
    const side = pN >= 0 ? 1 : -1;
    const score = Math.abs(Math.abs(pN) - (th / 2 + extN)); // 距贴合位的偏差
    if (!best || score < best.score) {
      best = { x: gx + side * nx * (th / 2 + extN), y: gy + side * ny * (th / 2 + extN), gx, gy, score };
    }
  }
  return best;
}

/** 两实体矩形是否重叠（SAT 分离轴）；重叠时返回把 b 从 a 推开的分离向量 {x, y}（
 * 距离=重叠量向上取整到 100mm 网格，保证推后仍落在网格线上），不重叠返回 null。
 * 中心完全重合（tie-break）时沿 a 的局部 X 轴正方向推开。 */
export function rectOverlap(a, b) {
  const ca = rotCorners(a), cb = rotCorners(b);
  // 轴归一化：消除 cos/sin 浮点残差（如 sin90°=6.1e-17），避免非零分量触发多余网格取整
  const norm = v => Math.abs(v) < 1e-9 ? 0 : (Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v);
  const axes = [];
  for (const o of [a, b]) { // 两矩形的局部 X/Y 轴（共 4 条候选分离轴）
    const rad = (o.rotation || 0) * Math.PI / 180;
    const c = norm(Math.cos(rad)), s = norm(Math.sin(rad));
    axes.push({ x: c, y: s }, { x: -s, y: c });
  }
  let minOv = Infinity, minAx = null;
  for (const ax of axes) {
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const p of ca) { const d = p.x * ax.x + p.y * ax.y; if (d < amin) amin = d; if (d > amax) amax = d; }
    for (const p of cb) { const d = p.x * ax.x + p.y * ax.y; if (d < bmin) bmin = d; if (d > bmax) bmax = d; }
    const ov = Math.min(amax, bmax) - Math.max(amin, bmin);
    if (ov <= 0) return null; // 该轴上分离 → 整体无重叠
    if (ov < minOv) { minOv = ov; minAx = ax; }
  }
  // 推挤方向：从 a 中心指向 b 中心在分离轴上的投影；中心重合时取轴正向
  let sgn = (b.x - a.x) * minAx.x + (b.y - a.y) * minAx.y;
  if (Math.abs(sgn) < 1e-6) sgn = 1; else sgn = sgn > 0 ? 1 : -1;
  // 目标位置取整到 100mm 网格（正向向上/反向向下，保证推挤量不缩水且落在网格线上）；
  // 轴分量为 0 的方向不移动也不取整（避免把本就网格外的坐标误推一格）
  const dist = Math.ceil(minOv / 100) * 100;
  const roundGrid = (v, up) => (up ? Math.ceil(v / 100) : Math.floor(v / 100)) * 100;
  const px = minAx.x * sgn, py = minAx.y * sgn;
  return {
    x: px === 0 ? 0 : roundGrid(b.x + px * dist, px > 0) - b.x,
    y: py === 0 ? 0 : roundGrid(b.y + py * dist, py > 0) - b.y,
  };
}

/* ---------- 两对象净距（垂足正交标尺） ---------- */

/** 对象轮廓凸多边形（世界坐标点数组）：矩形对象=旋转后 4 角；墙/桥架=线段沿法向扩半宽；
 * 门窗/格栅=洞口段沿墙方向扩半宽、法向扩墙半厚。resolve 用于门窗找所属墙（即 getObj） */
export function objOutline(o, resolve) {
  if (o.type === 'pipe') return pipeOutline(o, undefined, true);
  if (o.type === 'beam') { // 框架梁：端点可附着柱子动态跟随，按梁宽 b 沿法向外扩
    const e = beamEnds(o, resolve);
    const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    if (L < 1) return null;
    const ux = (e.x2 - e.x1) / L, uy = (e.y2 - e.y1) / L;
    const nx = -uy, ny = ux;
    const hw = (o.props.b || 300) / 2;
    return [
      { x: e.x1 + nx * hw, y: e.y1 + ny * hw }, { x: e.x2 + nx * hw, y: e.y2 + ny * hw },
      { x: e.x2 - nx * hw, y: e.y2 - ny * hw }, { x: e.x1 - nx * hw, y: e.y1 - ny * hw }];
  }
  if (o.type === 'wall' || o.type === 'tray') {
    const L = wallLen(o);
    if (L < 1) return null;
    const ux = (o.x2 - o.x1) / L, uy = (o.y2 - o.y1) / L;
    const nx = -uy, ny = ux;
    const hw = (o.type === 'wall' ? (o.props.thickness || 240) : (o.props.width || 300)) / 2;
    return [
      { x: o.x1 + nx * hw, y: o.y1 + ny * hw }, { x: o.x2 + nx * hw, y: o.y2 + ny * hw },
      { x: o.x2 - nx * hw, y: o.y2 - ny * hw }, { x: o.x1 - nx * hw, y: o.y1 - ny * hw }];
  }
  if (o.type === 'door' || o.type === 'window' || o.type === 'grille') {
    const w = resolve && resolve(o.wallId);
    if (!w) return null;
    const L = wallLen(w);
    if (L < 1) return null;
    const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
    const nx = -uy, ny = ux;
    const cx = w.x1 + ux * o.t * L, cy = w.y1 + uy * o.t * L;
    const hw = (o.props.width || 900) / 2, hd = (w.props.thickness || 240) / 2;
    return [
      { x: cx - ux * hw + nx * hd, y: cy - uy * hw + ny * hd },
      { x: cx + ux * hw + nx * hd, y: cy + uy * hw + ny * hd },
      { x: cx + ux * hw - nx * hd, y: cy + uy * hw - ny * hd },
      { x: cx - ux * hw - nx * hd, y: cy - uy * hw - ny * hd }];
  }
  // 未知类型保留在 JSON，但不伪装成矩形输出 NaN 轮廓。
  if(!Number.isFinite(o.x)||!Number.isFinite(o.y))return null;
  // 矩形对象（机柜/柱子/空调/风口/通道带）：旋转 4 角
  const rad = (o.rotation || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const hw = (o.props.w || 600) / 2, hd = (o.props.d || 600) / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]
    .map(([lx, ly]) => ({ x: o.x + lx * c - ly * s, y: o.y + lx * s + ly * c }));
}

/** 凸多边形与水平线 y 的交点 X 区间 [min,max]；无交返回 null */
function xRangeAtY(poly, y) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    if ((p.y - y) * (q.y - y) > 0) continue; // 边两端同侧
    if (p.y === q.y) { lo = Math.min(lo, p.x, q.x); hi = Math.max(hi, p.x, q.x); continue; } // 水平边在线上
    const t = (y - p.y) / (q.y - p.y);
    if (t < 0 || t > 1) continue;
    const x = p.x + t * (q.x - p.x);
    if (x < lo) lo = x; if (x > hi) hi = x;
  }
  return lo > hi ? null : [lo, hi];
}

/** 凸多边形与竖直线 x 的交点 Y 区间 [min,max]；无交返回 null */
function yRangeAtX(poly, x) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    if ((p.x - x) * (q.x - x) > 0) continue;
    if (p.x === q.x) { lo = Math.min(lo, p.y, q.y); hi = Math.max(hi, p.y, q.y); continue; }
    const t = (x - p.x) / (q.x - p.x);
    if (t < 0 || t > 1) continue;
    const y = p.y + t * (q.y - p.y);
    if (y < lo) lo = y; if (y > hi) hi = y;
  }
  return lo > hi ? null : [lo, hi];
}

/** 多边形 X/Y 包围区间 */
const bboxX = p => [Math.min(...p.map(q => q.x)), Math.max(...p.map(q => q.x))];
const bboxY = p => [Math.min(...p.map(q => q.y)), Math.max(...p.map(q => q.y))];

/** X 向（水平）净距：Y 投影重叠时取重叠区中线截两多边形得边到边垂足对（标注线直连两边）；
 * Y 投影不重叠（对角分布）时取包围盒边距，垂足落在轮廓最端点并向两对象之间竖直延长（ext=true） */
function hClearance(A, B) {
  const ay = bboxY(A), by = bboxY(B);
  const lo = Math.max(ay[0], by[0]), hi = Math.min(ay[1], by[1]);
  if (hi > lo) { // Y 投影重叠：标注线即垂足连线
    const y = (lo + hi) / 2;
    const ra = xRangeAtY(A, y), rb = xRangeAtY(B, y);
    if (!ra || !rb) return null;
    if (ra[1] <= rb[0]) return { gap: rb[0] - ra[1], a: { x: ra[1], y }, b: { x: rb[0], y }, dim: y, ext: false };
    if (rb[1] <= ra[0]) return { gap: ra[0] - rb[1], a: { x: ra[0], y }, b: { x: rb[1], y }, dim: y, ext: false };
    return null; // X 投影也重叠 → 该方向无净距
  }
  // 对角分布：包围盒边距（垂足取轮廓端点，保证落在真实边上）
  const ax = bboxX(A), bx = bboxX(B);
  let gap, xa, xb;
  if (ax[1] <= bx[0]) { gap = bx[0] - ax[1]; xa = ax[1]; xb = bx[0]; }
  else if (bx[1] <= ax[0]) { gap = ax[0] - bx[1]; xa = ax[0]; xb = bx[1]; }
  else return null; // X 投影重叠（上下分布）→ 无水平净距
  const yaR = yRangeAtX(A, xa) || ay;
  const ybR = yRangeAtX(B, xb) || by;
  const bAbove = by[0] >= ay[1]; // B 在 A 北侧
  const ya = bAbove ? yaR[1] : yaR[0];
  const yb = bAbove ? ybR[0] : ybR[1];
  return { gap, a: { x: xa, y: ya }, b: { x: xb, y: yb }, dim: (ya + yb) / 2, ext: true };
}

/** 交换坐标（复用 hClearance 计算垂直方向） */
const swapXY = poly => poly.map(p => ({ x: p.y, y: p.x }));
const unswap = p => ({ x: p.y, y: p.x });

/**
 * 两对象净距（垂足正交标尺数据）。
 * 返回 { h, v, center }：
 *  - h：X 向（水平）净距 { gap, a, b, dim, ext }，a/b 为两对象轮廓上的垂足点，
 *      dim 为标注线坐标（h=Y 值 / v=X 值），ext=true 时垂足需向标注线正交延长；
 *      该方向投影重叠（无净距）时为 null
 *  - center：{ d, a, b } 两轮廓质心与直线距离（中心距）
 * 任一对象无法取轮廓时返回 null
 */
export function pairClearance(o1, o2, resolve) {
  // 二维净距标尺不应用于三维管体，避免把平面净距误称空间净距。
  if (o1.type === 'pipe' || o2.type === 'pipe') return null;
  const A = objOutline(o1, resolve), B = objOutline(o2, resolve);
  if (!A || !B) return null;
  const ctr = poly => {
    let x = 0, y = 0;
    for (const p of poly) { x += p.x; y += p.y; }
    return { x: x / poly.length, y: y / poly.length };
  };
  const ca = ctr(A), cb = ctr(B);
  const h = hClearance(A, B);
  const dv = hClearance(swapXY(A), swapXY(B));
  const v = dv ? { gap: dv.gap, a: unswap(dv.a), b: unswap(dv.b), dim: dv.dim, ext: dv.ext } : null;
  return { h, v, center: { d: Math.hypot(cb.x - ca.x, cb.y - ca.y), a: ca, b: cb } };
}

/**
 * 与候选对象集中“最近邻居”的净距（摆放/拖动实时净距）。
 * 每个方向（X 向 / Y 向）各取 gap 最小的一个候选；相贴（gap=0）为有效值（表示已贴齐）。
 * @param obj 参照对象（拖动中的对象或放置预览伪对象）
 * @param candidates 候选对象数组（调用方负责剔除自身/选中组/不想参与的类型）
 * @returns { h, v, cA } | null；h/v 为 { dim, cB, obj }（dim=pairClearance 的标尺数据，
 *   cB=邻居质心，obj=邻居对象），该方向无任何可测候选时为 null；cA 为 obj 轮廓质心；
 *   候选为空或 obj 无轮廓时返回 null
 */
export function nearestClearance(obj, candidates, resolve) {
  let h = null, v = null, cA = null;
  for (const o of candidates) {
    const pc = pairClearance(obj, o, resolve);
    if (!pc) continue;
    if (!cA) cA = pc.center.a;
    if (pc.h && (!h || pc.h.gap < h.dim.gap)) h = { dim: pc.h, cB: pc.center.b, obj: o };
    if (pc.v && (!v || pc.v.gap < v.dim.gap)) v = { dim: pc.v, cB: pc.center.b, obj: o };
  }
  return cA ? { h, v, cA } : null;
}

/** 房间内表面包围盒（墙中心线包围盒各边向内缩该边墙半厚）。
 * 返回 { minX, minY, maxX, maxY, L, W }（L/W=内空尺寸 mm）；墙少于 3 段返回 null。
 * 注：仅对矩形/近矩形房间精确；L 形等异形房间按外接矩形近似。
 * 净距标尺（aabbWallClearances）、CSV 清单、合规自检共用同一口径。 */
export function roomInnerBox(walls) {
  if (!walls || walls.length < 3) return null;
  // 墙中心线包围盒 = 房间外表面
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of walls) {
    minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
  }
  // 与包围盒某边重合（整段轴线落在此边上）的墙段厚度，找不到回退默认 240；
  // 注意端点“恰好落在边上”的邻墙不算（如北墙东端点到东边界，会覆盖东墙真实厚度）
  const edgeT = (axis, edge) => {
    let t = 240;
    for (const w of walls) {
      const wt = w.props.thickness || 240;
      const lo = axis === 'x' ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2);
      const hi = axis === 'x' ? Math.max(w.x1, w.x2) : Math.max(w.y1, w.y2);
      if (Math.abs(lo - edge) < 1 && Math.abs(hi - edge) < 1) t = wt;
    }
    return t;
  };
  // 内表面 = 外表面各边向内缩该边墙半厚
  const inL = minX + edgeT('x', minX) / 2, inR = maxX - edgeT('x', maxX) / 2;
  const inB = minY + edgeT('y', minY) / 2, inT = maxY - edgeT('y', maxY) / 2;
  return { minX: inL, minY: inB, maxX: inR, maxY: inT, L: inR - inL, W: inT - inB };
}

/** AABB（ax=[minX,maxX]、ay=[minY,maxY]）到四周墙内表面的净距（房间近似为墙包围盒矩形，
 * 各边按该边墙厚向内缩半厚，见 roomInnerBox）。返回 { left, right, bottom, top, box }——各净距(mm)，
 * 对象越出对应方向墙内表面时为负值（由调用方决定是否显示）；box 为传入 AABB 的回显；
 * 墙少于 3 段时返回 null。 */
function aabbWallClearances(ax, ay, walls) {
  const b = roomInnerBox(walls);
  if (!b) return null;
  return {
    left: ax[0] - b.minX, right: b.maxX - ax[1],
    bottom: ay[0] - b.minY, top: b.maxY - ay[1],
    box: { minX: ax[0], maxX: ax[1], minY: ay[0], maxY: ay[1] },
  };
}

/** 对象到四周墙内表面的净距（单对象：按其轮廓 AABB 计距）。 */
export function wallClearances(obj, walls, resolve) {
  const poly = objOutline(obj, resolve);
  if (!poly) return null;
  return aabbWallClearances(bboxX(poly), bboxY(poly), walls);
}

/** 对象组到四周墙内表面的净距（整组外沿：所有对象轮廓 AABB 的联合包围盒计距）。
 * 无轮廓的对象（如未挂墙的门窗）自动跳过；全部无轮廓或数组为空时返回 null。 */
export function groupWallClearances(objs, walls, resolve) {
  if (!objs.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (const o of objs) {
    const poly = objOutline(o, resolve);
    if (!poly) continue;
    any = true;
    const ax = bboxX(poly), ay = bboxY(poly);
    minX = Math.min(minX, ax[0]); maxX = Math.max(maxX, ax[1]);
    minY = Math.min(minY, ay[0]); maxY = Math.max(maxY, ay[1]);
  }
  return any ? aabbWallClearances([minX, maxX], [minY, maxY], walls) : null;
}
