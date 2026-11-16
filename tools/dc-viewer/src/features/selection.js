/**
 * 悬停 + 选中拾取（含轻提示与悬停浮层）。
 *
 * 悬停 = 琥珀预览；选中 = 青色保持；两者互斥（悬停已选对象只显示浮层）。
 * 高亮通过材质克隆实现（共享材质不能就地改），移开/取消时还原并销毁克隆。
 * 射线每帧至多一次（指针位置脏了才做）；拖动期间不悬停。
 */
import * as THREE from 'three/webgpu';
import { beamEnds } from '../data/sanitize.js';
import { roomHeightOf } from '../scene/geometry.js';
import { showToast } from '../ui/toast.js';

export const HOVER_STYLE = Object.freeze({ color: 0xf39c12, emissiveIntensity: 0.32, basicLerp: 0.35 });
export const SELECT_STYLE = Object.freeze({
  color: 0x00b8d4, hex: '#00b8d4', emissiveIntensity: 0.48, basicLerp: 0.52, label: '已选中',
});
export const MAX_FOCUS_LEN = 160;

export const TYPE_NAMES = Object.freeze({
  wall: '墙体',
  door: '机房门',
  window: '窗',
  grille: '格栅',
  column: '柱子',
  beam: '框架梁',
  cabinet: '机柜',
  tray: '桥架',
  ceiling: '吊顶',
  aisle: '通道',
  ac: '空调',
  ups: 'UPS',
  battery: '蓄电池',
  extinguisher: '灭火器',
  vent: '地板出风口',
  pdu: '列头柜',
});

/* ---------- 纯函数 ---------- */

export function objectName(o) {
  if (!o) return '';
  const n = o.props && o.props.name;
  return String(n == null ? '' : n).trim();
}

/** 查询归一化：trim、长度 1..160、拒绝控制字符 */
export function normalizeFocusQuery(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.length > MAX_FOCUS_LEN) return '';
  if (/[\u0000-\u001f\u007f]/.test(s)) return '';
  return s;
}

export function selectionSummary(obj) {
  if (!obj) return null;
  const name = objectName(obj) || null;
  return { id: obj.id == null ? '' : String(obj.id), type: obj.type || '', name, label: name || String(obj.id || '') };
}

/**
 * 链接用标识：名称唯一且不与任何 id 冲突时用名称，否则用 id。
 */
export function selectionToken(objects, obj) {
  if (!obj) return null;
  const name = objectName(obj);
  const list = Array.isArray(objects) ? objects : [];
  if (!name) return String(obj.id);
  const same = list.filter(o => objectName(o).toLowerCase() === name.toLowerCase());
  const idClash = list.some(o => String(o.id) === name);
  if (same.length <= 1 && !idClash) return name;
  return String(obj.id);
}

/** 按 id 精确 → 名称精确 → 名称忽略大小写 → id 忽略大小写 查找 */
export function findFocusTarget(objects, q) {
  const query = normalizeFocusQuery(q);
  if (!query || !Array.isArray(objects)) return null;
  const lower = query.toLowerCase();
  let byId = null;
  let byName = null;
  let byNameLower = null;
  let byIdLower = null;
  for (const o of objects) {
    if (!o) continue;
    const id = String(o.id == null ? '' : o.id);
    const name = objectName(o);
    if (!byId && id === query) byId = o;
    if (!byName && name && name === query) byName = o;
    if (!byNameLower && name && name.toLowerCase() === lower) byNameLower = o;
    if (!byIdLower && id.toLowerCase() === lower) byIdLower = o;
  }
  return byId || byName || byNameLower || byIdLower || null;
}

export function selectionEvent(obj, objects) {
  const s = selectionSummary(obj);
  return s ? { ...s, token: selectionToken(objects, obj) } : null;
}

/* ---------- 拾取状态 ---------- */
let cv = null;
let tip = null;
let enabled = true;
let clipTest = null;
let mx = 0;
let my = 0;
let cx = 0;
let cy = 0;
let dirty = false;
let needDraw = false;
let downs = 0;
let multi = false;
let downOnCanvas = false;
let downX = 0;
let downY = 0;
let downT = 0;
let tapPending = null;
let cur = null;
let curNode = null;
let curHi = null;
let sel = null;
let selNode = null;
let selHi = null;
let selToken = null;
let modelRoot = null;
let nodeMap = null;
let changeHook = null;
let focusHook = null;
let camRef = null;
let builtRef = null;
let lastTap = null;
let projectRef = null;
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

