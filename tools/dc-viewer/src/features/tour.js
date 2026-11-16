/**
 * 自动巡检（第一视角自动巡视）：沿规划路线匀速行走，扫视 + 点头 + 起伏。
 * 进入/退出用过场贝塞尔平滑过渡；支持暂停、1/2/4× 速度、无级换线、与手动步行互切。
 */
import * as THREE from 'three/webgpu';
import { planRoute, posAt, yaw2d, listRoutes, routeLabelOf, routeHintOf } from './route.js';

export const TOUR_FP = Object.freeze({
  eye: 1.62,
  walk: 1.25,
  lookAhead: 1.8,
  turn: 4.2,
  enterSec: 1.8,
  exitSec: 1.3,
  handoffSec: 1.0,
  handoffLift: 0.45,
  pitch: -0.06,
  speeds: Object.freeze([1, 2, 4]),
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const wrapPi = a => {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
};

export class Tour {
  constructor(deps = {}) {
    this.controls = deps.controls;
    this.rig = deps.rig;
    this.getProject = deps.getProject || (() => null);
    this.setPick = deps.setPick || (() => {});
    this.beforeStart = deps.beforeStart || (() => {});
    this.invalidate = deps.invalidate || (() => {});
    this.onchange = deps.onchange || null;
    this.state = 'idle';
    this.routeId = 'all';
    this.route = null;
    this.paused = false;
    this.speed = 1;
    this.abs = 0;
    this.time = 0;
    this.snap = null;
    this.yaw = 0;
    this.pitch = TOUR_FP.pitch;
    this.transition = null;
    this.pendingRoute = null;
    this.from = 'orbit';
    this.pos = new THREE.Vector3();
    this.routes = [];
  }

  get active() {
    return this.state !== 'idle';
  }

  get walking() {
    return this.state === 'walk';
  }

  get routeLabel() {
    return this.route ? routeLabelOf(this.route) : '全场环线';
  }

  get routeHint() {
    return this.route ? routeHintOf(this.route) : '';
  }

  listRoutes() {
    const project = this.getProject();
    return project ? listRoutes(project) : [];
  }

  canStartRoute(id) {
    const project = this.getProject();
    if (!project) return false;
    const plan = planRoute(project, id);
    return !!(plan && plan.path && plan.path.len > 2000);
  }

  routeInfo(id) {
    const project = this.getProject();
    if (!project) return null;
    const plan = planRoute(project, id);
    if (!plan) return null;
    return {
      id: plan.requestedId || id,
      label: plan.label || '',
      hint: plan.hint || '',
      len: Math.round(plan.path ? plan.path.len : 0),
      waypoints: plan.stats ? plan.stats.waypoints : 0,
      fallback: plan.stats && plan.stats.fallback ? plan.stats.fallback : null,
      requested: plan.stats && plan.stats.requested ? plan.stats.requested : null,
      available: !!(plan.path && plan.path.len > 2000),
    };
  }

  start(id = 'all', opts = {}) {
    const project = this.getProject();
    if (!project || this.state === 'enter' || this.state === 'exit') return false;
    this.beforeStart('tour');
    const plan = planRoute(project, id);
    if (!plan || !plan.path || !(plan.path.len > 2000)) return false;
    this.route = plan;
    this.routeId = plan.requestedId || id;
    this.routes = listRoutes(project);
    if (this.state === 'idle') {
      this.snap = this.controls.snapshot();
      this.from = opts.fromWalk ? 'walk' : 'orbit';
      this.controls.enabled = false;
      this.setPick(false);
      if (this.rig.mode !== 'perspective' || this.rig.transitioning) this.rig.switchNow('perspective');
      const s0 = opts.fromWalk && opts.s != null ? opts.s : 0;
      this.abs = s0;
      this.time = 0;
      const p0 = posAt(plan.path, this.abs);
      const ahead = posAt(plan.path, this.abs + TOUR_FP.lookAhead * 1000);
      this.yaw = opts.fromWalk && Number.isFinite(opts.yaw)
        ? wrapPi(opts.yaw)
        : (Math.hypot(ahead.x - p0.x, ahead.y - p0.y) > 1
          ? yaw2d(ahead.x - p0.x, ahead.y - p0.y)
          : 0);
      if (opts.fromWalk && Number.isFinite(opts.pitch)) this.pitch = clamp(opts.pitch, -1.2, 1.2);
      const cam = this.rig.camera;
      const dur = this.rig.reduced ? 0 : (opts.fromWalk ? TOUR_FP.handoffSec : TOUR_FP.enterSec);
      this.transition = {
        kind: 'enter',
        dur,
        t: 0,
        fromPos: cam.position.clone(),
        fromQuat: cam.quaternion.clone(),
        lift: opts.fromWalk ? TOUR_FP.handoffLift : undefined,
        toS: this.abs,
        toYaw: this.yaw,
        toPitch: this.pitch,
      };
      this.state = dur > 0 ? 'enter' : 'walk';
      if (!(dur > 0)) this._settleWalk();
    } else {
      // 巡检中换线：先飞回轨道再进入新路线
      this.pendingRoute = id;
      this._leaveTo(id);
    }
    this._emit('start');
    this.invalidate();
    return true;
  }

  switchRoute(id) {
    if (!this.active) return this.start(id);
    this.pendingRoute = id;
    this._leaveTo(id);
    this._emit('switch');
    return true;
  }

  _leaveTo(next) {
    if (this.state === 'exit') {
      this.pendingRoute = next;
      return;
    }
    if (this.state === 'idle') return;
    const cam = this.rig.camera;
    const orbit = this._orbitPose();
    const dur = this.rig.reduced ? 0 : TOUR_FP.exitSec;
    this.transition = {
      kind: 'exit',
      dur,
      t: 0,
      fromPos: cam.position.clone(),
      fromQuat: cam.quaternion.clone(),
      toPos: orbit.pos,
      toQuat: orbit.quat,
    };
    this.state = dur > 0 ? 'exit' : 'idle';
    if (!(dur > 0)) this._finishExit();
  }

  _orbitPose() {
    const snap = this.snap;
    const target = snap ? snap.target : new THREE.Vector3();
    const cur = snap ? snap.cur : { r: 20, t: Math.PI / 4, p: 0.85 };
    const pos = new THREE.Vector3(
      target.x + cur.r * Math.sin(cur.p) * Math.sin(cur.t),
      target.y + cur.r * Math.cos(cur.p),
      target.z + cur.r * Math.sin(cur.p) * Math.cos(cur.t),
    );
    const m = new THREE.Matrix4().lookAt(pos, target, new THREE.Vector3(0, 1, 0));
    const quat = new THREE.Quaternion().setFromRotationMatrix(m);
    return { pos, quat };
  }

  _finishExit() {
    this.state = 'idle';
    const pending = this.pendingRoute;
    this.pendingRoute = null;
    this.controls.enabled = true;
    this.setPick(true);
    if (this.snap) this.controls.restore(this.snap);
    this.snap = null;
    if (pending) this.start(pending);
    this._emit('exit');
  }

  exit() {
    if (this.state === 'idle') return false;
    this._leaveTo(null);
    this._emit('exit-request');
    return true;
  }

  togglePause() {
    if (!this.active) return false;
    this.paused = !this.paused;
    this._emit('pause');
    return true;
  }

  cycleSpeed() {
    const i = TOUR_FP.speeds.indexOf(this.speed);
    this.speed = TOUR_FP.speeds[(i + 1) % TOUR_FP.speeds.length];
    this._emit('speed');
    return this.speed;
  }

  handoffToWalk() {
    if (this.state !== 'walk') return null;
    const cam = this.rig.camera;
    const e = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
    const info = {
      x: (cam.position.x / 0.001),
      y: (-cam.position.z / 0.001),
      yaw: wrapPi(e.y),
      pitch: clamp(e.x, -1.2, 1.2),
      orbitSnap: this.snap,
      routeId: this.routeId,
      s: this.abs % (this.route ? this.route.path.len : 1),
    };
    this.state = 'idle';
    this.transition = null;
    this.controls.enabled = false;
    this.setPick(true);
    this._emit('handoff-walk');
    return info;
  }

  acceptWalkHandoff() {
    this.state = 'idle';
    this.transition = null;
    this.snap = null;
  }

  _settleWalk() {
    const pose = this._poseAt(this.abs);
    const cam = this.rig.camera;
    cam.position.copy(pose.pos);
    cam.quaternion.copy(pose.quat);
    cam.updateMatrixWorld();
  }

  _poseAt(s) {
    const plan = this.route;
    const p = posAt(plan.path, s);
    const ahead = posAt(plan.path, s + TOUR_FP.lookAhead * 1000);
    let yawT = this.yaw;
    if (Math.hypot(ahead.x - p.x, ahead.y - p.y) > 1) yawT = yaw2d(ahead.x - p.x, ahead.y - p.y);
    const pos = new THREE.Vector3(p.x * 0.001, TOUR_FP.eye + Math.sin(this.time * 2.1) * 0.004, -p.y * 0.001);
    const scan = this.rig.reduced ? 0 : Math.sin(this.time * 0.62) * 0.13 + Math.sin(this.time * 0.23 + 1.7) * 0.045;
    const nod = this.rig.reduced ? 0 : Math.sin(this.time * 0.37 + 0.6) * 0.018;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      this.pitch + nod, yawT + scan, 0, 'YXZ',
    ));
    return { pos, quat: q, yawT };
  }

  update(dt) {
    if (this.state === 'idle') return;
    if (this.transition) {
      this._stepTransition(dt);
      return;
    }
    if (this.state !== 'walk') return;
    this.time += dt;
    if (!this.paused) this.abs += TOUR_FP.walk * 1000 * this.speed * dt;
    const len = this.route.path.len || 1;
    const s = ((this.abs % len) + len) % len;
    const p = posAt(this.route.path, s);
    const ahead = posAt(this.route.path, s + TOUR_FP.lookAhead * 1000);
    let yawT = this.yaw;
    if (Math.hypot(ahead.x - p.x, ahead.y - p.y) > 1) yawT = yaw2d(ahead.x - p.x, ahead.y - p.y);
    const k = 1 - Math.exp(-TOUR_FP.turn * dt);
    this.yaw += wrapPi(yawT - this.yaw) * k;
    this.pitch += (TOUR_FP.pitch - this.pitch) * k;
    const cam = this.rig.camera;
    const scan = this.rig.reduced ? 0 : Math.sin(this.time * 0.62) * 0.13 + Math.sin(this.time * 0.23 + 1.7) * 0.045;
    const nod = this.rig.reduced ? 0 : Math.sin(this.time * 0.37 + 0.6) * 0.018;
    const bob = this.rig.reduced ? 0 : Math.sin(this.time * 2.1) * 0.004;
    cam.position.set(p.x * 0.001, TOUR_FP.eye + bob, -p.y * 0.001);
    cam.quaternion.setFromEuler(new THREE.Euler(this.pitch + nod, this.yaw + scan, 0, 'YXZ'));
    cam.updateMatrixWorld();
    this.pos.copy(cam.position);
    this.invalidate();
  }

  _stepTransition(dt) {
    const tr = this.transition;
    tr.t += Math.max(0, dt);
    const k = tr.dur > 0 ? Math.min(1, tr.t / tr.dur) : 1;
    const e = easeInOut(k);
    if (tr.kind === 'enter') {
      const pose = this._poseAt(tr.toS);
      const mid = tr.fromPos.clone().add(pose.pos).multiplyScalar(0.5);
      mid.y += tr.lift == null ? Math.max(1.2, tr.fromPos.distanceTo(pose.pos) * 0.12) : tr.lift;
      const a = (1 - e) * (1 - e);
      const b = 2 * (1 - e) * e;
      const c = e * e;
      const pos = new THREE.Vector3(
        a * tr.fromPos.x + b * mid.x + c * pose.pos.x,
        a * tr.fromPos.y + b * mid.y + c * pose.pos.y,
        a * tr.fromPos.z + b * mid.z + c * pose.pos.z,
      );
      const quat = tr.fromQuat.clone().slerp(pose.quat, e);
      const cam = this.rig.camera;
      cam.position.copy(pos);
      cam.quaternion.copy(quat);
      cam.updateMatrixWorld();
      this.pos.copy(pos);
      if (k >= 1) {
        this.transition = null;
        this.state = 'walk';
        this._emit('entered');
      }
    } else if (tr.kind === 'exit') {
      const cam = this.rig.camera;
      const pos = tr.fromPos.clone().lerp(tr.toPos, e);
      const quat = tr.fromQuat.clone().slerp(tr.toQuat, e);
      cam.position.copy(pos);
      cam.quaternion.copy(quat);
      cam.updateMatrixWorld();
      if (k >= 1) {
        this.transition = null;
        this._finishExit();
      }
    }
    this.invalidate();
  }

  info() {
    const plan = this.route;
    return {
      active: this.active,
      state: this.state,
      walking: this.walking,
      paused: this.paused,
      speed: this.speed,
      progress: plan && plan.path.len > 0 ? +(((this.abs % plan.path.len) / plan.path.len).toFixed(4)) : 0,
      s: plan ? +(((this.abs % plan.path.len) + plan.path.len) % plan.path.len).toFixed(0) : 0,
      length: plan ? Math.round(plan.path.len) : 0,
      waypoints: plan ? plan.stats.waypoints : 0,
      route: this.routeId,
      routeLabel: this.routeLabel,
      routeHint: this.routeHint,
      routeKind: plan ? plan.stats.kind || 'all' : 'all',
      routes: this.routes.length,
      pendingRoute: this.pendingRoute,
      routeFallback: plan ? plan.stats.fallback || null : null,
      eye: TOUR_FP.eye,
      yaw: +this.yaw.toFixed(4),
      pitch: +this.pitch.toFixed(4),
      from: this.from,
      pos: [+this.pos.x.toFixed(3), +this.pos.y.toFixed(3), +this.pos.z.toFixed(3)],
    };
  }

  _emit(reason) {
    if (typeof this.onchange === 'function') {
      try {
        this.onchange(this.info(), reason);
      } catch (err) {
        console.warn('[巡检] onchange 异常：', err);
      }
    }
  }
}
