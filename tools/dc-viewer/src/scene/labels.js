/**
 * 俯视/轴测标签层：排号 + 柜号 LOD + 屏幕空间避让 + 点击选中。
 * 纯 CSS 浮层（不是 Sprite/CSS2DRenderer）：任意缩放字形清晰、可被读屏与测试读取。
 *
 * 分级：低缩放只显示排号；放大到柜体短边 ≥30px（回差 0.86）才铺柜号；
 * 悬停/选中始终显示；俯视要求接近正俯视，轴测只显示柜号。
 */
import * as THREE from 'three/webgpu';

const S = 0.001;
const EDGE = 3;
const CAB_ANCHOR_PAD = 0.06;

export const LABEL = Object.freeze({
  rowMaxPhi: 0.3,
  cabMinPx: 30,
  cabKeepRatio: 0.86,
  maxCabs: 80,
  mobileMaxCabs: 32,
  mobileWidth: 640,
  pad: 3,
  maxNameLen: 28,
  edge: EDGE,
});

const round1 = v => +v.toFixed(1);
const finite = v => Number.isFinite(+v);

/** 从项目数据派生可显示柜号列表（稳定排序） */
export function cabinetLabelItems(project, opts = {}) {
  const objs = project && Array.isArray(project.objects) ? project.objects : [];
  const maxLen = finite(opts.maxNameLen) && +opts.maxNameLen > 3
    ? Math.floor(+opts.maxNameLen)
    : LABEL.maxNameLen;
  const out = [];
  for (const o of objs) {
    if (!o || o.type !== 'cabinet' || o.x == null || o.y == null) continue;
    if (!finite(o.x) || !finite(o.y)) continue;
    const p = o.props || {};
    const name = String(p.name == null ? '' : p.name).trim();
    if (!name) continue;
    const w = Math.abs(+p.w) || 600;
    const d = Math.abs(+p.d) || 1200;
    const h = Math.abs(+p.h) || 2000;
    out.push({
      obj: o,
      id: o.id == null ? '' : String(o.id),
      name,
      label: name.length > maxLen ? name.slice(0, maxLen - 1) + '…' : name,
      x: +o.x,
      y: +o.y,
      w,
      d,
      h,
      minDim: Math.min(w, d),
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label, 'en')
    || a.name.localeCompare(b.name, 'en')
    || a.id.localeCompare(b.id, 'en'));
  return out;
}

/** 机柜短边中位数（米） */
export function medianCabinetSize(items) {
  const vals = (Array.isArray(items) ? items : [])
    .map(i => (i && finite(i.minDim) ? +i.minDim : 0) / 1000)
    .filter(v => v > 0)
    .sort((a, b) => a - b);
  if (!vals.length) return 0;
  const m = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
}

/** 柜号 LOD：估一个柜子当前占多少像素 */
export function cabinetLabelLod(opts = {}) {
  const ppm = finite(opts.pixelsPerMeter) ? Math.max(0, +opts.pixelsPerMeter) : 0;
  const med = finite(opts.medianM) ? Math.max(0, +opts.medianM) : 0;
  const px = ppm * med;
  const threshold = LABEL.cabMinPx * (opts.showing ? LABEL.cabKeepRatio : 1);
  const enabled = opts.enabled !== false;
  return {
    show: enabled && px > 0 && px >= threshold,
    px: round1(px),
    threshold: round1(threshold),
    max: opts.mobile ? LABEL.mobileMaxCabs : LABEL.maxCabs,
  };
}

export function rectOverlap(a, b, pad = 0) {
  if (!a || !b) return false;
  const p = finite(pad) ? Math.max(0, +pad) : 0;
  return a.x1 < b.x2 + p && a.x2 > b.x1 - p && a.y1 < b.y2 + p && a.y2 > b.y1 - p;
}

/** 屏幕空间避让（优先级：选中 0 > 悬停 1 > 排号 2 > 普通柜号 3） */
export function chooseLabelSlots(candidates, opts = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(c => c && c.rect);
  const pad = finite(opts.pad) ? Math.max(0, +opts.pad) : LABEL.pad;
  const max = finite(opts.max) ? Math.max(0, Math.floor(+opts.max)) : Infinity;
  const sorted = list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const pa = finite(a.c.priority) ? +a.c.priority : 9;
      const pb = finite(b.c.priority) ? +b.c.priority : 9;
      if (pa !== pb) return pa - pb;
      const oa = finite(a.c.order) ? +a.c.order : 0;
      const ob = finite(b.c.order) ? +b.c.order : 0;
      if (oa !== ob) return oa - ob;
      return a.i - b.i;
    })
    .map(x => x.c);
  const placed = [];
  const skipped = [];
  let normal = 0;
  for (const c of sorted) {
    const always = !!c.always;
    if (!always && normal >= max) {
      skipped.push(c);
      continue;
    }
    if (placed.some(p => rectOverlap(c.rect, p.rect, pad))) {
      skipped.push(c);
      continue;
    }
    placed.push(c);
    if (!always) normal++;
  }
  return { placed, skipped };
}

