/**
 * URL 状态与深链接：解析 / 归一化 / 序列化 / 应用（附录 B §4）。
 *
 * 纯函数，不依赖 DOM / three，可直接 Node 单测。地址只用 replaceState 同步：
 * 默认值不写入（view=orbit / cut=off / section=off / xray=0 / ui=1 省略），
 * 未管理参数（renderer / bright / 业务自定义）原样保留在末尾。
 *
 * 参数表见附录 B §4.2；applyViewState() 通过依赖注入调用各子系统钩子，
 * 缺失钩子进 pending，被钩子拒绝进 ignored。
 */
import { parseHiddenParam, serializeHidden } from '../data/typeplan.js';

export const DEFAULT_VIEW = 'orbit';
export const CUT_OFF = 'off';
export const SECTION_VALUES = Object.freeze(['height', 'side', 'clip', 'box', 'off']);
export const SIDE_AXES = Object.freeze(['x', 'z']);
export const CLIP_AXES = Object.freeze(['y', 'x', 'z']);
export const BOX_PRESETS = Object.freeze(['corner', 'top', 'half']);
export const EXPLODE_PROFILE_VALUES = Object.freeze(['presentation', 'review']);
export const STYLE_VALUES = Object.freeze(['real', 'lineart']);
export const DEFAULT_STYLE = 'real';
export const KNOWN_ROUTES = Object.freeze(['all', 'inspection']);

/** 由本模块统一管理（同步地址时先移除，再按当前状态重写） */
export const MANAGED_KEYS = Object.freeze([
  'src', 'src2', 'ab', 'view', 'focus', 'cut', 'section', 'side', 'sidePos', 'sideFlip',
  'clip', 'clipPos', 'clipFlip', 'box', 'boxX', 'boxZ', 'boxH', 'route', 'xray', 'hide', 'ui', 'debug',
  'explode', 'style',
]);

const MAX_VIEW_LEN = 80;
const MAX_FOCUS_LEN = 160;
const MAX_CUT_MM = 50000;
const MAX_SRC_LEN = 2048;
const VIEW_TOKEN_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ROUTE_TOKEN_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
const BOOL_TRUE = new Set(['1', 'true', 'on', 'yes']);
const BOOL_FALSE = new Set(['0', 'false', 'off', 'no']);

/** 立面别名（与 elevation3d 的 ALIASES 同步） */
const ELEVATION_ALIASES = Object.freeze({
  front: 'front', south: 'front', 'front-elevation': 'front', 'south-elevation': 'front',
  '前': 'front', '前立面': 'front', '南': 'front', '南立面': 'front',
  back: 'back', north: 'back', 'back-elevation': 'back', 'north-elevation': 'back',
  '后': 'back', '后立面': 'back', '北': 'back', '北立面': 'back',
  left: 'left', west: 'left', 'left-elevation': 'left', 'west-elevation': 'left',
  '左': 'left', '左立面': 'left', '西': 'left', '西立面': 'left',
  right: 'right', east: 'right', 'right-elevation': 'right', 'east-elevation': 'right',
  '右': 'right', '右立面': 'right', '东': 'right', '东立面': 'right',
});

const CORNER_ALIAS = Object.freeze({
  se: 'se', sw: 'sw', ne: 'ne', nw: 'nw',
  '东南': 'se', '西南': 'sw', '东北': 'ne', '西北': 'nw',
});

const ISO_RE = /^(?:iso|axo|axon|isometric|轴测|等轴测)(?:[-_:· ]?(se|sw|ne|nw|东南|西南|东北|西北))?$/;
const ISO_BAD_PREFIX_RE = /^(?:iso|axo|axon|isometric|轴测|等轴测)(?:[-_:· ])/;

/**
 * 视图 id 归一化（与 viewpose/elevation3d 别名表一致，内联避免跨模块耦合）。
 * 支持 orbit / top / iso(-角) / 四立面；非法值返回 null。
 */
function normalizeViewId(id) {
  const s = String(id == null ? '' : id).trim().toLowerCase();
  if (!s) return null;
  if (s === 'top' || s === 'plan' || s === 'bird' || s === '俯视') return 'top';
  if (s === 'orbit' || s === '3d' || s === 'default' || s === '全景') return 'orbit';
  if (ELEVATION_ALIASES[s]) return ELEVATION_ALIASES[s];
  const m = ISO_RE.exec(s);
  if (!m) return null;
  if (!m[1]) return 'iso';
  return 'iso-' + CORNER_ALIAS[m[1]];
}

