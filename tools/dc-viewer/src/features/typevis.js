/**
 * 分类显隐：按对象分类整组隐藏（地板始终可见），可与剖切/透视/隔离叠加。
 * 可见性通过 Section3D 的强制隐藏源落地（section.registerForced），
 * 近墙管理器额外注入同一判定，避免淡变逻辑把显式隐藏的墙显示回来。
 */
import {
  buildTypeCatalog, typeVisPlan, normalizeHidden, presetHidden, categoryOf,
} from '../data/typeplan.js';

export class TypeVis {
  constructor() {
    this.catalog = buildTypeCatalog([], {});
    this.hidden = [];
    this.onchange = null;
  }

  setModel(project, opts = {}) {
    const objects = (project && project.objects) || [];
    const sceneTypes = opts.sceneTypes;
    this.catalog = buildTypeCatalog(objects, sceneTypes ? { sceneTypes } : {});
    this.hidden = normalizeHidden(this.hidden.filter(id => this.catalog.available.includes(id)));
    this._emit();
  }

  get active() {
    return this.hidden.length > 0;
  }

  get canStart() {
    return this.catalog.available.length > 0;
  }

  setHidden(value) {
    const next = normalizeHidden(value);
    if (next.length === this.hidden.length && next.every((v, i) => v === this.hidden[i])) return false;
    this.hidden = next;
    this._emit();
    return true;
  }

  toggle(id) {
    const set = new Set(this.hidden);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    return this.setHidden([...set]);
  }

  setPreset(id) {
    return this.setHidden(presetHidden(id, this.catalog));
  }

  showAll() {
    return this.setHidden([]);
  }

  isTypeHidden(type) {
    const cat = categoryOf(type);
    return !!cat && this.hidden.includes(cat);
  }

  isHiddenGroup(group) {
    const o = group && group.userData && group.userData.obj;
    if (!o) return false;
    if (o.type === 'floor' || o.id === '__floor') return false;
    return this.isTypeHidden(o.type);
  }

  info() {
    return typeVisPlan(this.catalog, this.hidden);
  }

  _emit() {
    if (typeof this.onchange === 'function') {
      try {
        this.onchange(this.info());
      } catch (err) {
        console.warn('[分类显隐] onchange 异常：', err);
      }
    }
  }
}
