/**
 * 指北针与比例尺的纯计算（正交图纸视图）。
 *
 * 只做数学与文案，不依赖 three / DOM：
 *   · northAngleFromBasis / northAngleFromCamera：把世界北向（场景 -Z，项目 +Y）
 *     投影到相机屏幕基向量，得到「北在屏幕上的顺时针角度」（0° = 正上）；
 *   · scalePlan：按每像素世界长度，从 1 / 2 / 5 × 10ⁿ 中挑整米数，生成比例尺；
 *   · compassPlan：把视图 id / 相机模式 / 视口尺寸组合成 HUD 状态与读屏文案。
 *
 * 透视视图比例随距离变化，默认只在正交模式下显示比例尺与指北针；立面视轴
 * 与北向平行时屏幕上无法表达方向，故省略指北针。
 */

/** 比例尺与方位的显示参数 */
export const COMPASS = Object.freeze({
  northLabel: 'N',
  /** 桌面 / 移动端目标段长（CSS 像素） */
  targetPx: 96,
  mobileTargetPx: 64,
  /** 允许的最短 / 最长段长 */
  minPx: 28,
  maxPx: 140,
  mobileMaxPx: 96,
  mobileBreakpoint: 600,
  /** 北向在屏幕上短于此长度时视为退化（立面视轴与北向平行） */
  northEps: 0.12,
});

/** 正交立面标题（与视图模块文案保持一致，避免运行时反向依赖） */
const ELEVATION_TITLE = Object.freeze({
  front: '南立面', back: '北立面', left: '西立面', right: '东立面',
});

/** 轴测四角标题 */
const ISO_CORNER = Object.freeze({
  se: '东南', sw: '西南', nw: '西北', ne: '东北',
});

/** 角度归一到 [0, 360)；非法值按 0 处理（HUD 不因坏数据消失） */
export function normalizeAngle(deg) {
  const v = Number(deg);
  if (!Number.isFinite(v)) return 0;
  return ((v % 360) + 360) % 360;
}

/**
 * 世界北向在屏幕上的方向（顺时针角度，0° = 屏幕正上）。
 *
 * three 相机矩阵列 0/1 分别是屏幕右 / 上方向；世界北向是 (0, 0, -1)，
 * 因此 northRight = -right.z、northUp = -up.z。
 *
 * @param {{x?:number,z?:number}|null} right 相机屏幕右方向（世界向量）
 * @param {{x?:number,z?:number}|null} up 相机屏幕上方向（世界向量）
 * @returns {number|null} 0–360；北向几乎垂直于屏幕（立面）时返回 null
 */
export function northAngleFromBasis(right, up) {
  if (!right || !up) return null;
  const nr = -Number(right.z || 0);
  const nu = -Number(up.z || 0);
  const len = Math.hypot(nr, nu);
  if (!Number.isFinite(len) || len < COMPASS.northEps) return null;
  return normalizeAngle(Math.atan2(nr, nu) * 180 / Math.PI);
}

/**
 * 从 three 的 matrixWorld.elements 读屏幕方向并算北向角度。
 * 列 0 = right（e[0..2]），列 1 = up（e[4..6]）。
 * @param {ArrayLike<number>|null} elements
 * @returns {number|null}
 */
export function northAngleFromCamera(elements) {
  if (!elements || !Number.isFinite(Number(elements.length)) || elements.length < 8) return null;
  return northAngleFromBasis(
    { z: Number(elements[2]) || 0 },
    { z: Number(elements[6]) || 0 },
  );
}

/** 去掉多余小数：0.10 → 0.1、2.00 → 2 */
const trim = v => String(+Number(v).toFixed(2));

/**
 * 比例尺文案：小于 1m 用厘米、极近用毫米，大于 1km 用千米。
 * @param {number} meters
 * @returns {string} 例如 "2 m" / "50 cm" / "1.5 km"
 */
export function scaleLabel(meters) {
  const m = Number(meters);
  if (!(m > 0) || !Number.isFinite(m)) return '';
  if (m >= 1000) return trim(m / 1000) + ' km';
  if (m >= 1) return trim(m) + ' m';
  if (m >= 0.01) return Math.round(m * 100) + ' cm';
  return Math.round(m * 1000) + ' mm';
}

/**
 * 比例尺规划：从 1 / 2 / 5 × 10ⁿ 中挑像素宽度最接近目标、且落在允许区间的整米数。
 * @param {number} worldPerPixel 每个 CSS 像素代表的世界长度（米）
 * @param {{mobile?:boolean, viewportWidth?:number, targetPx?:number,
 *          minPx?:number, maxPx?:number}} [opts]
 * @returns {{meters:number, px:number, label:string, worldPerPixel:number,
 *            targetPx:number, minPx:number, maxPx:number}|null}
 */
