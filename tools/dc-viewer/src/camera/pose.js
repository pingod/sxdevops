/**
 * 视图取景与业务视点派生（纯函数，无 DOM / three 依赖）。
 *
 * 本模块只做数学与数据派生：
 *   · 视图 id 归一化（俯视 / 轴测四角 / 正交立面 / 轨道）；
 *   · 机柜排号 deriveRows；
 *   · 俯视 topViewPose、轴测 isoViewPose、立面 elevationViewPose；
 *   · 房间框架 projectFrame 与业务视点 listViewpoints / summarizeViewpoints。
 *
 * 单位约定：项目数据 mm，轨道位姿 target/r 为场景米；x 向东、y 向上、z = -项目 y。
 * 相机位姿：camera = target + (r·sinφ·sinθ, r·cosφ, r·sinφ·cosθ)，
 * theta = 0 表示相机在目标正南，phi 为从 +Y 起的极角。
 */

const S = 0.001; // 项目毫米 → 场景米

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clampNum = clamp;
const num = v => {
  const n = +v;
  return Number.isFinite(n) ? n : 0;
};

export const VIEW = Object.freeze({ ORBIT: 'orbit', TOP: 'top', ISO: 'iso' });

/** 俯视参数：取景留白 / 方位角（0 = 屏幕上方朝北）/ 极角（贴近正上方）/ 标签允许的最大倾角 */
export const TOP_VIEW = Object.freeze({
  padding: 1.08,
  theta: 0,
  phi: 0.01,
  labelMaxPhi: 0.30,
});

/**
 * 轴测参数：四角方位 + 等轴测仰角。
 * 仰角 = atan(1/√2) ≈ 35.264°，three 极角 phi = π/2 − 仰角 ≈ 54.736°。
 */
export const ISO_VIEW = Object.freeze({
  corners: Object.freeze({
    se: Object.freeze({ theta: Math.PI / 4, label: '东南' }),
    sw: Object.freeze({ theta: -Math.PI / 4, label: '西南' }),
    nw: Object.freeze({ theta: (-3 * Math.PI) / 4, label: '西北' }),
    ne: Object.freeze({ theta: (3 * Math.PI) / 4, label: '东北' }),
  }),
  order: Object.freeze(['se', 'sw', 'nw', 'ne']),
  defaultCorner: 'se',
  elevation: Math.atan(Math.SQRT1_2),
  phi: Math.PI / 2 - Math.atan(Math.SQRT1_2),
  padding: 1.05,
});

const CORNER_ALIAS = Object.freeze({
  se: 'se', sw: 'sw', ne: 'ne', nw: 'nw',
  东南: 'se', 西南: 'sw', 东北: 'ne', 西北: 'nw',
});

/** 正交立面：四个方向的角度、名称与提示（theta 与轨道相机一致） */
export const ELEVATION_VIEW = Object.freeze({
  order: Object.freeze(['front', 'back', 'left', 'right']),
  padding: 1.06,
  tilt: 1e-4,
  phi: Math.PI / 2 - 1e-4,
  sides: Object.freeze({
    front: Object.freeze({ theta: 0, label: '南立面', short: '前', hint: '从南向北 · 正交立面' }),
    back: Object.freeze({ theta: Math.PI, label: '北立面', short: '后', hint: '从北向南 · 正交立面' }),
    left: Object.freeze({ theta: -Math.PI / 2, label: '西立面', short: '左', hint: '从西向东 · 正交立面' }),
    right: Object.freeze({ theta: Math.PI / 2, label: '东立面', short: '右', hint: '从东向西 · 正交立面' }),
  }),
});

const ELEVATION_ALIASES = Object.freeze({
  front: 'front', south: 'front', 'front-elevation': 'front', 'south-elevation': 'front',
  前: 'front', 前立面: 'front', 南: 'front', 南立面: 'front',
  back: 'back', north: 'back', 'back-elevation': 'back', 'north-elevation': 'back',
  后: 'back', 后立面: 'back', 北: 'back', 北立面: 'back',
  left: 'left', west: 'left', 'left-elevation': 'left', 'west-elevation': 'left',
  左: 'left', 左立面: 'left', 西: 'left', 西立面: 'left',
  right: 'right', east: 'right', 'right-elevation': 'right', 'east-elevation': 'right',
  右: 'right', 右立面: 'right', 东: 'right', 东立面: 'right',
});

/** 视点派生参数（单位：场景米 / 项目毫米，见注释） */
export const VIEWPOINT = Object.freeze({
  max: 10,
  min: 6,
  cornerPhi: 0.85,
  cornerPadding: 1.05,
  entryEye: 1.62,
  entryInset: 800,
  aisleMargin: 1200,
  maxAisleViews: 3,
  wallInset: 700,
  areaEye: 1.0,
  areaCamH: 2.2,
  areaCamMaxH: 4.5,
  dedupeTarget: 1.5,
  dedupeAngle: (12 * Math.PI) / 180,
  tweenSec: 1.0,
});

