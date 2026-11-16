/**
 * 爆炸视图位移规划（纯几何，无 three / DOM 依赖，可在 Node 单测）。
 *
 * 以机房墙体包围盒中心为「爆心」：所有对象按离爆心的水平距离同比外扩（spread），
 * 再按类型叠加上下分层——地板 / 地板风口下沉，吊顶 / 框架梁 / 桥架 / 设备层抬升。
 * 同一套比例作用于所有对象，爆炸后机柜排、墙面的相对次序仍保持，不会交叉穿模。
 *
 * 两个档位共用同一套规划，只改参数：
 *   · presentation 演示档（默认）：大幅位移，讲解整体结构；
 *   · review 评审档：平面外扩 ×1.25、垂直分层 0.6–2.6m，构件仍聚在一起。
 *
 * 输出偏移单位为米；坐标轴与场景一致：x 向东、y 向上、z 向南（项目 y 越大 → z 越负）。
 */
import { beamEnds } from '../data/sanitize.js';
import { roomCenter } from './wallcut.js';

const S = 0.001; // mm → m

/** 爆炸/拼装基础参数（时长与分层距离；相机拉远由 viewer 负责） */
export const EXPLODE = Object.freeze({
  spread: 3.0,
  stagger: 0.35,
  explodeSec: 1.5,
  assembleSec: 1.9,
  floorDrop: 9.0,
  floorDropRatio: 5.0,
  ceilingLift: 15.0,
  ceilingLiftRatio: 3.0,
  beamLift: 10.0,
  beamLiftRatio: 1.2,
  trayLift: 5.5,
  trayLiftRatio: 0.8,
  equipLift: 2.8,
  equipLiftRatio: 0.3,
});

/**
 * 爆炸档位：只改位移参数，动画/几何/状态机完全共用。
 * dolly 是爆炸时相机拉远倍率；评审档位移小，镜头也更克制。
 */
export const EXPLODE_PROFILES = Object.freeze({
  presentation: Object.freeze({
    id: 'presentation', label: '演示档', hint: '大幅外扩 · 分层夸张',
    spread: EXPLODE.spread, dolly: 3.2,
    floorDrop: EXPLODE.floorDrop, floorDropRatio: EXPLODE.floorDropRatio,
    ceilingLift: EXPLODE.ceilingLift, ceilingLiftRatio: EXPLODE.ceilingLiftRatio,
    beamLift: EXPLODE.beamLift, beamLiftRatio: EXPLODE.beamLiftRatio,
    trayLift: EXPLODE.trayLift, trayLiftRatio: EXPLODE.trayLiftRatio,
    equipLift: EXPLODE.equipLift, equipLiftRatio: EXPLODE.equipLiftRatio,
  }),
  review: Object.freeze({
    id: 'review', label: '评审档', hint: '小幅外扩 · 构件可辨',
    spread: 1.25, dolly: 1.65,
    floorDrop: 0.6, floorDropRatio: 0,
    ceilingLift: 2.6, ceilingLiftRatio: 0,
    beamLift: 1.9, beamLiftRatio: 0,
    trayLift: 1.4, trayLiftRatio: 0,
    equipLift: 0.9, equipLiftRatio: 0,
  }),
});

export const DEFAULT_EXPLODE_PROFILE = 'presentation';

const PROFILE_ALIASES = Object.freeze({
  presentation: 'presentation', demo: 'presentation', show: 'presentation', default: 'presentation',
  review: 'review', small: 'review',
});

/** 档位归一化：presentation / demo / review / small；空与非法返回 null */
export function normalizeExplodeProfile(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return PROFILE_ALIASES[s] || null;
}

/** 取档位参数；非法/缺省回退演示档 */
export function explodeProfile(name) {
  return EXPLODE_PROFILES[normalizeExplodeProfile(name) || DEFAULT_EXPLODE_PROFILE];
}

/** 参与爆炸的对象类型（门窗/格栅依附墙体，随墙移动，不单独规划） */
const MOVABLE = new Set([
  'wall', 'column', 'beam', 'cabinet', 'pdu', 'ac', 'ups', 'battery',
  'extinguisher', 'vent', 'tray', 'aisle',
]);

/** 设备层：整体抬升，与下沉的地板、上方的桥架/梁/吊顶拉开层次 */
const EQUIPMENT = new Set([
  'cabinet', 'pdu', 'ac', 'ups', 'battery', 'extinguisher', 'aisle',
]);

const num = v => {
  const n = +v;
  return Number.isFinite(n) ? n : 0;
};

/** 结构层高（mm）：调用方 > meta.roomHeight > 最高墙 > 3000 */
function roomHeightOf(walls, meta) {
  const wallHs = walls.map(w => num(w.props && w.props.height));
  return num(meta.roomHeight) || Math.max(3000, ...wallHs);
}

