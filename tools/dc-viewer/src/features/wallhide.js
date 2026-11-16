/**
 * 近侧墙体自动隐藏 + 围护透视。
 *
 * 每面墙一套克隆材质（共享材质不能就地改透明）；淡出 0.18s，完全隐藏时整组跳过渲染，
 * 淡出期间关闭投影并在首尾重算阴影。围护透视开启时暂停自动近墙。
 */
import { S, sharedMaterials } from '../scene/materials.js';
import { HIDE, roomCenter, wallPlane, outsideOf } from './wallcut.js';
import { XRAY, isEnclosure, xrayMaterialState } from './xray.js';

export const WALL_FADE = Object.freeze({ sec: 0.18 });

const reducedMotion = () => typeof window !== 'undefined'
  && !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const SIDE_DIR = Object.freeze({
  front: { x: 0, y: -1 },
  back: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
});

export function createWallHider(groups, opts = {}) {
  const wallGroups = Array.isArray(groups) ? groups : [];
  const enclosureGroups = Array.isArray(opts.enclosure) ? opts.enclosure : [];
  const objs = wallGroups.map(g => g && g.userData && g.userData.obj).filter(Boolean);
  const center = roomCenter(objs);
  const reduced = reducedMotion();
  const recs = [];
  const enclosures = [];
  let suspended = false;
  let xrayOn = false;
  let viewSide = null;
  let forceHidden = null;

  const makeRec = (g, kind) => {
    const o = g.userData.obj;
    return {
      kind,
      id: o.id,
      label: (o.props && o.props.name) || o.id,
      group: g,
      plane: kind === 'wall' ? wallPlane(o, center) : null,
      hidden: false,
      k: 0,
      mats: null,
      cast: null,
      castOff: false,
    };
  };

  if (center) {
    for (const g of wallGroups) {
      if (!g || !g.userData || !g.userData.obj) continue;
      const rec = makeRec(g, 'wall');
      if (rec.plane) recs.push(rec);
    }
  }
  for (const g of enclosureGroups) {
    const o = g && g.userData && g.userData.obj;
    if (!o || !isEnclosure(o.type)) continue;
    const rec = makeRec(g, 'enclosure');
    rec.plane = null;
    enclosures.push(rec);
  }

  const shared = new Set(sharedMaterials());
  const owned = new Set();

  function prepare(rec) {
    if (rec.mats) return;
    const map = new Map();
    const mats = [];
    const cast = [];
    rec.group.traverse(m => {
      if (!m.isMesh) return;
      cast.push({ mesh: m, cast: !!m.castShadow });
      const swap = src => {
        if (!src) return src;
        let r = map.get(src);
        if (!r) {
          const isShared = shared.has(src);
          const reuse = rec.kind === 'enclosure' && !isShared && !owned.has(src);
          const mat = reuse ? src : src.clone();
          if (reuse) owned.add(src);
          else if (isShared && src.map) mat.userData.keepMap = true;
          r = {
            mat,
            transparent: !!src.transparent,
            depthWrite: src.depthWrite !== false,
            opacity: Number.isFinite(+src.opacity) ? +src.opacity : 1,
          };
          map.set(src, r);
          mats.push(r);
        }
        return r.mat;
      };
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
    });
    rec.mats = mats;
    rec.cast = cast;
  }

  function restore(rec) {
    for (const r of rec.mats) {
      if (r.mat.opacity !== r.opacity) r.mat.opacity = r.opacity;
      if (r.mat.transparent !== r.transparent) {
        r.mat.transparent = r.transparent;
        r.mat.needsUpdate = true;
      }
      if (r.mat.depthWrite !== r.depthWrite) r.mat.depthWrite = r.depthWrite;
    }
  }

  function setCast(rec, on) {
    for (const c of rec.cast) c.mesh.castShadow = on ? c.cast : false;
  }

  function applyXray(rec) {
    let changed = false;
    if (!rec.castOff) {
      rec.castOff = true;
      setCast(rec, false);
      changed = true;
    }
    for (const r of rec.mats) {
      const st = xrayMaterialState(r, true);
      if (r.mat.transparent !== st.transparent) {
        r.mat.transparent = st.transparent;
        r.mat.needsUpdate = true;
      }
      if (r.mat.depthWrite !== st.depthWrite) r.mat.depthWrite = st.depthWrite;
      if (r.mat.opacity !== st.opacity) r.mat.opacity = st.opacity;
    }
    return changed;
  }

  const isForced = rec => !!(forceHidden && rec && forceHidden(rec.group));

  function show(rec) {
    if (isForced(rec)) {
      if (rec.group.visible) {
        rec.group.visible = false;
        return true;
      }
      return false;
    }
    if (!rec.group.visible) {
      rec.group.visible = true;
      return true;
    }
    return false;
  }

  function apply(rec, k) {
    if (isForced(rec)) {
      if (rec.group.visible) rec.group.visible = false;
      return false;
    }
    if (k >= 1) {
      if (rec.group.visible) rec.group.visible = false;
      return false;
    }
    if (!rec.group.visible) rec.group.visible = true;
    if (k <= 0) {
      restore(rec);
      if (!rec.castOff) return false;
      rec.castOff = false;
      setCast(rec, true);
      return true;
    }
    const a = 1 - k;
    let changed = false;
    if (!rec.castOff) {
      rec.castOff = true;
      setCast(rec, false);
      changed = true;
    }
    for (const r of rec.mats) {
      if (!r.mat.transparent) {
        r.mat.transparent = true;
        r.mat.depthWrite = false;
        r.mat.needsUpdate = true;
      }
      r.mat.opacity = r.opacity * a;
    }
    return changed;
  }

  const camPlan = cam => ({ x: cam.x / S, y: -cam.z / S });
  const sideCam = () => {
    const d = viewSide && SIDE_DIR[viewSide];
    if (!d || !center) return null;
    return { x: center.x + d.x * 1e6, y: center.y + d.y * 1e6 };
  };

  for (const rec of recs) prepare(rec);
  for (const rec of enclosures) prepare(rec);

  function setViewSide(side) {
    const v = SIDE_DIR[side] ? side : null;
    if (v === viewSide) return false;
    viewSide = v;
    return true;
  }

  function sync(cam) {
    if (suspended) return;
    if (xrayOn) {
      for (const rec of recs) {
        rec.hidden = false;
        rec.k = 0;
        show(rec);
        applyXray(rec);
      }
      for (const rec of enclosures) applyXray(rec);
      return;
    }
    const c = sideCam() || camPlan(cam);
    for (const rec of recs) {
      rec.hidden = outsideOf(rec.plane, c) > HIDE.margin;
      rec.k = rec.hidden ? 1 : 0;
      apply(rec, rec.k);
    }
  }

  function setXray(v) {
    v = !!v;
    if (v === xrayOn) return false;
    xrayOn = v;
    let changed = false;
    if (v) {
      for (const rec of recs) {
        rec.hidden = false;
        rec.k = 0;
        if (show(rec)) changed = true;
        if (applyXray(rec)) changed = true;
      }
      for (const rec of enclosures) if (applyXray(rec)) changed = true;
    } else {
      for (const rec of recs.concat(enclosures)) {
        restore(rec);
        if (rec.castOff) {
          rec.castOff = false;
          setCast(rec, true);
          changed = true;
        }
      }
    }
    return changed;
  }

  const toggleXray = () => setXray(!xrayOn);

  function setSuspended(v) {
    v = !!v;
    if (v === suspended) return false;
    suspended = v;
    if (!v) return false;
    let changed = false;
    for (const rec of recs) {
      if (rec.hidden || rec.k !== 0 || !rec.group.visible) changed = true;
      rec.hidden = false;
      rec.k = 0;
      if (show(rec)) changed = true;
      if (xrayOn) {
        if (applyXray(rec)) changed = true;
      } else if (apply(rec, 0)) changed = true;
    }
    for (const rec of enclosures) {
      if (xrayOn) {
        if (applyXray(rec)) changed = true;
      } else {
        restore(rec);
        if (rec.castOff) {
          rec.castOff = false;
          setCast(rec, true);
          changed = true;
        }
      }
    }
    return changed;
  }

  function update(cam, dt) {
    if (suspended || xrayOn) return false;
    const c = sideCam() || camPlan(cam);
    const step = reduced ? 1 : dt / Math.max(1e-3, WALL_FADE.sec);
    let shadow = false;
    for (const rec of recs) {
      const d = outsideOf(rec.plane, c);
      rec.hidden = rec.hidden ? d > -HIDE.margin : d > HIDE.margin;
      const target = rec.hidden ? 1 : 0;
      if (rec.k === target) continue;
      rec.k = target > rec.k ? Math.min(target, rec.k + step) : Math.max(target, rec.k - step);
      if (apply(rec, rec.k)) shadow = true;
    }
    return shadow;
  }

  return {
    get count() {
      return recs.length;
    },
    get animating() {
      return !suspended && !xrayOn && recs.some(r => !isForced(r) && r.k !== (r.hidden ? 1 : 0));
    },
    get suspended() {
      return suspended;
    },
    get xray() {
      return xrayOn;
    },
    get viewSide() {
      return viewSide;
    },
    sync,
    update,
    setSuspended,
    setXray,
    setViewSide,
    toggleXray,
    setForceHidden(fn) {
      forceHidden = typeof fn === 'function' ? fn : null;
      let changed = false;
      for (const rec of recs) {
        if (isForced(rec)) {
          if (rec.group.visible) {
            rec.group.visible = false;
            changed = true;
          }
        } else if (!rec.hidden && rec.k === 0 && show(rec)) {
          changed = true;
        }
      }
      return changed;
    },
    info() {
      const all = recs.concat(enclosures);
      let materials = 0;
      const items = all.map(rec => {
        let lowered = false;
        for (const r of rec.mats) {
          materials++;
          if (r.mat.opacity < r.opacity - 1e-6) lowered = true;
        }
        return {
          id: rec.id,
          label: rec.label,
          kind: rec.kind,
          visible: !!rec.group.visible,
          materials: rec.mats.length,
          castOff: rec.castOff,
          lowered,
        };
      });
      return {
        count: recs.length,
        enclosure: enclosures.length,
        hidden: recs.filter(r => r.hidden).map(r => r.label),
        fading: recs.filter(r => r.k > 0 && r.k < 1).length,
        forcedHidden: recs.filter(r => isForced(r)).map(r => r.label),
        suspended,
        viewSide,
        materials,
        xray: {
          on: xrayOn,
          opacity: XRAY.opacity,
          groups: all.length,
          lowered: items.filter(i => i.lowered).length,
          castOff: items.filter(i => i.castOff).length,
          items,
        },
      };
    },
  };
}