/** 四角业务视点（轨道透视；与轴测 iso-* 是两套入口） */
const VP_CORNERS = Object.freeze([
  { key: 'se', label: '东南角', theta: Math.PI / 4 },
  { key: 'sw', label: '西南角', theta: -Math.PI / 4 },
  { key: 'nw', label: '西北角', theta: (-3 * Math.PI) / 4 },
  { key: 'ne', label: '东北角', theta: (3 * Math.PI) / 4 },
]);

/** 立面 id 归一化：front / south / 南立面 / 前 都得到 front；非法值返回 null */
export function elevationId(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s && ELEVATION_ALIASES[s] ? ELEVATION_ALIASES[s] : null;
}

/**
 * 视图 id 归一化；非法值返回 null（调用方忽略，不抛错）。
 * 支持 top/plan/bird/俯视、orbit/3d/default/全景、iso 四角中英文、
 * 立面 front/back/left/right 及 south/南立面/前 等别名。
 */
export function normalizeViewId(id) {
  const s = String(id || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'top' || s === 'plan' || s === 'bird' || s === '俯视') return VIEW.TOP;
  if (s === 'orbit' || s === '3d' || s === 'default' || s === '全景') return VIEW.ORBIT;
  const el = elevationId(s);
  if (el) return el;
  const m = /^(?:iso|axo|axon|isometric|轴测|等轴测)(?:[-_:· ]?(se|sw|ne|nw|东南|西南|东北|西北))?$/.exec(s);
  if (!m) return null;
  if (!m[1]) return VIEW.ISO;
  return VIEW.ISO + '-' + CORNER_ALIAS[m[1]];
}

/**
 * 从机柜名称前缀派生排号与端头锚点（项目 mm）。
 *   · 只认字母前缀（A01 / B-12 / C 05 → A / B / C），无前缀机柜不生成标签；
 *   · 排走向取包围盒长边：东西向 → 东端，南北向 → 北端；
 *   · 锚点离排端 gap（默认 900mm），并夹在墙体包围盒内缩 400mm 的安全区里。
 */
export function deriveRows(project, opts = {}) {
  const objs = (project && project.objects) || [];
  const gap = Number.isFinite(opts.gap) ? Math.max(0, +opts.gap) : 900;
  const groups = new Map();

  for (const o of objs) {
    if (!o || o.type !== 'cabinet' || !Number.isFinite(+o.x) || !Number.isFinite(+o.y)) continue;
    const p = o.props || {};
    const name = String(p.name || '').trim();
    const m = /^([A-Za-z]+)/.exec(name);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const w = Math.abs(+p.w) || 600;
    const d = Math.abs(+p.d) || 1200;
    let g = groups.get(key);
    if (!g) {
      g = {
        key, count: 0,
        minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity,
      };
      groups.set(key, g);
    }
    g.count++;
    g.minx = Math.min(g.minx, +o.x - w / 2);
    g.maxx = Math.max(g.maxx, +o.x + w / 2);
    g.miny = Math.min(g.miny, +o.y - d / 2);
    g.maxy = Math.max(g.maxy, +o.y + d / 2);
  }
  if (!groups.size) return [];

  // 墙体包围盒：锚点夹在墙内，避免标签落到机房外被边缘裁掉
  let wb = null;
  for (const o of objs) {
    if (!o || o.type !== 'wall') continue;
    if (!wb) wb = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
    wb.minx = Math.min(wb.minx, num(o.x1), num(o.x2));
    wb.maxx = Math.max(wb.maxx, num(o.x1), num(o.x2));
    wb.miny = Math.min(wb.miny, num(o.y1), num(o.y2));
    wb.maxy = Math.max(wb.maxy, num(o.y1), num(o.y2));
  }
  const inset = 400;

  return [...groups.values()]
    .sort((a, b) => a.key.localeCompare(b.key, 'en'))
    .map(g => {
      const cx = (g.minx + g.maxx) / 2;
      const cy = (g.miny + g.maxy) / 2;
      const axis = g.maxx - g.minx >= g.maxy - g.miny ? 'x' : 'y';
      let x = axis === 'x' ? g.maxx + gap : cx;
      let y = axis === 'y' ? g.maxy + gap : cy;
      if (wb && wb.maxx > wb.minx && wb.maxy > wb.miny) {
        x = clamp(x, wb.minx + inset, wb.maxx - inset);
        y = clamp(y, wb.miny + inset, wb.maxy - inset);
      }
      return {
        key: g.key, count: g.count, axis,
        anchor: { x, y },
        bbox: { minx: g.minx, miny: g.miny, maxx: g.maxx, maxy: g.maxy },
      };
    });
}

