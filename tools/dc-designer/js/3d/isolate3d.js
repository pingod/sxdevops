/**
 * 3D 对象隔离（右键菜单，纯查看）：**把选中的对象直接隐藏不显示**——
 * 其三维模型整组 visible=false：不再渲染、也不再参与悬停拾取（不会出现“看不见却能悬停”的幽灵标签），
 * 于是高墙 / 封闭通道 / 桥架 / 整排机柜不再遮挡视线，被它挡住的内容一眼可见。
 *
 * 交互：
 *   · 3D 中右键单击对象 → 菜单「隔离（隐藏不显示）」；可继续右键其他对象**追加隔离**
 *     （已经隔离的对象继续保持隐藏，互不影响）；
 *   · 右键任意位置（含空白处）→ 「取消隔离 ▸ 对象名」（只重新显示某一个）、
 *     「退出隔离 / 退出全部隔离」（全部重新显示）；或按 Esc；
 *   · 右键菜单弹出期间隐藏悬停尺寸标签（菜单与标签不同时出现）；
 *   · Esc 依次生效：收起右键菜单 → 退出全部隔离 → 返回 2D（顺序见 main.js）。
 * 实现要点：
 *   · 只改渲染（对象组 visible），绝不改写 state.project 数据，退出 3D 一律还原；
 *   · 每次隐藏/还原都回调 onSceneChange（viewer3d 传入）：脏标记渲染下要补一帧，
 *     且阴影贴图不每帧重算，必须显式让它重算一次（否则被隔离对象的影子会留在原处）；
 *   · 数据变更（撤销 / AI 建模）会重建整个场景：setIsolateRoot() 按对象 id 在新场景里逐一套用，
 *     某些隔离对象已不存在则保留其余并提示。
 */
import { ui, TYPE_NAMES } from '../state.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { pickAt, suspendPick, displayName } from './pick3d.js';

let cv = null, viewProvider = () => null, onSceneChange = null;
let root = null, menuEl = null;
let rDown = null;             // 右键按下信息：区分「右键单击 = 弹菜单」与「右键拖动 = 平移视角」
const isoNodes = new Map();   // 隔离对象 id → pick 节点（Map 保持插入顺序：最后一项 = 最近隔离）
const saved = new Map();      // pick 节点 → 原 visible 值（还原用）

/* ---------- 初始化 / 场景挂接 ---------- */

/** 初始化（ensureGL 时调用一次）：绑定右键单击与外部点击关闭。viewProvider 返回 { camera, built }；
 *  onSceneChange：隐藏/还原对象后回调（渲染循环出帧 + 重算阴影贴图） */
export function initIsolate3D(canvas, viewProvider2, onSceneChange2) {
  cv = canvas;
  viewProvider = viewProvider2 || (() => null);
  onSceneChange = onSceneChange2 || null;

  cv.addEventListener('pointerdown', e => {
    if (e.button !== 2) return;
    rDown = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
  });
  cv.addEventListener('pointermove', e => { // 右键拖动 = 平移视角，不弹菜单
    if (rDown && Math.hypot(e.clientX - rDown.x, e.clientY - rDown.y) > 6) rDown.moved = true;
  });
  window.addEventListener('pointerup', e => {
    if (e.button !== 2 || !rDown) return;
    const d = rDown; rDown = null;
    if (d.moved || performance.now() - d.t > 900) return;
    openMenu(e.clientX, e.clientY);
  });
  // 捕获阶段：点到菜单以外即收起（与 2D 右键菜单同一交互习惯）
  document.addEventListener('pointerdown', e => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  }, true);
  window.addEventListener('resize', closeMenu);
}

