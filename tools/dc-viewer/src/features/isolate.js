/**
 * 隔离定位：围绕当前选中对象，其余设备「变暗 18%」或「整组隐藏」。
 * 围护（墙/门/窗/格栅/吊顶）与地板始终保留；聚焦对象本身不受影响。
 */
import { S } from '../scene/materials.js';

export const ISOLATE = Object.freeze({
  modes: Object.freeze(['off', 'dim', 'hide']),
  dimOpacity: 0.18,
  minOpacity: 0.15,
  maxOpacity: 0.2,
  ghostColor: 0x8b949e,
  ghostHex: '#8b949e',
  labels: Object.freeze({ off: '关闭', dim: '变暗其余', hide: '隐藏其余' }),
  shortLabels: Object.freeze({ off: '关闭', dim: '变暗 18%', hide: '隐藏' }),
  contextTypes: Object.freeze(['wall', 'door', 'window', 'grille', 'ceiling', 'floor']),
  contextLabels: Object.freeze({
    wall: '墙体', door: '机房门', window: '窗', grille: '格栅', ceiling: '吊顶', floor: '地板',
  }),
});

const isContextType = t => ISOLATE.contextTypes.includes(String(t || '').toLowerCase());
const norm = t => String(t || '').trim().toLowerCase();

export class Isolate {
  constructor() {
    this.mode = 'off';
    this.focus = null;
    this.focusNode = null;
    this.built = null;
    this.project = null;
    this.targets = new Map(); // id → { group, type }
    this.saved = new Map(); // mesh → { material, cast }
    this.ghosts = new Map(); // src material → ghost material
    this.hiddenIds = new Set();
    this.onchange = null;
    this.lastError = null;
  }

  get enabled() {
    return this.mode !== 'off';
  }

  get active() {
    return this.mode !== 'off' && !!this.focus;
  }

  get canStart() {
    return !!this.focus && this.targets.size > 0;
  }

  get modeLabel() {
    return ISOLATE.labels[this.mode] || ISOLATE.labels.off;
  }

  get shortLabel() {
    return ISOLATE.shortLabels[this.mode] || ISOLATE.shortLabels.off;
  }

  get focusLabel() {
    return this.focus ? String((this.focus.props && this.focus.props.name) || this.focus.id || '') : '';
  }

  get focusIsContext() {
    return !!(this.focus && isContextType(this.focus.type));
  }

  setModel(built, project) {
    this.reset({ silent: true });
    this.built = built;
    this.project = project;
    this.targets.clear();
    for (const g of built.group.children) {
      const o = g.userData && g.userData.obj;
      if (!o || !o.id) continue;
      if (o.type === 'floor' || o.id === '__floor') continue;
      if (isContextType(o.type)) continue;
      this.targets.set(o.id, { group: g, type: o.type });
    }
    this.focus = null;
    this.focusNode = null;
  }

  setFocus(obj, node) {
    this.focus = obj || null;
    this.focusNode = node || null;
    if (!this.focus && this.enabled) {
      this.setMode('off');
      return;
    }
    if (this.enabled) this._apply();
  }

  setMode(mode) {
    const m = ISOLATE.modes.includes(mode) ? mode : 'off';
    if (m !== 'off' && !this.canStart) return false;
    if (m === this.mode) return false;
    this.mode = m;
    this._apply();
    return true;
  }

  toggle(mode = 'dim') {
    return this.setMode(this.enabled ? 'off' : mode);
  }

  setEnabled(on, mode = 'dim') {
    return this.setMode(on ? mode : 'off');
  }

  reset(opts = {}) {
    this.mode = 'off';
    this._restoreMaterials();
    this.hiddenIds.clear();
    if (!opts.silent) this._emit({ visibilityChanged: true, materialChanged: true });
  }

  isHiddenId(id) {
    return this.hiddenIds.has(id);
  }

  /** 供 Section3D 强制隐藏源使用 */
  isHiddenGroup(group) {
    const o = group && group.userData && group.userData.obj;
    return !!(o && this.hiddenIds.has(o.id));
  }