/** 无墙体时的备用爆心：对象锚点 / 线段端点的包围盒中心 */
function fallbackCenter(objs) {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  const ext = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minx = Math.min(minx, x);
    maxx = Math.max(maxx, x);
    miny = Math.min(miny, y);
    maxy = Math.max(maxy, y);
  };
  for (const o of objs) {
    if (o.type === 'wall' || o.type === 'tray' || o.type === 'beam') {
      ext(num(o.x1), num(o.y1));
      ext(num(o.x2), num(o.y2));
    } else if (o.x !== undefined) {
      ext(num(o.x), num(o.y));
    }
  }
  if (!(maxx >= minx) || !(maxy >= miny)) return { x: 0, y: 0 };
  return { x: (minx + maxx) / 2, y: (miny + maxy) / 2 };
}

/**
 * 生成爆炸位移计划。
 *
 * @param {{objects?:Array, meta?:object}} project 项目数据（只读）
 * @param {{spread?:number, profile?:string}} [opts]
 *        profile：presentation（默认）/ review；spread：覆盖平面外扩比例
 * @returns {{
 *   profile:string, dolly:number,
 *   center:{x:number,y:number}, roomH:number, floorH:number, ceilH:number,
 *   maxDist:number,
 *   items:Array<{id:string,type:string,dx:number,dy:number,dz:number,rank:number}>
 * }} 偏移单位米；rank 0~1 用于错峰
 */
export function explodePlan(project, opts = {}) {
  const objs = project && Array.isArray(project.objects) ? project.objects : [];
  const meta = (project && project.meta) || {};
  const walls = objs.filter(o => o && o.type === 'wall');
  const center = roomCenter(walls) || fallbackCenter(objs);

  const roomH = roomHeightOf(walls, meta);
  const floorH = Math.max(0, num(meta.floorHeight ?? 400));
  const rawCeilH = num(meta.ceilHeight);
  const hasCeil = rawCeilH > 0 && rawCeilH < roomH;
  const ceilH = hasCeil ? rawCeilH : 0;

  const profile = explodeProfile(opts.profile);
  const spread = Number.isFinite(+opts.spread) ? +opts.spread : profile.spread;
  const floorDrop = profile.floorDrop + floorH * S * profile.floorDropRatio;
  const ceilingLift = profile.ceilingLift + roomH * S * profile.ceilingLiftRatio;
  const beamLift = profile.beamLift + roomH * S * profile.beamLiftRatio;
  const trayLift = profile.trayLift + roomH * S * profile.trayLiftRatio;
  const equipLift = profile.equipLift + roomH * S * profile.equipLiftRatio;

  const items = [];
  const dists = new Map();
  const add = (id, type, x, y, dy, radial = true) => {
    const ddx = x - center.x;
    const ddy = y - center.y;
    const dist = radial ? Math.hypot(ddx, ddy) : 0;
    items.push({
      id, type,
      dx: radial ? ddx * S * spread : 0,
      dy,
      dz: radial ? -ddy * S * spread : 0,
      rank: 0,
    });
    dists.set(id, dist);
  };

  // 地板 / 吊顶：整块面，不参与平面外扩，只做上下分层
  add('__floor', 'floor', center.x, center.y, -floorDrop, false);
  if (hasCeil) add('__ceiling', 'ceiling', center.x, center.y, ceilingLift, false);

  const get = id => objs.find(q => q && q.id === id) || null;
  for (const o of objs) {
    if (!o || !MOVABLE.has(o.type)) continue;
    let x;
    let y;
    if (o.type === 'wall' || o.type === 'tray') {
      x = (num(o.x1) + num(o.x2)) / 2;
      y = (num(o.y1) + num(o.y2)) / 2;
    } else if (o.type === 'beam') {
      const e = beamEnds(o, get);
      x = (num(e.x1) + num(e.x2)) / 2;
      y = (num(e.y1) + num(e.y2)) / 2;
    } else {
      if (o.x === undefined || o.y === undefined) continue;
      x = num(o.x);
      y = num(o.y);
    }

    let dy = 0;
    let radial = true;
    if (o.type === 'vent') {
      dy = -floorDrop; // 风口嵌在地板上：跟地板一起下沉
      radial = false; // 不单独外扩，保持与板面的相对位置
    } else if (o.type === 'beam') dy = beamLift;
    else if (o.type === 'tray') dy = trayLift;
    else if (EQUIPMENT.has(o.type)) dy = equipLift;

    add(o.id, o.type, x, y, dy, radial);
  }

  let maxDist = 0;
  for (const it of items) maxDist = Math.max(maxDist, dists.get(it.id) || 0);
  if (maxDist < 1) maxDist = 1;
  for (const it of items) {
    const d = dists.get(it.id) || 0;
    it.rank = Math.min(1, Math.max(0, d / maxDist));
  }

  return {
    profile: profile.id,
    dolly: profile.dolly,
    center, roomH, floorH, ceilH, maxDist, items,
  };
}
