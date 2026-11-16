/**
 * 剖切与过滤纯规则（高度 / 侧别 / 真裁剪 / 盒体）。
 *
 * 本模块不依赖 DOM 与 three，可被 Node 直接单测；渲染层只消费这里算出的
 * 平面、包围盒与可见性计划：
 *   · 高度过滤（对象级）：只作用于吊顶 / 桥架 / 梁，顶面高于切面才整组隐藏；
 *   · 侧别过滤（对象级）：按对象包围盒中心判边，跨切面的对象完整保留；
 *   · 真裁剪（片元级）：输出 ClippingGroup 用的平面，不做封口；
 *   · 盒体剖切（对象级）：保留 x ≤ box.x、y ≥ box.z、竖向 ≤ box.h 的区域。
 *
 * 项目坐标单位为毫米（x 东 / y 北 / 竖向由各对象 props 给出）；Three 场景的
 * 换算是 x→x、项目 y→-z、竖向→y，平面换算见 clipScenePlane。
 */

const num = v => {
  const n = +v;
  return Number.isFinite(n) ? n : 0;
};
/** 正数取原值，其余回退默认值（尺寸类字段的通用规则） */
const pos = (v, d) => {
  const n = num(v);
  return n > 0 ? n : d;
};

/* ---------------- 盒体剖切参数 ---------------- */

/** 盒体预设与滑块约定；corner 按默认相机（东南上方）定义近角 */
export const BOX = Object.freeze({
  presets: Object.freeze([
    Object.freeze({
      id: 'corner', label: '前角剖开', hint: '切掉东南近角，保留西北侧', ico: '◱',
    }),
    Object.freeze({
      id: 'top', label: '顶剖', hint: '切掉吊顶以上，保留室内', ico: '⌃',
    }),
    Object.freeze({
      id: 'half', label: '半剖', hint: '沿东西中线切掉东半间', ico: '◧',
    }),
  ]),
  ids: Object.freeze(['corner', 'top', 'half']),
  defaultPreset: 'corner',
  stepMm: 100,
  epsMm: 1,
  maxMm: 50000,
  axes: Object.freeze(['x', 'z', 'h']),
});

/** 高度过滤参数与预设（顺序即 UI 顺序） */
export const SECTION = Object.freeze({
  modes: Object.freeze(['off', 'height', 'side', 'clip', 'box']),
  /** 盒体约定由 BOX 提供，避免两处漂移 */
  box: BOX,
  /** 默认参与高度过滤的类型：只动吊顶 / 桥架 / 梁，不碰设备 */
  types: Object.freeze(['ceiling', 'tray', 'beam']),
  presets: Object.freeze([
    { id: 'all', label: '全部显示', hint: '关闭对象级过滤', ico: '○' },
    { id: 'above-ceiling', label: '吊顶以上', hint: '隐藏顶面高于吊顶的构件', ico: '⌃' },
    { id: 'above-tray', label: '桥架以上', hint: '隐藏吊顶与梁，保留桥架', ico: '⌁' },
    { id: 'below-tray', label: '桥架以下', hint: '隐藏桥架及吊顶上方构件', ico: '⌄' },
  ]),
  slider: Object.freeze({ minMm: 600, stepMm: 100, fallbackMaxMm: 3600 }),
  epsMm: 1,
  maxCutMm: 50000,
});

/**
 * 真裁剪参数：ClippingGroup 平面逐片元切穿几何、不封口。
 * axis：y=水平（高度）/ x=东西 / z=南北（内部用项目 y）。
 * flip=false 保留坐标较大侧（以上 / 东 / 北），flip=true 保留较小侧。
 */
