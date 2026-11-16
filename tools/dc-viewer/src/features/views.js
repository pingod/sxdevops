/**
 * 视图状态机：轨道全景 / 俯视 / 轴测四角 / 正交立面 / 业务视点 / 对象聚焦。
 * 负责相机模式切换、取景、标签层开关、天花板隐藏与退出还原。
 */
import * as THREE from 'three/webgpu';
import {
  VIEW, TOP_VIEW, ISO_VIEW, ELEVATION_VIEW, VIEWPOINT,
  normalizeViewId, elevationId, deriveRows, topViewPose, isoViewPose, elevationViewPose,
  projectFrame, listViewpoints, summarizeViewpoints,
} from '../camera/pose.js';
import { cabinetLabelItems, LABEL, createLabelLayer } from '../scene/labels.js';
import { MODES } from '../camera/rig.js';
import { FOCUS, focusPose, focusBoxOf, focusLabel } from './focusplan.js';

const smooth = k => k * k * (3 - 2 * k);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const vec = t => new THREE.Vector3(t.x, t.y, t.z);

const VP_ICO = { entry: '⌂', corner: '◆', aisle: '⇥', area: '▣', preset: '▦' };

export class Views {
  constructor(deps) {
    this.rig = deps.rig;
    this.controls = deps.controls;
    this.invalidate = deps.invalidate || (() => {});
    this.onchange = deps.onchange || null;
    this.beforeStart = deps.beforeStart || null;
    this.hideCeiling = deps.hideCeiling || null;
    this.getSelected = deps.getSelected || (() => null);
    this.getHovered = deps.getHovered || (() => null);
    this.isHidden = deps.isHidden || null;
    this.onSelect = deps.onSelect || null;
    this.built = null;
    this.project = null;
    this.rows = [];
    this.cabinets = [];
    this.viewpoints = [];
    this.active = null;
    this.corner = null;
    this.vp = null;
    this.vpTween = null;
    this.focusTween = null;
    this.focus = null;
    this.snap = null;
    this.homeR = 0;
    this.labelsEnabled = true;
    this.ceilingHidden = false;
    this._labels = createLabelLayer({
      rows: [],
      cabinets: [],
      enabled: true,
      getSelected: () => this.getSelected(),
      getHovered: () => this.getHovered(),
      isHidden: this.isHidden ? obj => this.isHidden(obj) : null,
      onSelect: obj => this.onSelect && this.onSelect(obj),
      onchange: () => this._changed('labels'),
    });
  }

  get labels() {
    return this._labels;
  }

  setModel(built, project) {
    this.built = built;
    this.project = project;
    this.rows = deriveRows(project);
    this.cabinets = cabinetLabelItems(project);
    this.viewpoints = listViewpoints(project, built.bounds, { roomH: built.roomH, aspect: this.rig.aspect });
    this._labels.setRows(this.rows);
    this._labels.setCabinets(this.cabinets);
    this._labels.setOptions({
      getSelected: () => this.getSelected(),
      getHovered: () => this.getHovered(),
      isHidden: this.isHidden ? obj => this.isHidden(obj) : null,
      onSelect: obj => this.onSelect && this.onSelect(obj),
    });
    this._labels.setVisible(false);
    this.active = null;
    this.corner = null;
    this.vp = null;
    this.vpTween = null;
    this.focusTween = null;
    this.focus = null;
    this.snap = null;
    this.homeR = 0;
    this.ceilingHidden = false;
    this._setCeilingHidden(false);
  }

  get tweening() {
    return !!(this.vpTween || this.focusTween);
  }

  get activeId() {
    if (this.focus) return 'focus';
    return this.vp || this.active || VIEW.ORBIT;
  }

  get focusActive() {
    return !!this.focus;
  }

  get elevationSide() {
    return this.active && elevationId(this.active) ? this.active : null;
  }

  /* ---------- 进入/退出 ---------- */

  _prepare() {
    if (this.focus) this._dropFocus();
    if (!this.snap) this.snap = this.controls.snapshot();
    if (this.beforeStart) this.beforeStart('view');
    this.vp = null;
    this.vpTween = null;
  }

  _setCeilingHidden(on) {
    this.ceilingHidden = !!on;
    if (this.hideCeiling) this.hideCeiling(!!on);
  }