/** 场景（重新）构建后调用：更新根节点，并按对象 id 重新套用全部隔离（消失的对象自动剔除） */
export function setIsolateRoot(room) {
  closeMenu();
  const want = [...isoNodes.keys()];  // 先记下待套用的对象 id（dropRecords 会清空记录）
  dropRecords();                     // 旧场景节点已随旧场景销毁，直接丢弃记录
  root = room || null;
  const kept = want.filter(id => applyOne(id));   // 逐一套用：其他隔离对象继续保持隐藏
  if (kept.length < want.length) { // 有对象被删（撤销 / AI 建模等）：保留其余并提示
    ui.hint(kept.length ? t('iso.goneSome', { n: kept.length }) : t('iso.gone'));
  }
}

/** 退出 3D 时调用：重新显示全部被隔离的对象、收起菜单（下次进入 3D 从干净状态开始） */
export function resetIsolate3D() {
  closeMenu();
  restoreAll();
  root = null;
}

/** 指定对象当前是否被隔离隐藏（3D 机柜编号浮标同步隐藏用：不给「看不见却能读编号」的幽灵提示） */
export function isIsolated3D(id) { return isoNodes.has(id); }

/** 语言切换时调用：收起可能开着的右键菜单（下次打开按新语言重建，不留旧语言文案） */
export function refreshIsolateI18n() { closeMenu(); }

/* ---------- 隔离 / 还原 ---------- */

/** 追加隔离一个对象（该对象隐藏不显示）；已隔离或对象不存在时返回 false */
export function isolateObject(id) {
  if (!applyOne(id)) return false;
  const node = isoNodes.get(id);
  const name = displayName(node.userData.pick);
  const n = isoNodes.size;
  ui.hint(t(n > 1 ? 'iso.hintN' : 'iso.hint', { name, n }));
  return true;
}

/** 取消单个对象的隔离（重新显示它，其他已隔离对象不受影响） */
export function unisolateObject(id) {
  const node = isoNodes.get(id);
  if (!node) return false;
  showNode(node);
  isoNodes.delete(id);
  ui.hint(t('iso.exitedOne', { name: displayName(node.userData.pick) }));
  return true;
}

/** 退出全部隔离，重新显示所有被隔离的对象；hint=false 时不发状态栏提示（退出 3D 用） */
export function clearIsolate(hint = true) {
  closeMenu();
  if (!isoNodes.size) return;
  restoreAll();
  if (hint) ui.hint(t('iso.exited'));
}

export function isIsolated() { return isoNodes.size > 0; }

/** 收起右键菜单；返回是否确实收起了（main.js 的 Esc 分层：先菜单 → 再隔离 → 再退 3D） */
export function dismissIsolateMenu() {
  if (!menuEl) return false;
  closeMenu();
  return true;
}

/** 自检/测试用：当前隔离状态 */
export function isolateInfo() {
  const ids = [...isoNodes.keys()];
  const last = ids.length ? isoNodes.get(ids[ids.length - 1]) : null;
  let invisible = 0;
  if (root) forEachPickNode(root, n => { if (!n.visible) invisible++; });
  return {
    ids, count: ids.length,
    name: last ? displayName(last.userData.pick) : '',
    hiddenCount: saved.size,   // 被隔离隐藏的对象数（= count）
    invisible,                 // 场景内 visible=false 的对象组数（全部还原后应为 0）
    menuOpen: !!menuEl,
  };
}

/* ---------- 内部：隐藏 / 还原 ---------- */

/** 收集所有 pick 组（对象标注组；墙体组内还嵌着门窗格栅的 pick 组，需递归） */
function forEachPickNode(node, fn) {
  for (const c of node.children) {
    if (c.userData && c.userData.pick) fn(c);
    forEachPickNode(c, fn);
  }
}

function findPickNode(node, id) {
  let hit = null;
  forEachPickNode(node, n => { if (!hit && n.userData.pick.id === id) hit = n; });
  return hit;
}

/** 隐藏一个对象（追加，不影响其他已隔离对象）；成功返回 true */
function applyOne(id) {
  if (!root || isoNodes.has(id)) return false;
  const node = findPickNode(root, id);
  if (!node) return false;
  saved.set(node, node.visible);
  node.userData.isolationHidden = true;
  node.visible = false;        // 隔离 = 直接隐藏不显示（整组，含其内部子对象）
  isoNodes.set(id, node);
  notifySceneChange();
  return true;
}