export const CLIP = Object.freeze({
  axes: Object.freeze(['y', 'x', 'z']),
  axisLabel: Object.freeze({ y: '水平', x: '东西 X', z: '南北 Z' }),
  axisShort: Object.freeze({ y: 'Y', x: 'X', z: 'Z' }),
  cutSide: Object.freeze({
    y: Object.freeze(['以下', '以上']),
    x: Object.freeze(['西侧', '东侧']),
    z: Object.freeze(['南侧', '北侧']),
  }),
  keepSide: Object.freeze({
    y: Object.freeze(['以上', '以下']),
    x: Object.freeze(['东侧', '西侧']),
    z: Object.freeze(['北侧', '南侧']),
  }),
  defaultPosMm: 1200,
  stepMm: 100,
  maxPosMm: 50000,
});

/** 侧别过滤参数：axis 用项目坐标命名（x=东西，z=南北） */
export const SIDE = Object.freeze({
  axes: Object.freeze(['x', 'z']),
  axisLabel: Object.freeze({ x: '东西 X', z: '南北 Z' }),
  axisShort: Object.freeze({ x: 'X', z: 'Z' }),
  /** flip=false 切掉坐标较小的一侧；flip=true 切掉坐标较大的一侧 */
  cutSide: Object.freeze({
    x: Object.freeze(['西侧', '东侧']),
    z: Object.freeze(['南侧', '北侧']),
  }),
  keepSide: Object.freeze({
    x: Object.freeze(['东侧', '西侧']),
    z: Object.freeze(['北侧', '南侧']),
  }),
  stepMm: 100,
  maxPosMm: 50000,
});

/* ---------------- 盒体剖切纯函数 ---------------- */

/** 预设是否合法 */
export function isBoxPreset(id) {
  return BOX.ids.includes(String(id || '').toLowerCase());
}

/** 预设元数据；未知预设返回 null */
export function boxPreset(id) {
  const key = String(id || '').toLowerCase();
  return BOX.presets.find(p => p.id === key) || null;
}

/** 预设显示名；custom / 未知安全降级 */
export function boxPresetLabel(id) {
  const p = boxPreset(id);
  return p ? p.label : '自定义';
}

/** 合法包围盒：四个有限数且 lo ≤ hi */
export function isBoxBounds(b) {
  return !!b && ['x0', 'x1', 'y0', 'y1'].every(k => Number.isFinite(+b[k]))
    && +b.x0 <= +b.x1 && +b.y0 <= +b.y1;
}

const FALLBACK_BOX_BOUNDS = Object.freeze({ x0: 0, x1: 12000, y0: 0, y1: 7000 });
const FALLBACK_HEIGHTS = Object.freeze({ roomH: 3000, ceilH: 3000, hasCeil: false });

const snapDown = (v, s) => Math.floor(num(v) / s) * s;
const snapUp = (v, s) => Math.ceil(num(v) / s) * s;
const snapNear = (v, s) => Math.round(num(v) / s) * s;

/**
 * 盒体单轴滑块范围（mm）。
 * @param {object|null} bounds 房间 / 围护包围盒 {x0,x1,y0,y1}
 * @param {object|null} heights sectionHeights() 结果
 * @param {'x'|'z'|'h'} axis
 * @returns {{min:number,max:number,step:number}}
 */
export function boxRangeFor(bounds, heights, axis = 'x') {
  const s = BOX.stepMm;
  const b = isBoxBounds(bounds) ? bounds : FALLBACK_BOX_BOUNDS;
  const h = heights || FALLBACK_HEIGHTS;
  if (axis === 'h') {
    const max = Math.min(BOX.maxMm, Math.max(s, snapUp(Math.max(0, num(h.roomH)), s)));
    return { min: 0, max, step: s };
  }
  if (axis === 'z') {
    const min = Math.max(-BOX.maxMm, snapDown(b.y0, s));
    const max = Math.min(BOX.maxMm, snapUp(b.y1, s));
    return { min, max: Math.max(min + s, max), step: s };
  }
  const min = Math.max(-BOX.maxMm, snapDown(b.x0, s));
  const max = Math.min(BOX.maxMm, snapUp(b.x1, s));
  return { min, max: Math.max(min + s, max), step: s };
}

