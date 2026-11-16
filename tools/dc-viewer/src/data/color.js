/**
 * 机柜自定义颜色：规范化 + 派生配色（纯函数，无 DOM/three 依赖，可 Node 单测）。
 *
 *   body  柜体主色（设定色本身）
 *   front 正面色条 / 门框梁：亮柜压暗一档、暗柜提亮一档（保证正面有反差）
 *   edge  轮廓 / 立柱净面 / 网孔孔沿：比 front 再反一档
 *   text  柜内名称文字：压暗版柜色与白色中对比度更高的一档
 *   ghost 半透明基色
 */

const LIGHT_LUM = 0.3;

/** 未设定颜色时的兜底（与主题默认柜色一致） */
export const DEFAULT_CAB = Object.freeze({ body: '#e8edf4', front: '#4d5560', edge: '#22272e', ghost: '#3b424d' });

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 规范化柜色：`#abc` / `#aabbcc` / 无 `#` → 小写 `#rrggbb`；空值与非法值 → `''` */
export function normalizeCabColor(v) {
  if (typeof v !== 'string') return '';
  const m = HEX_RE.exec(v.trim());
  if (!m) return '';
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return '#' + h;
}

const toRgb = hex => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const toHex = (r, g, b) =>
  '#' +
  [r, g, b]
    .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('');

/** `#rrggbb` → 0xRRGGBB */
export const hexInt = hex => parseInt(normalizeCabColor(hex).slice(1), 16) || 0;

function mixHex(a, b, t) {
  const ca = normalizeCabColor(a);
  const cb = normalizeCabColor(b);
  if (!ca) return '';
  if (!cb) return ca;
  const [r1, g1, b1] = toRgb(ca);
  const [r2, g2, b2] = toRgb(cb);
  const k = Math.max(0, Math.min(1, +t || 0));
  return toHex(r1 + (r2 - r1) * k, g1 + (g2 - g1) * k, b1 + (b2 - b1) * k);
}

/** 明暗调整：amt>0 提亮、amt<0 压暗 */
export function shadeHex(hex, amt) {
  const c = normalizeCabColor(hex);
  if (!c) return '';
  const k = Math.max(-1, Math.min(1, +amt || 0));
  return k >= 0 ? mixHex(c, '#ffffff', k) : mixHex(c, '#000000', -k);
}

/** 相对亮度（WCAG sRGB 线性化加权，0 黑 / 1 白） */
export function hexLuminance(hex) {
  const c = normalizeCabColor(hex);
  if (!c) return 1;
  const lin = v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const [r, g, b] = toRgb(c).map(v => lin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `#rrggbb` + alpha → `rgba(...)` */
export function rgbaHex(hex, alpha) {
  const c = normalizeCabColor(hex);
  const a = Math.max(0, Math.min(1, +alpha || 0));
  if (!c) return `rgba(0,0,0,${a})`;
  const [r, g, b] = toRgb(c);
  return `rgba(${r},${g},${b},${a})`;
}

function textOn(hex, lum) {
  const dark = shadeHex(hex, -0.85);
  const dl = hexLuminance(dark);
  const cWhite = 1.05 / (lum + 0.05);
  const cDark = (lum + 0.05) / (dl + 0.05);
  return cWhite >= cDark ? '#ffffff' : dark;
}

/** 柜色派生：`{ body, front, edge, text, ghost, custom }`；空/非法色原样回传 base */
export function cabPaint(hex, base = DEFAULT_CAB) {
  const b = base || DEFAULT_CAB;
  const c = normalizeCabColor(hex);
  if (!c) {
    return { body: b.body, front: b.front, edge: b.edge, ghost: b.ghost || b.front, text: b.edge, custom: false };
  }
  const lum = hexLuminance(c);
  const light = lum >= LIGHT_LUM;
  return {
    body: c,
    front: light ? shadeHex(c, -0.42) : shadeHex(c, 0.28),
    edge: light ? shadeHex(c, -0.68) : shadeHex(c, 0.6),
    text: textOn(c, lum),
    ghost: light ? shadeHex(c, -0.5) : shadeHex(c, 0.42),
    custom: true,
  };
}