export function initPick(canvas) {
  cv = canvas;
  tip = document.createElement('div');
  tip.className = 'tip-box pick3d-tip';
  document.body.appendChild(tip);

  cv.addEventListener('pointermove', e => {
    if (!enabled) return;
    const r = cv.getBoundingClientRect();
    mx = e.clientX - r.left;
    my = e.clientY - r.top;
    cx = e.clientX;
    cy = e.clientY;
    dirty = true;
    if (downs > 0) hideHover();
    else if (cur) place();
  });
  cv.addEventListener('pointerdown', e => {
    if (!enabled) return;
    downs++;
    downOnCanvas = true;
    if (downs > 1) multi = true;
    downX = e.clientX;
    downY = e.clientY;
    downT = performance.now();
    hideHover();
  });
  window.addEventListener('pointerup', e => {
    if (!downOnCanvas) return;
    downOnCanvas = false;
    if (downs > 0) downs--;
    if (!enabled) {
      multi = false;
      return;
    }
    const isTap = downs === 0 && !multi
      && Math.hypot(e.clientX - downX, e.clientY - downY) < 8
      && performance.now() - downT < 500;
    if (downs === 0) multi = false;
    if (!isTap) return;
    const r = cv.getBoundingClientRect();
    mx = e.clientX - r.left;
    my = e.clientY - r.top;
    cx = e.clientX;
    cy = e.clientY;
    tapPending = { x: e.clientX, y: e.clientY };
    dirty = true;
    const now = performance.now();
    const dbl = lastTap && now - lastTap.t < 360 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    if (dbl) {
      lastTap = null;
      if (camRef && builtRef) {
        const hit = pickAt(camRef, builtRef, e.clientX, e.clientY);
        if (hit) {
          selectObject(hit.obj, { node: hit.node });
          if (focusHook) focusHook(hit.obj, hit.node);
        }
      }
      tapPending = null;
    }
  });
  window.addEventListener('pointercancel', () => {
    downs = 0;
    multi = false;
    downOnCanvas = false;
    tapPending = null;
  });
  cv.addEventListener('pointerleave', () => {
    if (downs === 0) hideHover();
  });
  cv.addEventListener('wheel', hideHover, { passive: true });
  cv.addEventListener('dblclick', e => {
    if (!enabled) return;
    if (!camRef || !builtRef) return;
    const hit = pickAt(camRef, builtRef, e.clientX, e.clientY);
    if (!hit) return;
    selectObject(hit.obj, { node: hit.node });
    if (focusHook) focusHook(hit.obj, hit.node);
  });
}

export function setProject(project) {
  projectRef = project;
}

export function setPickModel(built) {
  modelRoot = built && built.group ? built.group : null;
  nodeMap = null;
  clearSelection({ silent: true });
}

export function pickFrame(camera, built) {
  camRef = camera;
  builtRef = built;
  if (!enabled) {
    dirty = false;
    tapPending = null;
    return;
  }
  if (!dirty) return;
  dirty = false;
  if (!built || downs > 0) return;
  const r = cv.getBoundingClientRect();
  if (mx < 0 || my < 0 || mx >= r.width || my >= r.height) {
    setCur(null);
    if (tapPending) {
      tapPending = null;
      clearSelection();
    }
    return;
  }
  const hit = pickAt(camera, built, r.left + mx, r.top + my);
  if (tapPending) {
    tapPending = null;
    if (hit) selectObject(hit.obj, { node: hit.node });
    else clearSelection();
  }
  setCur(hit ? hit.obj : null, hit ? hit.node : null);
}

export function pickNeedsFrame() {
  return dirty || needDraw;
}

export function consumePickDraw() {
  const v = needDraw;
  needDraw = false;
  return v;
}

export function pickAt(camera, built, clientX, clientY) {
  if (!built || !cv) return null;
  const r = cv.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObject(built.group, true);
  for (const h of hits) {
    let n = h.object;
    let node = null;
    let hidden = false;
    while (n) {
      if (n.visible === false) {
        hidden = true;
        break;
      }
      if (n.userData.obj) {
        if (n.userData.noPick) {
          node = null;
          break;
        }
        node = n;
        break;
      }
      n = n.parent;
    }
    if (hidden || !node) continue;
    if (clipTest && !clipTest(h.point)) continue;
    return { obj: node.userData.obj, node };
  }
  return null;
}

export function hoveredObject() {
  return cur;
}

export function selectedObject() {
  return sel;
}

export function hasSelection() {
  return !!sel;
}

function nodeFor(obj) {
  if (!modelRoot || !obj) return null;
  if (!nodeMap) {
    nodeMap = new Map();
    modelRoot.traverse(n => {
      if (n.userData && n.userData.obj && !nodeMap.has(n.userData.obj)) nodeMap.set(n.userData.obj, n);
    });
  }
  return nodeMap.get(obj) || null;
}

export function objectNode(obj) {
  return nodeFor(obj);
}

export function objectBounds(obj) {
  const node = nodeFor(obj);
  if (!node) return null;
  const box = new THREE.Box3().setFromObject(node);
  if (box.isEmpty()) return null;
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };
}