/** 把 string / URLSearchParams / 对象 / 键值数组统一转成 URLSearchParams（不改原对象） */
function toParams(input) {
  if (input instanceof URLSearchParams) return new URLSearchParams(input);
  if (Array.isArray(input)) return new URLSearchParams(input);
  if (input && typeof input === 'object') {
    return new URLSearchParams(Object.entries(input)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]));
  }
  const s = String(input == null ? '' : input).trim();
  if (!s) return new URLSearchParams();
  // 允许直接传完整 URL 或带 ? 的查询串（测试/外部调用方便）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { return new URL(s).searchParams; } catch (e) { /* 落到下面的查询串解析 */ }
  }
  return new URLSearchParams(s.startsWith('?') ? s.slice(1) : s);
}

/** 视图 id 归一化：视图别名优先，其余合法 token 作为业务视点 id；非法值 null */
export function normalizeViewParam(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw.length > MAX_VIEW_LEN) return null;
  const known = normalizeViewId(raw);
  if (known) return known;
  const s = raw.toLowerCase();
  // iso / axo 系列写了非法角（如 iso-bad）时不要退化成“业务视点 id”
  if (ISO_BAD_PREFIX_RE.test(s)) return null;
  return VIEW_TOKEN_RE.test(s) ? s : null;
}

/** 对比项目地址：去首尾空格、拒绝控制字符与超长值；空 → null */
export function normalizeSrc2Param(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || s.length > MAX_SRC_LEN) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

/** 对比侧：a / b（大小写不敏感）；非法值 null */
export function normalizeCompareSideParam(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return s === 'a' || s === 'b' ? s : null;
}

/** 焦点目标：对象 id 或柜名；空/控制字符/过长返回 null（名称里的中文与空格允许） */
export function normalizeFocusParam(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || s.length > MAX_FOCUS_LEN) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

/** 剖切高度：off 或非负毫米数（上限 50m，避免异常 URL 把场景裁到看不见） */
export function normalizeCutParam(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (!s || s === CUT_OFF) return CUT_OFF;
  if (!/^\+?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MAX_CUT_MM);
}

/** 剖切模式枚举；非法值 null */
export function normalizeSectionParam(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return SECTION_VALUES.includes(s) ? s : null;
}

/** 侧别轴：x / z（大小写不敏感）；非法值 null */
export function normalizeSideAxisParam(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return SIDE_AXES.includes(s) ? s : null;
}

/** 侧别切面位置：项目毫米（允许负值，上限 ±50m）；非法值 null */
export function normalizeSidePosParam(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.max(-MAX_CUT_MM, Math.min(MAX_CUT_MM, n));
}

/** 侧别翻转：true / false / null（非法值） */
export function normalizeSideFlipParam(value) {
  const b = toBool(value);
  return b == null ? null : b;
}

/** 真裁剪轴：y / x / z（大小写不敏感）；非法值 null */
export function normalizeClipAxisParam(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return CLIP_AXES.includes(s) ? s : null;
}

/** 真裁剪位置：项目毫米（允许负值，上限 ±50m）；非法值 null */
export function normalizeClipPosParam(value) {
  return normalizeSidePosParam(value);
}

/** 真裁剪翻转：true / false / null（非法值） */
export function normalizeClipFlipParam(value) {
  const b = toBool(value);
  return b == null ? null : b;
}

/** 盒体预设：corner / top / half（大小写不敏感）；非法值 null */
export function normalizeBoxPresetParam(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return BOX_PRESETS.includes(s) ? s : null;
}

/** 盒体切面位置：项目毫米（允许负值，上限 ±50m）；非法值 null */
export function normalizeBoxPosParam(value) {
  return normalizeSidePosParam(value);
}

/** 路线 id：合法 token（all / inspection / row-* / cabinet-*，其它交给后续回退） */
export function normalizeRouteParam(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return s && s.length <= 80 && ROUTE_TOKEN_RE.test(s) ? s : null;
}

/**
 * 是否是查看器认识的路线 id：all / inspection / row-* / cabinet-*。
 * 前缀合法但目标不存在（如 row-z、cabinet-X99）仍算已知，由路线层回退全场并标注原因；
 * 完全未知的 token（如 foo）则在应用时忽略并从地址栏清理。
 */
export function isKnownRoute(value) {
  const s = normalizeRouteParam(value);
  return !!s && (KNOWN_ROUTES.includes(s) || /^(?:row-[a-z0-9]|cabinet-[\p{L}\p{N}])/u.test(s));
}

