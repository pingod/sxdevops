/**
 * 轨道控制器（手写，不依赖 three/examples）：
 *   左键拖动旋转；右键/中键/Shift+左键平移；滚轮缩放；触屏单指旋转、双指捏合+平移。
 * 阻尼 0.22/帧；enabled=false 时让出相机（巡视/步行接管）。
 */
import * as THREE from 'three/webgpu';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Orbit {
  constructor(rig, dom) {
    this.rig = rig;
    this.dom = dom;
    this.tg = new THREE.Vector3();
    this.tgD = new THREE.Vector3();
    this.cur = { r: 20, t: Math.PI / 4, p: 1.0 };
    this.dst = { r: 20, t: Math.PI / 4, p: 1.0 };
    this.enabled = true;
    this.oninput = null;
    this._pts = new Map();
    this._pinch = 0;

    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', e => this._down(e));
    dom.addEventListener('pointermove', e => this._move(e));
    window.addEventListener('pointerup', e => this._up(e));
    window.addEventListener('pointercancel', e => this._up(e));
    dom.addEventListener('wheel', e => {
      if (!this.enabled) return;
      e.preventDefault();
      if (this.oninput) this.oninput();
      this.dst.r = clamp(this.dst.r * Math.exp(e.deltaY * 0.0012), 0.3, 800);
    }, { passive: false });
    dom.addEventListener('contextmenu', e => e.preventDefault());
  }

  get camera() {
    return this.rig.camera;
  }

  get limits() {
    return this.rig.limits;
  }

  /** 取景：对准目标并设定初始视角 */
  fit(target, radius, theta = Math.PI / 4, phi = 1.02) {
    this.tg.copy(target);
    this.tgD.copy(target);
    this.cur.r = this.dst.r = radius;
    this.cur.t = this.dst.t = theta;
    this.cur.p = this.dst.p = phi;
    this.update(true);
  }

  _down(e) {
    if (!this.enabled) return;
    if (this.oninput) this.oninput();
    if (this.dom.setPointerCapture) {
      try {
        this.dom.setPointerCapture(e.pointerId);
      } catch {
        /* 指针已失效时忽略 */
      }
    }
    this._pts.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey });
    if (this._pts.size === 2) {
      const [a, b] = [...this._pts.values()];
      this._pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }

  _move(e) {
    if (!this.enabled) return;
    const p = this._pts.get(e.pointerId);
    if (!p) return;
    if (this.oninput) this.oninput();
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (this._pts.size === 2) {
      const [a, b] = [...this._pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this._pinch > 0) this.dst.r = clamp((this.dst.r * this._pinch) / d, 0.3, 800);
      this._pinch = d;
      this._pan(dx / 2, dy / 2);
      return;
    }
    if (p.btn === 2 || p.btn === 1 || p.shift) this._pan(dx, dy);
    else {
      const lim = this.limits;
      this.dst.t -= dx * 0.0052;
      this.dst.p = clamp(this.dst.p - dy * 0.0052, lim.min, lim.max);
    }
  }

  _up(e) {
    this._pts.delete(e.pointerId);
    this._pinch = 0;
  }

  snapshot() {
    return {
      target: this.tg.clone(),
      targetD: this.tgD.clone(),
      cur: { ...this.cur },
      dst: { ...this.dst },
      rig: this.rig.snapshot(),
    };
  }

  restore(snap) {
    if (!snap) return;
    if (snap.rig) this.rig.restore(snap.rig);
    this.tg.copy(snap.target);
    this.tgD.copy(snap.targetD);
    this.cur = { ...snap.cur };
    this.dst = { ...snap.dst };
    this._pts.clear();
    this._pinch = 0;
    this.update(true);
  }

  _pan(dx, dy) {
    const k = this.rig.worldPerPixel(this.dom.clientHeight || 1, this.dst.r);
    this.camera.updateMatrix();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    this.tgD.addScaledVector(right, -dx * k);
    this.tgD.addScaledVector(up, dy * k);
  }

  get moving() {
    const eps = Math.max(this.cur.r, 1e-4) * 1e-3;
    return Math.abs(this.dst.r - this.cur.r) > eps
      || Math.abs(this.dst.t - this.cur.t) > 1e-3
      || Math.abs(this.dst.p - this.cur.p) > 1e-3
      || this.tg.distanceToSquared(this.tgD) > eps * eps;
  }

  update(snap) {
    const k = snap ? 1 : 0.22;
    const lim = this.limits;
    this.dst.p = clamp(this.dst.p, lim.min, lim.max);
    this.cur.p = clamp(this.cur.p, lim.min, lim.max);
    this.cur.r += (this.dst.r - this.cur.r) * k;
    this.cur.t += (this.dst.t - this.cur.t) * k;
    this.cur.p += (this.dst.p - this.cur.p) * k;
    this.tg.lerp(this.tgD, k);
    this.rig.applyPose(this.tg, this.cur.r, this.cur.t, this.cur.p);
  }
}