export function onObjectFocus(fn) {
  focusHook = typeof fn === 'function' ? fn : null;
}

export function selectionInfo() {
  const summary = selectionSummary(sel);
  return {
    selected: summary,
    token: summary ? selToken : null,
    highlight: summary ? SELECT_STYLE.hex : null,
    materials: selHi ? selHi.size : 0,
    hover: selectionSummary(cur),
    hoverHighlight: cur && cur !== sel ? '#f39c12' : null,
  };
}

export function onSelectionChange(fn) {
  changeHook = typeof fn === 'function' ? fn : null;
}

function fireChange() {
  if (changeHook) {
    try {
      changeHook(selectionEvent(sel, projectRef ? projectRef.objects : []));
    } catch (err) {
      console.warn('[选中] 回调异常：', err);
    }
  }
}

export function selectByQuery(query) {
  const q = normalizeFocusQuery(query);
  if (!q) return false;
  const objects = projectRef ? projectRef.objects : [];
  const obj = findFocusTarget(objects, q);
  if (!obj) {
    showToast('未找到对象 · ' + q);
    return false;
  }
  return selectObject(obj, { announce: true }) ? obj : false;
}

export function selectObject(obj, opts = {}) {
  if (!obj) return clearSelection();
  const node = opts.node || nodeFor(obj);
  if (!node) return false;
  const token = selectionToken(projectRef ? projectRef.objects : [], obj);
  if (sel === obj && selNode === node && selToken === token) {
    if (opts.announce) showToast('已选中 · ' + (selectionSummary(obj).label || ''));
    return true;
  }
  hideHover();
  clearSelectionHi();
  sel = obj;
  selNode = node;
  selToken = token;
  selHi = applyHi(node, SELECT_STYLE);
  needDraw = true;
  dirty = true;
  if (!opts.silent) fireChange();
  if (opts.announce) showToast('已选中 · ' + (selectionSummary(obj).label || ''));
  return true;
}

export function clearSelection(opts = {}) {
  const had = !!sel;
  if (selNode && curNode === selNode) hideHover();
  clearSelectionHi();
  sel = null;
  selNode = null;
  selToken = null;
  if (had) {
    needDraw = true;
    dirty = true;
    if (!opts.silent) fireChange();
  }
  return had;
}

export function setPickEnabled(v) {
  enabled = !!v;
  dirty = false;
  tapPending = null;
  if (!enabled) hideHover();
}

export function setPickClipTest(fn) {
  clipTest = typeof fn === 'function' ? fn : null;
  dirty = true;
}

export function resetPick() {
  hideHover();
  clearSelection({ silent: true });
  modelRoot = null;
  nodeMap = null;
  if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
  tip = null;
}

/** 高亮基线被外部材质替换（xray/隔离/墙体淡变）后重新挂载 */
export function refreshPick() {
  const selObj = sel;
  const hoverObj = cur;
  const hoverNode = curNode;
  clearSelectionHi();
  curHi = null;
  if (selObj && selNode) selHi = applyHi(selNode, SELECT_STYLE);
  if (hoverObj && hoverNode && hoverObj !== selObj) curHi = applyHi(hoverNode, HOVER_STYLE);
  needDraw = true;
}

/** 保留逻辑选中，只丢弃克隆材质（隔离变暗前调用） */
export function releasePickMaterials() {
  clearSelectionHi();
  curHi = null;
}

function setCur(o, node) {
  if (o === cur && node === curNode) {
    if (o) place();
    return;
  }
  hideHover();
  cur = o || null;
  curNode = node || null;
  if (!cur) return;
  cv.style.cursor = 'pointer';
  buildTip(cur);
  tip.classList.add('on');
  if (sel && cur === sel) tip.classList.add('is-selected');
  place();
  if (!(sel && cur === sel)) curHi = applyHi(curNode, HOVER_STYLE);
  needDraw = true;
}

function hideHover() {
  if (!cur && !tip) {
    if (cv) cv.style.cursor = '';
    return;
  }
  if (tip) {
    tip.classList.remove('on');
    tip.classList.remove('is-selected');
  }
  if (cv) cv.style.cursor = '';
  if (curHi) {
    clearHi(curHi);
    curHi = null;
  }
  cur = null;
  curNode = null;
  needDraw = true;
}

