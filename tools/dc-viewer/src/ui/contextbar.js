/**
 * 上下文条：抽屉关闭时显示当前视图/效果，退出与快捷调整。
 * 优先级：聚焦 > 业务视点 > 立面 > 俯视 > 轴测 > 剖切 > 隔离 > 围护透视。
 */
const ELEVATION_TITLE = { front: '南立面', back: '北立面', left: '西立面', right: '东立面' };
const ELEVATION_HINT = {
  front: '从南向北 · 正交立面',
  back: '从北向南 · 正交立面',
  left: '从西向东 · 正交立面',
  right: '从东向西 · 正交立面',
};
const CORNER_LABEL = { se: '东南', sw: '西南', nw: '西北', ne: '东北' };
const VP_ICO = { entry: '⌂', corner: '◆', aisle: '⇥', area: '▣' };
const HEIGHT_ROTATE = ['above-ceiling', 'above-tray', 'below-tray'];

export function createContextBar(cb = {}) {
  const el = document.createElement('div');
  el.className = 'view-context';
  el.id = 'view-context';
  el.hidden = true;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', '当前视图');
  el.innerHTML = `<span class="vc-ico" aria-hidden="true"></span>
    <span class="vc-txt"><b class="vc-title" aria-live="polite"></b><small class="vc-hint"></small></span>
    <span class="vc-tools" hidden></span>
    <span class="vc-actions">
      <button type="button" class="vc-btn" data-act="focus-isolate" hidden>隔离</button>
      <button type="button" class="vc-btn" data-act="next" hidden>下一个</button>
      <button type="button" class="vc-btn" data-act="corner" hidden>换角</button>
      <button type="button" class="vc-btn" data-act="more">调整</button>
      <button type="button" class="vc-btn vc-exit" data-act="exit">退出</button>
    </span>`;
  document.body.appendChild(el);

  const ico = el.querySelector('.vc-ico');
  const title = el.querySelector('.vc-title');
  const hint = el.querySelector('.vc-hint');
  const toolsEl = el.querySelector('.vc-tools');
  const btn = act => el.querySelector(`[data-act="${act}"]`);
  const bIso = btn('focus-isolate');
  const bNext = btn('next');
  const bCorner = btn('corner');
  const bMore = btn('more');
  const bExit = btn('exit');

  let kind = null;
  let state = null;

  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'focus-isolate') return cb.onFocusIsolate && cb.onFocusIsolate();
    if (act === 'next') return cb.onNext && cb.onNext();
    if (act === 'corner') return cb.onCorner && cb.onCorner();
    if (act === 'more') return cb.onMore && cb.onMore(kind);
    if (act === 'exit') return cb.onExit && cb.onExit(kind);
    if (act === 'preset') return cb.onPreset && cb.onPreset();
    if (act === 'axis') return cb.onAxis && cb.onAxis();
    if (act === 'flip') return cb.onFlip && cb.onFlip();
    if (act === 'isolate-mode') return cb.onIsolateMode && cb.onIsolateMode();
    return undefined;
  });
  el.addEventListener('input', e => {
    const t = e.target;
    if (!t.classList.contains('vc-range')) return;
    if (cb.onRange) cb.onRange(kind, +t.value);
  });

  function text() {
    const s = state;
    if (!s) return null;
    const v = s.views || {};
    const f = s.focus || {};
    const iso = s.isolate || {};
    const sec = s.section || {};
    const x = s.xray || {};
    if (f.active) {
      let extra = '';
      if (iso.canStart) extra += ` · 隔离 ${iso.shortLabel || ''}`;
      if (x.on) extra += ' · 围护透视';
      return {
        kind: 'focus', ico: '◉', title: `聚焦 · ${f.label || f.id || '选中对象'}`,
        hint: '对象居中 · 双击/F 聚焦 · Esc 返回原视角' + extra,
        focusIsolate: !!iso.canStart, isolateOn: iso.mode && iso.mode !== 'off',
      };
    }
    if (v.activeId === 'viewpoint' || (v.viewpoint && v.activeId === 'viewpoint')) {
      return {
        kind: 'viewpoint', ico: VP_ICO[v.viewpointKind] || '◆',
        title: v.viewpointLabel || '业务视点', hint: v.viewpointHint || '定点视点', next: true,
      };
    }
    if (ELEVATION_TITLE[v.activeId]) {
      return {
        kind: 'elevation', ico: '▥', title: ELEVATION_TITLE[v.activeId],
        hint: `${ELEVATION_HINT[v.activeId]} · 近墙自动隐藏 · Esc 返回原视角`,
      };
    }
    if (v.activeId === 'top') {
      return { kind: 'top', ico: '▦', title: '俯视平面', hint: '正交 · 北朝上 · 排号标签' };
    }
    if (v.activeId === 'iso') {
      return {
        kind: 'iso', ico: '◈', title: `轴测 · ${CORNER_LABEL[v.corner] || '东南'}角`,
        hint: '正交平行投影 · 仰角 35.264°', corner: true,
      };
    }
    if (sec.active && sec.mode === 'clip') {
      return {
        kind: 'clip', ico: '✂', title: `真裁剪 · ${sec.clip.label}`,
        hint: '工程剖切：切穿机柜/墙体 · 切面不封口',
      };
    }
    if (sec.active && sec.mode === 'box') {
      return {
        kind: 'box', ico: '◱',
        title: `盒体剖切 · ${sec.box.presetLabel || '自定义'} · ${sec.box.label}`,
        hint: '对象级：完全在盒外的对象整组隐藏 · 与真裁剪可切换',
      };
    }
    if (sec.active && sec.mode === 'side') {
      return {
        kind: 'side', ico: '⇹',
        title: `侧别过滤 · ${sec.side.axis === 'x' ? '东西' : '南北'} ${(sec.side.pos / 1000).toFixed(2)}m`,
        hint: `对象级：切掉${sec.side.cutSide}（整对象隐藏），不切穿机柜/墙体`,
      };
    }
    if (sec.active && sec.mode === 'height') {
      return {
        kind: 'height', ico: '⌁', title: `高度过滤 · ${(sec.cut / 1000).toFixed(2)}m`,
        hint: '对象级：整对象隐藏，不切穿机柜',
      };
    }
    if (iso.mode && iso.mode !== 'off') {
      return {
        kind: 'isolate', ico: '◎',
        title: `隔离 · ${iso.focusLabel || '已选中对象'} · ${iso.shortLabel}`,
        hint: iso.mode === 'hide'
          ? '隐藏其余设备 · 墙/门/窗/格栅/吊顶与地板保留'
          : '其余设备变暗 18% · 墙/门/窗/格栅/吊顶与地板保留',
      };
    }
    if (x.on) {
      return {
        kind: 'xray', ico: '◌',
        title: `围护透视 · ${Math.round((x.opacity || 0.18) * 100)}%`,
        hint: '墙/门/窗/格栅/吊顶半透明 · 设备保持不透明 · X 退出',
      };
    }
    return null;
  }

  function buildTools(t) {
    const s = state;
    if (!s) return '';
    if (t.kind === 'height') {
      const sec = s.section;
      const preset = sec.preset === 'custom' ? '自定义' : (sec.presets || []).find(p => p.id === sec.preset)?.label || '自定义';
      return `<button type="button" class="vc-mini" data-act="preset"
          title="轮换高度预设：吊顶以上 → 桥架以上 → 桥架以下">${preset}</button>
        <input type="range" class="vc-range" min="${sec.slider.min}" max="${sec.slider.max}" step="${sec.slider.step}"
          value="${sec.cut}" aria-label="高度过滤切面高度（毫米）" aria-valuetext="${(sec.cut / 1000).toFixed(2)} 米">
        <span class="vc-out">${(sec.cut / 1000).toFixed(2)}m</span>`;
    }
    if (t.kind === 'side') {
      const side = s.section.side;
      return `<button type="button" class="vc-mini" data-act="axis" title="轮换侧别轴：东西 X → 南北 Z">${side.axisLabel || (side.axis === 'x' ? '东西 X' : '南北 Z')}</button>
        <button type="button" class="vc-mini" data-act="flip" title="切换切掉哪一侧">切掉${side.cutSide}</button>
        <input type="range" class="vc-range" min="${side.range.min}" max="${side.range.max}" step="${side.range.step}"
          value="${side.pos}" aria-label="侧别过滤切面位置（毫米）" aria-valuetext="${(side.pos / 1000).toFixed(2)} 米">
        <span class="vc-out">${(side.pos / 1000).toFixed(2)}m</span>`;
    }
    if (t.kind === 'clip') {
      const c = s.section.clip;
      return `<button type="button" class="vc-mini" data-act="axis" title="轮换裁剪轴：水平 → 东西 → 南北">${c.axisLabel}</button>
        <button type="button" class="vc-mini" data-act="flip" title="切换保留哪一侧">保留${c.keepSide}</button>
        <input type="range" class="vc-range" min="${c.range.min}" max="${c.range.max}" step="${c.range.step}"
          value="${c.pos}" aria-label="真裁剪位置（毫米）" aria-valuetext="${(c.pos / 1000).toFixed(2)} 米">
        <span class="vc-out">${(c.pos / 1000).toFixed(2)}m</span>`;
    }
    if (t.kind === 'box') {
      const b = s.section.box;
      return `<button type="button" class="vc-mini" data-act="preset" title="轮换盒体预设：前角剖开 → 顶剖 → 半剖">${b.presetLabel || '自定义'}</button>
        <input type="range" class="vc-range" min="${b.ranges.h.min}" max="${b.ranges.h.max}" step="${b.ranges.h.step}"
          value="${b.h}" aria-label="盒体顶切面高度（毫米）" aria-valuetext="${(b.h / 1000).toFixed(2)} 米">
        <span class="vc-out">X${(b.x / 1000).toFixed(1)} Z${(b.z / 1000).toFixed(1)} H${(b.h / 1000).toFixed(1)}</span>`;
    }
    if (t.kind === 'xray') {
      return `<span class="vc-badge">${Math.round((s.xray.opacity || 0.18) * 100)}%</span>`;
    }
    if (t.kind === 'isolate') {
      const iso = s.isolate;
      return `<button type="button" class="vc-mini" data-act="isolate-mode"
          title="切换隔离强度：变暗其余 ⇄ 隐藏其余">${iso.mode === 'hide' ? '切到变暗' : '切到隐藏'}</button>
        <span class="vc-badge">${iso.mode === 'hide' ? '隐藏' : '18%'}</span>`;
    }
    return '';
  }

  function refresh(next) {
    state = next;
    const t = text();
    const visible = !!(state.chromeVisible !== false && !state.drawerOpen && t);
    el.hidden = !visible;
    if (!visible) {
      kind = null;
      return;
    }
    kind = t.kind;
    el.dataset.kind = t.kind;
    ico.textContent = t.ico || '◱';
    title.textContent = t.title || '';
    hint.textContent = t.hint || '';
    bIso.hidden = !t.focusIsolate;
    bIso.textContent = t.isolateOn ? '取消隔离' : '隔离';
    bIso.setAttribute('aria-pressed', t.isolateOn ? 'true' : 'false');
    bNext.hidden = !t.next;
    bCorner.hidden = !t.corner;
    const html = buildTools(t);
    toolsEl.innerHTML = html;
    toolsEl.hidden = !html;
  }

  function info() {
    return { visible: !el.hidden, kind, title: title.textContent, hint: hint.textContent };
  }

  return { el, refresh, info, text: () => kind };
}

export { HEIGHT_ROTATE, CORNER_LABEL };
