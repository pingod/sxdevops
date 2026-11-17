/** i18n 核心：语言管理、t() 翻译、静态 DOM 文案同步、语言切换器、RTL 支持。
 * 支持语言：zh-CN（默认/回退）、en、ar（从右到左）、es。
 * 用法：
 *  - t('key', {param}) 取翻译（HTML 拼接前请自行转义用户输入）；
 *  - setLocale('en') 切换语言（持久化到 localStorage）；
 *  - initI18n() 启动时调用：设置 html lang/dir、同步静态文案、绑定切换器；
 *  - applyDom() 把 [data-i18n] / [data-i18n-title] / [data-i18n-ph] 同步为当前语言；
 *  - onLocaleChange(fn) 注册语言切换回调（重建动态面板/重绘画布用）；
 *  - tType(type) 对象类型名（TYPE_NAMES 的国际化实现）。
 * Node 环境（单元测试）无 document/localStorage：所有 DOM 访问均已守卫，t() 可用。 */

import { zhCN } from './i18n/zh.js';
import { en } from './i18n/en.js';

import { pipeDicts } from './i18n/pipe.js';
import { distributionBoxDicts } from './i18n/distribution-box.js';
import { sidebarDicts } from './i18n/sidebar.js';
import { jointDicts } from './i18n/joints3d.js';
const DICTS = Object.fromEntries(Object.entries({ 'zh-CN': zhCN, en })
  .map(([locale, dict]) => [locale, { ...dict, ...pipeDicts[locale], ...distributionBoxDicts[locale], ...sidebarDicts[locale], ...jointDicts[locale] }]));
const FALLBACK = 'zh-CN';
const LOCALE_KEY = 'dcd:locale';

let current = detectLocale();
const changeHandlers = [];

/** 初始语言：localStorage 记忆 → 浏览器语言（es/ar/en 前缀）→ 默认中文 */
function detectLocale() {
  try {
    // 平台内嵌可显式指定语言（?lang=zh-CN|en），优先于本机记忆与浏览器语言
    const forced = new URLSearchParams(location.search).get('lang');
    if (forced && DICTS[forced]) return forced;
  } catch (e) { /* file:// / 非浏览器 */ }
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved && DICTS[saved]) return saved;
    const nav = String(navigator.language || navigator.userLanguage || '').toLowerCase();
    if (nav.startsWith('en')) return 'en';
  } catch (e) { /* Node/隐私模式 */ }
  return FALLBACK;
}

export function getLocale() { return current; }
export function isRTL() { return false; }
export function supportedLocales() { return Object.keys(DICTS); }

/** 占位符替换：t('hint.deletedN', {n: 3}) → "已删除 3 个对象" */
const fmt = (s, params) => String(s).replace(/\{(\w+)\}/g, (m, k) =>
  params && params[k] !== undefined ? params[k] : m);

/** 取当前语言文案；缺失时回退中文；仍缺失返回键名（便于发现漏译） */
export function t(key, params) {
  const d = DICTS[current] || DICTS[FALLBACK];
  let v = d[key];
  if (v === undefined) v = DICTS[FALLBACK][key];
  if (v === undefined) return key;
  return params ? fmt(v, params) : v;
}

/** 对象类型显示名（state.TYPE_NAMES 由本函数驱动，语言切换后自动更新） */
export const tType = type => t('type.' + type, { d: type });

/** name 是否为任一语言的默认项目名（未命名）：用于跨语言切换时识别“系统生成的名字” */
export function isDefaultName(name) {
  return Object.values(DICTS).some(d => d['project.untitled'] === name);
}

/** 注册语言切换回调（面板重建、画布重绘等） */
export function onLocaleChange(fn) { changeHandlers.push(fn); }

/** 设置 html lang / dir（ar 为 RTL）与页面标题 */
function applyDocAttrs() {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  el.lang = current;
  el.dir = isRTL() ? 'rtl' : 'ltr';
  document.title = t('app.title');
}

/* ---------- 静态 DOM 文案同步 ---------- */
const DOM_ATTRS = [
  ['data-i18n', (el, v) => { el.textContent = v; }],
  // tooltip.js 悬停期间会把 title 暂存到 dataset.title：同步改写暂存值，防止鼠标移出时把旧语言还原回去
  ['data-i18n-title', (el, v) => {
    el.setAttribute('title', v);
    if (el.dataset && el.dataset.title !== undefined) el.dataset.title = v;
  }],
  ['data-i18n-ph', (el, v) => { el.setAttribute('placeholder', v); }],
];

/** 把 root 内所有带 data-i18n* 属性的元素同步为当前语言 */
export function applyDom(root) {
  if (typeof document === 'undefined') return;
  for (const [attr, set] of DOM_ATTRS) {
    (root || document).querySelectorAll(`[${attr}]`).forEach(el =>
      set(el, t(el.getAttribute(attr))));
  }
}

/** 切换语言并刷新全部界面；非法语言值忽略 */
export function setLocale(loc) {
  if (!DICTS[loc] || loc === current) return;
  current = loc;
  try { localStorage.setItem(LOCALE_KEY, loc); } catch (e) { /* ignore */ }
  applyDocAttrs();
  applyDom();
  for (const fn of changeHandlers) fn(loc);
}

/** 启动初始化：语言属性、静态文案、语言切换器绑定（main.js 最先调用） */
export function initI18n() {
  if (typeof document === 'undefined') return;
  applyDocAttrs();
  applyDom();
  const sel = document.getElementById('lang-sel');
  if (sel) {
    sel.value = current;
    sel.title = t('lang.title');
    sel.addEventListener('change', () => setLocale(sel.value));
  }
}