  goTo(id) {
    const raw = String(id == null ? '' : id).trim().toLowerCase();
    if (!raw || raw === 'view-top' || raw === 'view-iso') {
      if (raw === 'view-top') return this.goTo('top');
      if (raw === 'view-iso') return this.goTo('iso');
      return false;
    }
    const norm = normalizeViewId(raw);
    if (norm === VIEW.ORBIT) return this.exit();
    if (norm === VIEW.TOP) return this.enterTop();
    if (norm && norm.startsWith(VIEW.ISO)) return this.enterIso(norm.endsWith('-se') ? 'se' : norm.endsWith('-sw') ? 'sw' : norm.endsWith('-ne') ? 'ne' : norm.endsWith('-nw') ? 'nw' : ISO_VIEW.defaultCorner);
    const el = elevationId(raw);
    if (el) return this.enterElevation(el);
    const vp = this.viewpoints.find(v => v.id === raw);
    if (vp) return this.enterViewpoint(vp.id);
    return false;
  }

  enterTop() {
    if (this.active === VIEW.TOP && !this.vp) return this.exit();
    this._prepare();
    this.active = VIEW.TOP;
    this.corner = null;
    this.rig.setMode(MODES.ORTHO, { immediate: true });
    const pose = topViewPose(this.built.bounds, { aspect: this.rig.aspect, fov: this.rig.fov });
    this._fitPose(pose);
    this.homeR = pose.r;
    this._setCeilingHidden(true);
    this._labels.setVisible(true);
    this._changed('view');
    return true;
  }

  enterIso(corner) {
    const c = ISO_VIEW.corners[corner] ? corner : ISO_VIEW.defaultCorner;
    if (this.active === VIEW.ISO && this.corner === c) return this.exit();
    this._prepare();
    this.active = VIEW.ISO;
    this.corner = c;
    this.rig.setMode(MODES.ORTHO, { immediate: true });
    const pose = isoViewPose(this.built.bounds, {
      corner: c, aspect: this.rig.aspect, fov: this.rig.fov, roomH: this.built.roomH,
    });
    this._fitPose(pose);
    this.homeR = pose.r;
    this._setCeilingHidden(false);
    this._labels.setVisible(true);
    this._changed('view');
    return true;
  }

  enterElevation(side) {
    const s = elevationId(side);
    if (!s) return false;
    this._prepare();
    this.active = s;
    this.corner = null;
    this.rig.setMode(MODES.ORTHO, { immediate: true });
    const pose = elevationViewPose(this.built.bounds, {
      side: s, aspect: this.rig.aspect, fov: this.rig.fov, roomH: this.built.roomH,
    });
    this._fitPose(pose);
    this.homeR = pose.r;
    this._setCeilingHidden(false);
    this._labels.setVisible(false);
    this._changed('view');
    return true;
  }

  enterViewpoint(id) {
    const vp = this.viewpoints.find(v => v.id === id);
    if (!vp) return false;
    if (this.vp === id && this.active === 'viewpoint') return this.exit();
    this._prepare();
    this.active = 'viewpoint';
    this.vp = id;
    this.corner = null;
    this.vpTween = null;
    this.rig.setMode(MODES.PERSPECTIVE, { duration: 0.75, immediate: this.rig.reduced });
    this._setCeilingHidden(false);
    this._labels.setVisible(false);
    const to = { target: vec(vp.target), r: vp.r, theta: vp.theta, phi: vp.phi };
    this._startTween(to, VIEWPOINT.tweenSec);
    this._changed('viewpoint');
    return true;
  }

  _fitPose(pose) {
    this._cancelTween();
    this.controls.fit(vec(pose.target), pose.r, pose.theta, pose.phi);
    this.invalidate();
  }

