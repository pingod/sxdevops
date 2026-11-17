/**
 * 轻量轨道相机控制器（3D 查看专用，不依赖 three/examples）：
 *   左键拖动 = 旋转；右键 / 中键 / Shift+左键拖动 = 平移；滚轮 = 缩放；
 *   触屏：单指旋转，双指捏合缩放 + 平移。带阻尼平滑。
 */
import * as THREE from '../../lib/three/three.webgpu.min.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Orbit3D {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.tg = new THREE.Vector3();        // 当前观察目标
    this.tgD = new THREE.Vector3();       // 目标观察点（阻尼）
    this.cur = { r: 20, t: Math.PI / 4, p: 1.0 }; // 当前球坐标：半径/方位角/极角
    this.dst = { r: 20, t: Math.PI / 4, p: 1.0 }; // 目标球坐标
    this._pts = new Map();                // 活动指针
    this._pinch = 0;                      // 双指上一帧间距

    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', e => this._down(e));
    dom.addEventListener('pointermove', e => this._move(e));
    window.addEventListener('pointerup', e => this._up(e));
    window.addEventListener('pointercancel', e => this._up(e));
    dom.addEventListener('wheel', e => {
      e.preventDefault();
      this.dst.r = clamp(this.dst.r * Math.exp(e.deltaY * 0.0012), 0.3, 800);
    }, { passive: false });
    dom.addEventListener('contextmenu', e => e.preventDefault());
  }

  /** 取景：对准目标点并设定初始视角（方位角默认东南上方俯视） */
  fit(target, radius, theta = Math.PI / 4, phi = 1.02) {
    this.tg.copy(target); this.tgD.copy(target);
    this.cur.r = this.dst.r = radius;
    this.cur.t = this.dst.t = theta;
    this.cur.p = this.dst.p = phi;
    this.update(true);
  }

  _down(e) {
    this.dom.setPointerCapture && this.dom.setPointerCapture(e.pointerId);
    this._pts.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey });
    if (this._pts.size === 2) {
      const [a, b2] = [...this._pts.values()];
      this._pinch = Math.hypot(a.x - b2.x, a.y - b2.y);
    }
  }

  _move(e) {
    const p = this._pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (this._pts.size === 2) { // 双指：捏合缩放 + 中点平移
      const [a, b2] = [...this._pts.values()];
      const d = Math.hypot(a.x - b2.x, a.y - b2.y);
      if (this._pinch > 0) this.dst.r = clamp(this.dst.r * this._pinch / d, 0.3, 800);
      this._pinch = d;
      this._pan(dx / 2, dy / 2);
      return;
    }
    if (p.btn === 2 || p.btn === 1 || p.shift) this._pan(dx, dy); // 右/中键/Shift = 平移
    else { // 左键 = 旋转
      this.dst.t -= dx * 0.0052;
      this.dst.p = clamp(this.dst.p - dy * 0.0052, 0.08, 1.52);
    }
  }

  _up(e) {
    this._pts.delete(e.pointerId);
    this._pinch = 0;
  }

  /** 按当前缩放级别把屏幕像素位移换算为世界平移 */
  _pan(dx, dy) {
    const h = this.dom.clientHeight || 1;
    const k = this.dst.r * Math.tan(this.camera.fov * Math.PI / 360) * 2 / h;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    this.tgD.addScaledVector(right, -dx * k);
    this.tgD.addScaledVector(up, dy * k);
  }

  /** 阻尼是否仍在收敛（相机姿态还有肉眼可见的变化）：渲染循环据此决定是否继续出帧。
   *  阈值取相对半径的量（远景更宽松），保证阻尼尾巴会真正停住，不会一直出帧。 */
  get moving() {
    const eps = Math.max(this.cur.r, 1e-4) * 1e-3;
    return Math.abs(this.dst.r - this.cur.r) > eps ||
      Math.abs(this.dst.t - this.cur.t) > 1e-3 ||
      Math.abs(this.dst.p - this.cur.p) > 1e-3 ||
      this.tg.distanceToSquared(this.tgD) > eps * eps;
  }

  /** 每帧调用：阻尼逼近目标姿态并更新相机 */
  update(snap) {
    const k = snap ? 1 : 0.22;
    this.cur.r += (this.dst.r - this.cur.r) * k;
    this.cur.t += (this.dst.t - this.cur.t) * k;
    this.cur.p += (this.dst.p - this.cur.p) * k;
    this.tg.lerp(this.tgD, k);
    const sp = Math.sin(this.cur.p);
    this.camera.position.set(
      this.tg.x + this.cur.r * sp * Math.sin(this.cur.t),
      this.tg.y + this.cur.r * Math.cos(this.cur.p),
      this.tg.z + this.cur.r * sp * Math.cos(this.cur.t));
    this.camera.lookAt(this.tg);
  }
}