function showNode(node) {
  if (!saved.has(node)) return;
  node.visible = saved.get(node);
  delete node.userData.isolationHidden;
  saved.delete(node);
  notifySceneChange();
}

/** 可见性变了：通知渲染循环出帧并重算阴影贴图（无回调时静默） */
function notifySceneChange() { if (onSceneChange) onSceneChange(); }

function restoreAll() {
  for (const node of isoNodes.values()) showNode(node);
  isoNodes.clear();
}

function dropRecords() {
  saved.clear();
  isoNodes.clear();
}

/* ---------- 内部：右键菜单 ---------- */

/** 收起右键菜单：恢复悬停拾取（标签随下一次鼠标移动重现） */
function closeMenu() {
  if (!menuEl) return;
  menuEl.remove(); menuEl = null;
  suspendPick(false);
}

/** 在视口坐标 (clientX, clientY) 弹出隔离菜单；无对象可隔离且未隔离时不弹 */
function openMenu(clientX, clientY) {
  closeMenu();
  const view = viewProvider && viewProvider();
  if (!cv || !view || !view.camera || !view.built) return;
  const hit = pickAt(view.camera, view.built, clientX, clientY); // 隐藏对象不可拾取 → 空白处即“未命中”
  const obj = hit && hit.obj ? hit.obj : null;
  const n = isoNodes.size;

  const items = [];
  if (obj && !isoNodes.has(obj.id)) items.push({ ic: 'isolate', label: t('ctx.isolate'), fn: () => isolateObject(obj.id) });
  if (n) {
    items.push({ ic: 'fit', label: t(n > 1 ? 'ctx.isoExitAll' : 'ctx.isoExit'), fn: () => clearIsolate() });
    items.push({ ic: 'x', label: t('ctx.isoUnhide'), sub: true }); // 子菜单：逐个重新显示
  }
  if (!items.length) return;
  suspendPick(true);            // 菜单与悬停尺寸标签不同时出现：弹菜单即隐藏标签并暂停拾取

  menuEl = document.createElement('div');
  menuEl.className = 'ctx-menu';
  const head = document.createElement('div');
  head.className = 'ctx-head';
  const p = obj ? (obj.props || {}) : {};
  head.textContent = obj
    ? (p.name ? `${TYPE_NAMES[obj.type] || obj.type} ${p.name}` : displayName(obj))
    : t('iso.menuHead');
  menuEl.appendChild(head);
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'ctx-item' + (it.sub ? ' ctx-hassub' : '');
    el.innerHTML = `${icon(it.ic)}<span>${esc(it.label)}</span>${it.sub ? '<b>▸</b>' : ''}`;
    if (it.fn) el.addEventListener('click', () => { closeMenu(); it.fn(); });
    if (it.sub) {
      const sub = document.createElement('div');
      sub.className = 'ctx-sub';
      for (const [id, node] of isoNodes) {
        const si = document.createElement('div');
        si.className = 'ctx-item';
        si.innerHTML = `<span>${esc(displayName(node.userData.pick))}</span>`;
        si.addEventListener('click', () => { closeMenu(); unisolateObject(id); });
        sub.appendChild(si);
      }
      el.appendChild(sub);
      el.addEventListener('click', () => { // 触屏无悬停：点击父项也展开/收起子菜单
        sub.style.display = sub.style.display === 'block' ? '' : 'block';
      });
    }
    menuEl.appendChild(el);
  }
  document.body.appendChild(menuEl);
  // 定位：fixed，跟随点击点，贴着视口边缘时翻转
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  menuEl.style.left = Math.max(4, Math.min(clientX + 2, window.innerWidth - mw - 4)) + 'px';
  menuEl.style.top = Math.max(4, Math.min(clientY + 2, window.innerHeight - mh - 4)) + 'px';
}

/* ---------- 内部：杂项 ---------- */

const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
