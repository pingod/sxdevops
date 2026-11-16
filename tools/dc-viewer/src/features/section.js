/**
 * 剖切族：高度过滤 / 侧别过滤 / 真裁剪 / 盒体剖切（互斥）+ 全局可见性仲裁。
 *
 * 可见性唯一出口：visible = 对象基准可见 && !当前剖切过滤 && !强制隐藏源
 * （强制隐藏源：分类显隐、隔离隐藏、俯视/聚焦时隐藏吊顶）。墙体近墙淡变在挂起时
 * 不写 visible，避免与剖切互相覆盖。
 */
import * as THREE from 'three/webgpu';
import {
  SECTION, CLIP, SIDE, BOX,
  sectionHeights, sectionItems, hiddenByCut, matchPreset, presetCut, sliderRange,
  isBounds, sidePlane, sideRange, sideDefaultPos, hiddenBySide, sideLabel, sideCutName, sideKeepName,
  clipDefaultCut, clipRangeFor, clipDefaultPos, clipPlaneAt, clipScenePlane, clipLabel, clipCutName, clipKeepName,
  boxRanges, defaultBox, normalizeBox, hiddenByBox, boxLabel, matchBoxPreset, boxPresetLabel, boxPreset,
} from './sectionplan.js';

const num = v => {
  const n = +v;
  return Number.isFinite(n) ? n : 0;
};
const pos = (v, d) => {
  const n = +v;
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** 旋转矩形外接半尺寸 */
function halfExtents(w, d, deg) {
  const t = (num(deg) * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  return { hx: (w * c + d * s) / 2, hy: (w * s + d * c) / 2 };
}

/** 对象平面包围盒（项目 mm）：墙/桥架/梁按线段，其余按旋转外接矩形；吊顶/地板返回 null */
export function boundsOfObject(o) {
  if (!o) return null;
  const p = o.props || {};
  if (o.type === 'wall' || o.type === 'tray') {
    const pad = o.type === 'wall' ? pos(p.thickness, 240) / 2 : pos(p.width, 300) / 2;
    return {
      x0: Math.min(o.x1, o.x2) - pad,
      x1: Math.max(o.x1, o.x2) + pad,
      y0: Math.min(o.y1, o.y2) - pad,
      y1: Math.max(o.y1, o.y2) + pad,
    };
  }
  if (o.type === 'beam') {
    const pad = pos(p.b, 300) / 2;
    return {
      x0: Math.min(num(o.x1), num(o.x2)) - pad,
      x1: Math.max(num(o.x1), num(o.x2)) + pad,
      y0: Math.min(num(o.y1), num(o.y2)) - pad,
      y1: Math.max(num(o.y1), num(o.y2)) + pad,
    };
  }
  if (o.type === 'ceiling' || o.type === 'floor') return null;
  if (o.x === undefined || o.y === undefined) return null;
  const { hx, hy } = halfExtents(pos(p.w, 600), pos(p.d, 600), o.rotation);
  return { x0: num(o.x) - hx, x1: num(o.x) + hx, y0: num(o.y) - hy, y1: num(o.y) + hy };
}

export class Section3D {
  constructor() {
    this.built = null;
    this.project = null;
    this.heights = null;
    this.records = [];
    this.heightItems = new Map();
    this.mode = 'off';
    this.cut = 0;
    this.preset = 'all';
    this.sideState = { axis: 'x', pos: 0, flip: false };
    this.sideBounds = null;
    this.sideRoomBox = null;
    this.sideExtents = { x: { min: 0, max: 0 }, z: { min: 0, max: 0 } };
    this.clipState = { axis: 'y', pos: CLIP.defaultPosMm, flip: false };
    this.boxState = { x: 0, z: 0, h: 3000, preset: 'corner' };
    this.suspended = false;
    this.wallHider = null;
    this.forced = new Map();
    this.onchange = null;
    this._lastApplyMs = 0;
  }

  /** 强制隐藏源（分类显隐 / 隔离 / 视图占位） */
  registerForced(name, fn) {
    if (typeof fn === 'function') this.forced.set(name, fn);
    else this.forced.delete(name);
    this.refresh();
  }

  isForcedHidden(group) {
    for (const fn of this.forced.values()) {
      try {
        if (fn(group)) return true;
      } catch {
        /* 单个源异常不影响仲裁 */
      }
    }
    return false;
  }

  setModel(built, project) {
    this.built = built;
    this.project = project;
    this.heights = sectionHeights(project);
    this.heightItems = new Map(sectionItems(project).map(it => [it.id, it]));
    this.records = [];
    const b = built.bounds;
    const all = [];
    const wallBounds = [];
    for (const group of built.group.children) {
      const o = group.userData && group.userData.obj;
      if (!o || !o.id) continue;
      const type = o.type || 'object';
      const isFloor = type === 'floor' || o.id === '__floor';
      const bounds = isFloor ? null : boundsOfObject(o);
      this.records.push({
        id: o.id,
        type,
        label: (o.props && o.props.name) || o.id,
        group,
        bounds,
        baseVisible: !!group.visible,
        heightHidden: false,
        sideHidden: false,
        boxHidden: false,
        isFloor,
      });
      if (bounds) {
        all.push(bounds);
        if (type === 'wall') wallBounds.push(bounds);
      }
    }
    this.sideBounds = all.length ? uBounds(all) : null;
    this.sideRoomBox = wallBounds.length ? uBounds(wallBounds) : this.sideBounds;
    this.sideExtents = {
      x: { min: this.sideBounds ? this.sideBounds.x0 : 0, max: this.sideBounds ? this.sideBounds.x1 : 12000 },
      z: { min: this.sideBounds ? this.sideBounds.y0 : 0, max: this.sideBounds ? this.sideBounds.y1 : 7000 },
    };
    this.mode = 'off';
    this.cut = 0;
    this.preset = 'all';
    this.sideState = { axis: 'x', pos: sideDefaultPos(this.sideRoomBox, 'x'), flip: false };
    this.clipState = { axis: 'y', pos: clipDefaultCut(this.heights), flip: false };
    this.boxState = defaultBox(this.sideRoomBox, this.heights, BOX.defaultPreset);
    this.suspended = false;
    this._emit(this._apply(), { changedState: true });
  }

  /* ---------- 高度过滤 ---------- */
  get cuts() {
    return { minMm: 600, stepMm: 100, max: 3600 };
  }

  canStartHeight() {
    return this.heightItems.size > 0;
  }

  canStartSide() {
    return !!(this.sideBounds && this.records.some(r => r.bounds));
  }

  canStartClip() {
    return this.records.some(r => !r.isFloor);
  }

  canStartBox() {
    return this.canStartSide();
  }

  get canStart() {
    return this.canStartHeight() || this.canStartSide() || this.canStartClip();
  }

  get active() {
    return this.mode !== 'off';
  }

  get applied() {
    return this.active && !this.suspended;
  }

  get heightApplied() {
    return this.mode === 'height' && !this.suspended;
  }

  get sideApplied() {
    return this.mode === 'side' && !this.suspended;
  }

  get clipApplied() {
    return this.mode === 'clip' && !this.suspended;
  }

  get boxApplied() {
    return this.mode === 'box' && !this.suspended;
  }

  defaultCut() {
    const h = this.heights || {};
    if (Number.isFinite(h.trayBottom)) return h.trayBottom;
    return h.ceilH > 600 ? Math.min(h.ceilH, 2400) : 2400;
  }

  sliderRange() {
    return this.heights ? sliderRange(this.heights) : { min: 600, max: 3600, step: 100 };
  }

  setCut(mm) {
    const v = Math.max(0, Math.min(SECTION.maxCutMm, num(mm)));
    if (v <= 0) return this.reset();
    this.mode = 'height';
    this.cut = v;
    this.preset = matchPreset(v, this.heights);
    this._emit(this._apply(), { changedState: true });
    return true;
  }

  setHeight(mm) {
    return this.setCut(mm);
  }

  setPreset(id) {
    if (id === 'all') return this.reset();
    const v = presetCut(id, this.heights);
    if (v == null) return false;
    this.mode = 'height';
    this.cut = v;
    this.preset = id;
    this._emit(this._apply(), { changedState: true });
    return true;
  }

  /* ---------- 侧别过滤 ---------- */
  sidePlane() {
    return sidePlane(this.sideState);
  }

  setSide(next = {}) {
    const axis = next.axis === 'z' ? 'z' : next.axis === 'x' ? 'x' : this.sideState.axis;
    let posv = next.pos;
    if (posv == null || !Number.isFinite(+posv)) {
      posv = axis !== this.sideState.axis
        ? sideDefaultPos(this.sideRoomBox, axis)
        : this.sideState.pos;
    }
    this.sideState = sidePlane({ axis, pos: posv, flip: next.flip === undefined ? this.sideState.flip : next.flip });
    this.mode = 'side';
    this._emit(this._apply(), { changedState: true });
    return true;
  }

  setSideAxis(axis) {
    return this.setSide({ axis });
  }

  setSidePos(posv) {
    return this.setSide({ pos: posv });
  }

  setSideFlip(flip) {
    return this.setSide({ flip });
  }

  toggleSideFlip() {
    return this.setSide({ flip: !this.sideState.flip });
  }

  sideInfo() {
    const p = this.sidePlane();
    const hiddenRecs = this.records.filter(r => r.bounds && hiddenBySide(r.bounds, p));
    return {
      active: this.active && this.mode === 'side',
      applied: this.sideApplied,
      canStart: this.canStartSide(),
      axis: p.axis,
      axisLabel: SIDE.axisLabel[p.axis],
      axisShort: SIDE.axisShort[p.axis],
      pos: p.pos,
      posM: +(p.pos / 1000).toFixed(3),
      flip: p.flip,
      label: sideLabel(p.axis, p.flip),
      cutSide: sideCutName(p.axis, p.flip),
      keepSide: sideKeepName(p.axis, p.flip),
      range: sideRange(this.sideBounds, p.axis),
      bounds: this.sideBounds,
      roomBounds: this.sideRoomBox,
      counts: { total: this.records.length, hidden: hiddenRecs.length, appliedHidden: this.sideApplied ? hiddenRecs.length : 0 },
      hidden: hiddenRecs.map(r => r.label),
      hiddenIds: hiddenRecs.map(r => r.id),
    };
  }

  /* ---------- 真裁剪 ---------- */
  setClip(next = {}) {
    const axis = next.axis === 'x' || next.axis === 'z' ? next.axis : this.clipState.axis;
    let posv = next.pos;
    if (posv == null || !Number.isFinite(+posv)) {
      posv = axis !== this.clipState.axis
        ? clipDefaultPos(this.heights, this.sideRoomBox, axis)
        : this.clipState.pos;
    }
    this.clipState = {
      axis,
      pos: posv,
      flip: next.flip === undefined ? this.clipState.flip : !!next.flip,
    };
    this.mode = 'clip';
    this._emit(this._apply(), { changedState: true });
    return true;
  }

  setClipAxis(axis) {
    return this.setClip({ axis });
  }

  setClipPos(p) {
    return this.setClip({ pos: p });
  }

  setClipFlip(f) {
    return this.setClip({ flip: f });
  }

  toggleClipFlip() {
    return this.setClip({ flip: !this.clipState.flip });
  }

  clipInfo() {
    const plane = clipPlaneAt(this.clipState.axis, this.clipState.pos, this.clipState.flip);
    const scenePlane = clipScenePlane(plane);
    return {
      active: this.active && this.mode === 'clip',
      applied: this.clipApplied,
      canStart: this.canStartClip(),
      axis: this.clipState.axis,
      axisLabel: CLIP.axisLabel[this.clipState.axis],
      pos: this.clipState.pos,
      posM: +(this.clipState.pos / 1000).toFixed(3),
      flip: this.clipState.flip,
      label: clipLabel(this.clipState.axis, this.clipState.pos, this.clipState.flip),
      cutSide: clipCutName(this.clipState.axis, this.clipState.flip),
      keepSide: clipKeepName(this.clipState.axis, this.clipState.flip),
      range: clipRangeFor(this.heights, this.sideRoomBox, this.clipState.axis),
      defaultPos: clipDefaultPos(this.heights, this.sideRoomBox, this.clipState.axis),
      plane,
      scenePlane,
      capping: false,
      suspended: this.suspended,
    };
  }

  /* ---------- 盒体剖切 ---------- */
  boxRanges() {
    return boxRanges(this.sideRoomBox, this.heights);
  }

  setBox(next = {}) {
    const hasCoord = next.x != null || next.z != null || next.h != null;
    if (next.preset && !hasCoord) return this.setBoxPreset(next.preset);
    const merged = normalizeBox({
      x: next.x == null ? this.boxState.x : next.x,
      z: next.z == null ? this.boxState.z : next.z,
      h: next.h == null ? this.boxState.h : next.h,
      preset: next.preset || this.boxState.preset,
    }, this.boxState, this.sideRoomBox, this.heights);
    merged.preset = matchBoxPreset(merged, this.sideRoomBox, this.heights);
    this.boxState = merged;
    this.mode = 'box';
    this._emit(this._apply(), { changedState: true });
    return true;
  }

  setBoxPreset(id) {
    if (id === 'off') return this.reset();
    if (!boxPreset(id)) return false;
    this.boxState = normalizeBox(
      defaultBox(this.sideRoomBox, this.heights, id),
      this.boxState,
      this.sideRoomBox,
      this.heights,
    );
    this.mode = 'box';
    this._emit(this._apply(), { changedState: true });
    return true;
  }

  setBoxX(x) {
    return this.setBox({ x });
  }

  setBoxZ(z) {
    return this.setBox({ z });
  }

  setBoxHeight(h) {
    return this.setBox({ h });
  }

  boxInfo() {
    const ranges = this.boxRanges();
    const hiddenRecs = this.records.filter(r => {
      if (!r.bounds) return false;
      const item = this.heightItems.get(r.id);
      const range = item ? { minY: item.minY, maxY: item.maxY } : null;
      return hiddenByBox(r.bounds, this.boxState, range);
    });
    const byType = {};
    for (const r of hiddenRecs) byType[r.type] = (byType[r.type] || 0) + 1;
    return {
      active: this.active && this.mode === 'box',
      applied: this.boxApplied,
      canStart: this.canStartBox(),
      preset: this.boxState.preset,
      presetLabel: boxPresetLabel(this.boxState.preset),
      label: boxLabel(this.boxState),
      x: this.boxState.x,
      z: this.boxState.z,
      h: this.boxState.h,
      xM: +(this.boxState.x / 1000).toFixed(3),
      zM: +(this.boxState.z / 1000).toFixed(3),
      hM: +(this.boxState.h / 1000).toFixed(3),
      ranges,
      roomBounds: this.sideRoomBox,
      counts: { total: this.records.length, hidden: hiddenRecs.length, appliedHidden: this.boxApplied ? hiddenRecs.length : 0 },
      byType,
      hidden: hiddenRecs.map(r => r.label),
      hiddenIds: hiddenRecs.map(r => r.id),
      suspended: this.suspended,
    };
  }

  /* ---------- 模式 / 重置 / 挂起 ---------- */
  setMode(mode) {
    const m = String(mode || '').toLowerCase();
    if (m === 'off') return this.reset();
    if (m === 'height') {
      if (!this.canStartHeight()) return false;
      return this.setCut(this.cut > 0 && this.mode === 'height' ? this.cut : this.defaultCut());
    }
    if (m === 'side') return this.setSide({});
    if (m === 'clip') return this.setClip({});
    if (m === 'box') return this.setBoxPreset(this.boxState.preset || BOX.defaultPreset);
    return false;
  }

  reset() {
    if (this.mode === 'off' && !this.suspended) {
      this._emit({ visibilityChanged: false }, { changedState: false });
      return false;
    }
    this.mode = 'off';
    this.cut = 0;
    this.preset = 'all';
    this.sideState = { axis: 'x', pos: sideDefaultPos(this.sideRoomBox, 'x'), flip: false };
    this.clipState = { axis: 'y', pos: clipDefaultCut(this.heights.roomH, CLIP.defaultPosMm), flip: false };
    this.boxState = defaultBox(this.sideRoomBox, this.heights, BOX.defaultPreset);
    this.suspended = false;
    this._emit(this._apply(), { changedState: true });
    return true;
  }

  setSuspended(v) {
    const next = !!v;
    if (next === this.suspended) return false;
    this.suspended = next;
    this._emit(this._apply(), { changedState: true });
    return true;
  }

  refresh() {
    return this._apply();
  }

  _heightHidden(rec) {
    const item = this.heightItems.get(rec.id);
    if (!item) return false;
    return hiddenByCut(item, this.cut);
  }

  _apply() {
    const t0 = performance.now();
    let visibilityChanged = false;
    const mode = this.suspended ? 'off' : this.mode;
    const p = this.sidePlane();
    for (const rec of this.records) {
      let hidden = false;
      if (mode === 'height') hidden = this._heightHidden(rec);
      else if (mode === 'side') hidden = !!rec.bounds && hiddenBySide(rec.bounds, p);
      else if (mode === 'box') {
        const item = this.heightItems.get(rec.id);
        const range = item ? { minY: item.minY, maxY: item.maxY } : null;
        hidden = !!rec.bounds && hiddenByBox(rec.bounds, this.boxState, range);
      }
      const forced = this.isForcedHidden(rec.group);
      const visible = rec.baseVisible && !hidden && !forced;
      rec.heightHidden = mode === 'height' ? hidden : false;
      rec.sideHidden = mode === 'side' ? hidden : false;
      rec.boxHidden = mode === 'box' ? hidden : false;
      // 墙体可见性在未挂起时归近墙管理器所有（淡变 / 透视 / 分类隐藏），
      // 剖切激活时近墙管理器挂起，才由这里接管（侧别/盒体整组隐藏）。
      if (rec.type === 'wall' && this.wallHider && !this.wallHider.suspended) continue;
      if (rec.group.visible !== visible) {
        rec.group.visible = visible;
        visibilityChanged = true;
      }
    }
    this._lastApplyMs = +(performance.now() - t0).toFixed(2);
    return { visibilityChanged, active: this.active, mode: this.mode };
  }

  _emit(result, extra = {}) {
    if (typeof this.onchange === 'function') {
      try {
        this.onchange({
          ...result,
          active: this.active,
          mode: this.mode,
          cut: this.cut,
          preset: this.preset,
          suspended: this.suspended,
          side: this.sideInfo(),
          clip: this.clipInfo(),
          box: this.boxInfo(),
          ...extra,
        });
      } catch (err) {
        console.warn('[剖切] onchange 异常：', err);
      }
    }
  }

  info() {
    return {
      active: this.active,
      applied: this.applied,
      mode: this.mode,
      cut: this.cut,
      cutM: +(this.cut / 1000).toFixed(3),
      preset: this.preset,
      presets: SECTION.presets,
      slider: this.sliderRange(),
      types: SECTION.types,
      heights: this.heights,
      suspended: this.suspended,
      canStart: this.canStart,
      canStartHeight: this.canStartHeight(),
      canStartSide: this.canStartSide(),
      canStartClip: this.canStartClip(),
      canStartBox: this.canStartBox(),
      lastApplyMs: this._lastApplyMs,
      counts: {
        total: this.records.length,
        heightHidden: this.records.filter(r => r.heightHidden).length,
        sideHidden: this.records.filter(r => r.sideHidden).length,
        boxHidden: this.records.filter(r => r.boxHidden).length,
        forced: this.records.filter(r => this.isForcedHidden(r.group)).length,
      },
      side: this.sideInfo(),
      clip: this.clipInfo(),
      box: this.boxInfo(),
    };
  }
}

function uBounds(list) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of list || []) {
    if (!isBounds(b)) continue;
    x0 = Math.min(x0, +b.x0);
    y0 = Math.min(y0, +b.y0);
    x1 = Math.max(x1, +b.x1);
    y1 = Math.max(y1, +b.y1);
  }
  if (!Number.isFinite(x0)) return null;
  return { x0, y0, x1, y1 };
}

