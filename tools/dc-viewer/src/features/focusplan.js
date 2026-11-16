/**
 * 相机聚焦（纯函数，无 DOM / three 依赖，可在 Node 单测）。
 *
 * 目标：
 *   · 保持用户当前观察方位（theta）——聚焦只拉近/升高，不突然转到另一侧；
 *   · 按对象包围盒 + 当前 fov / 宽高比计算取景距离（透视与正交同语义）；
 *   · 透视时把相机限制在机房安全盒内，必要时逐步增大极角（降低机位）；
 *   · 相机不允许落进被聚焦对象自身；机房太矮/太窄时宁可少留白也不穿墙。
 *
 * 单位：场景米（x 东、y 高、z = -项目 y）；room 由调用方用 projectFrame 换算后传入。
 */

export const FOCUS = Object.freeze({
  padding: 1.16,
  minPhi: 0.12,
  maxPhi: 1.28,
  phiStep: 0.06,
  minDistance: 0.45,
  wallMargin: 0.4,
  floorMargin: 0.25,
  ceilMargin: 0.2,
  tweenSec: 0.85,
  nearPad: 0.06,
});

const S = 0.001;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const len = v => Math.hypot(v.x, v.y, v.z);
const norm = v => {
  const l = len(v);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 1, y: 0, z: 0 };
};
const add = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });

/**
 * 包围盒归一化：接受 {min:{x,y,z}, max:{x,y,z}}（或 minimum/maximum）。
 * @returns {{min:object,max:object,size:object,center:object,radius:number}|null}
 */
export function normalizeBox(box) {
  if (!box) return null;
  const mn = box.min || box.minimum;
  const mx = box.max || box.maximum;
  if (!mn || !mx) return null;
  const vals = [mn.x, mn.y, mn.z, mx.x, mx.y, mx.z].map(Number);
  if (!vals.every(Number.isFinite)) return null;
  const min = {
    x: Math.min(vals[0], vals[3]),
    y: Math.min(vals[1], vals[4]),
    z: Math.min(vals[2], vals[5]),
  };
  const max = {
    x: Math.max(vals[0], vals[3]),
    y: Math.max(vals[1], vals[4]),
    z: Math.max(vals[2], vals[5]),
  };
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  const center = {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  };
  const radius = Math.max(1e-4, Math.hypot(size.x, size.y, size.z) / 2);
  return { min, max, size, center, radius };
}

/**
 * 轨道相机方向基（与镜头 applyPose 同一约定）：
 *   dir = 目标 → 相机；right = 屏幕右；up = 屏幕上。
 */
export function viewBasis(theta, phi) {
  const t = Number.isFinite(theta) ? theta : Math.PI / 4;
  const p = Number.isFinite(phi) ? phi : 0.9;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const dir = { x: sp * Math.sin(t), y: cp, z: sp * Math.cos(t) };
  let right = cross({ x: 0, y: 1, z: 0 }, dir);
  if (len(right) < 1e-9) right = { x: 1, y: 0, z: 0 };
  right = norm(right);
  const up = norm(cross(dir, right));
  return { dir, right, up };
}

/** 包围盒 8 角点相对目标点的屏幕半宽 / 半高（场景米） */
export function projectedHalfExtents(box, target, theta, phi) {
  const b = normalizeBox(box);
  if (!b || !target) return { halfX: 0, halfY: 0 };
  const { right, up } = viewBasis(theta, phi);
  let halfX = 0;
  let halfY = 0;
  const t = { x: +target.x, y: +target.y, z: +target.z };
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const rel = {
          x: (sx < 0 ? b.min.x : b.max.x) - t.x,
          y: (sy < 0 ? b.min.y : b.max.y) - t.y,
          z: (sz < 0 ? b.min.z : b.max.z) - t.z,
        };
        halfX = Math.max(halfX, Math.abs(dot(rel, right)));
        halfY = Math.max(halfY, Math.abs(dot(rel, up)));
      }
    }
  }
  return { halfX, halfY };
}

/**
 * 相机沿 dir 从目标后退多少米刚好把包围盒放进画面（透视）或填满正交视野。
 *
 * 透视：对每个角点求 D ≥ 深度偏移 + 屏幕偏移 / tan(半视角)；
 * 正交：可见高度 = 2·D·tan(fov/2)（与 r→zoom 语义一致）。
 */