/** 取景函数的入参兼容：接受包围盒，或带 bounds/roomH 的场景构建结果 */
function boundsInput(input) {
  if (input && input.bounds && typeof input.bounds === 'object') {
    return { bounds: input.bounds, roomH: input.roomH };
  }
  return { bounds: input || {}, roomH: input && input.roomH };
}

/**
 * 俯视取景（纯函数）：让机房平面包围盒完整落进正交视野。
 * 正交可见高度 = 2·r·tan(fov/2)，可见宽度 = 高度·aspect，
 * 故 r = max(D, W/aspect) × padding / (2·tan(fov/2))。
 */
export function topViewPose(bounds, opts = {}) {
  const b = boundsInput(bounds).bounds;
  const minx = Number.isFinite(b.minx) ? +b.minx : 0;
  const maxx = Number.isFinite(b.maxx) ? +b.maxx : minx;
  const miny = Number.isFinite(b.miny) ? +b.miny : 0;
  const maxy = Number.isFinite(b.maxy) ? +b.maxy : miny;
  const aspect = Number.isFinite(opts.aspect) && opts.aspect > 0 ? +opts.aspect : 1;
  const fov = Number.isFinite(opts.fov) ? +opts.fov : 45;
  const padding = Number.isFinite(opts.padding) ? +opts.padding : TOP_VIEW.padding;
  const W = Math.max(0, maxx - minx) * S;
  const D = Math.max(0, maxy - miny) * S;
  const tan = Math.max(1e-6, Math.tan((fov * Math.PI) / 360));
  const visible = Math.max(D, W / aspect, 0.1) * padding;
  return {
    target: { x: ((minx + maxx) / 2) * S, y: 0, z: (-(miny + maxy) / 2) * S },
    r: Math.max(3, visible / (2 * tan)),
    theta: TOP_VIEW.theta,
    phi: TOP_VIEW.phi,
    visible,
  };
}

/**
 * 轴测取景（纯函数）：四角等轴测、正交平行投影。
 * 把房间包围盒 8 角点投到屏幕右轴 / 上轴得到 halfX/halfY，
 * visible = max(2·halfY, 2·halfX/aspect) × padding。
 */
export function isoViewPose(bounds, opts = {}) {
  const src = boundsInput(bounds);
  const b = src.bounds;
  const minx = Number.isFinite(b.minx) ? +b.minx : 0;
  const maxx = Number.isFinite(b.maxx) ? +b.maxx : minx;
  const miny = Number.isFinite(b.miny) ? +b.miny : 0;
  const maxy = Number.isFinite(b.maxy) ? +b.maxy : miny;
  const roomHRaw = Number.isFinite(opts.roomH) ? +opts.roomH : +src.roomH;
  const roomH = Number.isFinite(roomHRaw) && roomHRaw > 0 ? roomHRaw : 3000;
  const corner = ISO_VIEW.corners[opts.corner] ? opts.corner : ISO_VIEW.defaultCorner;
  const theta = ISO_VIEW.corners[corner].theta;
  const phi = ISO_VIEW.phi;
  const aspect = Number.isFinite(opts.aspect) && opts.aspect > 0 ? +opts.aspect : 1;
  const fov = Number.isFinite(opts.fov) ? +opts.fov : 45;
  const padding = Number.isFinite(opts.padding) ? +opts.padding : ISO_VIEW.padding;

  const target = {
    x: ((minx + maxx) / 2) * S,
    y: (Math.max(0, roomH) / 2) * S,
    z: (-(miny + maxy) / 2) * S,
  };

  // 相机视轴（目标 → 相机）与屏幕右轴 / 上轴
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const dir = { x: sp * Math.sin(theta), y: cp, z: sp * Math.cos(theta) };
  let right = {
    x: 1 * dir.z - 0 * dir.y,
    y: 0 * dir.x - 0 * dir.z,
    z: 0 * dir.y - 1 * dir.x,
  };
  let rl = Math.hypot(right.x, right.y, right.z);
  if (!(rl > 1e-9)) {
    right = { x: 1, y: 0, z: 0 };
    rl = 1;
  }
  right = { x: right.x / rl, y: right.y / rl, z: right.z / rl };
  const up = {
    x: dir.y * right.z - dir.z * right.y,
    y: dir.z * right.x - dir.x * right.z,
    z: dir.x * right.y - dir.y * right.x,
  };

  const ex = (Math.max(0, maxx - minx) / 2) * S;
  const ey = (Math.max(0, roomH) / 2) * S;
  const ez = (Math.max(0, maxy - miny) / 2) * S;
  let halfX = 0;
  let halfY = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = sx * ex;
        const py = sy * ey;
        const pz = sz * ez;
        halfX = Math.max(halfX, Math.abs(px * right.x + py * right.y + pz * right.z));
        halfY = Math.max(halfY, Math.abs(px * up.x + py * up.y + pz * up.z));
      }
    }
  }

  const tan = Math.max(1e-6, Math.tan((fov * Math.PI) / 360));
  const visible = Math.max(halfY * 2, (halfX * 2) / aspect, 0.1) * padding;
  return {
    target,
    r: Math.max(3, visible / (2 * tan)),
    theta,
    phi,
    visible,
    corner,
  };
}