/** 调试模式：wire / wireframe → wire；off/0/空 → null */
export function normalizeDebugParam(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (!s || s === '0' || s === 'off' || s === 'none') return null;
  return s === 'wire' || s === 'wireframe' ? 'wire' : null;
}

/**
 * 呈现档：lineart / white / edges / sketch → lineart；
 * real / default / 空 / off / 0 → real；其它非法值 → null（回退默认实景）。
 */
export function normalizeStyleParam(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (!s || s === 'real' || s === 'default' || s === 'off' || s === '0' || s === 'none') return DEFAULT_STYLE;
  if (s === 'lineart' || s === 'line-art' || s === 'white' || s === 'edges' || s === 'sketch') return 'lineart';
  return null;
}

/**
 * 爆炸档位：review / presentation（含 demo/show/default 别名）。
 * off / 0 / none 视为默认 presentation；非法值返回 null（调用方回退默认）。
 */
export function normalizeExplodeParam(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (!s || s === '0' || s === 'off' || s === 'none') return 'presentation';
  if (s === 'presentation' || s === 'demo' || s === 'show' || s === 'default') return 'presentation';
  if (s === 'review' || s === 'small') return 'review';
  return null;
}

/** 布尔参数：true/false/null（null = 非法值，调用方回退默认） */
function toBool(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (BOOL_TRUE.has(s)) return true;
  if (BOOL_FALSE.has(s)) return false;
  return null;
}

/**
 * 解析 URL 查询串；非法值保留默认并追加 issues。
 * @param {string|URLSearchParams|object|Array} input 查询串 / 完整 URL / 参数对象
 */