export function fitDistance(box, target, theta, phi, fov = 45, aspect = 1,
  mode = 'perspective', padding = FOCUS.padding) {
  const b = normalizeBox(box);
  const t = target || (b && b.center) || { x: 0, y: 0, z: 0 };
  const a = Number.isFinite(aspect) && aspect > 0 ? +aspect : 1;
  const f = Number.isFinite(fov) ? +fov : 45;
  const tanV = Math.max(1e-6, Math.tan((f * Math.PI) / 360));
  const tanH = Math.max(1e-6, tanV * a);
  const pad = Number.isFinite(padding) && padding > 0 ? +padding : FOCUS.padding;
  if (!b) return { fitR: FOCUS.minDistance, halfX: 0, halfY: 0, tanV, tanH };

  if (mode === 'ortho') {
    const { halfX, halfY } = projectedHalfExtents(b, t, theta, phi);
    const fitR = Math.max(FOCUS.minDistance, Math.max(halfY / tanV, halfX / tanH) * pad);
    return { fitR, halfX, halfY, tanV, tanH };
  }

  const { dir, right, up } = viewBasis(theta, phi);
  let D = 0;
  let halfX = 0;
  let halfY = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const rel = {
          x: (sx < 0 ? b.min.x : b.max.x) - t.x,
          y: (sy < 0 ? b.min.y : b.max.y) - t.y,
          z: (sz < 0 ? b.min.z : b.max.z) - t.z,
        };
        const toward = dot(rel, dir);
        const ex = Math.abs(dot(rel, right));
        const ey = Math.abs(dot(rel, up));
        halfX = Math.max(halfX, ex);
        halfY = Math.max(halfY, ey);
        D = Math.max(D, toward + ey / tanV, toward + ex / tanH);
      }
    }
  }
  const fitR = Math.max(FOCUS.minDistance, D * pad);
  return { fitR, halfX, halfY, tanV, tanH };
}

/** 从目标中心沿 dir 走到包围盒表面的距离（相机至少退到这里才不落进对象） */
export function boxExitDistance(box, target, dir) {
  const b = normalizeBox(box);
  if (!b || !target || !dir) return 0;
  let exit = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const d = +dir[axis];
    if (Math.abs(d) < 1e-9) continue;
    const bound = d > 0 ? b.max[axis] : b.min[axis];
    const dist = (bound - +target[axis]) / d;
    if (dist > 0) exit = Math.min(exit, dist);
  }
  return Number.isFinite(exit) ? exit : 0;
}

/**
 * 从目标点沿 dir 走到房间边界（墙/吊顶/地板）的距离。
 * 目标本身在房间外时返回 Infinity（避免机位被压到零）。
 */
export function roomClearance(target, dir, room) {
  if (!room || !target || !dir) return Infinity;
  const axes = [
    ['x', room.minx, room.maxx],
    ['y', room.miny, room.maxy],
    ['z', room.minz, room.maxz],
  ];
  for (const [axis, lo, hi] of axes) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    const v = +target[axis];
    if (!Number.isFinite(v) || v < lo || v > hi) return Infinity;
  }
  let max = Infinity;
  for (const [axis, lo, hi] of axes) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    const d = +dir[axis];
    if (Math.abs(d) < 1e-9) continue;
    const dist = ((d > 0 ? hi : lo) - +target[axis]) / d;
    if (dist > 0) max = Math.min(max, dist);
  }
  return max;
}

/**
 * 聚焦机位（纯函数）。
 *
 * @param {object} opts
 * @param {object} opts.box           对象包围盒（场景米）
 * @param {number} [opts.theta]       当前方位角（保持）
 * @param {number} [opts.phi]         当前极角
 * @param {number} [opts.fov]         透视 fov
 * @param {number} [opts.aspect]      画布宽高比
 * @param {'perspective'|'ortho'} [opts.mode]
 * @param {object} [opts.room]        室内安全盒 {minx,maxx,miny,maxy,minz,maxz}
 */