export function scalePlan(worldPerPixel, opts = {}) {
  const wpp = Number(worldPerPixel);
  if (!(wpp > 0) || !Number.isFinite(wpp)) return null;
  const mobile = opts.mobile == null
    ? (Number.isFinite(opts.viewportWidth) && opts.viewportWidth > 0
      && opts.viewportWidth < COMPASS.mobileBreakpoint)
    : !!opts.mobile;
  const targetPx = Number.isFinite(opts.targetPx)
    ? Math.max(8, opts.targetPx)
    : (mobile ? COMPASS.mobileTargetPx : COMPASS.targetPx);
  const minPx = Number.isFinite(opts.minPx) ? Math.max(4, opts.minPx) : COMPASS.minPx;
  const maxPx = Number.isFinite(opts.maxPx)
    ? Math.max(minPx + 1, opts.maxPx)
    : (mobile ? COMPASS.mobileMaxPx : COMPASS.maxPx);

  const targetMeters = targetPx * wpp;
  const exp = Math.floor(Math.log10(Math.max(targetMeters, 1e-12)));
  let best = null;
  let fallback = null;
  for (const k of [1, 2, 5]) {
    for (let d = -1; d <= 1; d++) {
      const meters = k * Math.pow(10, exp + d);
      const px = meters / wpp;
      if (!(meters > 0) || !Number.isFinite(px) || px <= 0) continue;
      const score = Math.abs(px - targetPx);
      if (!fallback || score < fallback.score) fallback = { meters, px, score };
      if (px < minPx || px > maxPx) continue;
      if (!best || score < best.score) best = { meters, px, score };
    }
  }
  // 极端缩放时可能没有候选落在区间内：退回最接近目标像素的整米数，
  // 宁可略超上限，也不要显示空白比例尺。
  const pick = best || fallback;
  if (!pick) return null;
  return {
    meters: pick.meters,
    px: +pick.px.toFixed(1),
    label: scaleLabel(pick.meters),
    worldPerPixel: wpp,
    targetPx,
    minPx,
    maxPx,
  };
}

/**
 * 视图标题与副标题。
 * @param {string} activeId top / iso / front / back / left / right / orbit / focus / 业务视点
 * @param {{corner?:string|null, cameraMode?:string, viewpointLabel?:string}} [opts]
 */
export function viewCaption(activeId, opts = {}) {
  const id = String(activeId || 'orbit');
  const mode = opts.cameraMode === 'ortho' ? '正交' : '透视';
  if (id === 'top') return { title: '俯视平面', sub: '正交 · 北朝上' };
  if (id === 'iso') {
    const corner = ISO_CORNER[opts.corner] || '';
    return { title: '轴测总览', sub: '正交 · ' + (corner ? corner + '角' : '平行投影') };
  }
  if (ELEVATION_TITLE[id]) return { title: ELEVATION_TITLE[id], sub: '正交 · 近墙隐藏' };
  if (id === 'orbit') {
    return mode === '正交'
      ? { title: '正交轨道', sub: '平行投影' }
      : { title: '全景轨道', sub: '透视' };
  }
  if (id === 'focus') return { title: '对象聚焦', sub: mode };
  if (id === 'viewpoint') {
    return { title: opts.viewpointLabel || '业务视点', sub: '定点视点' };
  }
  return { title: opts.viewpointLabel || '机房视图', sub: mode };
}

/** 是否为立面视图（屏幕上无法表达北向） */
export function isElevationView(activeId) {
  return !!ELEVATION_TITLE[String(activeId || '')];
}

/**
 * HUD 组合状态：是否显示、标题、北向角度、比例尺与读屏文案。
 * 只在正交相机下显示；suppressed（巡视 / 步行）时整体隐藏。
 *
 * @param {{activeId?:string, corner?:string|null, cameraMode?:string,
 *          right?:object|null, up?:object|null, worldPerPixel?:number,
 *          viewportWidth?:number, viewportHeight?:number, viewpointLabel?:string,
 *          suppressed?:boolean}} [input]
 * @returns {{show:boolean, title:string, sub:string, northAngle:number|null,
 *            showNorth:boolean, scale:object|null, aria:string, mobile:boolean}}
 */
export function compassPlan(input = {}) {
  const activeId = String(input.activeId || 'orbit');
  const cameraMode = input.cameraMode === 'ortho' ? 'ortho' : 'perspective';
  const mobile = Number.isFinite(input.viewportWidth) && input.viewportWidth > 0
    && input.viewportWidth < COMPASS.mobileBreakpoint;
  const caption = viewCaption(activeId, {
    corner: input.corner,
    cameraMode,
    viewpointLabel: input.viewpointLabel,
  });
  const show = cameraMode === 'ortho' && !input.suppressed;
  const elevation = isElevationView(activeId);
  const northAngle = show && !elevation
    ? northAngleFromBasis(input.right, input.up)
    : null;
  const scale = show
    ? scalePlan(input.worldPerPixel, {
      mobile,
      viewportWidth: input.viewportWidth,
    })
    : null;
  const showNorth = show && northAngle != null;
  const aria = show
    ? [caption.title, caption.sub,
      showNorth ? `指北针北偏${directionText(northAngle)}` : '',
      scale ? `比例尺 ${scale.label}` : '']
      .filter(Boolean).join('，')
    : '';
  return {
    show,
    title: caption.title,
    sub: caption.sub,
    northAngle,
    showNorth,
    scale,
    aria,
    mobile,
  };
}

/**
 * 角度 → 中文方位短语（读屏用；0° = 北，顺时针）。
 * 只给 8 个方位，避免读屏出现「北偏 37.4 度」这种过度精确的信息。
 */
export function directionText(angle) {
  const a = normalizeAngle(angle);
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return names[Math.round(a / 45) % 8];
}

/** HUD 自检 / 测试用摘要（不读 DOM） */
export function summarizeCompass(plan) {
  if (!plan || !plan.show) return { show: false, aria: '' };
  return {
    show: true,
    title: plan.title,
    sub: plan.sub,
    showNorth: !!plan.showNorth,
    northAngle: plan.northAngle == null ? null : +plan.northAngle.toFixed(1),
    direction: plan.northAngle == null ? null : directionText(plan.northAngle),
    scale: plan.scale ? {
      label: plan.scale.label, px: plan.scale.px, meters: plan.scale.meters,
      targetPx: plan.scale.targetPx,
    } : null,
    aria: plan.aria,
  };
}
