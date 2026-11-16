/**
 * 可访问性纯规则：颜色对比度、减少动效与焦点 / 触摸目标基线。
 *
 * 只放不依赖 DOM / three 的常量与函数，便于 Node 单测。颜色取值与
 * styles/tokens.css 的 :root 变量一致：
 *   · 浅色背景上的焦点环 #0f8f77：对白 4.03:1（非文本 3:1 达标）；
 *   · 选中柜号标签 #007c92 + 白字：4.89:1（普通文本 4.5:1 达标）；
 *   · 浅色面板弱化文字 #5d6d7e：对白 5.31:1；
 *   · 深色 HUD 焦点环 #1abc9c：对 #16222e 6.69:1。
 */

export const A11Y = Object.freeze({
  /** 浅色背景上的焦点环（非文本 3:1） */
  focusOnLight: '#0f8f77',
  /** 深色 HUD / 上下文条上的焦点环 */
  focusOnDark: '#1abc9c',
  /** 选中柜号标签：深青底 + 白字（4.89:1） */
  selectedLabelBg: '#007c92',
  selectedLabelFg: '#ffffff',
  /** 浅色面板里的弱化说明文字（5.31:1） */
  mutedOnLight: '#5d6d7e',
  /** 浅色面板里的状态 / 关闭文案（4.76:1） */
  subtleOnLight: '#64748b',
  /** 柜号标签常态：深灰蓝字 + 白底 */
  labelFg: '#2c3e50',
  labelBg: '#ffffff',
  /** 排号标签：深绿字 + 白底 */
  rowFg: '#14544a',
  rowBg: '#ffffff',
  /** 底部按钮组 / 抽屉项的触屏目标（CSS 像素） */
  touchTarget: 44,
});

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 把 #rgb / #rrggbb 规范化为 {r,g,b}（0–255）；非法值返回 null */
export function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  const s = hex.trim();
  if (!HEX.test(s)) return null;
  const body = s.slice(1);
  const full = body.length === 3 ? body.split('').map(c => c + c).join('') : body;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** sRGB 相对亮度（WCAG 2.x）：0 = 黑，1 = 白 */
export function srgbLuminance(hex) {
  const c = parseHex(hex);
  if (!c) return 0;
  const ch = v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** 两色对比度：1–21；非法颜色按黑色处理，保证调用方拿到有限值 */
export function contrastRatio(a, b) {
  const l1 = srgbLuminance(a);
  const l2 = srgbLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** 是否达到指定对比度（默认普通文本 4.5；非文本 / 大字号可传 3） */
export function meetsContrast(fg, bg, min = 4.5) {
  return contrastRatio(fg, bg) >= min - 1e-9;
}

/** 与 CSS `(prefers-reduced-motion: reduce)` 一致；无 window/matchMedia 时视为 false */
export function prefersReducedMotion(win = typeof window !== 'undefined' ? window : null) {
  return !!(win && typeof win.matchMedia === 'function'
    && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** 减少动效时直接返回 0（调用方据此走「瞬时终态」分支） */
export function motionDuration(seconds, reduced) {
  const s = Number(seconds);
  return reduced ? 0 : (Number.isFinite(s) && s > 0 ? s : 0);
}