export function parseViewState(input) {
  const params = toParams(input);
  const issues = [];
  const issue = (key, value, reason) => issues.push({ key, value: String(value == null ? '' : value), reason });

  const srcRaw = params.get('src');
  const src = srcRaw == null || String(srcRaw).trim() === '' ? null : String(srcRaw).trim();

  let src2 = null;
  const src2Raw = params.get('src2');
  if (src2Raw != null) {
    src2 = normalizeSrc2Param(src2Raw);
    if (!src2) issue('src2', src2Raw, 'invalid');
  }

  let ab = 'a';
  const abRaw = params.get('ab');
  if (abRaw != null) {
    const v = normalizeCompareSideParam(abRaw);
    if (v) ab = v;
    else issue('ab', abRaw, 'invalid');
  }

  let view = DEFAULT_VIEW;
  const viewRaw = params.get('view');
  if (viewRaw != null) {
    const v = normalizeViewParam(viewRaw);
    if (v) view = v;
    else issue('view', viewRaw, 'invalid');
  }

  let focus = null;
  const focusRaw = params.get('focus');
  if (focusRaw != null) {
    focus = normalizeFocusParam(focusRaw);
    if (!focus) issue('focus', focusRaw, 'invalid');
  }

  let cut = CUT_OFF;
  const cutRaw = params.get('cut');
  if (cutRaw != null) {
    const c = normalizeCutParam(cutRaw);
    if (c == null) issue('cut', cutRaw, 'invalid');
    else cut = c;
  }

  let section = 'off';
  const sectionRaw = params.get('section');
  if (sectionRaw != null) {
    const s = normalizeSectionParam(sectionRaw);
    if (s) section = s;
    else issue('section', sectionRaw, 'invalid');
  }

  let side = 'x';
  const sideRaw = params.get('side');
  if (sideRaw != null) {
    const a = normalizeSideAxisParam(sideRaw);
    if (a) side = a;
    else issue('side', sideRaw, 'invalid');
  }

  let sidePos = null;
  const sidePosRaw = params.get('sidePos');
  if (sidePosRaw != null) {
    const v = normalizeSidePosParam(sidePosRaw);
    if (v == null) issue('sidePos', sidePosRaw, 'invalid');
    else sidePos = v;
  }

  let sideFlip = false;
  const sideFlipRaw = params.get('sideFlip');
  if (sideFlipRaw != null) {
    const b = normalizeSideFlipParam(sideFlipRaw);
    if (b == null) issue('sideFlip', sideFlipRaw, 'invalid');
    else sideFlip = b;
  }

  let clip = 'y';
  const clipRaw = params.get('clip');
  if (clipRaw != null) {
    const a = normalizeClipAxisParam(clipRaw);
    if (a) clip = a;
    else issue('clip', clipRaw, 'invalid');
  }

  let clipPos = null;
  const clipPosRaw = params.get('clipPos');
  if (clipPosRaw != null) {
    const v = normalizeClipPosParam(clipPosRaw);
    if (v == null) issue('clipPos', clipPosRaw, 'invalid');
    else clipPos = v;
  }

  let clipFlip = false;
  const clipFlipRaw = params.get('clipFlip');
  if (clipFlipRaw != null) {
    const b = normalizeClipFlipParam(clipFlipRaw);
    if (b == null) issue('clipFlip', clipFlipRaw, 'invalid');
    else clipFlip = b;
  }

  let box = 'corner';
  const boxRaw = params.get('box');
  if (boxRaw != null) {
    const p = normalizeBoxPresetParam(boxRaw);
    if (p) box = p;
    else issue('box', boxRaw, 'invalid');
  }

  let boxX = null;
  const boxXRaw = params.get('boxX');
  if (boxXRaw != null) {
    const v = normalizeBoxPosParam(boxXRaw);
    if (v == null) issue('boxX', boxXRaw, 'invalid');
    else boxX = v;
  }

  let boxZ = null;
  const boxZRaw = params.get('boxZ');
  if (boxZRaw != null) {
    const v = normalizeBoxPosParam(boxZRaw);
    if (v == null) issue('boxZ', boxZRaw, 'invalid');
    else boxZ = v;
  }

  let boxH = null;
  const boxHRaw = params.get('boxH');
  if (boxHRaw != null) {
    const v = normalizeBoxPosParam(boxHRaw);
    if (v == null || v < 0) issue('boxH', boxHRaw, 'invalid');
    else boxH = v;
  }

  let route = null;
  const routeRaw = params.get('route');
  if (routeRaw != null) {
    route = normalizeRouteParam(routeRaw);
    if (!route) issue('route', routeRaw, 'invalid');
  }

  let xray = false;
  const xrayRaw = params.get('xray');
  if (xrayRaw != null) {
    const b = toBool(xrayRaw);
    if (b == null) issue('xray', xrayRaw, 'invalid');
    else xray = b;
  }

  let hide = [];
  const hideRaw = params.get('hide');
  if (hideRaw != null) {
    const parsed = parseHiddenParam(hideRaw);
    hide = parsed.hidden;
    for (const token of parsed.unknown) issue('hide', token, 'invalid');
  }

  let ui = true;
  const uiRaw = params.get('ui');
  if (uiRaw != null) {
    const b = toBool(uiRaw);
    if (b == null) issue('ui', uiRaw, 'invalid');
    else ui = b;
  }

  let debug = null;
  const debugRaw = params.get('debug');
  if (debugRaw != null) {
    debug = normalizeDebugParam(debugRaw);
    if (!debug && !['', '0', 'off', 'none'].includes(String(debugRaw).trim().toLowerCase())) {
      issue('debug', debugRaw, 'invalid');
    }
  }

  let explode = 'presentation';
  const explodeRaw = params.get('explode');
  if (explodeRaw != null) {
    const v = normalizeExplodeParam(explodeRaw);
    if (v) explode = v;
    else issue('explode', explodeRaw, 'invalid');
  }

  let style = DEFAULT_STYLE;
  const styleRaw = params.get('style');
  if (styleRaw != null) {
    const v = normalizeStyleParam(styleRaw);
    if (v) style = v;
    else issue('style', styleRaw, 'invalid');
  }

  const raw = Object.create(null);
  for (const [k, v] of params) if (!(k in raw)) raw[k] = v;

  return {
    src,
    src2,
    ab,
    view,
    focus,
    cut,
    section,
    side,
    sidePos,
    sideFlip,
    clip,
    clipPos,
    clipFlip,
    box,
    boxX,
    boxZ,
    boxH,
    route,
    xray,
    hide,
    ui,
    debug,
    explode,
    style,
    renderer: params.get('renderer'),
    bright: params.get('bright'),
    present: [...new Set(params.keys())],
    raw,
    issues,
    search: params.toString(),
  };
}

/**
 * 按当前状态序列化查询串（不含开头 ?）。
 * 默认值不写入，未管理参数（renderer、bright、业务自定义参数）按原始顺序追加在末尾。
 * @param {object} state 视图状态（parseViewState 结果或控制器当前状态）
 * @param {{base?:string|URLSearchParams|object}} [opts] base = 原始查询串，用于保留未知参数
 */