/* ---------- 真裁剪示意面 ---------- */
export function createClipVisual() {
  const group = new THREE.Group();
  group.name = 'clip-visual';
  group.visible = false;
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x1abc9c, transparent: true, opacity: 0.05, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }),
  );
  face.renderOrder = 12;
  face.frustumCulled = false;
  group.add(face);
  const div = 8;
  const pts = [];
  for (let i = 0; i <= div; i++) {
    const t = -0.5 + i / div;
    pts.push(t, -0.5, 0, t, 0.5, 0);
    pts.push(-0.5, t, 0, 0.5, t, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const grid = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: 0x0f8a74, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }),
  );
  grid.renderOrder = 13;
  grid.frustumCulled = false;
  group.add(grid);
  return group;
}

export function updateClipVisual(group, info, built) {
  if (!group || !built) return;
  const on = !!(info && info.applied);
  group.visible = on;
  if (!on) return;
  const b = built.bounds;
  const W = Math.max(0.01, (b.maxx - b.minx) / 1000);
  const D = Math.max(0.01, (b.maxy - b.miny) / 1000);
  const H = Math.max(0.01, built.roomH / 1000);
  const cx = (b.minx + b.maxx) / 2000;
  const cz = -(b.miny + b.maxy) / 2000;
  const n = info.plane ? info.plane.normal : { x: 0, y: 1, z: 0 };
  const off = 0.006;
  const face = group.children[0];
  const grid = group.children[1];
  const p = info.scenePlane ? info.scenePlane.constant : 0;
  if (info.axis === 'y') {
    group.scale.set(W, D, 1);
    group.rotation.set(-Math.PI / 2, 0, 0);
    group.position.set(cx + n.x * off, -p + n.y * off, cz + n.z * off);
  } else if (info.axis === 'x') {
    group.scale.set(D, H, 1);
    group.rotation.set(0, Math.PI / 2, 0);
    group.position.set(-p + n.x * off, H / 2 + n.y * off, cz + n.z * off);
  } else {
    group.scale.set(W, H, 1);
    group.rotation.set(0, 0, 0);
    group.position.set(cx + n.x * off, H / 2 + n.y * off, -p + n.z * off);
  }
  face.material.opacity = 0.05;
  grid.material.opacity = 0.3;
}