function place() {
  if (!tip || !tip.classList.contains('on')) return;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const off = 14;
  let x = cx + off;
  let y = cy + off;
  if (x + w > window.innerWidth - 4) x = cx - w - off;
  if (y + h > window.innerHeight - 4) y = cy - h - off;
  tip.style.left = Math.max(4, x) + 'px';
  tip.style.top = Math.max(4, y) + 'px';
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function displayName(o) {
  if (!o) return '';
  const n = objectName(o);
  if (n) return n;
  if (o.type === 'aisle') {
    const kind = (o.props && o.props.kind) === 'cold' ? '冷通道' : '热通道';
    return kind + (o.props && o.props.enclosed !== false ? '（封闭）' : '');
  }
  return TYPE_NAMES[o.type] || o.type || '';
}

function dimsOf(o) {
  const p = (o && o.props) || {};
  const R = Math.round;
  const roomH = projectRef ? roomHeightOf(projectRef) : 3000;
  switch (o && o.type) {
    case 'wall': {
      const l = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      return `长 ${R(l)} × 厚 ${R(p.thickness || 240)} × 高 ${R(p.height || roomH || 3000)} mm`;
    }
    case 'door':
      return `宽 ${R(p.width || 900)} × 高 ${R(p.height || 2100)} mm`;
    case 'window':
      return `宽 ${R(p.width || 900)} × 高 ${R(p.height || 1500)} mm`;
    case 'grille':
      return `宽 ${R(p.width || 900)} × 高 ${R(p.height || 1200)} mm`;
    case 'column':
      return `宽 ${R(p.w || 600)} × 深 ${R(p.d || 600)} × 高 ${R(p.h || 3000)} mm`;
    case 'beam': {
      const objects = projectRef ? projectRef.objects : [];
      const e = beamEnds(o, id => objects.find(q => q.id === id) || null);
      const l = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
      return `跨长 ${R(l)} × 宽 ${R(p.b || 300)} × 高 ${R(p.h || 600)} · 梁顶 ${R(p.top || 3000)} mm`;
    }
    case 'cabinet':
    case 'pdu':
      return `宽 ${R(p.w || 600)} × 深 ${R(p.d || 1200)} × 高 ${R(p.h || 2000)} mm`;
    case 'ups':
    case 'battery':
      return `宽 ${R(p.w || 800)} × 深 ${R(p.d || 800)} × 高 ${R(p.h || 2000)} mm`;
    case 'extinguisher':
      return `宽 ${R(p.w || 400)} × 深 ${R(p.d || 400)} × 高 ${R(p.h || 1200)} mm`;
    case 'ac':
      return `宽 ${R(p.w || 1000)} × 深 ${R(p.d || 800)} × 高 ${R(p.h || 2000)} mm`;
    case 'vent':
      return `宽 ${R(p.w || 600)} × 深 ${R(p.d || 600)} mm`;
    case 'ceiling':
      return `吊顶面高 ${R(p.h || 0)} mm`;
    case 'tray': {
      const l = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      return `长 ${R(l)} × 宽 ${R(p.width || 300)} × 槽高 ${R(p.bodyH || 100)} · 距地 ${R(p.height || 2500)} mm`;
    }
    case 'aisle': {
      const w = R(p.w || 1000);
      const d = R(p.d || 1200);
      return +p.h > 0 ? `通道宽 ${w} × 通道长 ${d} × 高 ${R(+p.h)} mm` : `通道宽 ${w} × 通道长 ${d} mm`;
    }
    default:
      return '';
  }
}

function buildTip(o) {
  const name = displayName(o);
  const type = TYPE_NAMES[o.type] || o.type || '';
  const dims = dimsOf(o);
  const named = !!objectName(o);
  tip.innerHTML = `<div class="p3-name">${esc(name)}${named ? ` <span class="p3-type">${esc(type)}</span>` : ''}`
    + `${sel === o ? '<span class="p3-badge">已选中</span>' : ''}</div>`
    + (dims ? `<div class="p3-dims">${esc(dims)}</div>` : '');
}

/** 给对象组内所有 Mesh 克隆材质并加发光/提亮；返回快照供还原 */
function applyHi(node, style) {
  const saved = new Map();
  const color = new THREE.Color(style.color);
  node.traverse(m => {
    if (!m.isMesh) return;
    const src = m.material;
    const one = mat => {
      if (!mat) return mat;
      const c = mat.clone();
      if (c.emissive && c.emissive.isColor) {
        c.emissive.copy(color);
        c.emissiveIntensity = style.emissiveIntensity;
      } else if (c.color && c.color.isColor) {
        c.color.lerp(color, style.basicLerp);
      }
      return c;
    };
    saved.set(m, src);
    m.material = Array.isArray(src) ? src.map(one) : one(src);
  });
  return saved;
}

function clearHi(saved) {
  if (!saved) return;
  for (const [mesh, src] of saved) {
    const curMat = mesh.material;
    if (Array.isArray(curMat)) for (const m of curMat) m && m.dispose();
    else if (curMat && curMat.dispose) curMat.dispose();
    mesh.material = src;
  }
  saved.clear();
}

function clearSelectionHi() {
  if (!selHi) return;
  clearHi(selHi);
  selHi = null;
}
