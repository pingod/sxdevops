/** 右侧统一工作区：属性 / AI建模。
 * 只管理标签、收起和宽度；属性刷新不触碰 AI DOM，AI 隐藏不等于停止请求。
 * 沿用旧属性栏的存储键和 phide 类，兼容已有宽度、收起状态。
 */
import { ui } from './state.js';
import { icon } from './icons.js';
import { t, isRTL, onLocaleChange } from './i18n.js';
import { loadUI, patchUI } from './uistate.js';
import { notifyPanelState, onPanelBusy } from './panels.js';

const WIDTH_KEY = 'idc2d_props_w_v1';
const MIN_WIDTH = 240, MAX_WIDTH = 560;
let main, root, tabs, closeBtn, aiView;
let tab = 'props', hidden = false, aiVisible = false;
let busy = false, pending = false, initialized = false;

export function isAiVisible() { return aiVisible; }

/** AI 只注册一个视图适配器，首次真正显示时才懒构建。 */
export function registerAiView(view) {
  aiView = view;
  if (initialized) aiView.setVisible(aiVisible, false);
}

/** 待确认与 busy 分离：等待用户确认时编排器已经不忙。 */
export function setAiPending(value) {
  pending = !!value;
  if (initialized) syncStatus();
}

function setTitle(node, text) {
  node.title = text;
  // tooltip.js 悬停时暂存 title；切换状态 / 语言也必须同步暂存值。
  if (node.dataset.title !== undefined) node.dataset.title = text;
}

function syncStatus() {
  const badge = document.getElementById('sidebar-ai-status');
  badge.hidden = !busy && !pending;
  badge.textContent = pending ? t('sidebar.pending') : (busy ? '●' : '');
  badge.classList.toggle('pending', pending);
  const title = pending ? t('sidebar.pending') : (busy ? t('aip.thinking') : t('sidebar.ai'));
  setTitle(tabs[1], title);
  badge.setAttribute('aria-label', title);
  tabs[1].setAttribute('aria-label', t('sidebar.ai') + (pending || busy ? ' · ' + title : ''));
  closeBtn.classList.toggle('has-ai-status', busy || pending);
  const action = hidden ? t('sidebar.expand') : t('sidebar.close');
  closeBtn.setAttribute('aria-label', action + (hidden && (pending || busy) ? ' · ' + title : ''));
}

function syncTexts() {
  const text = hidden ? t('sidebar.expand') : t('sidebar.close');
  closeBtn.innerHTML = icon(hidden ? 'bars' : 'x');
  setTitle(closeBtn, text);
  closeBtn.setAttribute('aria-label', text);
  closeBtn.setAttribute('aria-expanded', String(!hidden));
  root.setAttribute('aria-label', t('sidebar.title'));
  document.getElementById('sidebar-tabs').setAttribute('aria-label', t('sidebar.title'));
  const grip = document.getElementById('props-grip');
  setTitle(grip, t('sidebar.resize'));
  syncStatus();
}

function render({ focus = false } = {}) {
  main.classList.toggle('phide', hidden);
  main.classList.toggle('ai-tab', tab === 'ai');
  root.dataset.tab = tab;
  document.getElementById('props').hidden = hidden || tab !== 'props';
  tabs.forEach(b => {
    const selected = b.dataset.sidebarTab === tab;
    b.setAttribute('aria-selected', String(selected));
    b.tabIndex = selected ? 0 : -1;
    b.classList.toggle('active', selected);
  });
  const visible = !hidden && tab === 'ai';
  if (visible !== aiVisible) {
    aiVisible = visible;
    if (aiView) aiView.setVisible(visible, focus);
    notifyPanelState('ai', visible);
  } else if (visible && focus && aiView) aiView.setVisible(true, true);
  syncTexts();
}

