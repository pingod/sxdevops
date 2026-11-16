/** 剖切面板：四种互斥方式（真裁剪 / 盒体剖切 / 高度过滤 / 侧别过滤）。 */
import { group } from '../dom.js';

const MODES = [
  { id: 'clip', label: '真裁剪', hint: '切穿几何 · 不封口' },
  { id: 'box', label: '盒体剖切', hint: '按空间范围整组隐藏' },
  { id: 'height', label: '高度过滤', hint: '整组隐藏顶架 · 不切设备' },
  { id: 'side', label: '侧别过滤', hint: '按一侧整组隐藏' },
];

const HEIGHT_PRESETS = [
  { id: 'above-ceiling', label: '吊顶以上', hint: '隐藏顶面高于吊顶的构件', ico: '⌃' },
  { id: 'above-tray', label: '桥架以上', hint: '隐藏吊顶与梁，保留桥架', ico: '⌁' },
  { id: 'below-tray', label: '桥架以下', hint: '隐藏桥架及吊顶上方构件', ico: '⌄' },
];

export function createSectionPanel(cb = {}) {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="section-modes" role="group" aria-label="剖切方式（互斥）">
      ${MODES.map(m => `<button type="button" class="section-mode" data-section-mode="${m.id}"
        aria-pressed="false"><b>${m.label}</b><small>${m.hint}</small></button>`).join('')}
    </div>
    <button type="button" class="section-reset vd-mini">关闭剖切</button>

    <div class="section-pane" id="section-pane-clip" hidden>
      <div class="vd-range vd-clip">
        <div class="vd-range-head"><label>真裁剪</label><output>关闭</output></div>
        <div class="vd-side-btns vd-clip-btns">
          <button type="button" class="vd-mini" data-clip-axis="y">水平</button>
          <button type="button" class="vd-mini" data-clip-axis="x">东西</button>
          <button type="button" class="vd-mini" data-clip-axis="z">南北</button>
          <button type="button" class="vd-mini vd-flip" data-clip-flip>翻转方向</button>
        </div>
        <input type="range" data-clip-pos min="0" max="3000" step="100" value="1200" aria-label="真裁剪剖切位置（毫米）">
        <small class="vd-range-note">工程剖切：真正切穿机柜/墙体 · 切面不封口（无实心截面）</small>
      </div>
    </div>

    <div class="section-pane" id="section-pane-box" hidden>
      <div class="vd-range vd-box">
        <div class="vd-range-head"><label>盒体剖切</label><output>关闭</output></div>
        <div class="vd-side-btns vd-box-presets">
          <button type="button" class="vd-mini" data-box-preset="corner" title="切掉东南近角，保留西北侧">前角剖开</button>
          <button type="button" class="vd-mini" data-box-preset="top" title="切掉吊顶以上，保留室内">顶剖</button>
          <button type="button" class="vd-mini" data-box-preset="half" title="沿东西中线切掉东半间">半剖</button>
          <button type="button" class="vd-mini vd-box-exit" data-box-exit>退出</button>
        </div>
        <div class="vd-box-sliders">
          <div class="vd-box-row"><label>东西 X</label>
            <input type="range" data-box-axis="x" min="0" max="12000" step="100" value="6000"
              aria-label="盒体东西切面（保留西侧，毫米）"><output>6.00m</output></div>
          <div class="vd-box-row"><label>南北 Z</label>
            <input type="range" data-box-axis="z" min="0" max="7000" step="100" value="3500"
              aria-label="盒体南北切面（保留北侧，毫米）"><output>3.50m</output></div>
          <div class="vd-box-row"><label>顶高</label>
            <input type="range" data-box-axis="h" min="0" max="3200" step="100" value="3200"
              aria-label="盒体顶切面高度（毫米）"><output>3.20m</output></div>
        </div>
        <small class="vd-range-note vd-box-note">对象级：保留 X 西侧 / Z 北侧 / 顶高以下，完全在盒外的对象整组隐藏</small>
      </div>
    </div>

    <div class="section-pane" id="section-pane-height" hidden>
      <div class="vd-range">
        <div class="vd-range-head"><label>切面高度</label><output>关闭</output></div>
        <input type="range" data-cut min="600" max="3600" step="100" value="2400" aria-label="高度过滤切面高度（毫米）">
        <small class="vd-range-note">对象级：整对象隐藏，不切穿机柜；默认只过滤吊顶/桥架/梁</small>
      </div>
      <section class="vd-group" data-group="section">
        ${group('高度预设', '仅过滤吊顶 / 桥架 / 梁')}
        <div class="vd-items vd-items-3">${HEIGHT_PRESETS.map(p => `<button type="button" class="vd-item"
          data-height-preset="${p.id}" aria-pressed="false" title="${p.label} · ${p.hint}">
          <span class="vd-ico" aria-hidden="true">${p.ico}</span>
          <span class="vd-txt"><b>${p.label}</b><small>${p.hint}</small></span></button>`).join('')}</div>
      </section>
    </div>

    <div class="section-pane" id="section-pane-side" hidden>
      <div class="vd-range vd-side">
        <div class="vd-range-head"><label>侧别切面</label><output>关闭</output></div>
        <div class="vd-side-btns">
          <button type="button" class="vd-mini" data-side-axis="x">东西 X</button>
          <button type="button" class="vd-mini" data-side-axis="z">南北 Z</button>
          <button type="button" class="vd-mini vd-flip" data-side-flip>翻转方向</button>
        </div>
        <input type="range" data-side-pos min="0" max="12000" step="100" value="6000" aria-label="侧别切面位置（毫米）">
        <small class="vd-range-note">对象级：按包围盒中心整对象隐藏，不切穿机柜/墙体；需要切穿请用真裁剪</small>
      </div>
    </div>`;

  const panes = {
    clip: el.querySelector('#section-pane-clip'),
    box: el.querySelector('#section-pane-box'),
    height: el.querySelector('#section-pane-height'),
    side: el.querySelector('#section-pane-side'),
  };
  const range = sel => el.querySelector(sel);

  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.sectionMode) return cb.onMode && cb.onMode(b.dataset.sectionMode);
    if (b.classList.contains('section-reset')) return cb.onReset && cb.onReset();
    if (b.dataset.heightPreset) return cb.onPreset && cb.onPreset(b.dataset.heightPreset);
    if (b.dataset.clipAxis) return cb.onClipAxis && cb.onClipAxis(b.dataset.clipAxis);
    if (b.hasAttribute('data-clip-flip')) return cb.onClipFlip && cb.onClipFlip();
    if (b.dataset.boxPreset) return cb.onBoxPreset && cb.onBoxPreset(b.dataset.boxPreset);
    if (b.hasAttribute('data-box-exit')) return cb.onReset && cb.onReset();
    if (b.dataset.sideAxis) return cb.onSideAxis && cb.onSideAxis(b.dataset.sideAxis);
    if (b.hasAttribute('data-side-flip')) return cb.onSideFlip && cb.onSideFlip();
    return undefined;
  });

  el.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.cut !== undefined) return cb.onCut && cb.onCut(+t.value);
    if (t.dataset.clipPos !== undefined) return cb.onClipPos && cb.onClipPos(+t.value);
    if (t.dataset.sidePos !== undefined) return cb.onSidePos && cb.onSidePos(+t.value);
    if (t.dataset.boxAxis) return cb.onBoxAxis && cb.onBoxAxis(t.dataset.boxAxis, +t.value);
    return undefined;
  });

  function refresh(info, busy) {
    const mode = info ? info.mode : 'off';
    for (const b of el.querySelectorAll('[data-section-mode]')) {
      const on = b.dataset.sectionMode === mode;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.disabled = busy || (info && info['canStart' + b.dataset.sectionMode[0].toUpperCase() + b.dataset.sectionMode.slice(1)] === false);
    }
    for (const id of Object.keys(panes)) panes[id].hidden = mode !== id;
    if (!info) return;
    el.querySelector('.section-reset').disabled = busy || mode === 'off';

    // 高度
    const h = panes.height;
    const out = h.querySelector('output');
    out.textContent = mode === 'height' && info.cut > 0 ? `${(info.cut / 1000).toFixed(2)} m` : '关闭';
    out.classList.toggle('on', mode === 'height' && info.cut > 0);
    h.classList.toggle('is-off', mode !== 'height');
    const slider = h.querySelector('[data-cut]');
    slider.min = info.slider.min;
    slider.max = info.slider.max;
    slider.step = info.slider.step;
    if (mode === 'height') slider.value = info.cut;
    slider.disabled = busy;
    for (const b of h.querySelectorAll('[data-height-preset]')) {
      const on = info.preset === b.dataset.heightPreset;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.disabled = busy;
    }

    // 侧别
    const s = info.side;
    const sp = panes.side;
    const sOut = sp.querySelector('output');
    sOut.textContent = s.active ? `${s.axisShort || s.axis.toUpperCase()} ${(s.pos / 1000).toFixed(2)} m` : '关闭';
    sOut.classList.toggle('on', s.active);
    sp.classList.toggle('is-off', !s.active);
    for (const b of sp.querySelectorAll('[data-side-axis]')) {
      const on = b.dataset.sideAxis === s.axis;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.disabled = busy;
    }
    const flip = sp.querySelector('[data-side-flip]');
    flip.textContent = `切掉${s.cutSide || '西侧'}`;
    flip.title = '切换切掉哪一侧';
    flip.disabled = busy;
    const sr = sp.querySelector('[data-side-pos]');
    sr.min = s.range.min;
    sr.max = s.range.max;
    sr.step = s.range.step;
    sr.value = s.pos;
    sr.disabled = busy;
    sr.setAttribute('aria-valuetext', `${(s.pos / 1000).toFixed(2)} 米`);

    // 真裁剪
    const c = info.clip;
    const cp = panes.clip;
    const cOut = cp.querySelector('output');
    cOut.textContent = c.active ? c.label : '关闭';
    cOut.classList.toggle('on', c.active);
    cp.classList.toggle('is-off', !c.active);
    for (const b of cp.querySelectorAll('[data-clip-axis]')) {
      const on = b.dataset.clipAxis === c.axis;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.disabled = busy;
    }
    const cf = cp.querySelector('[data-clip-flip]');
    cf.textContent = `保留${c.keepSide || '以上'}`;
    cf.disabled = busy;
    const cr = cp.querySelector('[data-clip-pos]');
    cr.min = c.range.min;
    cr.max = c.range.max;
    cr.step = c.range.step;
    cr.value = c.pos;
    cr.disabled = busy;
    cr.setAttribute('aria-valuetext', `${(c.pos / 1000).toFixed(2)} 米`);

    // 盒体
    const b = info.box;
    const bp = panes.box;
    const bOut = bp.querySelector('output');
    bOut.textContent = b.active ? `${b.presetLabel || '自定义'} · ${b.label}` : '关闭';
    bOut.classList.toggle('on', b.active);
    bp.classList.toggle('is-off', !b.active);
    for (const btn of bp.querySelectorAll('[data-box-preset]')) {
      const on = b.preset === btn.dataset.boxPreset;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.disabled = busy;
    }
    bp.querySelector('[data-box-exit]').disabled = busy || !b.active;
    for (const r of bp.querySelectorAll('[data-box-axis]')) {
      const ax = r.dataset.boxAxis;
      const rng = b.ranges[ax];
      r.min = rng.min;
      r.max = rng.max;
      r.step = rng.step;
      r.value = b[ax];
      r.disabled = busy;
      r.setAttribute('aria-valuetext', `${(b[ax] / 1000).toFixed(2)} 米`);
      r.parentElement.querySelector('output').textContent = `${(b[ax] / 1000).toFixed(2)}m`;
    }
    const note = bp.querySelector('.vd-box-note');
    note.textContent = b.active
      ? `对象级：隐藏 ${b.counts.hidden} 组完全在盒外的对象 · 保留 X 西侧 / Z 北侧 / 顶高以下 · Esc 退出`
      : '对象级：保留 X 西侧 / Z 北侧 / 顶高以下，完全在盒外的对象整组隐藏';
  }

  return { el, refresh };
}
