/**
 * 相机底座：透视 / 正交双相机，共用 target + (r, theta, phi) 轨道状态。
 * 正交可见高度 = 2·r·tan(fov/2)，切换模式时 0.75s 投影矩阵混合。
 */
import * as THREE from 'three/webgpu';

export const MODES = Object.freeze({ PERSPECTIVE: 'perspective', ORTHO: 'ortho' });
export const TRANSITION_SEC = 0.75;
export const ORTHO_BASE_HEIGHT = 10;
export const PERSP_LIMIT = Object.freeze({ min: 0.08, max: 1.52 });
export const ORTHO_LIMIT = Object.freeze({ min: 0.01, max: Math.PI / 2 - 1e-4 });

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = k => k * k * (3 - 2 * k);

function prefersReduced() {
  return typeof window !== 'undefined'
    && !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** 模式归一化；非法返回 null */
export function normalizeMode(mode) {
  const s = String(mode || '').toLowerCase();
  if (s === 'ortho' || s === 'orthographic') return MODES.ORTHO;
  if (s === 'persp' || s === 'perspective') return MODES.PERSPECTIVE;
  return null;
}

export class CameraRig {
  constructor(opts = {}) {
    this.fov = Number.isFinite(opts.fov) ? opts.fov : 45;
    this.aspect = 1;
    this.transitionSec = Number.isFinite(opts.transitionSec) ? opts.transitionSec : TRANSITION_SEC;
    this.reduced = opts.reducedMotion === undefined ? prefersReduced() : !!opts.reducedMotion;
    const near = Number.isFinite(opts.near) ? opts.near : 0.05;
    const far = Number.isFinite(opts.far) ? opts.far : 1000;
    this.persp = new THREE.PerspectiveCamera(this.fov, 1, near, far);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, near, far);
    this.mode = MODES.PERSPECTIVE;
    this.zoom = 1;
    this._pose = { target: new THREE.Vector3(0, 1, 0), r: 20, theta: Math.PI / 4, phi: 0.85 };
    this._transition = null;
    this._lastE = 0;
    this._pPersp = new THREE.Matrix4();
    this._pOrtho = new THREE.Matrix4();
    this.zoom = this._zoomFor(this._pose.r);
    this.ortho.zoom = this.zoom;
    this.resize(Number.isFinite(opts.aspect) ? opts.aspect : 1);
  }

  /** 渲染相机：过渡中始终用透视相机 + 混合投影，避免闪跳 */
  get camera() {
    return this._transition ? this.persp : this._active();
  }

  get transitioning() {
    return !!this._transition;
  }

  get limits() {
    return this.mode === MODES.ORTHO ? ORTHO_LIMIT : PERSP_LIMIT;
  }

  _active() {
    return this.mode === MODES.ORTHO ? this.ortho : this.persp;
  }

  _zoomFor(r) {
    const visible = 2 * Math.max(r, 1e-4) * Math.tan((this.fov * Math.PI) / 360);
    return clamp(ORTHO_BASE_HEIGHT / Math.max(visible, 1e-6), 1e-4, 1e6);
  }

  /** 取景：场景米制包围盒 → {target, radius} */
  fit(bounds, padding = 1.05) {
    const b = bounds || {};
    const minx = Number.isFinite(b.minx) ? b.minx : 0;
    const maxx = Number.isFinite(b.maxx) ? b.maxx : minx;
    const miny = Number.isFinite(b.miny) ? b.miny : 0;
    const maxy = Number.isFinite(b.maxy) ? b.maxy : miny;
    const minz = Number.isFinite(b.minz) ? b.minz : 0;
    const maxz = Number.isFinite(b.maxz) ? b.maxz : minz;
    const w = Math.max(0, maxx - minx);
    const d = Math.max(0, maxz - minz);
    const h = Math.max(0, maxy - miny);
    const target = new THREE.Vector3((minx + maxx) / 2, miny + h * 0.32, (minz + maxz) / 2);
    const diag = Math.hypot(w, d, h);
    return { target, radius: Math.max(diag * padding, 3) };
  }

  /** 视口像素 → 世界单位（两种相机同一语义） */
  worldPerPixel(viewportHeight, radius = this._pose.r) {
    const h = Math.max(1, Number(viewportHeight) || 1);
    const r = Math.max(1e-4, Number(radius) || this._pose.r);
    return (2 * r * Math.tan((this.fov * Math.PI) / 360)) / h;
  }

  resize(aspect) {
    const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    this.aspect = a;
    this.persp.aspect = a;
    this.persp.updateProjectionMatrix();
    const h = ORTHO_BASE_HEIGHT;
    const w = h * a;
    this.ortho.left = -w / 2;
    this.ortho.right = w / 2;
    this.ortho.top = h / 2;
    this.ortho.bottom = -h / 2;
    this.ortho.updateProjectionMatrix();
    if (this._transition) this._updateBlend(this._lastE);
  }

  setClip(near, far) {
    const n = Number.isFinite(near) && near > 0 ? near : this.persp.near;
    const f = Number.isFinite(far) && far > n ? far : this.persp.far;
    for (const c of [this.persp, this.ortho]) {
      c.near = n;
      c.far = f;
    }
    this.persp.updateProjectionMatrix();
    this.ortho.updateProjectionMatrix();
    if (this._transition) this._updateBlend(this._lastE);
  }

  applyPose(target, r, theta, phi) {
    const R = clamp(Number.isFinite(r) ? r : this._pose.r, 0.05, 5000);
    const T = Number.isFinite(theta) ? theta : this._pose.theta;
    const P = clamp(Number.isFinite(phi) ? phi : this._pose.phi, this.limits.min, this.limits.max);
    this._pose.target.copy(target);
    this._pose.r = R;
    this._pose.theta = T;
    this._pose.phi = P;
    this.zoom = this._zoomFor(R);
    this._applyPoseTo(this.camera, target, R, T, P);
    if (this._transition) this._updateBlend(this._lastE);
  }

  switchNow(mode) {
    const m = normalizeMode(mode);
    if (!m) return false;
    this._finishTransition();
    this.mode = m;
    this._applyPoseTo(this._active(), this._pose.target, this._pose.r, this._pose.theta, this._pose.phi);
    return true;
  }

  setMode(mode, opts = {}) {
    const m = normalizeMode(mode);
    if (!m) return false;
    if (this._transition) this._finishTransition();
    if (m === this.mode) return false;
    const duration = Number.isFinite(opts.duration) ? opts.duration : this.transitionSec;
    if (opts.immediate || this.reduced || !(duration > 0)) return this.switchNow(m);
    const from = this.mode;
    const cam = this._active();
    this.persp.position.copy(cam.position);
    this.persp.quaternion.copy(cam.quaternion);
    this.persp.near = cam.near;
    this.persp.far = cam.far;
    this.mode = m;
    this._transition = { from, to: m, t: 0, dur: duration };
    this._lastE = 0;
    this._applyPoseTo(this.persp, this._pose.target, this._pose.r, this._pose.theta, this._pose.phi);
    this._updateBlend(0);
    return true;
  }

  /** 模式过渡推进；返回是否仍在过渡或本帧刚结束 */
  update(dt) {
    const tr = this._transition;
    if (!tr) return false;
    tr.t += Math.max(0, Number(dt) || 0);
    const k = Math.min(1, tr.t / Math.max(1e-4, tr.dur));
    this._lastE = smooth(k);
    this._updateBlend(this._lastE);
    if (k >= 1) {
      this._finishTransition();
      return true;
    }
    return true;
  }

  finishTransition() {
    return this._finishTransition();
  }

  snapshot() {
    return { mode: this.mode, zoom: this.zoom };
  }

  restore(snap) {
    if (!snap) return false;
    return this.switchNow(normalizeMode(snap.mode) || MODES.PERSPECTIVE);
  }

  info() {
    const orthoZoom = +this.zoom.toFixed(4);
    return {
      mode: this.mode,
      zoom: this.mode === MODES.ORTHO ? orthoZoom : 1,
      orthoZoom,
      transitioning: !!this._transition,
      fov: this.fov,
      aspect: +this.aspect.toFixed(4),
      orthoHeight: +(ORTHO_BASE_HEIGHT / Math.max(this.zoom, 1e-6)).toFixed(3),
      limits: { min: +this.limits.min.toFixed(4), max: +this.limits.max.toFixed(4) },
    };
  }

  _applyPoseTo(cam, target, r, theta, phi) {
    const sp = Math.sin(phi);
    cam.position.set(
      target.x + r * sp * Math.sin(theta),
      target.y + r * Math.cos(phi),
      target.z + r * sp * Math.cos(theta),
    );
    cam.lookAt(target);
    cam.updateMatrix();
    cam.updateMatrixWorld();
    if (cam === this.ortho) {
      this.ortho.zoom = this.zoom;
      this.ortho.updateProjectionMatrix();
    } else if (!this._transition) {
      this.persp.fov = this.fov;
      this.persp.aspect = this.aspect;
      this.persp.zoom = 1;
      this.persp.updateProjectionMatrix();
    }
  }

  _updateBlend(e) {
    const tr = this._transition;
    if (!tr) return;
    this._lastE = clamp(e, 0, 1);
    this.persp.fov = this.fov;
    this.persp.aspect = this.aspect;
    this.persp.zoom = 1;
    this.persp.updateProjectionMatrix();
    this._pPersp.copy(this.persp.projectionMatrix);
    this.ortho.zoom = this.zoom;
    this.ortho.updateProjectionMatrix();
    this._pOrtho.copy(this.ortho.projectionMatrix);
    const from = tr.from === MODES.PERSPECTIVE ? this._pPersp : this._pOrtho;
    const to = tr.to === MODES.PERSPECTIVE ? this._pPersp : this._pOrtho;
    const a = from.elements;
    const b = to.elements;
    const out = this.persp.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) out[i] = a[i] + (b[i] - a[i]) * this._lastE;
    this.persp.projectionMatrixInverse.copy(this.persp.projectionMatrix).invert();
  }

  _finishTransition() {
    if (!this._transition) return false;
    this._transition = null;
    this._lastE = 0;
    this.persp.updateProjectionMatrix();
    const cam = this._active();
    cam.position.copy(this.persp.position);
    cam.quaternion.copy(this.persp.quaternion);
    this._applyPoseTo(cam, this._pose.target, this._pose.r, this._pose.theta, this._pose.phi);
    return true;
  }
}