/** 三个滑块的范围快照 */
export function boxRanges(bounds, heights) {
  return {
    x: boxRangeFor(bounds, heights, 'x'),
    z: boxRangeFor(bounds, heights, 'z'),
    h: boxRangeFor(bounds, heights, 'h'),
  };
}

/** 数值夹到 [min,max]；非法值回退 fallback */
function clampTo(v, range, fallback) {
  const n = Number.isFinite(+v) ? +v : fallback;
  return Math.max(range.min, Math.min(range.max, n));
}

/**
 * 预设默认盒体。
 * @param {object|null} bounds 房间 / 围护包围盒
 * @param {object|null} heights sectionHeights()
 * @param {'corner'|'top'|'half'} preset
 * @returns {{x:number,z:number,h:number,preset:string}}
 */
export function defaultBox(bounds, heights, preset = BOX.defaultPreset) {
  const id = isBoxPreset(preset) ? String(preset).toLowerCase() : BOX.defaultPreset;
  const b = isBoxBounds(bounds) ? bounds : FALLBACK_BOX_BOUNDS;
  const h = heights || FALLBACK_HEIGHTS;
  const ranges = boxRanges(b, h);
  const midX = snapNear((num(b.x0) + num(b.x1)) / 2, ranges.x.step);
  const midZ = snapNear((num(b.y0) + num(b.y1)) / 2, ranges.z.step);
  const base = { x: midX, z: midZ, h: ranges.h.max, preset: id };
  if (id === 'top') {
    const top = h.hasCeil ? num(h.ceilH) : num(h.roomH);
    return { x: ranges.x.max, z: ranges.z.min, h: Math.max(0, top - BOX.stepMm), preset: id };
  }
  if (id === 'half') return { x: midX, z: ranges.z.min, h: ranges.h.max, preset: id };
  return base;
}

/**
 * 归一化盒体：缺字段沿用当前值，非法值夹到滑块范围；坐标取整到毫米。
 * @param {object} box 目标值（可只传 x / z / h）
 * @param {object} current 当前盒体
 * @param {object|null} bounds
 * @param {object|null} heights
 */
export function normalizeBox(box, current, bounds, heights) {
  const ranges = boxRanges(bounds, heights);
  const cur = current || defaultBox(bounds, heights);
  const x = clampTo(box && box.x, ranges.x, cur.x);
  const z = clampTo(box && box.z, ranges.z, cur.z);
  const h = clampTo(box && box.h, ranges.h, cur.h);
  return {
    x: Math.round(x), z: Math.round(z), h: Math.round(h),
    preset: box && box.preset ? String(box.preset) : (cur.preset || 'custom'),
  };
}

/** 盒体文案：`X 6.00m · Z 3.50m · 高 2.80m` */
export function boxLabel(box) {
  const b = box || {};
  return 'X ' + (num(b.x) / 1000).toFixed(2) + 'm'
    + ' · Z ' + (num(b.z) / 1000).toFixed(2) + 'm'
    + ' · 高 ' + (num(b.h) / 1000).toFixed(2) + 'm';
}

/**
 * 对象是否完全在盒外（整对象隐藏）。eps 1mm，恰好压线视为保留。
 * @param {object|null} bounds 对象平面包围盒 {x0,x1,y0,y1}
 * @param {{x:number,z:number,h:number}} box
 * @param {{minY:number,maxY:number}|null} range 对象竖向范围（mm）
 */
