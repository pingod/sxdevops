/** 定位面板：搜索（外挂）+ 相机聚焦 + 隔离定位。 */
export function createLocatePanel(cb = {}) {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="vd-search-slot"></div>
    <div class="vd-range vd-focus">
      <div class="vd-range-head"><label>相机聚焦</label><output>待聚焦</output></div>
      <button type="button" class="vd-mini vd-focus-btn" data-focus-btn>聚焦选中对象</button>
      <small class="vd-range-note">先选中对象或双击对象 · 焦点相机不穿墙/穿柜 · Esc 返回</small>
    </div>
    <div class="vd-range vd-isolate">
      <div class="vd-range-head"><label>隔离定位</label><output>关闭</output></div>
      <div class="vd-side-btns">
        <button type="button" class="vd-mini" data-isolate="dim">变暗其余</button>
        <button type="button" class="vd-mini" data-isolate="hide">隐藏其余</button>
        <button type="button" class="vd-mini vd-isolate-exit" data-isolate="off">退出隔离</button>
      </div>
      <small class="vd-range-note">先在场景中点选对象或用上方搜索 · 围护与地板保留</small>
    </div>`;

  const slot = el.querySelector('.vd-search-slot');
  const focusOut = el.querySelector('.vd-focus output');
  const focusNote = el.querySelector('.vd-focus .vd-range-note');
  const focusBtn = el.querySelector('[data-focus-btn]');
  const isoOut = el.querySelector('.vd-isolate output');
  const isoNote = el.querySelector('.vd-isolate .vd-range-note');
  const isoBtns = [...el.querySelectorAll('[data-isolate]')];

  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.hasAttribute('data-focus-btn')) return cb.onFocus && cb.onFocus();
    if (b.dataset.isolate !== undefined) return cb.onIsolate && cb.onIsolate(b.dataset.isolate);
    return undefined;
  });

  function refresh(state) {
    const busy = !!state.busy;
    const f = state.focus || {};
    const canFocus = !!(state.selected && !busy && !state.tourActive && !state.walkActive);
    focusBtn.disabled = !canFocus;
    focusBtn.textContent = f.active ? '重新聚焦' : '聚焦选中对象';
    if (f.active) {
      focusOut.textContent = `已聚焦 · ${f.label || '选中对象'}`;
      focusOut.classList.add('on');
      focusNote.textContent = `对象已居中（r ${(f.r || 0).toFixed(2)}m）· 双击/F 聚焦 · Esc 返回进入前视角`;
    } else if (state.selected) {
      focusOut.textContent = '待聚焦';
      focusOut.classList.remove('on');
      focusNote.textContent = `已选中 ${state.selected.label || state.selected.id} · 双击对象或点此聚焦 · 不穿墙/穿柜`;
    } else {
      focusOut.textContent = '未聚焦';
      focusOut.classList.remove('on');
      focusNote.textContent = '先选中对象或双击对象 · 焦点相机不穿墙/穿柜 · Esc 返回';
    }

    const iso = state.isolate || {};
    const canIso = iso.canStart && !busy;
    for (const b of isoBtns) {
      const on = b.dataset.isolate === iso.mode && iso.mode !== 'off';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.disabled = busy || (b.dataset.isolate === 'off' ? !iso.enabled : !canIso);
    }
    if (iso.mode !== 'off') {
      isoOut.textContent = `${iso.modeLabel} · ${iso.focusLabel || '已选中对象'}`;
      isoOut.classList.add('on');
      const n = iso.counts ? iso.counts.hiddenGroups : 0;
      isoNote.textContent = iso.mode === 'hide'
        ? `隐藏其余 ${n} 组设备 · 围护与地板保留 · Esc 退出隔离`
        : `变暗其余 ${n} 组设备 · 围护与地板保留 · Esc 退出隔离`;
    } else {
      isoOut.textContent = '关闭';
      isoOut.classList.remove('on');
      isoNote.textContent = state.selected
        ? `已选中 ${state.selected.label || state.selected.id} · 选择变暗或隐藏其余设备`
        : '先在场景中点选对象或用上方搜索 · 围护与地板保留';
    }
    el.querySelector('.vd-focus').classList.toggle('is-off', !f.active && !state.selected);
    el.querySelector('.vd-isolate').classList.toggle('is-off', iso.mode === 'off');
  }

  return { el, slot, refresh };
}