/** 正交立面取景：8 角点投影到屏幕轴，宽房间也能完整落入视口 */
export function elevationViewPose(bounds, opts = {}) {
  const src = boundsInput(bounds);
  const b = src.bounds;
  const minx = Number.isFinite(b.minx) ? +b.minx : 0;
  const maxx = Number.isFinite(b.maxx) ? +b.maxx : minx;
  const miny = Number.isFinite(b.miny) ? +b.miny : 0;
  const maxy = Number.isFinite(b.maxy) ? +b.maxy : miny;
  const side = elevationId(opts.side) || 'front';
  const roomHRaw = Number.isFinite(opts.roomH) ? +opts.roomH : +src.roomH;
  const roomH = Number.isFinite(roomHRaw) && roomHRaw > 0 ? roomHRaw : 3000;
  const aspect = Number.isFinite(opts.aspect) && opts.aspect > 0 ? +opts.aspect : 1;
  const fov = Number.isFinite(opts.fov) ? +opts.fov : 45;
  const padding = Number.isFinite(opts.padding) ? +opts.padding : ELEVATION_VIEW.padding;
  const theta = ELEVATION_VIEW.sides[side].theta;
  const phi = clamp(
    Number.isFinite(opts.phi) ? +opts.phi : ELEVATION_VIEW.phi,
    ELEVATION_VIEW.tilt,
    Math.PI / 2 - ELEVATION_VIEW.tilt,
  );

  const target = {
    x: ((minx + maxx) / 2) * S,
    y: (Math.max(0, roomH) / 2) * S,
    z: (-(miny + maxy) / 2) * S,
  };

  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const dir = [sp * Math.sin(theta), cp, sp * Math.cos(theta)];
  let right = [dir[2], 0, -dir[0]];
  let rl = Math.hypot(right[0], right[1], right[2]);
  if (!(rl > 1e-9)) {
    right = [1, 0, 0];
    rl = 1;
  }
  right = right.map(v => v / rl);
  const up = [
    dir[1] * right[2] - dir[2] * right[1],
    dir[2] * right[0] - dir[0] * right[2],
    dir[0] * right[1] - dir[1] * right[0],
  ];

  const ex = (Math.max(0, maxx - minx) / 2) * S;
  const ey = (Math.max(0, roomH) / 2) * S;
  const ez = (Math.max(0, maxy - miny) / 2) * S;
  let halfX = 0;
  let halfY = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = sx * ex;
        const py = sy * ey;
        const pz = sz * ez;
        halfX = Math.max(halfX, Math.abs(px * right[0] + py * right[1] + pz * right[2]));
        halfY = Math.max(halfY, Math.abs(px * up[0] + py * up[1] + pz * up[2]));
      }
    }
  }

  const tan = Math.max(1e-6, Math.tan((fov * Math.PI) / 360));
  const visible = Math.max(halfY * 2, (halfX * 2) / aspect, 0.1) * padding;
  return {
    side,
    target,
    r: Math.max(3, visible / (2 * tan)),
    theta,
    phi,
    visible,
  };
}