export function hiddenByBox(bounds, box, range = null) {
  if (!isBoxBounds(bounds) || !box) return false;
  const xMax = num(box.x);
  const zMin = num(box.z);
  const hMax = num(box.h);
  const eps = BOX.epsMm;
  // 完全在东西切面以东（保留区以西侧为准）
  if (num(bounds.x0) > xMax + eps) return true;
  // 完全在南北切面以南（保留区以北侧为准）
  if (num(bounds.y1) < zMin - eps) return true;
  // 底面不低于顶切面：整个对象在盒体上方（恰好等高视为盒外，避免吊顶残留）
  if (range && Number.isFinite(+range.minY) && num(range.minY) >= hMax - eps) return true;
  return false;
}

/**
 * 盒体隐藏计划（纯规则）。
 * @param {Array<{id:string,type?:string,label?:string,bounds:object,minY?:number,maxY?:number}>} records
 * @param {{x:number,z:number,h:number}} box
 */
export function boxPlan(records, box) {
  const items = (records || []).filter(r => r && isBoxBounds(r.bounds)).map(r => {
    const bounds = {
      x0: +r.bounds.x0, x1: +r.bounds.x1,
      y0: +r.bounds.y0, y1: +r.bounds.y1,
    };
    const range = Number.isFinite(+r.minY)
      ? { minY: +r.minY, maxY: Number.isFinite(+r.maxY) ? +r.maxY : +r.minY }
      : null;
    return {
      id: r.id,
      type: r.type || 'object',
      label: r.label || r.id,
      bounds,
      minY: range ? range.minY : null,
      maxY: range ? range.maxY : null,
      hidden: hiddenByBox(bounds, box, range),
    };
  });
  const hidden = items.filter(i => i.hidden);
  const byType = {};
  for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;
  const hiddenTypes = {};
  for (const it of hidden) hiddenTypes[it.type] = (hiddenTypes[it.type] || 0) + 1;
  return { items, hidden, byType, hiddenTypes };
}

/**
 * 盒体与某个预设默认值是否一致（±2mm）；都不一致返回 custom。
 * @param {object} box
 * @param {object|null} bounds
 * @param {object|null} heights
 */
export function matchBoxPreset(box, bounds, heights) {
  if (!box) return 'custom';
  for (const id of BOX.ids) {
    const p = defaultBox(bounds, heights, id);
    if (Math.abs(num(box.x) - p.x) <= 2
      && Math.abs(num(box.z) - p.z) <= 2
      && Math.abs(num(box.h) - p.h) <= 2) return id;
  }
  return 'custom';
}

/* ---------------- 高度过滤 ---------------- */

/** 结构层高（mm）：与 builders 的取值规则一致 */
function roomHeightOf(objs, meta) {
  const wallHs = objs.filter(o => o && o.type === 'wall').map(o => num(o.props && o.props.height));
  return pos(meta.roomHeight, Math.max(3000, ...wallHs));
}

/**
 * 从项目数据派生过滤基准高度（mm）。
 * @param {{objects?:Array, meta?:object}} project
 * @returns {{roomH:number, ceilH:number, hasCeil:boolean, floorH:number,
 *            trayBottom:number|null, trayTop:number|null, beamTop:number|null}}
 */
export function sectionHeights(project) {
  const objs = (project && Array.isArray(project.objects)) ? project.objects : [];
  const meta = (project && project.meta) || {};
  const roomH = roomHeightOf(objs, meta);
  const rawCeil = num(meta.ceilHeight);
  const hasCeil = rawCeil > 0 && rawCeil < roomH;
  const ceilH = hasCeil ? rawCeil : roomH; // 无吊顶时按结构层高（吊顶以上 = 顶板以上）
  const floorH = Math.max(0, num(meta.floorHeight ?? 400));

  let trayBottom = null;
  let trayTop = null;
  for (const o of objs) {
    if (!o || o.type !== 'tray') continue;
    const p = o.props || {};
    const bottom = pos(p.height, 2500);
    const top = bottom + pos(p.bodyH, 100);
    trayBottom = trayBottom == null ? bottom : Math.min(trayBottom, bottom);
    trayTop = trayTop == null ? top : Math.max(trayTop, top);
  }

  let beamTop = null;
  for (const o of objs) {
    if (!o || o.type !== 'beam') continue;
    const p = o.props || {};
    const top = pos(p.top, 3000);
    beamTop = beamTop == null ? top : Math.max(beamTop, top);
  }

  return { roomH, ceilH, hasCeil, floorH, trayBottom, trayTop, beamTop };
}