export function createLabelLayer(opts = {}) {
  let rows = Array.isArray(opts.rows) ? opts.rows : [];
  let cabinets = Array.isArray(opts.cabinets) ? opts.cabinets : [];
  let getSelected = typeof opts.getSelected === 'function' ? opts.getSelected : null;
  let getHovered = typeof opts.getHovered === 'function' ? opts.getHovered : null;
  let isHidden = typeof opts.isHidden === 'function' ? opts.isHidden : null;
  let onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
  const onchange = typeof opts.onchange === 'function' ? opts.onchange : null;

  let box = null;
  let rowEls = [];
  let cabEls = [];
  let visible = false;
  let enabled = opts.enabled !== false;
  let rowShown = 0;
  let cabShown = 0;
  let level = 'off';
  let lodPx = 0;
  let lodThreshold = 0;
  let measureW = 0;
  let measureH = 0;
  let selectedFixed;
  let hoveredFixed;
  let cabLevel = false;
  const medianM = medianCabinetSize(cabinets);
  const v = new THREE.Vector3();

  const readSelected = () => (selectedFixed !== undefined
    ? selectedFixed
    : getSelected ? getSelected() : null);
  const readHovered = () => (hoveredFixed !== undefined ? hoveredFixed : getHovered ? getHovered() : null);

  function ensure() {
    if (box && box.isConnected) return;
    if (typeof document === 'undefined') return;
    box = document.createElement('div');
    box.id = 'row-labels';
    box.className = 'row-labels';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', '机柜排号与柜号标签');
    document.body.appendChild(box);
    rowEls = rows.map(row => {
      const el = document.createElement('span');
      el.className = 'row-label';
      el.textContent = row.key;
      el.title = `${row.key} 排 · ${row.count} 台机柜`;
      el.setAttribute('aria-hidden', 'true');
      box.appendChild(el);
      return { row, el };
    });
    cabEls = cabinets.map(cab => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'cab-label';
      el.textContent = cab.label;
      el.dataset.id = cab.id;
      el.dataset.name = cab.name;
      el.title = `${cab.name} · 机柜 · 点击选中`;
      el.setAttribute('aria-label', `${cab.name} 机柜，点击选中`);
      el.setAttribute('aria-pressed', 'false');
      el.addEventListener('pointerdown', e => e.stopPropagation());
      el.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        if (onSelect) onSelect(cab.obj);
      });
      box.appendChild(el);
      return { cab, el };
    });
  }

  function clearOn() {
    for (const { el } of rowEls) el.classList.remove('on');
    for (const { el } of cabEls) el.classList.remove('on');
    rowShown = 0;
    cabShown = 0;
    level = 'off';
  }

  function sizeOf(el) {
    if (!el._lw || !el._lh) {
      el._lw = el.offsetWidth || 20;
      el._lh = el.offsetHeight || 16;
    }
    return { w: el._lw, h: el._lh };
  }

  function clearMeasures() {
    for (const { el } of rowEls) {
      el._lw = 0;
      el._lh = 0;
    }
    for (const { el } of cabEls) {
      el._lw = 0;
      el._lh = 0;
    }
  }

  function setVisible(on) {
    visible = !!on;
    if (visible && enabled) {
      ensure();
      if (box) box.hidden = false;
    } else {
      clearOn();
      if (box) box.hidden = true;
    }
    if (onchange) onchange(info());
  }

  function setEnabled(on) {
    const next = on !== false;
    if (next === enabled) return false;
    enabled = next;
    if (!enabled) {
      clearOn();
      if (box) box.hidden = true;
    } else if (visible) {
      ensure();
      if (box) box.hidden = false;
    }
    if (onchange) onchange(info());
    return true;
  }

  function setOptions(next = {}) {
    if ('getSelected' in next) getSelected = typeof next.getSelected === 'function' ? next.getSelected : null;
    if ('getHovered' in next) getHovered = typeof next.getHovered === 'function' ? next.getHovered : null;
    if ('isHidden' in next) isHidden = typeof next.isHidden === 'function' ? next.isHidden : null;
    if ('onSelect' in next) onSelect = typeof next.onSelect === 'function' ? next.onSelect : null;
    return true;
  }

  function setRows(next) {
    rows = Array.isArray(next) ? next : [];
    if (box && box.isConnected && rowEls.length !== rows.length) {
      box.remove();
      box = null;
      rowEls = [];
      cabEls = [];
      clearMeasure();
      if (visible && enabled) ensure();
    } else {
      rowEls = rowEls.map((r, i) => {
        const row = rows[i] || r.row;
        r.row = row;
        r.el.textContent = row.key;
        r.el.title = `${row.key} 排 · ${row.count} 台机柜`;
        return r;
      });
    }
    clearOn();
  }

  function setCabinets(next) {
    cabinets = Array.isArray(next) ? next : [];
    if (box && box.isConnected) {
      for (const { el } of cabEls) el.remove();
      cabEls = [];
      box = null;
      clearMeasure();
      if (visible && enabled) ensure();
    }
    clearOn();
  }

  function clearMeasure() {
    measureW = 0;
    measureH = 0;
    clearMeasures();
    cabLevel = false;
  }

  function setSelected(obj) {
    selectedFixed = obj === undefined ? undefined : obj;
  }

  function setHovered(obj) {
    hoveredFixed = obj === undefined ? undefined : obj;
  }

  function update(camera, flat = true, viewport = null, ctx = {}) {
    if (!visible || !enabled || !box || !camera) return;
    if (!box.isConnected) ensure();
    if (!box || box.hidden) return;
    const w = viewport && viewport.w > 0 ? viewport.w : window.innerWidth;
    const h = viewport && viewport.h > 0 ? viewport.h : window.innerHeight;
    if (!(w > 0 && h > 0)) return;
    if (Math.abs(w - measureW) > 0.5 || Math.abs(h - measureH) > 0.5) {
      measureW = w;
      measureH = h;
      clearMeasures();
    }

    const sel = readSelected();
    const hov = readHovered();
    for (const { cab, el } of cabEls) {
      const isSel = !!sel && cab.obj === sel;
      const isHov = !!hov && cab.obj === hov && !isSel;
      if (el.classList.contains('is-selected') !== isSel) el.classList.toggle('is-selected', isSel);
      if (el.classList.contains('is-hover') !== isHov) el.classList.toggle('is-hover', isHov);
      const pressed = isSel ? 'true' : 'false';
      if (el.getAttribute('aria-pressed') !== pressed) el.setAttribute('aria-pressed', pressed);
    }

    const allowRows = ctx.allowRows !== undefined ? !!ctx.allowRows : !!flat;
    const allowCabs = ctx.allowCabs !== undefined ? !!ctx.allowCabs : !!flat;
    const ppm = finite(ctx.ppm) ? Math.max(0, +ctx.ppm) : 0;
    const lod = cabinetLabelLod({
      pixelsPerMeter: ppm,
      medianM,
      showing: cabLevel,
      enabled,
      mobile: w < LABEL.mobileWidth,
    });
    cabLevel = lod.show;
    lodPx = lod.px;
    lodThreshold = lod.threshold;

    camera.updateMatrixWorld();
    const candidates = [];

    if (allowRows) {
      for (let i = 0; i < rowEls.length; i++) {
        const { row, el } = rowEls[i];
        v.set(row.anchor.x * S, 0.03, -row.anchor.y * S).project(camera);
        if (!finite(v.x) || !finite(v.y) || !(v.z >= -1 && v.z <= 1)) continue;
        const x = (v.x * 0.5 + 0.5) * w;
        const y = (-v.y * 0.5 + 0.5) * h;
        const { w: lw, h: lh } = sizeOf(el);
        if (x - lw / 2 < EDGE || x + lw / 2 > w - EDGE || y - lh / 2 < EDGE || y + lh / 2 > h - EDGE) continue;
        candidates.push({
          kind: 'row',
          index: i,
          x,
          y,
          priority: 2,
          always: true,
          order: i,
          rect: { x1: x - lw / 2, y1: y - lh / 2, x2: x + lw / 2, y2: y + lh / 2 },
        });
      }
    }

    if (allowCabs) {
      for (let i = 0; i < cabEls.length; i++) {
        const { cab, el } = cabEls[i];
        const isSel = !!sel && cab.obj === sel;
        const isHov = !!hov && cab.obj === hov && !isSel;
        if (!isSel && !isHov && !cabLevel) continue;
        if (isHidden && isHidden(cab.obj)) continue;
        v.set(cab.x * S, cab.h * S + CAB_ANCHOR_PAD, -cab.y * S).project(camera);
        if (!finite(v.x) || !finite(v.y) || !(v.z >= -1 && v.z <= 1)) continue;
        let x = (v.x * 0.5 + 0.5) * w;
        let y = (-v.y * 0.5 + 0.5) * h;
        const { w: lw, h: lh } = sizeOf(el);
        const always = isSel || isHov;
        if (always) {
          x = Math.max(EDGE + lw / 2, Math.min(w - EDGE - lw / 2, x));
          y = Math.max(EDGE + lh / 2, Math.min(h - EDGE - lh / 2, y));
        } else if (x - lw / 2 < EDGE || x + lw / 2 > w - EDGE
          || y - lh / 2 < EDGE || y + lh / 2 > h - EDGE) {
          continue;
        }
        candidates.push({
          kind: 'cab',
          index: i,
          x,
          y,
          priority: isSel ? 0 : isHov ? 1 : 3,
          always,
          order: i,
          rect: { x1: x - lw / 2, y1: y - lh / 2, x2: x + lw / 2, y2: y + lh / 2 },
        });
      }
    }

    const { placed } = chooseLabelSlots(candidates, { max: lod.max, pad: LABEL.pad });
    const rowSet = new Set();
    const cabSet = new Set();
    const pos = new Map();
    for (const p of placed) {
      pos.set(p.kind + p.index, p);
      if (p.kind === 'row') rowSet.add(p.index);
      else cabSet.add(p.index);
    }
    for (let i = 0; i < rowEls.length; i++) {
      const { el } = rowEls[i];
      const p = pos.get('row' + i);
      const on = rowSet.has(i);
      if (on) {
        el.style.left = p.x.toFixed(1) + 'px';
        el.style.top = p.y.toFixed(1) + 'px';
      }
      if (el.classList.contains('on') !== on) el.classList.toggle('on', on);
    }
    for (let i = 0; i < cabEls.length; i++) {
      const { el } = cabEls[i];
      const p = pos.get('cab' + i);
      const on = cabSet.has(i);
      if (on) {
        el.style.left = p.x.toFixed(1) + 'px';
        el.style.top = p.y.toFixed(1) + 'px';
      }
      if (el.classList.contains('on') !== on) el.classList.toggle('on', on);
    }
    rowShown = rowSet.size;
    cabShown = cabSet.size;
    level = cabShown ? 'cab' : rowShown ? 'row' : 'off';
  }

  function info() {
    return {
      visible: !!visible,
      enabled,
      level,
      rows: rowEls.length,
      cabinets: cabEls.length,
      rowShown,
      cabShown,
      lodPx: round1(lodPx),
      lodThreshold: round1(lodThreshold),
      visibleBox: !!(box && !box.hidden),
    };
  }

  function destroy() {
    if (box) box.remove();
    box = null;
    rowEls = [];
    cabEls = [];
  }

  return {
    setVisible,
    setEnabled,
    setOptions,
    setRows,
    setCabinets,
    setSelected,
    setHovered,
    update,
    info,
    destroy,
  };
}

export const createRowLabels = createLabelLayer;
