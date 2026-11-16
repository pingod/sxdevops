/** 视角面板：总览与工程视角 + 场景机位（运行时派生）。 */
import { group } from '../dom.js';

export const VIEW_ITEMS = Object.freeze([
  { id: 'orbit', label: '全景轨道', ico: '◱', hint: '透视 · 3/4 俯视' },
  { id: 'top', label: '俯视平面', ico: '▦', hint: '正交 · 北朝上' },
  { id: 'iso', label: '轴测总览', ico: '◈', hint: '正交 · 平行投影' },
  { id: 'front', label: '南立面', ico: '▥', hint: '从南向北 · 正交立面 · 近墙隐藏' },
  { id: 'back', label: '北立面', ico: '▤', hint: '从北向南 · 正交立面 · 近墙隐藏' },
  { id: 'left', label: '西立面', ico: '◧', hint: '从西向东 · 正交立面 · 近墙隐藏' },
  { id: 'right', label: '东立面', ico: '◨', hint: '从东向西 · 正交立面 · 近墙隐藏' },
]);

const VP_ICO = { entry: '⌂', corner: '◆', aisle: '⇥', area: '▣', preset: '▦' };

export function createViewPanel({ onPick }) {
  const el = document.createElement('div');
  const base = VIEW_ITEMS.map(v => `<button type="button" class="vd-item" data-view="${v.id}" aria-pressed="false"
      title="${v.label} · ${v.hint}"><span class="vd-ico" aria-hidden="true">${v.ico}</span>
      <span class="vd-txt"><b>${v.label}</b><small>${v.hint}</small></span></button>`).join('');
  el.innerHTML = `<section class="vd-group" data-group="view">${group('总览与工程视角', '全景透视 / 正交平面 / 轴测 / 立面')}
      <div class="vd-items vd-items-3">${base}</div></section>
    <section class="vd-group" data-group="viewpoint" hidden>
      <div class="vd-group-head"><h2 class="vd-group-title">场景机位</h2>
      <span class="vd-group-hint">透视 · 入口 / 四角 / 通道 / 设备区</span></div>
      <div class="vd-items vd-items-3"></div></section>`;
  const vpGroup = el.querySelector('[data-group="viewpoint"]');
  const vpList = vpGroup.querySelector('.vd-items');
  let lastKey = '';

  el.addEventListener('click', e => {
    const b = e.target.closest('[data-view],[data-vp]');
    if (!b || b.disabled) return;
    onPick(b.dataset.view || b.dataset.vp, b.dataset.kind || 'preset');
  });

  function refresh(state) {
    const active = state.activeId;
    for (const b of el.querySelectorAll('[data-view]')) {
      const pressed = b.dataset.view === active;
      b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      b.classList.toggle('is-active', pressed);
      b.disabled = !!state.busy;
    }
    const list = (state.viewpoints || []).filter(v => v.kind !== 'preset');
    const key = list.map(v => v.id + '|' + v.label).join(',');
    if (key !== lastKey) {
      lastKey = key;
      vpList.innerHTML = list.map(v => {
        const label = v.kind === 'corner' ? v.label + '机位' : v.label;
        const ico = VP_ICO[v.kind] || '◆';
        return `<button type="button" class="vd-item" data-vp="${v.id}" data-kind="${v.kind}" aria-pressed="false"
          title="${v.label} · ${v.hint}"><span class="vd-ico" aria-hidden="true">${ico}</span>
          <span class="vd-txt"><b>${label}</b><small>透视 · ${v.hint}</small></span></button>`;
      }).join('');
    }
    vpGroup.hidden = list.length === 0;
    for (const b of vpList.querySelectorAll('[data-vp]')) {
      const pressed = b.dataset.vp === active;
      b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      b.classList.toggle('is-active', pressed);
      b.disabled = !!state.busy;
    }
  }

  return { el, refresh };
}