/**
 * 预设对应的切面高度（mm）；all 返回 null。
 * 无桥架时桥架预设退化为吊顶面 / 吊顶下 100mm，保证不产生 NaN。
 * @param {string} id
 * @param {ReturnType<typeof sectionHeights>} heights
 */
export function presetCut(id, heights) {
  const h = heights || sectionHeights(null);
  if (id === 'above-ceiling') return h.ceilH;
  if (id === 'above-tray') return h.trayTop != null ? h.trayTop : h.ceilH;
  if (id === 'below-tray') return h.trayBottom != null ? h.trayBottom : Math.max(0, h.ceilH - 100);
  return null;
}

/** 切面高度 → 预设 id（±2mm 命中；否则 custom；0/空为 all） */
export function matchPreset(cut, heights) {
  if (!(num(cut) > 0)) return 'all';
  for (const p of SECTION.presets) {
    if (p.id === 'all') continue;
    const v = presetCut(p.id, heights);
    if (v != null && Math.abs(v - num(cut)) <= 2) return p.id;
  }
  return 'custom';
}

/** 单对象竖向范围（mm）；只用于过滤，默认值与建模侧保持一致 */
function rangeOfObject(o, ctx) {
  const p = (o && o.props) || {};
  switch (o && o.type) {
    case 'tray': {
      const bottom = pos(p.height, 2500);
      return [bottom, bottom + pos(p.bodyH, 100)];
    }
    case 'beam': {
      const top = pos(p.top, 3000);
      return [top - pos(p.h, 600), top];
    }
    case 'ceiling':
      return [pos(p.h, ctx.ceilH), pos(p.h, ctx.ceilH)];
    case 'wall':
      return [0, pos(p.height, ctx.roomH)];
    case 'column':
      return [0, pos(p.h, 3000)];
    case 'cabinet':
    case 'pdu':
    case 'ac':
    case 'ups':
    case 'battery':
    case 'aisle':
      return [0, pos(p.h, 2000)];
    case 'vent':
      return [0, 20]; // 地板出风口：贴地
    case 'extinguisher':
      return [0, 700];
    default:
      return [0, pos(p.h, 0)];
  }
}

/**
 * 参与过滤的对象高度表（mm）。默认只返回 ceiling / tray / beam。
 * 吊顶没有数据对象，按 meta.ceilHeight 生成合成记录（id=__ceiling）。
 * @param {object} project
 * @param {{types?:string[]}} [opts]
 */
export function sectionItems(project, opts = {}) {
  const objs = (project && Array.isArray(project.objects)) ? project.objects : [];
  const heights = sectionHeights(project);
  const types = Array.isArray(opts.types) && opts.types.length ? opts.types : SECTION.types;
  const want = new Set(types);
  const items = [];
  if (want.has('ceiling') && heights.hasCeil) {
    items.push({
      id: '__ceiling', type: 'ceiling',
      label: '吊顶', minY: heights.ceilH, maxY: heights.ceilH,
    });
  }
  for (const o of objs) {
    if (!o || !o.id || !want.has(o.type)) continue;
    const [minY, maxY] = rangeOfObject(o, heights);
    items.push({
      id: o.id, type: o.type,
      label: (o.props && o.props.name) || o.id,
      minY, maxY,
    });
  }
  return items;
}

/** 单个对象在切面 cut（mm）下是否隐藏：顶面高于切面才隐藏，恰好等高保留 */
export function hiddenByCut(item, cut) {
  const c = num(cut);
  return c > 0 && !!item && num(item.maxY) > c + SECTION.epsMm;
}

