/**
 * 性能验收纯规则：帧时统计、资源增量、预算判定。
 *
 * 不依赖 three / DOM，可直接在 Node 里单测；浏览器端由性能探针采样后调用。
 * 预算来自实际机房的实测值并乘了约 2× 余量：目的是拦住“新增视图把查看器拖垮”的
 * 回归，而不是追求跑分。
 */

export const PERF = Object.freeze({
  /** 滚动窗口：只保留最近 N 个已渲染帧，避免长时间巡视后数组无限增长 */
  window: 120,
  /** 基准采样：warmup 帧不计入，正式采样帧数 */
  bench: Object.freeze({
    frames: 60,
    warmup: 10,
    maxFrames: 600,
    timeoutMs: 30000,
  }),
  /** 验收预算：桌面 / 移动、WebGPU 与 WebGL 2 都适用 */
  budgets: Object.freeze({
    desktopMinFps: 24,
    mobileMinFps: 15,
    /** 单项模式相对同后端“透视轨道”基准的最低保留比例 */
    relativeFps: 0.55,
    /** 单帧 CPU 提交耗时（不含 GPU 异步完成） */
    avgRenderMs: 45,
    /** 首屏构建（含合并/取景/首帧）上限 */
    buildMs: 10000,
  }),
  /** 反复开关后的资源增量容差：正常应为 0，这里只留整数计数噪声的 0 容差 */
  leakTolerance: Object.freeze({
    objects: 0, meshes: 0, materials: 0, sceneGeometries: 0,
    geometries: 0, textures: 0, programs: 0, drawCalls: 0, triangles: 0,
  }),
});

/** 数字检查：NaN / Infinity / 非数字统一为 false */
export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 线性插值分位数。
 * @param {number[]} values
 * @param {number} p 0–1
 * @returns {number} 空数组返回 0
 */
export function percentile(values, p) {
  const a = (Array.isArray(values) ? values : []).filter(isNum).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const q = Math.min(1, Math.max(0, isNum(p) ? p : 0));
  const idx = (a.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

/** 取平均（空数组返回 0） */
export function mean(values) {
  const a = (Array.isArray(values) ? values : []).filter(isNum);
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

/** 保留 1 位小数（避免快照里出现 59.999999） */
export function round1(v) {
  return isNum(v) ? Math.round(v * 10) / 10 : 0;
}

/**
 * 汇总最近一个窗口的帧间隔与渲染耗时。
 * @param {number[]} frameDts 相邻两帧的 rAF 间隔（ms）
 * @param {number[]} renderMs 每帧 renderer.render 的 CPU 耗时（ms）
 * @param {{window?:number}} [opts]
 * @returns {{samples:number, seconds:number, fps:number, fpsLow:number,
 *   frameMs:{avg:number,p50:number,p95:number,max:number},
 *   renderMs:{avg:number,p50:number,p95:number,max:number}}}
 */
export function summarizeSamples(frameDts, renderMs, opts = {}) {
  const n = Math.max(1, Math.round(opts.window || PERF.window));
  const dt = (Array.isArray(frameDts) ? frameDts : [])
    .filter(v => isNum(v) && v > 0 && v < 5000).slice(-n);
  const rd = (Array.isArray(renderMs) ? renderMs : []).filter(isNum).slice(-n);
  const avgDt = mean(dt);
  const avgRender = mean(rd);
  const p95Dt = percentile(dt, .95);
  return {
    samples: dt.length,
    seconds: round1(dt.reduce((s, v) => s + v, 0) / 1000),
    fps: round1(avgDt > 0 ? 1000 / avgDt : 0),
    // 保守 fps：用 p95 帧间隔估算，反映偶发卡顿后的下限
    fpsLow: round1(p95Dt > 0 ? 1000 / p95Dt : 0),
    frameMs: {
      avg: round1(avgDt), p50: round1(percentile(dt, .5)),
      p95: round1(p95Dt), max: round1(percentile(dt, 1)),
    },
    renderMs: {
      avg: round1(avgRender), p50: round1(percentile(rd, .5)),
      p95: round1(percentile(rd, .95)), max: round1(percentile(rd, 1)),
    },
  };
}

/** 读取资源快照里的一个数值（缺失按 null，不参与增量） */
function resourceValue(snapshot, key) {
  const v = snapshot && snapshot[key];
  return isNum(v) ? v : null;
}

/**
 * 对比两次资源快照。
 * @param {object} before
 * @param {object} after
 * @param {object} [tolerance] 每项允许的增量（默认 PERF.leakTolerance）
 * @returns {{clean:boolean, delta:object, grew:string[], missing:string[]}}
 */
export function resourceDelta(before, after, tolerance = PERF.leakTolerance) {
  const tol = tolerance || {};
  const keys = Object.keys({ ...(before || {}), ...(after || {}) })
    .filter(k => isNum(resourceValue(before, k)) || isNum(resourceValue(after, k)))
    .sort();
  const delta = {}, grew = [], missing = [];
  for (const k of keys) {
    const a = resourceValue(before, k), b = resourceValue(after, k);
    if (a === null || b === null) { missing.push(k); continue; }
    const d = b - a;
    delta[k] = d;
    const allowed = isNum(tol[k]) ? tol[k] : 0;
    if (d > allowed) grew.push(k + '+' + d);
  }
  return { clean: grew.length === 0, delta, grew, missing };
}

/**
 * 帧率是否满足验收预算。
 * @param {object} stats summarizeSamples 的返回值
 * @param {{mobile?:boolean, baselineFps?:number, relative?:number, minSamples?:number}} [opts]
 */
export function fpsAcceptable(stats, opts = {}) {
  if (!stats || !isNum(stats.fps) || stats.fps <= 0) return false;
  const min = opts.mobile ? PERF.budgets.mobileMinFps : PERF.budgets.desktopMinFps;
  const relative = isNum(opts.relative) ? opts.relative : PERF.budgets.relativeFps;
  const minSamples = isNum(opts.minSamples) ? opts.minSamples : 10;
  const baseline = isNum(opts.baselineFps) && opts.baselineFps > 0 ? opts.baselineFps : null;
  return stats.samples >= minSamples
    && stats.fps >= min
    && (!baseline || stats.fps >= baseline * relative)
    && isNum(stats.renderMs && stats.renderMs.avg)
    && stats.renderMs.avg <= PERF.budgets.avgRenderMs;
}

/** 首屏构建耗时是否在预算内（0 < ms <= budget） */
export function buildAcceptable(ms, budget = PERF.budgets.buildMs) {
  return isNum(ms) && ms > 0 && ms <= budget;
}

/**
 * 基准采样参数归一化：帧数限制在 10–maxFrames，warmup 0–30。
 * @param {{frames?:number, warmup?:number, label?:string}} [opts]
 */
export function normalizeBench(opts = {}) {
  const frames = Math.round(isNum(opts.frames) ? opts.frames : PERF.bench.frames);
  const warmup = Math.round(isNum(opts.warmup) ? opts.warmup : PERF.bench.warmup);
  return {
    frames: Math.min(PERF.bench.maxFrames, Math.max(10, frames)),
    warmup: Math.min(30, Math.max(0, warmup)),
    label: typeof opts.label === 'string' && opts.label ? opts.label.slice(0, 40) : 'bench',
  };
}
