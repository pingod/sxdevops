/** 显示面板：方案对比 + 分类显隐 + 呈现方式 + 围护透视 + 柜号标签。 */
import { group, setOut } from '../dom.js';

const DIFF_ORDER = ['added', 'removed', 'moved', 'changed'];
const DIFF_META = {
  added: { label: '新增', hint: 'B 有 · A 无', color: '#22c55e' },
  removed: { label: '删除', hint: 'A 有 · B 无', color: '#ef4444' },
  moved: { label: '移动', hint: '位置 / 朝向变化', color: '#f59e0b' },
  changed: { label: '属性变化', hint: '尺寸 / 参数 / 名称', color: '#8b5cf6' },
};

export function createDisplayPanel({ onTypeToggle, onTypePreset, onStyle, onXray, onLabels, onCompareSide }) {
  const el = document.createElement('div');
  el.innerHTML = `
    <section class="vd-group vd-compare" aria-label="方案对比" hidden>
      <div class="vd-group-head"><h2 class="vd-group-title">方案对比</h2>
        <span class="vd-group-hint">同一视角 · 按对象 id 对比</span></div>
      <div class="vd-compare-switch" role="group" aria-label="切换方案 A / B"></div>
      <div class="vd-compare-legend" role="list" aria-label="差异图例"></div>
      <small class="vd-compare-note" role="status" aria-live="polite"></small>
    </section>
    <div class="vd-range vd-types">
      <div class="vd-range-head"><label>分类显隐</label><output>全部显示</output></div>
      <div class="vd-side-btns vd-types-presets"></div>
      <div class="vd-type-list"></div>
      <small class="vd-range-note">按分类整组隐藏 · 地板始终显示 · 可与剖切 / 透视 / 隔离叠加</small>
    </div>
    <div class="tool-heading"><h2>呈现方式</h2><small>实景或白模线稿；围护透视只影响墙、门窗与吊顶</small></div>
    <div class="vd-side-btns style-options">
      <button type="button" class="vd-mini" data-style="real" aria-pressed="true">实景材质</button>
      <button type="button" class="vd-mini" data-style="lineart" aria-pressed="false">白模线稿 <kbd>K</kbd></button>
    </div>
    <div class="vd-range vd-xray">
      <div class="vd-range-head"><label>围护透视</label><output>关闭</output></div>
      <small class="vd-range-note">只透墙/门/窗/格栅/吊顶 · 设备保持不透明 · X 切换</small>
    </div>
    <div class="vd-range vd-labels">
      <div class="vd-range-head"><label>柜号标签</label><output>关闭</output></div>
      <small class="vd-range-note">俯视/轴测生效 · 放大显示柜号 · 点击标签选中机柜 · L 切换</small>
    </div>`;

  const compareEl = el.querySelector('.vd-compare');
  const switchEl = el.querySelector('.vd-compare-switch');
  const legendEl = el.querySelector('.vd-compare-legend');
  const noteEl = el.querySelector('.vd-compare-note');
  const typeOut = el.querySelector('.vd-types output');
  const presetWrap = el.querySelector('.vd-types-presets');
  const typeList = el.querySelector('.vd-type-list');
  const xrayOut = el.querySelector('.vd-xray output');
  const labelOut = el.querySelector('.vd-labels output');
  let presetsRendered = '';
  let typesRendered = '';

  el.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.style) return onStyle(t.dataset.style);
    if (t.dataset.typePreset !== undefined) return onTypePreset(t.dataset.typePreset);
    if (t.dataset.typeId) return onTypeToggle(t.dataset.typeId);
    if (t.dataset.compareSide) return onCompareSide(t.dataset.compareSide);
    if (t.id === 'vd-xray-toggle' || t.closest('.vd-xray')) return onXray();
    if (t.closest('.vd-labels')) return onLabels();
    return undefined;
  });

  function refresh(state) {
    const busy = !!state.busy;
    // 分类
    const types = state.types || {};
    const pkey = (types.items || []).map(i => i.id).join(',');
    if (pkey !== presetsRendered) {
      presetsRendered = pkey;
      presetWrap.innerHTML = `<button type="button" class="vd-mini" data-type-preset="all">全部显示</button>
        <button type="button" class="vd-mini" data-type-preset="devices">只看设备</button>
        <button type="button" class="vd-mini" data-type-preset="envelope">只看围护</button>
        <button type="button" class="vd-mini" data-type-preset="no-top">隐藏顶架</button>`;
    }
    const tkey = (types.items || []).map(i => `${i.id}:${i.count}:${i.hidden ? 1 : 0}`).join('|');
    if (tkey !== typesRendered) {
      typesRendered = tkey;
      typeList.innerHTML = (types.items || []).map(i => `<button type="button" class="vd-type-item"
        data-type-id="${i.id}" aria-pressed="${i.hidden ? 'false' : 'true'}"
        title="${i.label} · ${i.count} 个对象 · ${i.hidden ? '已隐藏，点击显示' : '显示中，点击隐藏'}">
        <span class="vd-type-ico" aria-hidden="true">${i.ico || '◆'}</span>
        <span class="vd-type-txt"><b>${i.label}</b><small>${i.count} 个对象</small></span>
        <span class="vd-type-eye" aria-hidden="true">${i.hidden ? '○' : '●'}</span></button>`).join('');
    }
    typeOut.textContent = types.active ? (types.label || '已隐藏') : '全部显示';
    typeOut.classList.toggle('on', !!types.active);
    for (const b of presetWrap.querySelectorAll('[data-type-preset]')) {
      b.disabled = busy || !(types.items || []).length;
      b.classList.toggle('is-active', types.preset === b.dataset.typePreset);
      b.setAttribute('aria-pressed', types.preset === b.dataset.typePreset ? 'true' : 'false');
    }
    for (const b of typeList.querySelectorAll('[data-type-id]')) b.disabled = busy;

    // 呈现
    for (const b of el.querySelectorAll('[data-style]')) {
      const on = b.dataset.style === (state.style && state.style.lineart && state.style.lineart.on ? 'lineart' : 'real');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-active', on);
      b.disabled = busy;
    }

    // 围护透视
    const x = state.xray || {};
    xrayOut.textContent = x.on ? `${Math.round((x.opacity || 0.18) * 100)}%` : '关闭';
    xrayOut.classList.toggle('on', !!x.on);
    el.querySelector('.vd-xray').classList.toggle('is-off', !x.on);
    const xb = el.querySelector('.vd-xray');
    xb.style.cursor = 'pointer';
    xb.title = x.on ? '退出围护透视' : '开启围护透视';
    xb.onclick = busy ? null : onXray;

    // 标签
    const l = state.labels || {};
    labelOut.textContent = l.enabled === false ? '关闭' : l.level === 'cab' ? '柜号 + 排号' : l.level === 'row' ? '排号' : '待显示';
    labelOut.classList.toggle('on', l.enabled !== false && !!l.visible);
    el.querySelector('.vd-labels').classList.toggle('is-off', l.enabled === false);
    const lb = el.querySelector('.vd-labels');
    lb.style.cursor = 'pointer';
    lb.title = l.enabled === false ? '开启柜号标签' : '关闭柜号标签';
    lb.onclick = busy ? null : onLabels;

    // 对比
    const cmp = state.compare;
    compareEl.hidden = !(cmp && cmp.enabled);
    if (cmp && cmp.enabled) {
      switchEl.innerHTML = ['a', 'b'].map(side => {
        const on = cmp.side === side;
        const p = cmp[side] || {};
        return `<button type="button" class="vd-compare-btn" data-compare-side="${side}"
          aria-pressed="${on ? 'true' : 'false'}" title="${on ? '当前方案：' : '切换到方案 '}${p.name || side.toUpperCase()}">
          <span class="vd-compare-tag" aria-hidden="true">${side.toUpperCase()}</span>
          <span class="vd-compare-txt"><b>方案 ${side.toUpperCase()}</b><small>${p.count || 0} 个对象</small></span></button>`;
      }).join('');
      for (const b of switchEl.querySelectorAll('[data-compare-side]')) {
        b.disabled = busy || cmp.switching || b.dataset.compareSide === cmp.side;
      }
      const c = cmp.counts || {};
      const kinds = cmp.visibleKinds || DIFF_ORDER;
      legendEl.innerHTML = DIFF_ORDER.map(k => {
        const meta = DIFF_META[k];
        const muted = !kinds.includes(k);
        return `<span class="vd-diff${muted ? ' is-muted' : ''}" data-kind="${k}" role="listitem"
          title="${meta.hint} · ${c[k] || 0} 项"><i class="vd-diff-dot" style="background:${meta.color}"></i>
          <span class="vd-diff-label">${meta.label}</span><b class="vd-diff-count">${c[k] || 0}</b></span>`;
      }).join('');
      if (cmp.switching) {
        noteEl.textContent = '正在切换方案…保持同一视角';
        noteEl.classList.add('is-switching');
      } else if (!(c.added || c.removed || c.moved || c.changed)) {
        noteEl.textContent = '两个方案完全一致 · 当前视角保持不变';
        noteEl.classList.remove('is-switching');
      } else {
        const parts = DIFF_ORDER.filter(k => kinds.includes(k)).map(k => `${DIFF_META[k].label} ${c[k] || 0}`);
        noteEl.textContent = `当前 ${cmp.side.toUpperCase()}：${parts.join(' · ')} · 相同 ${c.same || 0}`;
        noteEl.classList.remove('is-switching');
      }
    }
    setOut(el.querySelector('.vd-types'), 'output', typeOut.textContent, typeOut.classList.contains('on'));
  }

  return { el, refresh, compareEl };
}
