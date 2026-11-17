/**
 * 3D 悬停拾取：鼠标移过对象（或触屏轻点）时高亮该对象，并浮层显示其名称与 XYZ 真实毫米尺寸（纯查看，不改数据）。
 *
 * 原理：builders3d 把每个对象（含墙上门/窗/格栅洞口）的全部 Mesh 收进标注 userData.pick 的组，
 *      射线命中后沿父链找该标注回溯源对象；地板系统作为独立伪对象参与拾取/隔离，
 *      不透明面层阻挡其下方管道的拾取；架空层四周开放，侧面可直接拾取可见管道。
 * 可见性：隔离（isolate3d）隐藏的对象不参与拾取（沿父链检查 visible）——
 *      不会出现“看不见却能悬停、弹出尺寸标签”的幽灵提示；
 *      右键菜单弹出期间调 suspendPick(true) 暂停拾取并立即隐藏标签（菜单与尺寸标签不同时出现）。
 * 高亮：材质是跨对象共享的（M.*），不能直接改——悬停时把组内 Mesh（含素模风的棱线）换成 emissive 提亮的克隆，
 *      移开后还原并销毁克隆（克隆与原材质共享纹理，dispose 不动纹理，无泄漏）。
 * 性能：鼠标移动只记录位置，射线拾取在渲染循环中每帧至多一次（位置脏了才做）；
 *      拖动旋转/平移/缩放期间提示隐藏，松手后随下一次移动重现。
 *      与渲染循环的脏标记配合：pickNeedsFrame() 让循环在本模块有待办时出帧，
 *      consumePickDraw() 上报「高亮刚变化」（指针离开/按下清高亮后仍需补一帧，否则画面留旧高亮）。
 */
import * as THREE from '../../lib/three/three.webgpu.min.js';
import { getObj } from '../state.js';
import { beamEnds } from '../geo.js';
import { pipeGeometry } from '../pipe-geometry.js';
import { t } from '../i18n.js';

let cv = null, tip = null;
let mx = 0, my = 0;                    // 指针位置（canvas CSS 像素，射线用）
let cx = 0, cy = 0;                    // 指针位置（视口 CSS 像素，浮层定位用）
let dirty = false;                     // 位置自上次拾取后有变化
let needDraw = false;                  // 悬停高亮/标签刚变化 → 渲染循环需补一帧（脏标记渲染用）
let downs = 0, multi = false;          // 活动指针数 / 是否多指（捏合）
let downX = 0, downY = 0, downT = 0;   // 最近一次按下位置与时间（轻点判定）
let cur = null, curNode = null;        // 当前悬停对象 / 其场景组（高亮用）
let paused = false;                    // 暂停拾取（右键菜单弹出期间：标签让位给菜单）
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/** 初始化：创建浮层并绑定 canvas 指针事件（ensureGL 时调用一次） */
export function initPick3D(canvas) {
  cv = canvas;
  tip = document.createElement('div');
  tip.className = 'tip-box pick3d-tip';
  document.body.appendChild(tip);

  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect();
    mx = e.clientX - r.left; my = e.clientY - r.top;
    cx = e.clientX; cy = e.clientY;
    dirty = true;
    if (downs > 0) hide();       // 拖动视角期间隐藏
    else if (cur) place();       // 同一对象内移动：浮层跟随指针
  });
  cv.addEventListener('pointerdown', e => {
    downs++;
    if (downs > 1) multi = true;
    downX = e.clientX; downY = e.clientY; downT = performance.now();
    hide();
  });
  window.addEventListener('pointerup', e => {
    if (downs > 0) downs--;
    // 轻点（主要服务触屏：无悬停，点对象显示、点空白隐藏）：位移小、时间短、非多指
    if (downs === 0 && !multi &&
        Math.hypot(e.clientX - downX, e.clientY - downY) < 8 && performance.now() - downT < 500) {
      const r = cv.getBoundingClientRect();
      mx = e.clientX - r.left; my = e.clientY - r.top;
      cx = e.clientX; cy = e.clientY;
      dirty = true;
    }
    if (downs === 0) multi = false;
  });
  window.addEventListener('pointercancel', () => { downs = 0; multi = false; });
  cv.addEventListener('pointerleave', () => { if (downs === 0) hide(); });
  cv.addEventListener('wheel', hide, { passive: true });
}

