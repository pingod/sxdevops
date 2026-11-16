/** 漫游面板：开始自动巡视 + 手动步行 + 当前路线摘要 + 路线清单。 */
import { group } from '../dom.js';

export function createRoamPanel(cb = {}) {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="roam-actions">
      <button type="button" class="tour-start" id="tour-start" aria-keyshortcuts="G"
        title="立即沿当前路线自动巡视，进入后可暂停、调速或切换手动步行">
        <span class="ts-ico" aria-hidden="true">▶</span><span class="ts-txt">开始自动巡视</span></button>
      <div class="vd-items vd-items-2">
        <button type="button" class="vd-item" data-walk aria-pressed="false"
          title="WASD / 摇杆 · 拖拽看向 · 点击选中 · G；HUD「切自动」回巡检">
          <span class="vd-ico" aria-hidden="true">⇢</span>
          <span class="vd-txt"><b>手动步行</b><small>自己控制方向与步速</small></span></button>
      </div>
    </div>
    <span class="roam-summary" aria-live="polite"></span>
    <section class="vd-group" data-group="route">
      ${group('选择巡视路线', '点击路线立即巡视')}
      <div class="vd-items"></div>
    </section>`;

  const summary = el.querySelector('.roam-summary');
  const routeList = el.querySelector('.vd-group[data-group="route"] .vd-items');
  const routeHintEl = el.querySelector('.vd-group[data-group="route"] .vd-group-hint');
  const tourBtn = el.querySelector('#tour-start');
  const walkBtn = el.querySelector('[data-walk]');

  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.id === 'tour-start') return cb.onTour && cb.onTour();
    if (b.hasAttribute('data-walk')) return cb.onWalk && cb.onWalk();
    if (b.dataset.route) return cb.onRoute && cb.onRoute(b.dataset.route);
    return undefined;
  });

  function refresh(state) {
    const busy = !!state.busy;
    const routes = state.routes || [];
    const current = state.route || 'all';
    tourBtn.disabled = busy || !state.canTour;
    walkBtn.disabled = busy || !state.canWalk || state.walkActive;
    walkBtn.setAttribute('aria-pressed', state.walkActive ? 'true' : 'false');
    walkBtn.classList.toggle('is-active', !!state.walkActive);
    summary.textContent = state.summary || `当前路线：${state.routeLabel || '全场环线'}`;
    routeHintEl.textContent = state.routeHintText || `点击路线立即巡视 · ${routes.length} 条可用`;
    const key = routes.map(r => `${r.id}:${r.label}:${r.available === false ? 0 : 1}`).join('|');
    if (key !== routeList.dataset.key) {
      routeList.dataset.key = key;
      routeList.innerHTML = routes.map(r => {
        const ico = r.kind === 'inspection' ? '◉' : r.kind === 'row' ? '▤' : '▶';
        return `<button type="button" class="vd-item" data-route="${r.id}" aria-pressed="false"
          title="${r.hint || ''}"${r.available === false ? ' disabled' : ''}>
          <span class="vd-ico" aria-hidden="true">${ico}</span>
          <span class="vd-txt"><b>${r.label}</b><small>${r.hint || ''}</small></span></button>`;
      }).join('');
    }
    for (const b of routeList.querySelectorAll('[data-route]')) {
      const on = b.dataset.route === current && state.tourActive;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-active', on);
    }
  }

  return { el, refresh, tourBtn };
}
