/**
 * 爆炸/拼装：整体位移分层（地板下沉、设备抬升、桥架/梁/吊顶上浮、平面外扩）。
 * 两档位共用同一动画状态机；拼装按反序。
 */
import { explodePlan, explodeProfile, normalizeExplodeProfile, DEFAULT_EXPLODE_PROFILE } from './explodeplan.js';

const reducedMotion = () => typeof window !== 'undefined'
  && !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const easeInOutCubic = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

export class Explode {
  constructor() {
    this.state = 'assembled';
    this.profile = DEFAULT_EXPLODE_PROFILE;
    this.plan = null;
    this.items = [];
    this.groups = new Map();
    this.t = 0;
    this.dur = 0;
    this.dir = 1;
    this.reduced = reducedMotion();
    this.onchange = null;
    this.maxOffset = 0;
  }

  get animating() {
    return this.state === 'exploding' || this.state === 'assembling';
  }

  get active() {
    return this.state !== 'assembled';
  }

  get canStart() {
    return !!(this.plan && this.items.length);
  }

  get dolly() {
    return explodeProfile(this.profile).dolly;
  }

  setModel(project, built) {
    this.collapseNow();
    this.project = project;
    this.plan = explodePlan(project, { profile: this.profile });
    this.groups.clear();
    this.basePos = new Map();
    for (const g of built.group.children) {
      const o = g.userData && g.userData.obj;
      if (o && o.id) {
        this.groups.set(o.id, g);
        this.basePos.set(o.id, g.position.clone());
      }
    }
    this.items = [];
    let maxOff = 0;
    for (const it of this.plan.items) {
      const group = this.groups.get(it.id);
      if (!group) continue;
      this.items.push({ it, group, base: this.basePos.get(it.id).clone() });
      maxOff = Math.max(maxOff, Math.hypot(it.dx, it.dy, it.dz));
    }
    this.maxOffset = maxOff;
    this._emit();
  }

  setProfile(name) {
    if (this.animating) return false;
    const id = normalizeExplodeProfile(name);
    if (!id || id === this.profile) return !!id;
    const wasExploded = this.state === 'exploded';
    this.profile = id;
    if (!this.project) {
      this._emit();
      return true;
    }
    if (wasExploded) this._setAll(0);
    this.plan = explodePlan(this.project, { profile: id });
    this.items = [];
    let maxOff = 0;
    for (const it of this.plan.items) {
      const group = this.groups.get(it.id);
      if (!group) continue;
      this.items.push({ it, group, base: this.basePos.get(it.id) || group.position.clone() });
      maxOff = Math.max(maxOff, Math.hypot(it.dx, it.dy, it.dz));
    }
    this.maxOffset = maxOff;
    if (wasExploded) {
      this._setAll(1);
      this.state = 'exploded';
    }
    this._emit();
    return true;
  }

  explode() {
    if (this.state !== 'assembled' || !this.canStart) return false;
    this.dir = 1;
    this.dur = this.reduced ? 0 : 1.5;
    this.t = 0;
    if (this.reduced) {
      this._setAll(1);
      this.state = 'exploded';
      this._emit();
      return true;
    }
    this.state = 'exploding';
    this._emit();
    return true;
  }

  assemble() {
    if (this.state !== 'exploded' || !this.canStart) return false;
    this.dir = -1;
    this.dur = this.reduced ? 0 : 1.9;
    this.t = 0;
    if (this.reduced) {
      this._setAll(0);
      this.state = 'assembled';
      this._emit();
      return true;
    }
    this.state = 'assembling';
    this._emit();
    return true;
  }

  toggle() {
    if (this.state === 'assembled') return this.explode();
    if (this.state === 'exploded') return this.assemble();
    return false;
  }

  collapseNow() {
    this._setAll(0);
    this.t = 0;
    this.dur = 0;
    this.dir = 1;
    const was = this.state;
    this.state = 'assembled';
    if (was !== 'assembled') this._emit();
  }

  update(dt) {
    if (!this.animating) return;
    this.t = Math.min(this.dur, this.t + Math.max(0, dt));
    const p = this.dur > 0 ? this.t / this.dur : 1;
    const span = Math.max(1e-3, 1 - 0.35);
    for (const entry of this.items) {
      const delay = entry.it.rank * 0.35;
      const local = Math.max(0, Math.min(1, (p - delay) / span));
      const e = easeInOutCubic(local);
      const k = this.dir > 0 ? e : 1 - e;
      entry.group.position.set(
        entry.base.x + entry.it.dx * k,
        entry.base.y + entry.it.dy * k,
        entry.base.z + entry.it.dz * k,
      );
    }
    if (this.t >= this.dur - 1e-6) {
      this._setAll(this.dir > 0 ? 1 : 0);
      this.state = this.dir > 0 ? 'exploded' : 'assembled';
      this._emit();
    }
  }

  _setAll(k) {
    for (const entry of this.items) {
      entry.group.position.set(
        entry.base.x + entry.it.dx * k,
        entry.base.y + entry.it.dy * k,
        entry.base.z + entry.it.dz * k,
      );
    }
  }

  info() {
    const ks = this.items.map(entry => {
      const dx = entry.group.position.x - entry.base.x;
      const dy = entry.group.position.y - entry.base.y;
      const dz = entry.group.position.z - entry.base.z;
      const len = Math.hypot(entry.it.dx, entry.it.dy, entry.it.dz);
      return { k: len > 1e-9 ? Math.hypot(dx, dy, dz) / len : 0, len: Math.hypot(dx, dy, dz) };
    });
    const progress = ks.length ? ks.reduce((s, v) => s + Math.min(1, v.k), 0) / ks.length : 0;
    return {
      state: this.state,
      profile: this.profile,
      profileLabel: explodeProfile(this.profile).label,
      dolly: this.dolly,
      animating: this.animating,
      progress: +progress.toFixed(4),
      parts: ks.length,
      movedParts: ks.filter(v => v.k > 0.999).length,
      offset: +Math.max(0, ...ks.map(v => v.len)).toFixed(3),
      maxOffset: +this.maxOffset.toFixed(3),
      canStart: this.canStart,
    };
  }

  _emit() {
    if (typeof this.onchange === 'function') {
      try {
        this.onchange(this.info());
      } catch (err) {
        console.warn('[拆解] onchange 异常：', err);
      }
    }
  }
}