/** 渲染循环每帧调用：指针位置脏了才做一次射线拾取（built = buildRoom 返回值，可为 null） */
export function pickFrame(camera, built) {
  if (!dirty || paused) return;    // 右键菜单弹出期间暂停拾取（标签与菜单不同时出现）
  dirty = false;
  if (!built || downs > 0) return;
  const r = cv.getBoundingClientRect();
  if (mx < 0 || my < 0 || mx >= r.width || my >= r.height) { setCur(null); return; }
  const hit = pickAt(camera, built, r.left + mx, r.top + my);
  setCur(hit ? hit.obj : null, hit ? hit.node : null, built.roomH);
}

/** 渲染循环用：拾取是否有待办（指针位置脏了要做射线检测，或高亮刚变化要重绘一帧） */
export function pickNeedsFrame() { return dirty || needDraw; }

/** 渲染循环用：消费「高亮变化」标记（每帧调用一次，消费后本帧必须重绘） */
export function consumePickDraw() { const v = needDraw; needDraw = false; return v; }

/** 暂停/恢复悬停拾取：暂停时立即隐藏浮层与高亮且不再拾取（右键菜单弹出期间用）；
 * 无论暂停还是恢复都丢弃待处理的位置，避免标签在菜单开合瞬间闪现（下次鼠标移动才重现） */
export function suspendPick(on) {
  paused = !!on;
  dirty = false;
  if (paused) hide();
}

/**
 * 射线拾取（视口坐标 → 对象）：返回 { obj, node }，未命中返回 null。
 * 被隔离隐藏（父链 visible=false）的对象不参与拾取，也不会弹出幽灵标签。
 */
export function pickAt(camera, built, clientX, clientY) {
  if (!built || !cv) return null;
  const r = cv.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(built.group.children, true);
  for (const h of hits) {
    let n = h.object, node = null, hidden = false;
    while (n) {
      if (n.visible === false) hidden = true;
      if (!node && n.userData.pick) node = n;
      n = n.parent;
    }
    if (hidden) continue;
    // 按最近可见交点拾取；面层/底板返回地板自身，开放侧面轮廓不参与射线检测。
    if (!node) continue;
    return { obj: node.userData.pick, node };
  }
  return null;
}

/** 当前悬停对象（3D 机柜编号浮标高亮用；未悬停返回 null） */
export function hoveredObject() { return cur; }

/** 对象显示名（悬停浮层 / 隔离条共用）：自定义名优先，通道未命名时给「冷/热通道（封闭）」之类默认名 */
export function displayName(o) {
  const p = o.props || {};
  const typeName = t('type.' + o.type);
  return p.name || (o.type === 'aisle'
    ? t((p.kind || 'cold') === 'cold' ? 'aisle.cold' : 'aisle.hot') + (p.enclosed !== false ? t('aisle.enclosed') : '')
    : typeName);
}

/** 场景重建 / 退出 3D 时调用：旧对象引用全部失效 */
export function resetPick3D() { hide(); }

/* ---------- 内部 ---------- */

const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hide() {
  const had = !!(cur || curNode);
  cur = null; curNode = null;
  clearHi();
  if (cv) cv.style.cursor = '';
  if (tip) tip.classList.remove('on');
  if (had) needDraw = true; // 高亮被撤下：脏标记渲染下不会自动再出帧，需显式补一帧
}

function setCur(o, node, roomH) {
  if (o === cur) return;
  needDraw = true; // 换了悬停对象：高亮要重画一帧
  hide(); // 先清旧高亮/浮层（hide 会把 cur 置 null）
  cur = o; curNode = node;
  if (!o) return;
  applyHi(curNode);
  cv.style.cursor = 'pointer';
  const p = o.props || {};
  const name = displayName(o);
  const d = dims(o, roomH);
  tip.innerHTML =
    `<div class="p3-name">${esc(name)}${p.name ? ` <span class="p3-type">${esc(t('type.' + o.type))}</span>` : ''}</div>` +
    (d ? `<div class="p3-dims">${esc(d)}</div>` : '');
  tip.classList.add('on');
  place();
}

/* ---------- 悬停高亮（整对象提亮：贴合真实几何，一眼认出当前对象） ---------- */
const HI = new THREE.Color(0xf39c12); // 与 2D 选中琥珀同族
const HI_INTENSITY = 0.32;
let hiSaved = null;                   // Map<Mesh, 原 material|material[]>