/** 显式进入 AI 时默认收左栏；之后打开向导/自检不再把 AI 挤下线。 */
export function selectSidebarTab(next, { focus = false, collapseLeft = true } = {}) {
  if (!initialized || !['props', 'ai'].includes(next)) return;
  if (next === 'props' && document.body.classList.contains('mode3d')) return;
  const enteringAi = next === 'ai' && (tab !== 'ai' || hidden);
  tab = next;
  hidden = false;
  patchUI('sidebarTab', tab);
  patchUI('propsHidden', false);
  if (enteringAi && collapseLeft) notifyPanelState('ai-enter', true);
  render({ focus });
  ui.resize();
}

export function closeSidebar() {
  if (!initialized || hidden) return;
  hidden = true;
  patchUI('propsHidden', true);
  render();
  ui.resize();
}

function setWidth(w, persist = true) {
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
  main.style.setProperty('--props-w', width + 'px');
  if (persist) try { localStorage.setItem(WIDTH_KEY, String(width)); } catch (e) { /* 隐私模式 */ }
}

function initResize() {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) setWidth(saved, false);
  } catch (e) { /* 隐私模式 */ }
  const grip = document.getElementById('props-grip');
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('presize');
    const startX = e.clientX, startWidth = root.getBoundingClientRect().width;
    const direction = isRTL() ? 1 : -1;
    let raf = 0, width = startWidth;
    const move = ev => {
      width = startWidth + direction * (ev.clientX - startX);
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setWidth(width); ui.resize(); });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      document.body.classList.remove('presize');
      if (raf) { cancelAnimationFrame(raf); setWidth(width); ui.resize(); }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => {
    main.style.removeProperty('--props-w');
    try { localStorage.removeItem(WIDTH_KEY); } catch (e) { /* 隐私模式 */ }
    ui.resize();
  });
}

const AI_ENABLED = (() => {
  try { return new URLSearchParams(location.search).get('ai') === '1'; } catch (e) { return false; }
})();

export function initSidebar() {
  if (initialized) return;
  main = document.querySelector('main');
  root = document.getElementById('sidebar');
  tabs = [...root.querySelectorAll('[role="tab"]')];
  closeBtn = document.getElementById('props-close');
  const saved = loadUI();
  tab = saved.sidebarTab;
  hidden = saved.propsHidden;
  initialized = true;
  tabs.forEach(b => b.addEventListener('click', () => selectSidebarTab(b.dataset.sidebarTab)));
  document.getElementById('sidebar-tabs').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation(); // 不让方向键冒泡到画布快捷键，避免切 TAB 时微移选中对象
    const enabled = tabs.filter(b => !b.disabled);
    const i = enabled.indexOf(document.activeElement);
    const step = (e.key === 'ArrowRight') !== isRTL() ? 1 : -1;
    const next = e.key === 'Home' ? enabled[0] : e.key === 'End' ? enabled[enabled.length - 1]
      : enabled[(i + step + enabled.length) % enabled.length];
    next.focus();
    selectSidebarTab(next.dataset.sidebarTab);
  });
  closeBtn.addEventListener('click', () => {
    if (hidden) selectSidebarTab(tab);
    else closeSidebar();
  });
  onPanelBusy(d => { if (d.name === 'ai') { busy = d.busy; syncStatus(); } });
  onLocaleChange(syncTexts);
  // 3D 仍可用 AI，但不开放 2D 属性编辑；属性态整个右栏不占位。
  new MutationObserver(() => {
    const mode3d = document.body.classList.contains('mode3d');
    tabs[0].disabled = mode3d;
    if (mode3d && document.activeElement === tabs[0]) tabs[1].focus();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  initResize();
  if (!AI_ENABLED) {
    // AI 建模已拆到 AIOps「AI 机房建模」：普通设计器不加载/不显示 AI 入口
    const btn = document.getElementById('btn-ai');
    if (btn) btn.style.display = 'none';
    const tabAi = document.getElementById('tab-ai');
    if (tabAi) tabAi.style.display = 'none';
    if (tab === 'ai') tab = 'props';
  }
  render(); // 刷新恢复不广播 ai-enter，保留用户显式展开的左栏
  if (AI_ENABLED) setTimeout(() => selectSidebarTab('ai', { focus: true }), 0);
}