/** 2D 对象外轮廓半尺寸（mm）：旋转后的轴对齐包围盒 */
function footprint2(o) {
  const p = (o && o.props) || {};
  const w = Math.abs(+p.w) || 600;
  const d = Math.abs(+p.d) || 600;
  const a = ((+o.rotation || 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return { hx: (w * c + d * s) / 2, hy: (w * s + d * c) / 2 };
}

const vpScene = (x, y, height = 0) => ({ x: x * S, y: height, z: -y * S });
const round3 = v => +v.toFixed(3);
const round4 = v => +v.toFixed(4);

/**
 * 房间平面框架（项目 mm）：优先墙体，其次有坐标的对象外轮廓，再次传入 bounds，最后兜底。
 * 同时给出结构层高 roomH（调用方 > meta.roomHeight > 最高墙 > 3000）。
 */
export function projectFrame(project, bounds, roomH) {
  const objs = project && Array.isArray(project.objects) ? project.objects : [];
  const box = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  const ext = (x, y) => {
    if (!Number.isFinite(+x) || !Number.isFinite(+y)) return;
    box.minx = Math.min(box.minx, +x);
    box.miny = Math.min(box.miny, +y);
    box.maxx = Math.max(box.maxx, +x);
    box.maxy = Math.max(box.maxy, +y);
  };

  let source = 'walls';
  for (const o of objs) {
    if (!o || o.type !== 'wall') continue;
    ext(o.x1, o.y1);
    ext(o.x2, o.y2);
  }
  if (!Number.isFinite(box.minx)) {
    source = 'objects';
    for (const o of objs) {
      if (!o || !Number.isFinite(+o.x) || !Number.isFinite(+o.y)) continue;
      const f = footprint2(o);
      ext(+o.x - f.hx, +o.y - f.hy);
      ext(+o.x + f.hx, +o.y + f.hy);
    }
  }
  if (!Number.isFinite(box.minx)) {
    source = 'bounds';
    if (bounds) {
      ext(bounds.minx, bounds.miny);
      ext(bounds.maxx, bounds.maxy);
    }
  }
  if (!Number.isFinite(box.minx)) {
    source = 'fallback';
    box.minx = -4000;
    box.miny = -3000;
    box.maxx = 4000;
    box.maxy = 3000;
  }

  let H = Number.isFinite(+roomH) && +roomH > 0 ? +roomH : 0;
  if (!H && project && project.meta && Number.isFinite(+project.meta.roomHeight)) {
    H = +project.meta.roomHeight;
  }
  if (!H) {
    const hs = objs
      .filter(o => o && o.type === 'wall')
      .map(o => +((o.props && o.props.height) || 0))
      .filter(v => v > 0);
    H = hs.length ? Math.max(...hs) : 3000;
  }

  return {
    minx: box.minx,
    miny: box.miny,
    maxx: box.maxx,
    maxy: box.maxy,
    cx: (box.minx + box.maxx) / 2,
    cy: (box.miny + box.maxy) / 2,
    W: Math.max(0, box.maxx - box.minx),
    D: Math.max(0, box.maxy - box.miny),
    roomH: H,
    source,
  };
}

/** 二维点夹在房间内（离墙内表面留 inset mm） */
function clampPoint2D(p, frame, inset = VIEWPOINT.wallInset) {
  const ix = Math.min(inset, Math.max(0, frame.W / 2 - 1));
  const iy = Math.min(inset, Math.max(0, frame.D / 2 - 1));
  return {
    x: clampNum(p.x, frame.minx + ix, frame.maxx - ix),
    y: clampNum(p.y, frame.miny + iy, frame.maxy - iy),
  };
}

/** 由「目标点 + 相机点」反解轨道位姿（场景米） */
function poseFromCamera(target, cam) {
  const dx = cam.x - target.x;
  const dy = cam.y - target.y;
  const dz = cam.z - target.z;
  const len = Math.hypot(dx, dy, dz);
  const r = len > 1e-4 ? len : 3;
  let theta = Math.atan2(dx, dz);
  if (!Number.isFinite(theta)) theta = 0;
  let phi = Math.acos(clampNum(dy / r, -1, 1));
  if (!Number.isFinite(phi)) phi = Math.PI / 2;
  return { target: { x: target.x, y: target.y, z: target.z }, r, theta, phi };
}

/** 轨道位姿 → 相机世界坐标（去重/自检用） */
function cameraOfViewpoint(v) {
  const sp = Math.sin(v.phi);
  return {
    x: v.target.x + v.r * sp * Math.sin(v.theta),
    y: v.target.y + v.r * Math.cos(v.phi),
    z: v.target.z + v.r * sp * Math.cos(v.theta),
  };
}

/** 两个视点是否近到可以合并：目标近 + 相机朝向近 + 距离量级相近 */
function isDuplicateViewpoint(a, b, cfg) {
  if (!a || !b) return false;
  const dt = Math.hypot(a.target.x - b.target.x, a.target.y - b.target.y, a.target.z - b.target.z);
  if (dt > cfg.dedupeTarget) return false;
  const ac = cameraOfViewpoint(a);
  const bc = cameraOfViewpoint(b);
  const ad = { x: ac.x - a.target.x, y: ac.y - a.target.y, z: ac.z - a.target.z };
  const bd = { x: bc.x - b.target.x, y: bc.y - b.target.y, z: bc.z - b.target.z };
  const la = Math.hypot(ad.x, ad.y, ad.z) || 1;
  const lb = Math.hypot(bd.x, bd.y, bd.z) || 1;
  const dot = (ad.x * bd.x + ad.y * bd.y + ad.z * bd.z) / (la * lb);
  if (dot < Math.cos(cfg.dedupeAngle)) return false;
  return Math.abs(a.r - b.r) <= Math.max(1.5, 0.25 * Math.max(a.r, b.r));
}

/** 墙体朝向可读名（门洞提示用）：南墙 / 北墙 / 西墙 / 东墙 */
function wallSideLabel(w, frame) {
  const dx = Math.abs(w.x2 - w.x1);
  const dy = Math.abs(w.y2 - w.y1);
  const mx = (w.x1 + w.x2) / 2;
  const my = (w.y1 + w.y2) / 2;
  if (dx >= dy) return my <= frame.cy ? '南墙' : '北墙';
  return mx <= frame.cx ? '西墙' : '东墙';
}

/** 入口视点：门内侧人眼高度看向房间中心；无门时退到房间西南角 */
function makeEntryViewpoint(project, frame) {
  const objs = (project && project.objects) || [];
  const walls = new Map(objs.filter(o => o && o.type === 'wall').map(o => [o.id, o]));
  const door = objs.find(o => o && o.type === 'door' && walls.has(o.wallId));
  let cam2;
  let hint;

  if (door) {
    const w = walls.get(door.wallId);
    const t = clampNum(Number.isFinite(+door.t) ? +door.t : 0, 0, 1);
    const px = +w.x1 + (+w.x2 - +w.x1) * t;
    const py = +w.y1 + (+w.y2 - +w.y1) * t;
    let dx = frame.cx - px;
    let dy = frame.cy - py;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    cam2 = { x: px + dx * VIEWPOINT.entryInset, y: py + dy * VIEWPOINT.entryInset };
    hint = wallSideLabel(w, frame) + '机房门内侧 · 望向全场';
  } else {
    cam2 = { x: frame.minx + VIEWPOINT.entryInset, y: frame.miny + VIEWPOINT.entryInset };
    hint = '无门 · 房间西南角 · 望向全场';
  }

  cam2 = clampPoint2D(cam2, frame, Math.min(VIEWPOINT.wallInset, 500));
  // 目标取胸口以下高度：远距离时视线仍接近水平，phi 不超过透视极角上限
  const target = vpScene(frame.cx, frame.cy, 0.7);
  const cam = vpScene(cam2.x, cam2.y, VIEWPOINT.entryEye);
  return {
    id: 'entry', kind: 'entry', label: '入口', hint,
    mode: 'perspective', ...poseFromCamera(target, cam),
  };
}

/** 四角轨道视点：与默认取景同一套 3/4 俯视数学，方位角固定在四个角 */
function makeCornerViewpoints(frame) {
  const target = vpScene(frame.cx, frame.cy, frame.roomH * S * 0.32);
  const diag = Math.hypot(frame.W * S, frame.D * S, frame.roomH * S);
  const r = Math.max(3, diag * VIEWPOINT.cornerPadding);
  return VP_CORNERS.map(c => ({
    id: 'corner-' + c.key, kind: 'corner', label: c.label,
    hint: '轨道视角 · 3/4 俯视', mode: 'perspective',
    target: { ...target }, r, theta: c.theta, phi: VIEWPOINT.cornerPhi,
  }));
}

/** 通道所在相邻两排（把「冷通道-1」这类重复名称变成「A/B 排通道」） */
function adjacentRowKeys(rows, seed, f) {
  if (!rows || !rows.length) return [];
  const tol = 400;
  if (seed.axis === 'y') {
    const west = rows
      .filter(r => r.bbox.maxx <= seed.cx - f.hx + tol)
      .sort((a, b) => b.bbox.maxx - a.bbox.maxx)[0];
    const east = rows
      .filter(r => r.bbox.minx >= seed.cx + f.hx - tol)
      .sort((a, b) => a.bbox.minx - b.bbox.minx)[0];
    return [west, east].filter(Boolean).map(r => r.key);
  }
  const south = rows
    .filter(r => r.bbox.maxy <= seed.cy - f.hy + tol)
    .sort((a, b) => b.bbox.maxy - a.bbox.maxy)[0];
  const north = rows
    .filter(r => r.bbox.miny >= seed.cy + f.hy - tol)
    .sort((a, b) => a.bbox.miny - b.bbox.miny)[0];
  return [south, north].filter(Boolean).map(r => r.key);
}

/** 物理 aisle 对象 → 通道种子；无 aisle 时用相邻机柜排净空反推 */
function collectAisleSeeds(project, frame, rows) {
  const objs = (project && project.objects) || [];
  const seeds = [];
  for (const o of objs) {
    if (!o || o.type !== 'aisle' || !Number.isFinite(+o.x) || !Number.isFinite(+o.y)) continue;
    const f = footprint2(o);
    const axis = f.hx >= f.hy ? 'x' : 'y';
    const half = axis === 'x' ? f.hx : f.hy;
    if (!(half > 0)) continue;
    const seed = {
      cx: +o.x, cy: +o.y, axis, half,
      name: String((o.props && o.props.name) || '').trim(), rows: [],
    };
    seed.rows = adjacentRowKeys(rows, seed, f);
    seeds.push(seed);
  }

  if (!seeds.length) {
    for (const axis of ['x', 'y']) {
      const list = (rows || []).filter(r => r.axis === axis);
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => (axis === 'x'
        ? a.bbox.miny - b.bbox.miny
        : a.bbox.minx - b.bbox.minx));
      for (let i = 0; i + 1 < sorted.length; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        const gap = axis === 'x' ? b.bbox.miny - a.bbox.maxy : b.bbox.minx - a.bbox.maxx;
        if (!(gap >= 1000 && gap <= 6000)) continue;
        const half = axis === 'x'
          ? Math.max(a.bbox.maxx - a.bbox.minx, b.bbox.maxx - b.bbox.minx) / 2
          : Math.max(a.bbox.maxy - a.bbox.miny, b.bbox.maxy - b.bbox.miny) / 2;
        if (!(half > 0)) continue;
        seeds.push({
          cx: axis === 'x'
            ? (a.bbox.minx + a.bbox.maxx + b.bbox.minx + b.bbox.maxx) / 4
            : (a.bbox.maxx + b.bbox.minx) / 2,
          cy: axis === 'x'
            ? (a.bbox.maxy + b.bbox.miny) / 2
            : (a.bbox.miny + a.bbox.maxy + b.bbox.miny + b.bbox.maxy) / 4,
          axis, half, name: '', rows: [a.key, b.key],
        });
      }
    }
  }

  seeds.sort((a, b) => (a.axis === b.axis
    ? (a.axis === 'y' ? a.cx - b.cx : a.cy - b.cy)
    : a.axis.localeCompare(b.axis)));
  return seeds;
}

/** 通道两端视点：相机退到端头外，目标在通道中心，视线沿通道方向 */
function makeAisleViewpoints(project, frame, rows, cfg) {
  const seeds = collectAisleSeeds(project, frame, rows);
  if (!seeds.length || cfg.maxAisleViews <= 0) return [];
  const out = [];

  const push = (seed, index, sign) => {
    const end = seed.axis === 'y'
      ? (sign < 0 ? { key: 's', label: '南端' } : { key: 'n', label: '北端' })
      : (sign < 0 ? { key: 'w', label: '西端' } : { key: 'e', label: '东端' });
    const dx = seed.axis === 'x' ? sign : 0;
    const dy = seed.axis === 'y' ? sign : 0;
    let cam2 = {
      x: seed.cx + dx * (seed.half + VIEWPOINT.aisleMargin),
      y: seed.cy + dy * (seed.half + VIEWPOINT.aisleMargin),
    };
    cam2 = clampPoint2D(cam2, frame);
    const base = seed.rows.length >= 2
      ? `${seed.rows[0]}/${seed.rows[1]} 排通道`
      : seed.rows.length === 1 ? `${seed.rows[0]} 排通道` : (seed.name || '机柜通道');
    const target = vpScene(seed.cx, seed.cy, 1.0);
    const cam = vpScene(cam2.x, cam2.y, VIEWPOINT.entryEye);
    out.push({
      id: `aisle-${index}-${end.key}`, kind: 'aisle', label: `${base} · ${end.label}`,
      hint: seed.axis === 'y' ? '沿通道南北方向看机柜排' : '沿通道东西方向看机柜排',
      mode: 'perspective', ...poseFromCamera(target, cam),
    });
  };

  if (seeds.length === 1) {
    push(seeds[0], 0, -1);
    push(seeds[0], 0, 1);
    return out.slice(0, cfg.maxAisleViews);
  }

  push(seeds[0], 0, -1);
  push(seeds[0], 0, 1);
  if (cfg.maxAisleViews > 2) push(seeds[seeds.length - 1], seeds.length - 1, -1);
  return out.slice(0, cfg.maxAisleViews);
}

/** 设备区质心（mm） */
function centroidOf(objs) {
  const list = objs.filter(o => o && Number.isFinite(+o.x) && Number.isFinite(+o.y));
  if (!list.length) return null;
  return {
    x: list.reduce((s, o) => s + +o.x, 0) / list.length,
    y: list.reduce((s, o) => s + +o.y, 0) / list.length,
  };
}

/** 设备区视点：从机房中心一侧看向设备区质心，相机略高于机柜中部 */
function makeAreaViewpoints(project, frame) {
  const objs = (project && project.objects) || [];
  const pick = type => objs.filter(o => o && o.type === type);
  const ups = pick('ups');
  const bat = pick('battery');
  const ac = pick('ac');
  const pdu = pick('pdu');
  const ext = pick('extinguisher');
  const groups = [];

  const add = (id, label, list, priority, extra = '') => {
    if (!list.length) return;
    groups.push({
      id, label, priority,
      hint: `${list.length} 台${extra ? ' · ' + extra : ''}`,
      center: centroidOf(list),
    });
  };
  const upsC = centroidOf(ups);
  const batC = centroidOf(bat);
  const combined = ups.length && bat.length && upsC && batC
    && Math.hypot(upsC.x - batC.x, upsC.y - batC.y) <= 8000;
  if (combined) {
    groups.push({
      id: 'area-ups', label: 'UPS/电池区', priority: 0,
      hint: `${ups.length + bat.length} 台设备 · UPS ${ups.length} · 电池 ${bat.length}`,
      center: centroidOf([...ups, ...bat]),
    });
  } else {
    add('area-ups', 'UPS 区', ups, 0, 'UPS');
    add('area-battery', '电池区', bat, 0, '电池');
  }
  add('area-ac', '空调区', ac, 1, '精密空调');
  add('area-pdu', '列头柜区', pdu, 2, '列头柜');
  add('area-ext', '灭火器区', ext, 3, '灭火器');
  groups.sort((a, b) => a.priority - b.priority);

  const camH = Math.min(VIEWPOINT.areaCamMaxH, Math.max(VIEWPOINT.areaCamH, frame.roomH * S * 0.65));
  return groups.filter(g => g.center).map(g => {
    const ax = g.center.x;
    const ay = g.center.y;
    let dx = frame.cx - ax;
    let dy = frame.cy - ay;
    let l = Math.hypot(dx, dy);
    if (l < 1e-6) {
      dx = 1;
      dy = -1;
      l = Math.SQRT2;
    }
    dx /= l;
    dy /= l;
    const d = Math.max(3000, l);
    let cam2 = { x: ax + dx * d, y: ay + dy * d };
    cam2 = clampPoint2D(cam2, frame);
    const target = vpScene(ax, ay, VIEWPOINT.areaEye);
    const cam = vpScene(cam2.x, cam2.y, camH);
    return {
      id: g.id, kind: 'area', label: g.label, hint: g.hint,
      mode: 'perspective', ...poseFromCamera(target, cam),
    };
  });
}

/** 俯视 / 轴测：业务视点不足下限时补足（空机房也能有一组可用观察点） */
function makePresetViewpoints(frame) {
  const aspect = 16 / 9;
  const fov = 45;
  const top = topViewPose(frame, { aspect, fov, padding: TOP_VIEW.padding });
  const iso = isoViewPose(frame, {
    roomH: frame.roomH, corner: ISO_VIEW.defaultCorner, aspect, fov, padding: ISO_VIEW.padding,
  });
  return [
    {
      id: 'view-top', kind: 'preset', preset: 'top', mode: 'ortho',
      label: '俯视平面', hint: '正交 · 北朝上',
      target: { ...top.target }, r: top.r, theta: top.theta, phi: top.phi,
    },
    {
      id: 'view-iso', kind: 'preset', preset: 'iso', mode: 'ortho',
      label: '轴测总览', hint: '正交 · 平行投影',
      target: { ...iso.target }, r: iso.r, theta: iso.theta, phi: iso.phi,
    },
  ];
}

/**
 * 派生业务视点：入口 / 四角 / 通道两端 / 设备区，不足 6 个时补俯视 / 轴测。
 * 输出统一为场景米制轨道位姿，可直接喂给 Camera3D / Orbit3D。
 * 任何空数据 / 缺门 / 缺机柜都返回可用退化结果，不抛错。
 */
export function listViewpoints(project, bounds, opts = {}) {
  const cfg = { ...VIEWPOINT, ...(opts || {}) };
  const frame = projectFrame(project, bounds, cfg.roomH);
  const rows = deriveRows(project);
  const picked = [];

  picked.push(makeEntryViewpoint(project, frame));
  for (const v of makeCornerViewpoints(frame)) picked.push(v);
  for (const v of makeAisleViewpoints(project, frame, rows, cfg)) picked.push(v);
  for (const v of makeAreaViewpoints(project, frame)) picked.push(v);

  const unique = [];
  for (const v of picked) {
    if (!v) continue;
    if (unique.some(u => isDuplicateViewpoint(u, v, cfg))) continue;
    unique.push(v);
  }

  if (unique.length < cfg.min) {
    for (const v of makePresetViewpoints(frame)) {
      if (!unique.some(u => isDuplicateViewpoint(u, v, cfg))) unique.push(v);
    }
  }

  const out = unique.slice(0, cfg.max);

  // 名称去重：同一区域有多个入口时追加（2）（3）
  const used = new Map();
  for (const v of out) {
    const base = v.label || '视点';
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    v.label = n > 1 ? `${base}（${n}）` : base;
  }
  return out;
}

/** 视点自检摘要（info() 用）：只暴露测试需要的字段并适度取整 */
export function summarizeViewpoints(list) {
  const views = Array.isArray(list) ? list : [];
  const kinds = {};
  for (const v of views) kinds[v.kind] = (kinds[v.kind] || 0) + 1;
  return {
    count: views.length,
    min: VIEWPOINT.min,
    max: VIEWPOINT.max,
    kinds,
    items: views.map(v => ({
      id: v.id, kind: v.kind, label: v.label, hint: v.hint, mode: v.mode,
      preset: v.preset || null,
      target: { x: round3(v.target.x), y: round3(v.target.y), z: round3(v.target.z) },
      r: round3(v.r), theta: round4(v.theta), phi: round4(v.phi),
    })),
  };
}
