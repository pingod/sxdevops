/**
 * 设备共用自定义颜色（历史模块名保留以兼容机柜调用）：颜色规范化 + 派生配色（2D/3D 共用）。
 *
 * 数据模型：设备 `props.color` = `''`（该类型默认色，走主题配色）或 `'#rrggbb'`。
 * 覆盖 cabinet/pdu/ups/battery/ac/extinguisher/vent，函数名保留以兼容既有机柜代码。
 * 2D 只画矩形 + 正面色条 + 名称，因此只需要「体色 / 正面色条 / 轮廓与文字」三档；
 * 3D 需要钣金、门框梁、U 位立柱几处材质色，同样从这三档派生——两端观感一致：
 *
 *   body  设定色本身（柜体主色）
 *   front 正面色条 / 门框梁：亮色柜体压暗一档、暗色柜体提亮一档
 *         （朝向标识必须相对柜体明暗有一档反差，否则深色柜体上看不出正面）
 *   edge  轮廓线 / 立柱净面 / 网孔孔沿：比 front 再反一档，浅灰底与深色柜体上都可辨
 *   text  柜内名称文字：在「压暗的柜色」与白色之间取对比度更高的一档（浅底深字 / 深底白字）
 *   ghost 放置预览的半透明基色
 *
 * 未设颜色时 `cabPaint()` 原样回传传入的主题默认配色（2D 传 render.js 的 `P.cabinet`），
 * 所以调用侧无需分支：`const pc = cabPaint(o.props.color, P.cabinet)`。
 * 本模块为纯函数 + 常量，无 DOM/THREE 依赖，Node 单测可直接 import。
 */

/** 相对亮度分界：≥ 该值视为「亮色柜体」（取深色件），否则视为「暗色柜体」（取浅色件） */
const LIGHT_LUM = 0.3;

/** 未传基准配色时的兜底（与 render.js 的 P.cabinet 默认柜色一致，仅供单测/独立调用） */
const DEFAULT_BASE = { body: '#e8edf4', front: '#4d5560', edge: '#22272e', ghost: '#3b424d' };

/** 属性面板快捷色板（常见机柜钣金/喷涂色；点一下即套用，默认柜色用空值表示，不在色板里） */
export const CABINET_PRESETS = [
  '#1b1f24', // 深空黑
  '#4d5560', // 石墨灰
  '#8a939e', // 铝灰
  '#e8edf4', // 云白
  '#2f6fb2', // 品牌蓝
  '#2e9e6e', // 青绿
  '#e0a02c', // 琥珀
  '#c0392b', // 消防红
];

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 规范化颜色值：接受 `#abc` / `#aabbcc` / 不带 `#`，统一为小写 `#rrggbb`；
 *  空值与非法值一律返回 `''`（= 默认柜色，渲染走主题配色） */
export function normalizeCabColor(v) {
  if (typeof v !== 'string') return '';
  const m = HEX_RE.exec(v.trim());
  if (!m) return '';
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return '#' + h;
}

/** 颜色值是否合法（属性面板/数据清洗共用） */
export const isCabColor = v => normalizeCabColor(v) !== '';

const toRgb = hex => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (r, g, b) => '#' + [r, g, b]
  .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** `#rrggbb` → 0xRRGGBB（three.js 材质用） */
export const hexInt = hex => parseInt(normalizeCabColor(hex).slice(1), 16) || 0;

/** 双色线性混合：t=0 取 a、t=1 取 b（非法入参返回 a 的规范值） */
export function mixHex(a, b, t) {
  const ca = normalizeCabColor(a), cb = normalizeCabColor(b);
  if (!ca) return '';
  if (!cb) return ca;
  const [r1, g1, b1] = toRgb(ca), [r2, g2, b2] = toRgb(cb);
  const k = Math.max(0, Math.min(1, +t || 0));
  return toHex(r1 + (r2 - r1) * k, g1 + (g2 - g1) * k, b1 + (b2 - b1) * k);
}

/** 明暗调整：amt>0 向白提亮、amt<0 向黑压暗（|amt|≤1） */
export function shadeHex(hex, amt) {
  const c = normalizeCabColor(hex);
  if (!c) return '';
  const k = Math.max(-1, Math.min(1, +amt || 0));
  return k >= 0 ? mixHex(c, '#ffffff', k) : mixHex(c, '#000000', -k);
}

/** 相对亮度（WCAG sRGB 线性化加权，0=黑 / 1=白）：用于判断「亮底深字 / 深底浅字」 */
export function hexLuminance(hex) {
  const c = normalizeCabColor(hex);
  if (!c) return 1;
  const lin = v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const [r, g, b] = toRgb(c).map(v => lin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `#rrggbb` + 透明度 → `rgba(...)`（画布半透明填充 / 纹理孔沿用） */
export function rgbaHex(hex, alpha) {
  const c = normalizeCabColor(hex);
  if (!c) return `rgba(0,0,0,${Math.max(0, Math.min(1, +alpha || 0))})`;
  const [r, g, b] = toRgb(c);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, +alpha || 0))})`;
}

/** 文字取色：压暗版柜色与纯白之间取对比度更高的一档（保证任意柜色下名称都可读） */
function textOn(hex, lum) {
  const dark = shadeHex(hex, -0.85);
  const dl = hexLuminance(dark);
  const cWhite = 1.05 / (lum + 0.05);              // 白字对比度
  const cDark = (lum + 0.05) / (dl + 0.05);        // 深字对比度
  return cWhite >= cDark ? '#ffffff' : dark;
}

/**
 * 柜色派生：返回 `{ body, front, edge, text, ghost, custom }`。
 * - `hex` 为空/非法 → 原样回传 `base`（主题默认配色）+ `text = base.edge`、`custom=false`；
 * - `base` 省略时用内置默认柜色（与 2D 主题一致），独立调用（单测/3D）也安全。
 * @param {string} hex 机柜颜色（'' 或 #rrggbb）
 * @param {{body:string,front:string,edge:string,ghost:string}} [base] 主题默认配色
 */
export function cabPaint(hex, base = DEFAULT_BASE) {
  const b = base || DEFAULT_BASE;
  const c = normalizeCabColor(hex);
  if (!c) return { body: b.body, front: b.front, edge: b.edge, ghost: b.ghost || b.front, text: b.edge, custom: false };
  const lum = hexLuminance(c);
  const light = lum >= LIGHT_LUM;            // 亮色柜体 → 深色件；暗色柜体 → 浅色件
  return {
    body: c,
    front: light ? shadeHex(c, -0.42) : shadeHex(c, 0.28),
    edge: light ? shadeHex(c, -0.68) : shadeHex(c, 0.6),
    text: textOn(c, lum),
    ghost: light ? shadeHex(c, -0.5) : shadeHex(c, 0.42),
    custom: true,
  };
}
