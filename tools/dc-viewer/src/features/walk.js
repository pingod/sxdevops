/**
 * 手动步行（第一视角）：WASD/方向键移动、拖拽画面看向、摇杆、碰撞滑动、起伏。
 * Shift 不加速；无跳跃/重力/点击传送。
 */
import * as THREE from 'three/webgpu';
import {
  WALK, wrapPi, canStand, nearestStand, moveWalk, clearanceRatio, speedFactor,
  joystickAxis, walkDirection, lookDelta, walkHint, speedText,
} from './walkplan.js';
import { buildWalkGrid } from './route.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

const KEY_AXIS = {
  KeyW: 'f', ArrowUp: 'f',
  KeyS: 'b', ArrowDown: 'b',
  KeyA: 'l', ArrowLeft: 'l',
  KeyD: 'r', ArrowRight: 'r',
};
const KEY_LABEL = { f: 'W', b: 'S', l: 'A', r: 'D' };

const isTyping = t => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
  || t.tagName === 'SELECT' || t.isContentEditable);

function isTouchCapable() {
  if (typeof window === 'undefined') return false;
  return (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window
    || !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}

const yaw2d = (dx, dy) => Math.atan2(-dx, dy);

export class Walk {
  constructor(deps = {}) {
    this.controls = deps.controls;
    this.rig = deps.rig;
    this.canvas = deps.canvas;
    this.getProject = deps.getProject || (() => null);
    this.getBuilt = deps.getBuilt || (() => null);
    this.setPick = deps.setPick || (() => {});
    this.beforeStart = deps.beforeStart || (() => {});
    this.invalidate = deps.invalidate || (() => {});
    this.onchange = deps.onchange || null;
    this.state = 'idle';
    this.grid = null;
    this.entry = null;
    this.x = 0;
    this.y = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.vx = 0;
    this.vy = 0;
    this.factor = 1;
    this.walked = 0;
    this.moved = 0;
    this.blocked = 0;
    this.slide = false;
    this.keys = new Set();
    this.joy = { x: 0, y: 0 };
    this.touch = isTouchCapable();
    this.bob = !this.rig.reduced;
    this.bobY = 0;
    this.snap = null;
    this.transition = null;
    this.fromTour = false;
    this.canStart = false;
    this._drag = null;
    this._initInput();
  }

  get active() {
    return this.state !== 'idle';
  }

  get walking() {
    return this.state === 'walk';
  }

  _initInput() {
    this._onKeyDown = e => {
      if (!this.walking) return;
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const axis = KEY_AXIS[e.code];
      if (!axis) return;
      e.preventDefault();
      this.keys.add(axis);
    };
    this._onKeyUp = e => {
      const axis = KEY_AXIS[e.code];
      if (axis) this.keys.delete(axis);
    };
    this._onBlur = () => this.keys.clear();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', this._onBlur);
    if (!this.canvas) return;
    this.canvas.addEventListener('pointerdown', e => {
      if (!this.walking) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this._drag) return;
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* 忽略失效指针 */
      }
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointermove', e => {
      if (!this.walking || !this._drag || e.pointerId !== this._drag.id) return;
      this.look(e.clientX - this._drag.x, e.clientY - this._drag.y);
      this._drag.x = e.clientX;
      this._drag.y = e.clientY;
      this.setTouch(true);
    });
    const end = e => {
      if (this._drag && e.pointerId === this._drag.id) this._drag = null;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('lostpointercapture', end);
  }

  setTouch(v) {
    const next = !!v;
    if (next === this.touch) return false;
    this.touch = next;
    this._emit('touch');
    return true;
  }

  setJoystick(x, y) {
    this.joy = joystickAxis((x || 0) * 100, (y || 0) * 100, 100, WALK.joyDead);
    this.setTouch(true);
    this.invalidate();
  }

  look(dx, dy) {
    const d = lookDelta(this.yaw, this.pitch, dx, dy);
    this.yaw = wrapPi(d.yaw);
    this.pitch = clamp(d.pitch, WALK.pitchMin, WALK.pitchMax);
    this.invalidate();
  }

  toggleBob() {
    this.bob = !this.bob;
    this._emit('bob');
    return this.bob;
  }

  _ensureGrid() {
    if (this.grid) return true;
    const project = this.getProject();
    if (!project) return false;
    const grid = buildWalkGrid(project, {});
    if (!grid) return false;
    this.grid = grid;
    return true;
  }

  start(opts = {}) {
    const project = this.getProject();
    if (!project || this.state === 'enter' || this.state === 'exit') return false;
    this.beforeStart('walk');
    this._ensureGrid();
    if (!this.grid) {
      this.canStart = false;
      return false;
    }
    const grid = this.grid;
    this.entry = grid.entry || null;
    const spawn = this._spawn(opts);
    if (!spawn) {
      this.canStart = false;
      return false;
    }
    this.canStart = true;
    if (!this.snap) this.snap = this.controls.snapshot();
    this.x = spawn.x;
    this.y = spawn.y;
    this.yaw = Number.isFinite(opts.yaw) ? wrapPi(opts.yaw) : this._defaultYaw(this.x, this.y);
    this.pitch = Number.isFinite(opts.pitch) ? clamp(opts.pitch, WALK.pitchMin, WALK.pitchMax) : 0;
    this.vx = 0;
    this.vy = 0;
    this.walked = 0;
    this.moved = 0;
    this.blocked = 0;
    this.factor = 1;
    this.keys.clear();
    this.joy = { x: 0, y: 0 };
    this.fromTour = !!opts.fromTour;
    this.controls.enabled = false;
    this.setPick(true);
    if (this.rig.mode !== 'perspective' || this.rig.transitioning) this.rig.switchNow('perspective');
    const cam = this.rig.camera;
    if (opts.fromTour) {
      this.state = 'walk';
      this.transition = null;
      this._applyCamera(cam, 0);
    } else {
      const dur = this.rig.reduced ? 0 : WALK.enterSec;
      const toPos = new THREE.Vector3(this.x * 0.001, WALK.eye, -this.y * 0.001);
      const toQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
      this.transition = {
        kind: 'enter', dur, t: 0,
        fromPos: cam.position.clone(), fromQuat: cam.quaternion.clone(),
        toPos, toQuat,
      };
      this.state = dur > 0 ? 'enter' : 'walk';
      if (!(dur > 0)) this._applyCamera(cam, 0);
    }
    this._emit('start');
    this.invalidate();
    return true;
  }

  _spawn(opts) {
    const grid = this.grid;
    if (!grid) return null;
    let p = null;
    if (Number.isFinite(opts.x) && Number.isFinite(opts.y)) {
      p = nearestStand(grid, opts.x, opts.y, { body: WALK.body, maxR: 20 });
    }
    if (!p && grid.entry) p = nearestStand(grid, grid.entry.x, grid.entry.y, { body: WALK.body, maxR: 20 });
    if (!p) {
      const cx = (grid.minx + grid.maxx) / 2;
      const cy = (grid.miny + grid.maxy) / 2;
      p = nearestStand(grid, cx, cy, { body: WALK.body, maxR: 40 });
    }
    return p || null;
  }

  _defaultYaw(x, y) {
    const project = this.getProject();
    if (!project) return 0;
    const walls = project.objects.filter(o => o.type === 'wall');
    if (!walls.length) return 0;
    let sx = 0;
    let sy = 0;
    for (const w of walls) {
      sx += w.x1 + w.x2;
      sy += w.y1 + w.y2;
    }
    const cx = sx / (walls.length * 2);
    const cy = sy / (walls.length * 2);
    if (Math.hypot(cx - x, cy - y) < 300) return 0;
    return yaw2d(cx - x, cy - y);
  }

  _applyCamera(cam, dt) {
    const speed = Math.hypot(this.vx, this.vy);
    const bob = this.bob && this.walking ? Math.sin((this.walked / WALK.bobStride) * Math.PI * 2) * WALK.bobAmp : 0;
    this.bobY = bob;
    cam.position.set(this.x * 0.001, WALK.eye + bob, -this.y * 0.001);
    cam.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    cam.updateMatrixWorld();
    this._speed = speed;
  }

  update(dt) {
    if (this.state === 'idle') return;
    const cam = this.rig.camera;
    if (this.transition) {
      const tr = this.transition;
      tr.t += Math.max(0, dt);
      const k = tr.dur > 0 ? Math.min(1, tr.t / tr.dur) : 1;
      const e = easeInOut(k);
      if (tr.kind === 'enter') {
        const mid = tr.fromPos.clone().add(tr.toPos).multiplyScalar(0.5);
        mid.y += Math.max(1.2, tr.fromPos.distanceTo(tr.toPos) * 0.12);
        const a = (1 - e) * (1 - e);
        const b = 2 * (1 - e) * e;
        const c = e * e;
        cam.position.set(
          a * tr.fromPos.x + b * mid.x + c * tr.toPos.x,
          a * tr.fromPos.y + b * mid.y + c * tr.toPos.y,
          a * tr.fromPos.z + b * mid.z + c * tr.toPos.z,
        );
        cam.quaternion.copy(tr.fromQuat).slerp(tr.toQuat, e);
      } else {
        cam.position.copy(tr.fromPos).lerp(tr.toPos, e);
        cam.quaternion.copy(tr.fromQuat).slerp(tr.toQuat, e);
      }
      cam.updateMatrixWorld();
      this.invalidate();
      if (k >= 1) {
        this.transition = null;
        if (tr.kind === 'exit') this._finishExit();
        else {
          this.state = 'walk';
          this._emit('entered');
        }
      }
      return;
    }
    if (this.state !== 'walk') return;
    const keys = this.keys;
    const forward = (keys.has('f') ? 1 : 0) - (keys.has('b') ? 1 : 0) + this.joy.y;
    const strafe = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0) + this.joy.x;
    const dir = walkDirection(this.yaw, forward, strafe);
    const targetFactor = this.grid ? speedFactor(this.grid, this.x, this.y) : 1;
    this.factor += (targetFactor - this.factor) * (1 - Math.exp(-4 * dt));
    const targetVx = dir.x * WALK.base * 1000 * this.factor;
    const targetVy = dir.y * WALK.base * 1000 * this.factor;
    this.vx += (targetVx - this.vx) * (1 - Math.exp(-WALK.accel * dt));
    this.vy += (targetVy - this.vy) * (1 - Math.exp(-WALK.accel * dt));
    const px = this.x;
    const py = this.y;
    const r = this.grid
      ? moveWalk(this.grid, this.x, this.y, this.vx * dt, this.vy * dt, { body: WALK.body, step: WALK.step })
      : { ok: false, x: this.x, y: this.y, moved: 0, blocked: 0, slide: false };
    this.x = r.x;
    this.y = r.y;
    // 用实际位移反推速度：顶住墙时速度归零，不会积累穿透
    this.vx = dt > 0 ? (r.x - px) / dt : 0;
    this.vy = dt > 0 ? (r.y - py) / dt : 0;
    this.moved = r.moved;
    this.blocked = r.blocked;
    this.slide = !!r.slide;
    this.walked += r.moved;
    this._narrow = targetFactor < 0.99;
    this._applyCamera(cam, dt);
    this.invalidate();
  }

  exit() {
    if (!this.active || this.state === 'exit') return false;
    const cam = this.rig.camera;
    const orbit = this._orbitPose();
    const dur = this.rig.reduced ? 0 : 1.0;
    this.transition = {
      kind: 'exit', dur, t: 0,
      fromPos: cam.position.clone(), fromQuat: cam.quaternion.clone(),
      toPos: orbit.pos, toQuat: orbit.quat,
    };
    this.state = dur > 0 ? 'exit' : 'idle';
    if (!(dur > 0)) this._finishExit();
    this._emit('exit-request');
    return true;
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
    return { pos, quat: new THREE.Quaternion().setFromRotationMatrix(m) };
  }

  _finishExit() {
    this.state = 'idle';
    this.controls.enabled = true;
    this.setPick(true);
    if (this.snap) this.controls.restore(this.snap);
    this.snap = null;
    this.keys.clear();
    this.joy = { x: 0, y: 0 };
    this._emit('exit');
    this.invalidate();
  }

  handoffToTour() {
    if (this.state !== 'walk') return null;
    const cam = this.rig.camera;
    const e = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
    const info = {
      x: this.x,
      y: this.y,
      yaw: wrapPi(this.yaw),
      pitch: clamp(this.pitch, -1.2, 1.2),
      orbitSnap: this.snap,
    };
    this.state = 'idle';
    this.transition = null;
    this.controls.enabled = false;
    this.setPick(true);
    this._emit('handoff-tour');
    return { ...info, e: e.y };
  }

  acceptTourHandoff() {
    this.state = 'idle';
    this.transition = null;
    this.snap = null;
  }

  resetModel() {
    this.grid = null;
    this.entry = null;
    this.state = 'idle';
    this.transition = null;
  }

  info() {
    const grid = this.grid;
    return {
      active: this.active,
      state: this.state,
      walking: this.walking,
      canStart: this.canStart || !!grid,
      pos: [+this.x.toFixed(1), +this.y.toFixed(1)],
      scene: [+(this.x * 0.001).toFixed(3), WALK.eye + this.bobY, +(-this.y * 0.001).toFixed(3)],
      yaw: +this.yaw.toFixed(4),
      pitch: +this.pitch.toFixed(4),
      fromTour: this.fromTour,
      eye: WALK.eye,
      base: WALK.base,
      speed: +((this._speed || 0)).toFixed(3),
      targetSpeed: +(WALK.base * this.factor).toFixed(3),
      factor: +this.factor.toFixed(3),
      narrow: !!this._narrow,
      bob: this.bob,
      bobOffset: +this.bobY.toFixed(4),
      moved: +this.moved.toFixed(2),
      blocked: this.blocked,
      slide: this.slide,
      joystick: { x: +this.joy.x.toFixed(3), y: +this.joy.y.toFixed(3) },
      keys: [...this.keys].map(k => KEY_LABEL[k] || k),
      touch: this.touch,
      standable: grid ? canStand(grid, this.x, this.y, WALK.body) : false,
      clearance: grid ? clearanceRatio(grid, this.x, this.y, 2) : 0,
      entry: this.entry
        ? {
          x: +this.entry.x.toFixed(0),
          y: +this.entry.y.toFixed(0),
          fromDoor: !!(this.entry.fromDoor || (this.grid && this.grid.fromDoor)),
        }
        : null,
      spawn: { x: +this.x.toFixed(0), y: +this.y.toFixed(0), yaw: +this.yaw.toFixed(3) },
      grid: grid ? {
        cell: grid.cell, nx: grid.nx, ny: grid.ny, free: grid.free,
        minx: grid.minx, maxx: grid.maxx, miny: grid.miny, maxy: grid.maxy,
      } : null,
    };
  }

  _emit(reason) {
    if (typeof this.onchange === 'function') {
      try {
        this.onchange(this.info(), reason);
      } catch (err) {
        console.warn('[步行] onchange 异常：', err);
      }
    }
  }
}

export { walkHint, speedText, KEY_LABEL };