export function focusPose(opts = {}) {
  const b = normalizeBox(opts.box);
  if (!b) return null;
  const theta = Number.isFinite(opts.theta) ? +opts.theta : Math.PI / 4;
  const basePhi = clamp(Number.isFinite(opts.phi) ? +opts.phi : 0.9, FOCUS.minPhi, FOCUS.maxPhi);
  const fov = Number.isFinite(opts.fov) ? +opts.fov : 45;
  const aspect = Number.isFinite(opts.aspect) && opts.aspect > 0 ? +opts.aspect : 1;
  const mode = opts.mode === 'ortho' ? 'ortho' : 'perspective';
  const room = opts.room || null;
  const padding = Number.isFinite(opts.padding) ? +opts.padding : FOCUS.padding;
  const target = { ...b.center };

  // 候选极角：从当前值开始，按 0.06 递增（增大 phi = 降低机位）直到上限
  const candidates = [basePhi];
  if (mode !== 'ortho') {
    for (let p = basePhi + FOCUS.phiStep; p <= FOCUS.maxPhi + 1e-9; p += FOCUS.phiStep) {
      candidates.push(+p.toFixed(4));
    }
  }

  let best = null;
  for (const phi of candidates) {
    const fit = fitDistance(b, target, theta, phi, fov, aspect, mode, padding);
    if (mode === 'ortho') {
      best = { phi, fit, clearance: Infinity, usedR: fit.fitR, score: 1 };
      break;
    }
    const { dir } = viewBasis(theta, phi);
    const clearance = roomClearance(target, dir, room);
    const limit = Number.isFinite(clearance) && clearance > 0 ? clearance : fit.fitR;
    const usedR = Math.max(0.05, Math.min(fit.fitR, limit));
    const score = fit.fitR > 0 ? Math.min(1, usedR / fit.fitR) : 1;
    if (!best || score > best.score + 1e-6) best = { phi, fit, clearance, usedR, score };
    if (score >= 1 - 1e-6) break;
  }
  if (!best) return null;

  const { dir } = viewBasis(theta, best.phi);
  let usedR = mode === 'ortho' ? best.fit.fitR : best.usedR;
  // 相机不得落进被聚焦对象：退到包围盒表面之外
  if (mode !== 'ortho') {
    usedR = Math.max(usedR, boxExitDistance(b, target, dir) + FOCUS.nearPad);
  }
  const camera = add(target, dir, usedR);
  const eps = 1e-6;
  const insideRoom = !room ? null : (
    camera.x >= room.minx - eps && camera.x <= room.maxx + eps
    && camera.y >= room.miny - eps && camera.y <= room.maxy + eps
    && camera.z >= room.minz - eps && camera.z <= room.maxz + eps
  );
  return {
    target,
    theta,
    phi: best.phi,
    r: usedR,
    fitR: best.fit.fitR,
    usedR,
    camera,
    box: b,
    mode,
    clearance: best.clearance,
    clamped: mode !== 'ortho' && best.score < 1 - 1e-6,
    phiAdjusted: Math.abs(best.phi - basePhi) > 1e-6,
    aboveCeiling: !!(room && Number.isFinite(room.maxy) && camera.y > room.maxy + eps),
    insideRoom,
  };
}

/**
 * 没有场景节点时的对象包围盒（场景米）：按项目数据字段推算。
 * 场景构建后优先用实测包围盒；这里只做兜底。
 */
export function focusBoxOf(obj, opts = {}) {
  if (!obj) return null;
  const p = obj.props || {};
  const roomH = Number.isFinite(+opts.roomH) && +opts.roomH > 0 ? +opts.roomH : 3000;
  const box = (x0, x1, y0, y1, z0, z1) => {
    const minx = Math.min(x0, x1) * S;
    const maxx = Math.max(x0, x1) * S;
    const miny = Math.min(y0, y1) * S;
    const maxy = Math.max(y0, y1) * S;
    const minz = -Math.max(z0, z1) * S;
    const maxz = -Math.min(z0, z1) * S;
    return { min: { x: minx, y: miny, z: minz }, max: { x: maxx, y: maxy, z: maxz } };
  };

  if (obj.type === 'wall') {
    const th = Math.abs(+p.thickness) || 240;
    const h = +p.height || roomH;
    const x1 = +obj.x1;
    const y1 = +obj.y1;
    const x2 = +obj.x2;
    const y2 = +obj.y2;
    if ([x1, y1, x2, y2].every(Number.isFinite)) {
      return box(x1 - th / 2, x2 + th / 2, 0, h, y1 - th / 2, y2 + th / 2);
    }
  }
  if (obj.type === 'tray' || obj.type === 'beam') {
    const x1 = +obj.x1;
    const y1 = +obj.y1;
    const x2 = +obj.x2;
    const y2 = +obj.y2;
    if ([x1, y1, x2, y2].every(Number.isFinite)) {
      const w = (obj.type === 'tray' ? Math.abs(+p.width) || 300 : Math.abs(+p.b) || 300) / 2;
      const bottom = +p.height || 2500;
      const h = obj.type === 'tray' ? +p.bodyH || 100 : +p.h || 600;
      return box(x1 - w, x2 + w, bottom, bottom + h, y1 - w, y2 + w);
    }
  }
  if (obj.type === 'ceiling') return null; // 吊顶是整层分组，由场景包围盒给出

  const x = +obj.x;
  const y = +obj.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const w = Math.abs(+p.w) || 600;
  const d = Math.abs(+p.d) || 600;
  const h = Math.abs(+p.h) || (obj.type === 'aisle' ? +p.h || roomH : 2000);
  return box(x - w / 2, x + w / 2, 0, h, y - d / 2, y + d / 2);
}

/** 聚焦对象显示名：名称优先，其次 id / 类型 */
export function focusLabel(obj) {
  if (!obj) return '';
  const p = obj.props || {};
  return String(p.name || obj.id || obj.type || '').trim();
}