  _startTween(to, sec) {
    const cur = {
      target: this.controls.tg.clone(),
      r: this.controls.cur.r,
      theta: this.controls.cur.t,
      phi: this.controls.cur.p,
    };
    let d = to.theta - cur.theta;
    d = ((((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
    const dur = this.rig.reduced ? 0 : sec;
    this.vpTween = {
      from: cur, to: { ...to, theta: cur.theta + d }, dur, t: 0, immediate: !(dur > 0),
    };
    if (!(dur > 0)) this._finishTween();
    this.invalidate();
  }

  _cancelTween() {
    this.vpTween = null;
  }

  cancelTween() {
    if (this.vpTween) {
      this.vpTween = null;
      this.controls.dst.r = this.controls.cur.r;
      this.controls.dst.t = this.controls.cur.t;
      this.controls.dst.p = this.controls.cur.p;
      this.controls.tgD.copy(this.controls.tg);
    }
    if (this.focusTween) this.cancelFocusTween();
  }

  _finishTween() {
    const tw = this.vpTween;
    if (!tw) return;
    const { to } = tw;
    this.controls.tg.copy(to.target);
    this.controls.tgD.copy(to.target);
    this.controls.cur.r = this.controls.dst.r = to.r;
    this.controls.cur.t = this.controls.dst.t = to.theta;
    this.controls.cur.p = this.controls.dst.p = to.phi;
    this.controls.update(true);
    this.vpTween = null;
    this.invalidate();
    this._changed('viewpoint-done');
  }

  toggle(id = VIEW.TOP) {
    const norm = normalizeViewId(id) || id;
    if (norm === VIEW.TOP) return this.active === VIEW.TOP ? this.exit() : this.enterTop();
    if (String(norm).startsWith(VIEW.ISO)) return this.enterIso(this.corner || ISO_VIEW.defaultCorner);
    return this.goTo(id);
  }

  cycleIso() {
    const order = ISO_VIEW.order;
    const next = order[(order.indexOf(this.corner || ISO_VIEW.defaultCorner) + 1) % order.length];
    this.enterIso(next);
  }

  /** 业务视点下一个/上一个（排除 preset） */
  _cycleViewpoint(dir) {
    const list = this.viewpoints.filter(v => v.kind !== 'preset');
    if (!list.length) return false;
    const i = list.findIndex(v => v.id === this.vp);
    const n = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
    return this.enterViewpoint(list[n].id);
  }

  next() {
    return this._cycleViewpoint(1);
  }

  prev() {
    return this._cycleViewpoint(-1);
  }

  back() {
    return this.exit();
  }

  exit() {
    if (this.focus) return this.exitFocus();
    if (!this.active && !this.vp) return false;
    const snap = this.snap;
    this._cancelTween();
    this.active = null;
    this.corner = null;
    this.vp = null;
    this.homeR = 0;
    this._setCeilingHidden(false);
    this._labels.setVisible(false);
    if (snap) this.controls.restore(snap);
    this.snap = null;
    this.invalidate();
    this._changed('exit');
    return true;
  }

  reset() {
    this.snap = null;
    this.active = null;
    this.corner = null;
    this.vp = null;
    this.homeR = 0;
    this._cancelTween();
    this._setCeilingHidden(false);
    if (this._labels) this._labels.setVisible(false);
  }

  /* ---------- 聚焦 ---------- */

  _focusRoom() {
    const built = this.built;
    if (!built) return null;
    const frame = projectFrame(this.project, built.bounds, built.roomH);
    const spanX = (frame.maxx - frame.minx) / 1000;
    const spanZ = (frame.maxy - frame.miny) / 1000;
    const m = Math.min(0.4, Math.max(0.02, spanX * 0.25), Math.max(0.02, spanZ * 0.25));
    const minyP = frame.miny / 1000;
    const maxyP = frame.maxy / 1000;
    const ceil = built.ceilH || built.roomH;
    const maxy = Math.max(0.35, ceil / 1000 - 0.2);
    return {
      minx: frame.minx / 1000 + m,
      maxx: frame.maxx / 1000 - m,
      minz: -maxyP + m,
      maxz: -minyP - m,
      miny: 0.25,
      maxy,
    };
  }

  focusObject(obj, opts = {}) {
    if (!obj || !this.built) return false;
    if (this.focus && this.focus.obj === obj) return true;
    const first = !this.focus;
    if (first) {
      this.snap = this.controls.snapshot();
      this._focusStart = {
        active: this.active,
        corner: this.corner,
        vp: this.vp,
        ceilingHidden: this.ceilingHidden,
      };
      if (this.beforeStart) this.beforeStart('focus');
      this.vpTween = null;
    }
    const box = opts.box || focusBoxOf(obj, { roomH: this.built.roomH, ceilH: this.built.ceilH, objects: this.project.objects });
    if (!box) return false;
    const pose = focusPose({
      box,
      theta: this.controls.cur.t,
      phi: this.controls.cur.p,
      fov: this.rig.fov,
      aspect: this.rig.aspect,
      mode: this.rig.mode,
      room: opts.room || this._focusRoom(),
    });
    if (!pose) return false;
    this.active = 'focus';
    this.vp = null;
    this.corner = null;
    this.focus = {
      obj,
      id: obj.id,
      type: obj.type,
      label: focusLabel(obj),
      box,
      target: pose.target,
      r: pose.r,
      theta: pose.theta,
      phi: pose.phi,
      fitR: pose.fitR,
      clamped: pose.clamped,
      phiAdjusted: pose.phiAdjusted,
      aboveCeiling: pose.aboveCeiling,
      insideRoom: pose.insideRoom,
    };
    this.homeR = pose.r;
    if (obj.type !== 'ceiling') this._setCeilingHidden(true);
    this._labels.setVisible(false);
    this.startFocusTween(pose, opts.immediate);
    this._changed('focus');
    return true;
  }

  startFocusTween(pose, immediate) {
    const from = {
      target: this.controls.tg.clone(),
      r: this.controls.cur.r,
      theta: this.controls.cur.t,
      phi: this.controls.cur.p,
    };
    let d = pose.theta - from.theta;
    d = ((((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
    const to = {
      target: vec(pose.target),
      r: pose.r,
      theta: from.theta + d,
      phi: clamp(pose.phi, this.rig.limits.min, this.rig.limits.max),
    };
    const dur = immediate || this.rig.reduced ? 0 : FOCUS.tweenSec;
    this.focusTween = { from, to, dur, t: 0 };
    if (!(dur > 0)) this._finishFocusTween();
    this.invalidate();
  }

  stepFocusTween(dt) {
    const tw = this.focusTween;
    if (!tw) return false;
    tw.t += Math.max(0, dt);
    const k = tw.dur > 0 ? Math.min(1, tw.t / tw.dur) : 1;
    const e = smooth(k);
    const { from, to } = tw;
    this.controls.tg.lerpVectors(from.target, to.target, e);
    this.controls.tgD.copy(this.controls.tg);
    this.controls.cur.r = this.controls.dst.r = from.r + (to.r - from.r) * e;
    this.controls.cur.t = this.controls.dst.t = from.theta + (to.theta - from.theta) * e;
    this.controls.cur.p = this.controls.dst.p = from.phi + (to.phi - from.phi) * e;
    this.controls.update(true);
    this.invalidate();
    if (k >= 1) {
      this.controls.tg.copy(to.target);
      this.controls.tgD.copy(to.target);
      this.controls.cur.r = this.controls.dst.r = to.r;
      this.controls.cur.t = this.controls.dst.t = to.theta;
      this.controls.cur.p = this.controls.dst.p = to.phi;
      this.controls.update(true);
      this.homeR = to.r;
      this.focusTween = null;
      this._changed('focus-done');
      return false;
    }
    return true;
  }

  cancelFocusTween() {
    this.controls.dst.r = this.controls.cur.r;
    this.controls.dst.t = this.controls.cur.t;
    this.controls.dst.p = this.controls.cur.p;
    this.controls.tgD.copy(this.controls.tg);
    this.focusTween = null;
  }

  exitFocus() {
    if (!this.focus) return false;
    this.focusTween = null;
    const start = this._focusStart;
    this.focus = null;
    this._setCeilingHidden(false);
    const snap = this.snap;
    if (start) {
      this.active = start.active;
      this.corner = start.corner;
      this.vp = start.vp;
      this._setCeilingHidden(start.ceilingHidden);
    } else {
      this.active = null;
      this.corner = null;
      this.vp = null;
    }
    if (snap) this.controls.restore(snap);
    this.snap = null;
    this._focusStart = null;
    if (this.active === VIEW.TOP || this.active === VIEW.ISO) this._labels.setVisible(true);
    else this._labels.setVisible(false);
    this.invalidate();
    this._changed('exit-focus');
    return true;
  }

  _dropFocus() {
    if (!this.focus) return;
    this.focusTween = null;
    this.focus = null;
    const start = this._focusStart;
    if (start) {
      this.active = start.active;
      this.corner = start.corner;
      this.vp = start.vp;
    }
    this._focusStart = null;
    this._setCeilingHidden(false);
    this._labels.setVisible(false);
  }

  /* ---------- 每帧 ---------- */

  update(dt, camera, viewport) {
    if (this.vpTween) {
      const tw = this.vpTween;
      tw.t += Math.max(0, dt);
      const k = tw.dur > 0 ? Math.min(1, tw.t / tw.dur) : 1;
      const e = smooth(k);
      const { from, to } = tw;
      this.controls.tg.lerpVectors(from.target, to.target, e);
      this.controls.tgD.copy(this.controls.tg);
      this.controls.cur.r = this.controls.dst.r = from.r + (to.r - from.r) * e;
      this.controls.cur.t = this.controls.dst.t = from.theta + (to.theta - from.theta) * e;
      this.controls.cur.p = this.controls.dst.p = from.phi + (to.phi - from.phi) * e;
      this.controls.update(true);
      this.invalidate();
      if (k >= 1) this._finishTween();
    }
    if (this.focusTween) this.stepFocusTween(dt);
    if (this._labels.info().visible) this.syncLabels(camera, viewport);
  }

  syncLabels(camera, viewport) {
    if (!this.built) return;
    const active = this.activeId;
    const isTop = active === VIEW.TOP;
    const isIso = active === VIEW.ISO;
    if (!isTop && !isIso) {
      this._labels.setVisible(false);
      return;
    }
    const vp = viewport || { w: this.rig.aspect * 1000, h: 1000 };
    const ppm = 1 / this.rig.worldPerPixel(vp.h, this.controls.cur.r);
    const allowRows = isTop && this.controls.cur.p <= LABEL.rowMaxPhi;
    const allowCabs = isTop || isIso;
    this._labels.update(camera, allowRows, vp, { ppm, allowRows, allowCabs });
  }

  onResize() {
    if (!this.built) return;
    if (this.active === VIEW.TOP) {
      const pose = topViewPose(this.built.bounds, { aspect: this.rig.aspect, fov: this.rig.fov });
      this._refitRelative(pose);
    } else if (this.active === VIEW.ISO) {
      const pose = isoViewPose(this.built.bounds, {
        corner: this.corner, aspect: this.rig.aspect, fov: this.rig.fov, roomH: this.built.roomH,
      });
      this._refitRelative(pose);
    } else if (this.elevationSide) {
      const pose = elevationViewPose(this.built.bounds, {
        side: this.elevationSide, aspect: this.rig.aspect, fov: this.rig.fov, roomH: this.built.roomH,
      });
      this._refitRelative(pose);
    }
  }

  _refitRelative(pose) {
    const k = this.homeR > 0 ? pose.r / this.homeR : 1;
    this.controls.tg.copy(vec(pose.target));
    this.controls.tgD.copy(pose.target);
    if (k === 1) {
      this.controls.cur.r = this.controls.dst.r = pose.r;
    } else {
      this.controls.cur.r *= k;
      this.controls.dst.r *= k;
    }
    this.controls.cur.t = this.controls.dst.t = pose.theta;
    this.controls.cur.p = this.controls.dst.p = pose.phi;
    this.controls.update(true);
    this.homeR = pose.r;
    this.invalidate();
  }

  setLabelsEnabled(on) {
    const changed = this._labels.setEnabled(on);
    this.labelsEnabled = this._labels.info().enabled;
    return changed;
  }

  labelInfo() {
    return this._labels.info();
  }

  setLabelOptions(opts) {
    return this._labels.setOptions(opts);
  }

  info() {
    const f = this.focus;
    return {
      active: this.active,
      activeId: this.activeId,
      corner: this.corner,
      viewpoint: this.vp,
      viewpointLabel: this.vp ? (this.viewpoints.find(v => v.id === this.vp) || {}).label || '' : '',
      labels: this._labels.info(),
      focus: f
        ? {
          active: true,
          id: f.id,
          label: f.label,
          type: f.type,
          r: +f.r.toFixed(3),
          target: { x: +f.target.x.toFixed(3), y: +f.target.y.toFixed(3), z: +f.target.z.toFixed(3) },
          clamped: f.clamped,
          phiAdjusted: f.phiAdjusted,
          aboveCeiling: f.aboveCeiling,
          tween: !!this.focusTween,
        }
        : { active: false },
      viewpointCount: this.viewpoints.length,
      viewpoints: summarizeViewpoints(this.viewpoints),
      rows: this.rows.length,
      cabinets: this.cabinets.length,
      ceilingHidden: this.ceilingHidden,
      tween: !!this.vpTween,
      snap: !!this.snap,
    };
  }

  _changed(reason = 'view') {
    this.invalidate();
    if (typeof this.onchange === 'function') {
      try {
        this.onchange(this.info(), reason);
      } catch (err) {
        console.warn('[视图] onchange 异常：', err);
      }
    }
  }
}

export { VP_ICO, ELEVATION_VIEW };
