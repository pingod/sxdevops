/**
 * 方案对比（3D 高亮）：按对象 id 高亮新增/删除/移动/属性变化，切换 A/B 保持同一视角。
 * 高亮用材质克隆（共享材质不能就地改色），恢复时逐个还原并释放克隆。
 */
import { compareProjects, DIFF_META, DIFF_ORDER, isVisibleKind, summarizeDiff } from './compareplan.js';

const DEFAULT_PALETTE = Object.fromEntries(DIFF_ORDER.map(k => [k, DIFF_META[k].color]));

export class Compare {
  constructor(deps = {}) {
    this.getBuilt = deps.getBuilt || (() => null);
    this.invalidate = deps.invalidate || (() => {});
    this.onSwitch = deps.onSwitch || null;
    this.onchange = deps.onchange || null;
    this.projects = { a: null, b: null };
    this.src = { a: null, b: null };
    this.side = 'a';
    this.diff = null;
    this.switching = false;
    this.palette = { ...DEFAULT_PALETTE };
    this.saved = [];
    this.nodes = new Map();
  }

  get enabled() {
    return !!(this.projects.a && this.projects.b);
  }

  get canSwitch() {
    return this.enabled && !this.switching;
  }

  setProjects(a, b, opts = {}) {
    this.projects = { a: a || null, b: b || null };
    this.src = { a: opts.src || null, b: opts.src2 || null };
    this.side = opts.side === 'b' ? 'b' : 'a';
    this.diff = this.enabled ? compareProjects(a, b) : null;
    this._emit('projects');
  }

  setModel() {
    this.nodes.clear();
    const built = this.getBuilt();
    if (!built) return;
    built.group.traverse(n => {
      const o = n.userData && n.userData.obj;
      if (!o || !o.id) return;
      if (!this.nodes.has(String(o.id))) this.nodes.set(String(o.id), n);
    });
    this.applyHighlights();
  }

  setPalette(patch) {
    const next = { ...this.palette };
    let ok = false;
    for (const [k, v] of Object.entries(patch || {})) {
      if (!DIFF_ORDER.includes(k)) continue;
      if (typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim())) {
        next[k] = v.trim();
        ok = true;
      }
    }
    if (!ok) return false;
    this.palette = next;
    this.applyHighlights();
    return true;
  }

  async switchTo(side) {
    const next = side === 'b' ? 'b' : 'a';
    if (!this.enabled || this.switching || next === this.side) return false;
    if (!this.onSwitch) return false;
    const prev = this.side;
    this._restoreMaterials();
    this.switching = true;
    this._emit('switching');
    try {
      const project = next === 'b' ? this.projects.b : this.projects.a;
      await this.onSwitch(next, project);
      this.side = next;
      this.nodes.clear();
      const built = this.getBuilt();
      if (built) {
        built.group.traverse(n => {
          const o = n.userData && n.userData.obj;
          if (!o || !o.id) return;
          if (!this.nodes.has(String(o.id))) this.nodes.set(String(o.id), n);
        });
      }
      this.applyHighlights();
      this.switching = false;
      this._emit('switch');
      return true;
    } catch (err) {
      this.side = prev;
      this.switching = false;
      this._emit('switch-error', err);
      throw err;
    }
  }

  visibleKinds(side = this.side) {
    if (!this.diff) return [];
    return DIFF_ORDER.filter(k => isVisibleKind(side, k));
  }

  applyHighlights() {
    this._restoreMaterials();
    if (!this.diff || !this.enabled) return;
    const kinds = new Set(this.visibleKinds());
    for (const item of this.diff.items) {
      if (!kinds.has(item.kind)) continue;
      const node = this.nodes.get(String(item.id));
      if (!node) continue;
      this._tint(node, item.kind);
    }
    this.invalidate();
  }

  _tint(node, kind) {
    const color = this.palette[kind] || DIFF_META[kind].color;
    const c = { r: 0, g: 0, b: 0 };
    const hex = color.replace('#', '');
    const full = hex.length === 3 ? hex.split('').map(ch => ch + ch).join('') : hex;
    const n = parseInt(full, 16);
    c.r = ((n >> 16) & 255) / 255;
    c.g = ((n >> 8) & 255) / 255;
    c.b = (n & 255) / 255;
    node.traverse(m => {
      if (!m.isMesh) return;
      if (m.userData && m.userData.lineartEdge) return;
      const src = m.material;
      const one = mat => {
        if (!mat) return mat;
        const clone = mat.clone();
        clone.userData.compareTint = true;
        clone.userData.compareKind = kind;
        if (clone.emissive && clone.emissive.isColor) {
          clone.emissive.setRGB(c.r, c.g, c.b);
          clone.emissiveIntensity = Math.max(clone.emissiveIntensity || 1, 0.62);
        } else if (clone.color && clone.color.isColor) {
          clone.color.lerp({ r: c.r, g: c.g, b: c.b }, 0.62);
        }
        return clone;
      };
      this.saved.push({ mesh: m, material: src });
      m.material = Array.isArray(src) ? src.map(one) : one(src);
    });
  }

  _restoreMaterials() {
    for (const { mesh, material } of this.saved) {
      const cur = mesh.material;
      if (Array.isArray(cur)) {
        for (const m of cur) if (m && m.userData && m.userData.compareTint) m.dispose();
      } else if (cur && cur.userData && cur.userData.compareTint) cur.dispose();
      mesh.material = material;
    }
    this.saved = [];
  }

  info() {
    const c = this.diff ? this.diff.counts : { added: 0, removed: 0, moved: 0, changed: 0, same: 0, total: 0 };
    return {
      enabled: this.enabled,
      side: this.side,
      switching: this.switching,
      canSwitch: this.canSwitch,
      counts: c,
      summary: this.diff ? summarizeDiff(this.diff) : '',
      visibleKinds: this.visibleKinds(),
      palette: { ...this.palette },
      a: { name: this.projects.a ? this.projects.a.name : null, count: this.projects.a ? (this.projects.a.objects || []).length : 0 },
      b: { name: this.projects.b ? this.projects.b.name : null, count: this.projects.b ? (this.projects.b.objects || []).length : 0 },
    };
  }

  _emit(reason) {
    if (typeof this.onchange === 'function') {
      try {
        this.onchange(this.info(), reason);
      } catch (err) {
        console.warn('[对比] onchange 异常：', err);
      }
    }
  }
}