function applyHi(node) {
  const clones = new Map(); // 原材质 → 高亮克隆（组内去重：机柜 20 个 Mesh 只需 ~8 个克隆）
  const hiMat = m0 => {
    let c = clones.get(m0);
    if (!c) {
      c = m0.clone();
      if ('emissive' in c) { c.emissive.copy(HI); c.emissiveIntensity = HI_INTENSITY; }
      else if (c.color) c.color.lerp(HI, .35); // MeshBasicMaterial（显示屏/LED）无 emissive：直接提亮
      clones.set(m0, c);
    }
    return c;
  };
  hiSaved = new Map();
  node.traverse(m => {
    if (!m.isMesh && !m.isLine) return; // 棱线（素模风）一起提亮：素模材质浅，靠轮廓变色更醒目
    hiSaved.set(m, m.material);
    m.material = Array.isArray(m.material) ? m.material.map(x => hiMat(x)) : hiMat(m.material);
  });
}

function clearHi() {
  if (!hiSaved) return;
  const done = new Set();
  for (const [m, orig] of hiSaved) {
    for (const c of Array.isArray(m.material) ? m.material : [m.material])
      if (!done.has(c)) { done.add(c); c.dispose(); } // 销毁克隆（与原材质共享的纹理不受影响）
    m.material = orig;
  }
  hiSaved = null;
}

/** 浮层定位：指针右下方，视口边缘翻转 */
function place() {
  const off = 14;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = cx + off, y = cy + off;
  if (x + w > window.innerWidth - 4) x = cx - w - off;
  if (y + h > window.innerHeight - 4) y = cy - h - off;
  tip.style.left = Math.max(4, x) + 'px';
  tip.style.top = Math.max(4, y) + 'px';
}

/** 按对象类型格式化尺寸行（默认值与 builders3d 保持一致） */
const R = Math.round;
function dims(o, roomH) {
  const p = o.props || {};
  switch (o.type) {
    case 'pipe': {
      const g=pipeGeometry(o);
      return `${p.nominalSize} · OD ${p.outsideDiameter} mm · ${t('pipe.outer')} ${g.outerDiameter} mm · Z ${o.z1} → ${o.z2} mm · L ${g.length.toFixed(1)} mm · ${t('pipe.'+p.side)}`;
    }
    case 'wall': {
      const l = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      return t('pick3d.lth', { l: R(l), th: R(p.thickness || 240), h: R(p.height || roomH || 3000) });
    }
    case 'door':   return t('pick3d.wh', { w: R(p.width || 900), h: R(p.height || 2100) });
    case 'window': return t('pick3d.wh', { w: R(p.width || 900), h: R(p.height || 1500) });
    case 'grille': return t('pick3d.wh', { w: R(p.width || 900), h: R(p.height || 1200) });
    case 'column': return t('pick3d.wdh', { w: R(p.w || 600), d: R(p.d || 600), h: R(p.h || 3000) });
    case 'beam': {
      const e = beamEnds(o, getObj); // 端点随附着柱动态求解
      const l = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
      return t('pick3d.beamDim', { l: R(l), b: R(p.b || 300), h: R(p.h || 600), top: R(p.top || 3000) });
    }
    case 'cabinet':
    case 'pdu':    return t('pick3d.wdh', { w: R(p.w || 600), d: R(p.d || 1200), h: R(p.h || 2000) });
    case 'dbox': return t('pick3d.wdh', { w: R(p.w || 600), d: R(p.d || 200), h: R(p.h || 800) });
    case 'ups':
    case 'battery': return t('pick3d.wdh', { w: R(p.w || 800), d: R(p.d || 800), h: R(p.h || 2000) });
    case 'extinguisher': return t('pick3d.wdh', { w: R(p.w || 400), d: R(p.d || 400), h: R(p.h || 1200) });
    case 'ac':     return t('pick3d.wdh', { w: R(p.w || 1000), d: R(p.d || 800), h: R(p.h || 2000) });
    case 'vent':   return t('pick3d.wd', { w: R(p.w || 600), d: R(p.d || 600) });
    case 'floor': return t('pick3d.floorDim', { h: R(p.h ?? 400) }); // 架空地板系统（伪对象，无 2D 数据）
    case 'ceiling': return t('pick3d.ceilDim', { h: R(p.h || 0) }); // 吊顶（伪对象，无 2D 数据）
    case 'tray': {
      const l = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      return t('pick3d.trayDim', { l: R(l), w: R(p.width || 300), b: R(p.bodyH || 100), h: R(p.height || 2500) });
    }
    case 'aisle': {
      const w = R(p.w || 1000), d = R(p.d || 1200);
      return +p.h > 0
        ? t('pick3d.aisleDimH', { w, d, h: R(+p.h) })
        : t('pick3d.aisleDim', { w, d });
    }
    default: return '';
  }
}