export function serializeViewState(state, opts = {}) {
  const s = state || {};
  const base = toParams(opts.base != null ? opts.base : s.base);
  const src = s.src != null && String(s.src) !== '' ? String(s.src) : (base.get('src') || '');
  const out = [];
  const push = (k, v) => {
    if (v == null || v === '') return;
    out.push([k, String(v)]);
  };

  push('src', src);
  if (s.src2) push('src2', s.src2);
  if (s.src2 && s.ab === 'b') push('ab', 'b');
  if (s.view && s.view !== DEFAULT_VIEW) push('view', s.view);
  if (s.focus) push('focus', s.focus);
  if (s.cut != null && s.cut !== CUT_OFF && s.section !== 'side' && s.section !== 'clip' && s.section !== 'box') {
    push('cut', s.cut);
  }
  if (s.section && s.section !== 'off') push('section', s.section);
  if (s.section === 'side') {
    if (s.side && s.side !== 'x') push('side', s.side);
    if (s.sidePos != null && Number.isFinite(+s.sidePos)) push('sidePos', Math.round(+s.sidePos));
    if (s.sideFlip === true) push('sideFlip', '1');
  }
  if (s.section === 'clip') {
    if (s.clip && s.clip !== 'y') push('clip', s.clip);
    if (s.clipPos != null && Number.isFinite(+s.clipPos)) push('clipPos', Math.round(+s.clipPos));
    if (s.clipFlip === true) push('clipFlip', '1');
  }
  if (s.section === 'box') {
    if (s.box && s.box !== 'corner' && BOX_PRESETS.includes(s.box)) push('box', s.box);
    if (s.boxX != null && Number.isFinite(+s.boxX)) push('boxX', Math.round(+s.boxX));
    if (s.boxZ != null && Number.isFinite(+s.boxZ)) push('boxZ', Math.round(+s.boxZ));
    if (s.boxH != null && Number.isFinite(+s.boxH)) push('boxH', Math.round(+s.boxH));
  }
  if (s.route) push('route', s.route);
  if (s.xray === true) push('xray', '1');
  const hidden = serializeHidden(s.hide);
  if (hidden) push('hide', hidden);
  if (s.ui === false) push('ui', '0');
  if (s.debug) push('debug', s.debug);
  if (s.style === 'lineart') push('style', 'lineart');
  if (s.explode === 'review') push('explode', 'review');

  // 未管理参数原样保留（renderer / bright / 未来的业务参数），保持其原始相对顺序
  for (const [k, v] of base) {
    if (MANAGED_KEYS.includes(k)) continue;
    out.push([k, v]);
  }

  // encodeURIComponent 会把路径分隔符与协议冒号编码掉；查询串里保留它们可读性更好
  const enc = v => encodeURIComponent(v)
    .replace(/%2F/gi, '/').replace(/%3A/gi, ':').replace(/%2C/gi, ',');
  return out.map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
}

/**
 * 应用 URL 状态（视图 / UI / 路线 / 选中 / 剖切 / 显隐等）。
 * 调用顺序：UI 显隐 → 视图 → 焦点/剖切 → 分类显隐 → 透视/调试/呈现/爆炸 → 路线（最后，会退出当前视图）。
 *
 * @param {object} state parseViewState 结果
 * @param {object} deps 依赖注入：
 *   views.goTo、tour.start/info、setChromeVisible、
 *   applyFocus/applyCut/applySection/applySide/applyClip/applyBox/applyHide/
 *   applyXray/applyDebug/applyStyle/applyExplode
 * @returns {{applied:object, ignored:Array, pending:Array, issues:Array}}
 */