/** 某个切面高度下的隐藏计划（纯规则） */
export function sectionPlan(project, opts = {}) {
  const cut = Math.max(0, Math.min(SECTION.maxCutMm, num(opts.cut)));
  const types = (Array.isArray(opts.types) && opts.types.length ? opts.types : SECTION.types).slice();
  const heights = sectionHeights(project);
  const items = sectionItems(project, { types }).map(it => ({ ...it, hidden: hiddenByCut(it, cut) }));
  return { cut, types, heights, items, hidden: items.filter(it => it.hidden) };
}

/** 高度滑块范围（mm）：至少覆盖结构层高 / 吊顶 / 桥架顶；步长 100mm */
export function sliderRange(heights) {
  const h = heights || sectionHeights(null);
  const top = Math.max(
    SECTION.slider.fallbackMaxMm,
    num(h.roomH), num(h.ceilH), num(h.trayTop), num(h.beamTop),
  );
  const max = Math.min(
    SECTION.maxCutMm,
    Math.max(SECTION.slider.minMm + SECTION.slider.stepMm,
      Math.ceil(top / SECTION.slider.stepMm) * SECTION.slider.stepMm),
  );
  return { min: SECTION.slider.minMm, max, step: SECTION.slider.stepMm };
}

/* ---------------- 侧别过滤 ---------------- */

/** 坐标轴 → 包围盒字段（axis z 用项目 y：z 只是对外命名） */
const boundsAxis = axis => (axis === 'x'
  ? { lo: 'x0', hi: 'x1' }
  : { lo: 'y0', hi: 'y1' });

/** 合法包围盒：四个有限数且 lo ≤ hi */
export function isBounds(b) {
  return !!b && ['x0', 'x1', 'y0', 'y1'].every(k => Number.isFinite(+b[k]))
    && +b.x0 <= +b.x1 && +b.y0 <= +b.y1;
}

/** 侧别轴是否合法（x=东西 / z=南北） */
export function isSideAxis(axis) {
  return SIDE.axes.includes(String(axis || '').toLowerCase());
}

/** 对象包围盒中心（项目 mm） */
export function sideCenter(bounds, axis) {
  if (!isBounds(bounds)) return null;
  const a = boundsAxis(isSideAxis(axis) ? axis : 'x');
  return (num(bounds[a.lo]) + num(bounds[a.hi])) / 2;
}

/** 对象是否跨越切面（包围盒两侧都有几何） */
export function sideCrosses(bounds, plane) {
  if (!isBounds(bounds) || !plane) return false;
  const a = boundsAxis(isSideAxis(plane.axis) ? plane.axis : 'x');
  const p = num(plane.pos);
  return num(bounds[a.lo]) < p && num(bounds[a.hi]) > p;
}

/**
 * 单个对象在侧别平面下是否隐藏：按包围盒中心判边，保证不切穿对象。
 * flip=false 隐藏坐标较小的一侧（x=西 / z=南）；flip=true 隐藏较大一侧。
 */
export function hiddenBySide(bounds, plane) {
  if (!isBounds(bounds) || !plane) return false;
  const c = sideCenter(bounds, plane.axis);
  if (c == null) return false;
  const p = num(plane.pos);
  return plane.flip ? c > p : c < p;
}

/** 平面归一化：axis/pos/flip 转安全值（不修改输入） */
export function sidePlane(plane = {}) {
  const axis = isSideAxis(plane.axis) ? String(plane.axis).toLowerCase() : 'x';
  const p = Math.max(-SIDE.maxPosMm, Math.min(SIDE.maxPosMm, num(plane.pos)));
  return { axis, pos: p, flip: !!plane.flip };
}

