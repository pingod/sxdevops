/**
 * 三维检视（union）：把当前项目交给 DCExplorer 只读查看器（tools/dc-viewer）。
 *
 * 设计：
 *  - 不复制查看器 UI/控制器；以 iframe 组合两个独立应用，查看器负责巡检/步行/剖切/定位/显示/拆解；
 *  - 数据只经 postMessage 传输（结构化克隆副本，避免父页引用被修改）；
 *  - 打开/关闭是纯视图操作，不改项目、不进撤销栈；
 *  - 查看器未构建（prod ./inspect/ 缺失）或 dev 5199 未启动时给出可操作提示，不静默失败。
 *
 * 协议：
 *  父 → 查看器：{ source:'dc-designer', type:'project', payload:{ project } }
 *  查看器 → 父：{ source:'dc-viewer', type:'ready' }（可重复）
 */
import { state } from './state.js';
import { t } from './i18n.js';

const BASE = (() => {
  if (typeof window !== 'undefined' && window.__DC_INSPECT_URL__) return window.__DC_INSPECT_URL__;
  const dev = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV;
  if (dev) {
    try { return `${location.protocol}//${location.hostname}:5199/`; } catch (e) { /* file:// */ }
  }
  return './inspect/index.html';
})();

let overlay = null;
let frame = null;
let ready = false;
let timer = 0;

const withEmbed = (url) => {
  const u = new URL(url, location.href);
  u.searchParams.set('embed', '1');
  u.searchParams.set('ui', '1');
  return u.href;
};

function build() {
  hide();
  overlay = document.createElement('div');
  overlay.id = 'dc-inspect';
  overlay.innerHTML = `
    <div class="dci-bar">
      <b>${t('inspect.title')}</b>
      <span>${t('inspect.hint')}</span>
      <button type="button" class="dci-back">${t('inspect.back')}</button>
    </div>
    <iframe title="${t('inspect.title')}" allow="fullscreen"></iframe>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.dci-back').addEventListener('click', hide);
  frame = overlay.querySelector('iframe');
  frame.src = withEmbed(BASE);
  timer = setTimeout(() => {
    if (ready) return;
    const hint = document.createElement('div');
    hint.className = 'dci-hint';
    hint.textContent = t('inspect.offline');
    overlay.appendChild(hint);
  }, 4500);
}

function sendProject() {
  if (!frame || !ready) return;
  const project = JSON.parse(JSON.stringify(state.project));
  frame.contentWindow.postMessage({ source: 'dc-designer', type: 'project', payload: { project } }, '*');
}

function onMessage(event) {
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || data.source !== 'dc-viewer' || data.type !== 'ready') return;
  ready = true;
  clearTimeout(timer);
  const hint = overlay && overlay.querySelector('.dci-hint');
  if (hint) hint.remove();
  sendProject();
}

export function openInspect() {
  if (!state.project) return;
  ready = false;
  build();
  window.addEventListener('message', onMessage);
}

export function hide() {
  window.removeEventListener('message', onMessage);
  clearTimeout(timer);
  ready = false;
  frame = null;
  if (overlay) { overlay.remove(); overlay = null; }
}

export function isInspectOpen() { return !!overlay; }

function init() {
  const btn = document.getElementById('btn-inspect');
  if (!btn) return;
  btn.addEventListener('click', openInspect);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !e.defaultPrevented) hide();
  });
  if (typeof window !== 'undefined') {
    window.__dcdInspect = { open: openInspect, hide, isOpen: isInspectOpen, base: BASE };
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