export function applyViewState(state, deps = {}) {
  const s = state || {};
  const issues = Array.isArray(s.issues) ? s.issues.slice() : [];
  const applied = {};
  const ignored = [];
  const pending = [];

  // 未实现的参数不是错误：先记录 pending，等模块注入 hook
  const TASK_OF = {
    focus: 'T14', cut: 'T09', section: 'T09/T10/T11/T23', xray: 'T12',
    hide: 'T33', debug: 'T25', style: 'T31', explode: 'T26',
  };
  const hook = (key, value, fn, readyWhen) => {
    if (typeof fn === 'function') {
      let ok = false;
      try { ok = fn(value) !== false; } catch (e) { ok = false; }
      if (ok) applied[key] = value;
      else ignored.push({ key, value, reason: 'rejected' });
    } else {
      const task = key === 'section' && value === 'side' ? 'T10' : (TASK_OF[key] || null);
      pending.push({ key, value, reason: 'not-implemented', task });
    }
  };

  if (typeof deps.setChromeVisible === 'function') {
    try { deps.setChromeVisible(s.ui !== false); } catch (e) { /* UI 未就绪时忽略 */ }
  }
  applied.ui = s.ui !== false;

  if (s.view && s.view !== DEFAULT_VIEW) {
    if (deps.views && typeof deps.views.goTo === 'function') {
      let ok = false;
      try { ok = deps.views.goTo(s.view) !== false; } catch (e) { ok = false; }
      if (ok) applied.view = s.view;
      else {
        applied.view = DEFAULT_VIEW;
        ignored.push({ key: 'view', value: s.view, reason: 'not-found' });
      }
    } else {
      pending.push({ key: 'view', value: s.view, reason: 'viewer-not-ready', task: 'T08' });
    }
  } else {
    applied.view = DEFAULT_VIEW;
  }

  if (s.focus) hook('focus', s.focus, deps.applyFocus);
  // 侧别/真裁剪/盒体模式只用一个 section 参数：同一条 URL 里混入的 cut 不应用（避免多套切面打架）
  if (s.cut != null && s.cut !== CUT_OFF && s.section !== 'side' && s.section !== 'clip' && s.section !== 'box') {
    hook('cut', s.cut, deps.applyCut);
  }
  if (s.section === 'side') {
    const side = { axis: s.side || 'x', pos: s.sidePos, flip: !!s.sideFlip };
    if (typeof deps.applySide === 'function') {
      let ok = false;
      try { ok = deps.applySide(side) !== false; } catch (e) { ok = false; }
      if (ok) {
        applied.section = 'side';
        applied.side = side;
      } else {
        ignored.push({ key: 'section', value: 'side', reason: 'rejected' });
      }
    } else {
      hook('section', 'side', deps.applySection);
    }
  } else if (s.section === 'clip') {
    const clip = { axis: s.clip || 'y', pos: s.clipPos, flip: !!s.clipFlip };
    if (typeof deps.applyClip === 'function') {
      let ok = false;
      try { ok = deps.applyClip(clip) !== false; } catch (e) { ok = false; }
      if (ok) {
        applied.section = 'clip';
        applied.clip = clip;
      } else {
        ignored.push({ key: 'section', value: 'clip', reason: 'rejected' });
      }
    } else {
      pending.push({ key: 'section', value: 'clip', reason: 'not-implemented', task: 'T11' });
    }
  } else if (s.section === 'box') {
    const box = { preset: s.box || 'corner', x: s.boxX, z: s.boxZ, h: s.boxH };
    if (typeof deps.applyBox === 'function') {
      let ok = false;
      try { ok = deps.applyBox(box) !== false; } catch (e) { ok = false; }
      if (ok) {
        applied.section = 'box';
        applied.box = box;
      } else {
        ignored.push({ key: 'section', value: 'box', reason: 'rejected' });
      }
    } else if (typeof deps.applySection === 'function') {
      hook('section', 'box', deps.applySection);
    } else {
      pending.push({ key: 'section', value: 'box', reason: 'not-implemented', task: 'T23' });
    }
  } else if (s.section && s.section !== 'off') {
    hook('section', s.section, deps.applySection);
  }
  if ((Array.isArray(s.hide) && s.hide.length) || (Array.isArray(s.present) && s.present.includes('hide'))) {
    hook('hide', s.hide || [], deps.applyHide);
  }
  if (s.xray) hook('xray', true, deps.applyXray);
  if (s.debug) hook('debug', s.debug, deps.applyDebug);
  if (s.style && s.style !== DEFAULT_STYLE) hook('style', s.style, deps.applyStyle);
  if (s.explode && s.explode !== 'presentation') hook('explode', s.explode, deps.applyExplode);

  if (s.route) {
    if (!isKnownRoute(s.route)) {
      ignored.push({ key: 'route', value: s.route, reason: 'unknown-route' });
    } else if (deps.tour && typeof deps.tour.start === 'function') {
      let ok = false;
      try { ok = deps.tour.start(s.route) === true; } catch (e) { ok = false; }
      if (ok) {
        const ti = typeof deps.tour.info === 'function' ? deps.tour.info() : null;
        const actual = (ti && ti.route) || deps.tour.routeId || s.route;
        applied.route = actual;
        if (ti && ti.routeFallback) applied.routeFallback = ti.routeFallback;
      } else {
        ignored.push({ key: 'route', value: s.route, reason: 'cannot-start' });
      }
    } else {
      pending.push({ key: 'route', value: s.route, reason: 'tour-not-ready', task: 'T20' });
    }
  }

  return { applied, ignored, pending, issues };
}