/** 对象包围盒并集（项目 mm）；空数组返回 null */
export function sideBounds(boundsList) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boundsList || []) {
    if (!isBounds(b)) continue;
    x0 = Math.min(x0, +b.x0);
    y0 = Math.min(y0, +b.y0);
    x1 = Math.max(x1, +b.x1);
    y1 = Math.max(y1, +b.y1);
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
  return { x0, y0, x1, y1 };
}

/** 侧别滑块范围（mm）：按包围盒外沿取整到 100mm */
export function sideRange(bounds, axis = 'x') {
  const b = bounds;
  const a = boundsAxis(isSideAxis(axis) ? axis : 'x');
  const step = SIDE.stepMm;
  if (!isBounds(b)) return { min: 0, max: 0, step };
  const min = Math.floor(+b[a.lo] / step) * step;
  const max = Math.ceil(+b[a.hi] / step) * step;
  return { min, max: Math.max(min + step, max), step };
}

/** 侧别默认切面：房间中线上，取整到 100mm */
export function sideDefaultPos(bounds, axis = 'x') {
  const b = bounds;
  const a = boundsAxis(isSideAxis(axis) ? axis : 'x');
  const step = SIDE.stepMm;
  if (!isBounds(b)) return 0;
  const mid = (+b[a.lo] + +b[a.hi]) / 2;
  return Math.round(mid / step) * step;
}

/** 侧别文案：如「东西 X · 切掉西侧」 */
export function sideLabel(axis = 'x', flip = false) {
  const ax = isSideAxis(axis) ? axis : 'x';
  return SIDE.axisLabel[ax] + ' · 切掉' + SIDE.cutSide[ax][flip ? 1 : 0];
}

/** 被切侧名称（西 / 东 / 南 / 北侧） */
export function sideCutName(axis = 'x', flip = false) {
  const ax = isSideAxis(axis) ? axis : 'x';
  return SIDE.cutSide[ax][flip ? 1 : 0];
}

/** 保留侧名称（东 / 西 / 北 / 南侧） */
export function sideKeepName(axis = 'x', flip = false) {
  const ax = isSideAxis(axis) ? axis : 'x';
  return SIDE.keepSide[ax][flip ? 1 : 0];
}

/** 某个侧别平面下的隐藏计划（纯规则） */
export function sidePlan(records, plane) {
  const p = sidePlane(plane);
  const items = (records || []).filter(r => r && isBounds(r.bounds)).map(r => {
    const bounds = { x0: +r.bounds.x0, x1: +r.bounds.x1, y0: +r.bounds.y0, y1: +r.bounds.y1 };
    return {
      id: r.id,
      type: r.type,
      label: r.label || r.id,
      bounds,
      center: sideCenter(bounds, p.axis),
      crosses: sideCrosses(bounds, p),
      hidden: hiddenBySide(bounds, p),
    };
  });
  return {
    plane: p,
    bounds: sideBounds(items.map(i => i.bounds)),
    items,
    hidden: items.filter(i => i.hidden),
    crossed: items.filter(i => i.crosses),
  };
}

/* ---------------- 真裁剪 ---------------- */

/** 合法裁剪轴（y=水平 / x=东西 / z=南北） */
export function isClipAxis(axis) {
  return CLIP.axes.includes(String(axis || '').toLowerCase());
}

/** 非法轴回退水平（y），避免传错产生 NaN */
function clipAxisOf(axis) {
  return isClipAxis(axis) ? String(axis).toLowerCase() : 'y';
}

/** 水平剖切默认高度（mm）：1.2m 与结构层高的较小值 */
export function clipDefaultCut(heights) {
  const h = heights || sectionHeights(null);
  return Math.max(0, Math.min(CLIP.defaultPosMm, num(h.roomH)));
}

/**
 * 真裁剪位置范围（mm）：水平 0..结构层高；垂直沿用侧别包围盒范围。
 * 无包围盒时给安全的 0–100mm 范围，避免原生 range max=0。
 */