  _apply() {
    const before = this.hiddenIds.size;
    this._restoreMaterials();
    this.hiddenIds.clear();
    let materialChanged = false;
    let castOff = 0;
    if (this.mode === 'hide') {
      for (const [id, rec] of this.targets) {
        if (this.focus && id === this.focus.id) continue;
        this.hiddenIds.add(id);
        rec.group.visible = false;
      }
    } else if (this.mode === 'dim') {
      for (const [id, rec] of this.targets) {
        if (this.focus && id === this.focus.id) continue;
        const n = this._ghostGroup(rec.group);
        castOff += n;
        materialChanged = true;
      }
    }
    const visibilityChanged = before !== this.hiddenIds.size || this.mode === 'hide' || before > 0;
    this.lastError = null;
    this._emit({ visibilityChanged, materialChanged, castOff });
  }

  _ghostGroup(group) {
    let count = 0;
    group.traverse(m => {
      if (!m.isMesh) return;
      if (this.saved.has(m)) return;
      const src = m.material;
      const one = mat => {
        if (!mat) return mat;
        let ghost = this.ghosts.get(mat);
        if (!ghost) {
          ghost = mat.clone();
          ghost.transparent = true;
          ghost.depthWrite = false;
          ghost.opacity = ISOLATE.dimOpacity;
          if (ghost.color && ghost.color.isColor) ghost.color.setHex(ISOLATE.ghostColor);
          if (ghost.emissive && ghost.emissive.isColor) ghost.emissive.setHex(0x000000);
          if ('emissiveIntensity' in ghost) ghost.emissiveIntensity = 0;
          ghost.userData.isolateGhost = true;
          ghost.needsUpdate = true;
          this.ghosts.set(mat, ghost);
        }
        return ghost;
      };
      this.saved.set(m, { material: src, cast: !!m.castShadow });
      m.material = Array.isArray(src) ? src.map(one) : one(src);
      m.castShadow = false;
      count++;
    });
    return count;
  }

  _restoreMaterials() {
    for (const [m, rec] of this.saved) {
      const cur = m.material;
      if (Array.isArray(cur)) {
        for (const mat of cur) {
          if (mat && mat.userData && mat.userData.isolateGhost) mat.dispose();
        }
      } else if (cur && cur.userData && cur.userData.isolateGhost) cur.dispose();
      m.material = rec.material;
      m.castShadow = rec.cast;
    }
    this.saved.clear();
    this.ghosts.clear();
  }

  get opacity() {
    return ISOLATE.dimOpacity;
  }

  info() {
    let savedMeshes = this.saved.size;
    const total = this.targets.size;
    return {
      mode: this.mode,
      active: this.active,
      canStart: this.canStart,
      enabled: this.enabled,
      focus: this.focus ? String(this.focus.id || '') : null,
      focusId: this.focus ? this.focus.id || null : null,
      focusLabel: this.focusLabel,
      focusIsContext: this.focusIsContext,
      modeLabel: this.modeLabel,
      shortLabel: this.shortLabel,
      opacity: ISOLATE.dimOpacity,
      ghostHex: ISOLATE.ghostHex,
      counts: {
        total,
        targets: total,
        context: (this.project ? this.project.objects.filter(o => isContextType(o.type) && o.type !== 'floor').length : 0),
        savedMeshes,
        hiddenGroups: this.hiddenIds.size,
      },
      hiddenIds: [...this.hiddenIds],
      contextTypes: ISOLATE.contextTypes.slice(),
      lastError: this.lastError,
      _s: S,
    };
  }

  _emit(payload = {}) {
    if (typeof this.onchange === 'function') {
      try {
        this.onchange({ ...payload, ...this.info() });
      } catch (err) {
        console.warn('[隔离] onchange 异常：', err);
      }
    }
  }
}

export function isolateSummary(active, mode, focusLabel) {
  if (!active) return '隔离关闭';
  const label = focusLabel || '已选中对象';
  return mode === 'hide' ? `隐藏其余 · ${label} 保持` : `变暗其余 18% · ${label} 保持`;
}

export function nextIsolateMode(mode) {
  return mode === 'hide' ? 'dim' : 'hide';
}

export { isContextType };