export function clipRangeFor(heights, bounds, axis = 'y') {
  const ax = clipAxisOf(axis);
  if (ax === 'y') {
    const h = heights || sectionHeights(null);
    const step = CLIP.stepMm;
    const max = Math.min(CLIP.maxPosMm, Math.max(step, Math.ceil(num(h.roomH) / step) * step));
    return { min: 0, max, step };
  }
  const r = sideRange(bounds, ax);
  return { min: r.min, max: Math.max(r.min + r.step, r.max), step: r.step };
}

/** 真裁剪默认位置（mm）：水平 1.2m；垂直取墙体中线 */
export function clipDefaultPos(heights, bounds, axis = 'y') {
  const ax = clipAxisOf(axis);
  if (ax === 'y') return clipDefaultCut(heights);
  return sideDefaultPos(bounds, ax);
}

/**
 * 真裁剪平面（项目毫米坐标）：保留 n·p + c ≥ 0 的一侧。
 * flip=false 保留坐标较大侧（以上 / 东 / 北），flip=true 保留较小侧。
 * @returns {{axis:string,pos:number,flip:boolean,
 *            normal:{x:number,y:number,z:number},constant:number}}
 */
export function clipPlaneAt(axis = 'y', pos = 0, flip = false) {
  const ax = clipAxisOf(axis);
  const p = Math.max(-CLIP.maxPosMm, Math.min(CLIP.maxPosMm, num(pos)));
  const s = flip ? -1 : 1; // 法向符号：+ 保留大坐标侧，- 保留小坐标侧
  const normal = ax === 'y' ? { x: 0, y: 0, z: s }
    : ax === 'x' ? { x: s, y: 0, z: 0 }
      : { x: 0, y: s, z: 0 };
  return { axis: ax, pos: p, flip: !!flip, normal, constant: -s * p };
}

/**
 * 项目毫米平面 → Three 场景平面（米）：x 东 → x，项目 z 上 → y，项目 y 北 → -z。
 * 返回的 normal/constant 可直接写进 THREE.Plane（保留 n·p + c ≥ 0 的一侧）。
 */
export function clipScenePlane(planeOrAxis, pos, flip) {
  const p = planeOrAxis && typeof planeOrAxis === 'object' && planeOrAxis.normal
    ? planeOrAxis
    : clipPlaneAt(planeOrAxis, pos, flip);
  const n = p.normal;
  return {
    normal: { x: n.x, y: n.z, z: n.y === 0 ? 0 : -n.y },
    constant: num(p.constant) / 1000,
  };
}

/** 点是否在保留侧（项目毫米坐标；等于平面时保留，避免边界闪烁） */
export function clipKeepsPoint(plane, point) {
  if (!plane || !plane.normal || !point) return true;
  const n = plane.normal;
  return n.x * num(point.x) + n.y * num(point.y) + n.z * num(point.z)
    + num(plane.constant) >= 0;
}

/** 被切掉的一侧名称（以下 / 以上、西 / 东、南 / 北侧） */
export function clipCutName(axis = 'y', flip = false) {
  const ax = clipAxisOf(axis);
  return CLIP.cutSide[ax][flip ? 1 : 0];
}

/** 保留的一侧名称 */
export function clipKeepName(axis = 'y', flip = false) {
  const ax = clipAxisOf(axis);
  return CLIP.keepSide[ax][flip ? 1 : 0];
}

/** 真裁剪文案：如「水平 1.20m · 保留以上」「东西 X 3.00m · 切掉西侧」 */
export function clipLabel(axis = 'y', pos = 0, flip = false) {
  const ax = clipAxisOf(axis);
  const m = (num(pos) / 1000).toFixed(2) + 'm';
  if (ax === 'y') return '水平 ' + m + ' · 保留' + (flip ? '以下' : '以上');
  return CLIP.axisLabel[ax] + ' ' + m + ' · 切掉' + CLIP.cutSide[ax][flip ? 1 : 0];
}
