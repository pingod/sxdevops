/** 主入口：画布初始化、事件绑定、工具栏、项目保存/打开、导入导出 */
import {
  state, runtime, ui, newProject, markDirty, pushUndo,
  undo, redo, deleteObjects, loadDraft, flushDraft, flushLastProps, getObj, sanitize, isDraftSaved,
  undoDepth,
} from './state.js';
import { pipeGeometry } from './pipe-geometry.js';
import { pipeVisible } from './pipe-tools.js';
import { objOutline, beamEnds } from './geo.js';
import { render } from './render.js';
import * as tools from './tools.js';
import { refreshProps } from './props.js';
import * as wizard from './wizard.js';
import * as checksPanel from './checks-panel.js';
import * as livecheck from './livecheck.js';
import { hydrateIcons } from './icons.js';
import { initTooltip } from './tooltip.js';
import { initViewer3D, is3DActive, enter3D, exit3D, exportFullPNG as exportFullPNG3D, applyView3D, view3DInfo, toggleStyle, refreshStyleI18n, toggleLabels, refreshLabelsI18n } from './3d/viewer3d.js';
import { dismissIsolateMenu, isIsolated, clearIsolate, refreshIsolateI18n } from './3d/isolate3d.js';
import { exportDXF } from './dxf.js';
import { exportCSV } from './csv.js';
import { initI18n, onLocaleChange, isDefaultName, t } from './i18n.js';
import * as ctxmenu from './ctxmenu.js';
import { initExportMenu } from './exportmenu.js';
import { loadUI, patchUI, flushUI } from './uistate.js';
import { initSidebar } from './sidebar.js';

const canvas = document.getElementById('cv');
const ctx = canvas.getContext('2d');
const $ = id => document.getElementById(id);

/* ---------- UI 回调注入 ---------- */
/** 当前 2D 视图快照：缩放 + 视野中心的世界坐标（mm）。
 *  存中心而非画布偏移：窗口尺寸/属性面板宽度变化后刷新，也能回到同一处看同一片图 */
function view2DSnapshot() {
  const v = state.view;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!(W > 0 && H > 0) || !(v.scale > 0)) return null;
  return { scale: v.scale, cx: (W / 2 - v.ox) / v.scale, cy: (v.oy - H / 2) / v.scale };
}

/** 应用记忆的 2D 视图（刷新恢复）：缩放与视野中心按当前画布尺寸换算回偏移 */
function restoreView2D(sv) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  state.view.boot = false;
  state.view.scale = sv.scale;
  state.view.ox = W / 2 - sv.cx * sv.scale;
  state.view.oy = H / 2 + sv.cy * sv.scale; // 屏幕 y = oy - 世界y·scale
  ui.zoom(state.view.scale);
}

function doRender() {
  render(ctx, canvas.clientWidth, canvas.clientHeight);
  const v = view2DSnapshot();
  if (v) patchUI('view2d', v); // 缩放/平移变化后记忆（节流写盘），刷新页面原样恢复
}
Object.assign(ui, {
  render: doRender,
  props: () => { refreshProps(); wizard.updateCounts(); },
  hint: m => { $('st-hint').textContent = m; },
  cursor: c => { canvas.style.cursor = c; }, // 悬停通道带拖拽手柄等动态光标
  coords: (wx, wy) => {
    $('st-coords').textContent = t('coord.pos', {
      x: Math.round(wx), y: Math.round(wy),
    }) + (runtime.altKey ? t('coord.alt') : '');
  },
  zoom: s => { $('st-zoom').textContent = Math.round(s / 0.1 * 100) + '%'; },
  syncTool: t => {
    document.querySelectorAll('[data-tool]')
      .forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    // 鼠标图标：选择工具=箭头，创建类工具=十字；空格/中键平移=抓手
    canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
  },
  fit: () => fitView(),
  resize: () => resize(),
  save: () => saveProject(),
  exportPNG: () => $('btn-png').click(),
  exportDXF: () => $('btn-dxf').click(),
  exportCSV: () => $('btn-csv').click(),
});

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state.view.boot) { // 首次布局：原点(0,0)置于画布左下角（西南角）
    state.view.boot = false;
    state.view.ox = 100;
    state.view.oy = r.height - 100;
  }
  doRender();
}
window.addEventListener('resize', resize);

// 右栏的标签、收起与宽度管理独立在 sidebar.js，属性重绘不影响 AI 对话。

/* ---------- 画布事件 ---------- */
const pos = e => {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
canvas.addEventListener('mousedown', e => {
  if (e.button === 1) { e.preventDefault(); canvas.style.cursor = 'grabbing'; }
  const p = pos(e);
  tools.pointerDown(p.x, p.y, e);
});
window.addEventListener('mousemove', e => {
  if (is3DActive()) return; // 3D 查看模式：不驱动 2D 交互
  const p = pos(e); tools.pointerMove(p.x, p.y, e);
});
window.addEventListener('mouseup', () => {
  tools.pointerUp();
  ui.syncTool(state.tool); // 恢复当前工具对应的鼠标图标
});
canvas.addEventListener('dblclick', () => tools.dblClick());
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  const p = pos(e);
  tools.rightClick(p.x, p.y);
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const p = pos(e);
  tools.wheel(p.x, p.y, e);
}, { passive: false });
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key || '').toLowerCase() === 's') {
    e.preventDefault(); saveProject(); return;
  }
  // 2D/3D 视图切换：数字键 3 进入 3D，数字键 2 返回 2D（与按钮等价；输入框内打字不触发）
  const typingInput = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '');
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey; // 带修饰键的组合留给浏览器/系统
  const key3 = e.key === '3' || e.code === 'Digit3' || e.code === 'Numpad3'; // 带上 code：兼容 AZERTY 等数字需 Shift 的布局
  const key2 = e.key === '2' || e.code === 'Digit2' || e.code === 'Numpad2';
  const keyT = e.key === 't' || e.key === 'T' || e.code === 'KeyT'; // 3D 显示风格（实景 / 素模）
  const keyL = e.key === 'l' || e.key === 'L' || e.code === 'KeyL'; // 3D 机柜编号浮标开关
  if (is3DActive()) { // 3D 查看模式：屏蔽全部编辑快捷键；Esc 分层生效：收起右键菜单 → 退出隔离 → 返回 2D
    if (e.key === 'Escape') {
      if (dismissIsolateMenu()) return;
      if (isIsolated()) { clearIsolate(); return; }
      exit3D();
    }
    else if (plain && key2 && !typingInput) { e.preventDefault(); exit3D(); }
    else if (plain && keyT && !typingInput) { e.preventDefault(); toggleStyle(); } // 3D 内 T = 实景/素模切换
    else if (plain && keyL && !typingInput) { e.preventDefault(); toggleLabels(); } // 3D 内 L = 机柜编号浮标开关
    return;
  }
  // 绘制墙体/桥架时的长度直接输入优先（数字 2/3 属于实测尺寸，不做视图切换）
  const typingLen = (state.tool === 'wall' || state.tool === 'tray' || state.tool === 'pipe') && runtime.drawing;
  if (plain && key3 && !typingInput && !typingLen) { e.preventDefault(); enter3D(); return; }
  if (e.code === 'Space' && !typingInput) {
    canvas.style.cursor = 'grabbing'; // 空格平移中
  }
  tools.keyDown(e);
});
window.addEventListener('keyup', e => {
  if (is3DActive()) return;
  tools.keyUp(e);
  if (e.code === 'Space') ui.syncTool(state.tool);
});
window.addEventListener('beforeunload', e => {
  flushDraft(); // 关闭/刷新前把最新草稿写入 localStorage
  flushLastProps(); // 属性默认值注册表一并落盘（默认值跟随上一次设置跨会话生效）
  flushUIState(); // 界面状态（面板/视图/3D 视角）一并落盘，刷新后原样恢复
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('visibilitychange', () => { if (document.hidden) { flushDraft(); flushLastProps(); flushUIState(); } });

/** 把当前界面状态快照进工作现场记忆并立即落盘（页面隐藏/刷新/关闭前调用）：
 *  3D 中记相机视角与模式，2D 中记缩放与视野中心（两者都随刷新恢复，见 uistate.js） */
function flushUIState() {
  if (is3DActive()) {
    patchUI('mode3d', true);
    const cam = view3DInfo();
    if (cam) patchUI('cam3d', cam);
  } else {
    patchUI('mode3d', false);
    const v = view2DSnapshot();
    if (v) patchUI('view2d', v);
  }
  flushUI();
}

/* ---------- 工具栏 ---------- */
document.querySelectorAll('[data-tool]')
  .forEach(b => b.addEventListener('click', () => tools.setTool(b.dataset.tool)));
$('btn-undo').onclick = undo;
$('btn-redo').onclick = redo;
$('btn-rotate').onclick = () => tools.rotateSelected();
$('btn-del').onclick = () => {
  if (!state.selectedIds.length) return;
  const n = state.selectedIds.length;
  deleteObjects(state.selectedIds);
  ui.hint(n > 1 ? t('hint.deletedN', { n }) : t('hint.deleted'));
};
$('btn-grid').onclick = e => { state.grid = !state.grid; e.currentTarget.classList.toggle('active', state.grid); doRender(); };
$('btn-snap').onclick = e => { state.snap = !state.snap; e.currentTarget.classList.toggle('active', state.snap); };
$('btn-zoomin').onclick = () => tools.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.3);
$('btn-zoomout').onclick = () => tools.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.3);
$('btn-fit').onclick = fitView;

/** 缩放到全部内容；opts.render=false 时只计算视野不渲染（打开项目时由后续 markDirty 统一渲染，避免重复渲染大项目） */
function fitView(opts = {}) {
  const renderIt = opts.render !== false;
  const objs = state.project.objects;
  if (!objs.length) { // 空项目：原点(左下角)放在画布左下
    state.view = { scale: 0.06, ox: 100, oy: canvas.clientHeight - 100 };
    ui.zoom(state.view.scale);
    if (renderIt) doRender();
    return;
  }
  let minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
  const add = (x, y) => {
    minx = Math.min(minx, x); miny = Math.min(miny, y);
    maxx = Math.max(maxx, x); maxy = Math.max(maxy, y);
  };
  for (const o of objs) {
    if(o.type==='pipe') { const b=pipeGeometry(o).bounds;add(b.minx,b.miny);add(b.maxx,b.maxy); }
    else if (o.type === 'wall' || o.type === 'tray') { add(o.x1, o.y1); add(o.x2, o.y2); }
    else if (o.type === 'beam') { const e = beamEnds(o, getObj); add(e.x1, e.y1); add(e.x2, e.y2); } // 梁端点随附着柱求解
    else if (o.x !== undefined) {
      const r = Math.hypot(o.props.w || 600, o.props.d || 600) / 2;
      add(o.x - r, o.y - r); add(o.x + r, o.y + r);
    }
  }
  if(minx>maxx||!Number.isFinite(minx+miny+maxx+maxy)){
    state.view={scale:.06,ox:100,oy:canvas.clientHeight-100};ui.zoom(.06);if(renderIt)doRender();return;
  }
  const W = canvas.clientWidth, H = canvas.clientHeight, m = 600;
  const s = Math.min(W / (maxx - minx + 2 * m), H / (maxy - miny + 2 * m), 2);
  state.view.scale = s;
  state.view.ox = (W - (maxx - minx) * s) / 2 - minx * s;
  state.view.oy = (H - (maxy - miny) * s) / 2 + maxy * s; // Y 向上：maxy 对应屏幕上边距
  ui.zoom(s);
  if (renderIt) doRender();
}

/* ---------- 项目保存 / 打开（标准文件对话框） ---------- */
// 文件类型描述每次取当前语言（启动时取一次的话，切换语言后不跟随）
const jsonTypes = () => [{ description: t('file.typeDesc'), accept: { 'application/json': ['.json'] } }];

/* 已保存文件句柄：项目保存过一次后，再次“保存”直接覆盖原文件，不再弹对话框。
 * 句柄存入 IndexedDB（localStorage 存不了句柄），刷新页面后仍可恢复直存。 */
let savedHandle = null;
const HANDLE_KEY = 'idc2d_saved_handle_v1';

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('idc2d', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const q = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => rej(q.error);
    });
  } catch (e) { return null; }
}
async function idbPut(key, val) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const q = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
      q.onsuccess = res; q.onerror = () => rej(q.error);
    });
  } catch (e) { /* ignore */ }
}
async function idbDel(key) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const q = db.transaction('kv', 'readwrite').objectStore('kv').delete(key);
      q.onsuccess = res; q.onerror = () => rej(q.error);
    });
  } catch (e) { /* ignore */ }
}

/** 记住当前项目对应的保存文件（内存 + IndexedDB，含项目名便于刷新后校验） */
function storeHandle(h) {
  savedHandle = h;
  idbPut(HANDLE_KEY, { handle: h, name: state.project.name });
}
/** 切换项目（打开其他/新建/导入）时作废旧句柄 */
function clearSavedHandle() {
  savedHandle = null;
  idbDel(HANDLE_KEY);
}
/** 句柄是否仍可写（刷新页面后需重新确认权限） */
async function canWriteHandle(h) {
  try {
    if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    if (await h.requestPermission({ mode: 'readwrite' }) === 'granted') return true;
  } catch (e) { /* ignore */ }
  return false;
}

/** 保存默认文件名：机房-YYYYMMDD-HHMMSS */
/** 首次保存的建议文件名：机房信息中已填名称 → 取机房名称；否则用时间戳 */
function defaultFileName() {
  const n = (state.project.name || '').trim();
  if (n && !isDefaultName(n)) { // 默认名按任一语言判断：跨语言切换后旧语言的默认名同样视为未命名
    const safe = n.replace(/[\\/:*?"<>|]/g, '_'); // 去掉文件名非法字符
    if (safe) return safe;
  }
  const d = new Date();
  const p = x => String(x).padStart(2, '0');
  return `${t('file.prefix')}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 保存：已保存过（本会话或本浏览器）→ 直接覆盖原文件；首次 → 原生“另存为”对话框（不支持时降级为下载） */
let saving = false; // 保存并发锁：文件选择框未关闭时屏蔽重复保存（否则浏览器抛 File picker already active）
async function saveProject() {
  if (saving) { ui.hint(t('hint.pickerBusy')); return; }
  saving = true;
  try {
  const data = JSON.stringify(state.project, null, 2);
  if (savedHandle) { // 已有保存位置 → 直接写原文件，不再弹对话框
    try {
      if (await canWriteHandle(savedHandle)) {
        const w = await savedHandle.createWritable();
        await w.write(data);
        await w.close();
        state.dirty = false;
        markDirty({ dirty: false }); // 保持已保存状态，仅刷新界面
        refreshProps();
        idbPut(HANDLE_KEY, { handle: savedHandle, name: state.project.name }); // 项目名可能已改，同步更新
        ui.hint(t('hint.saved', { name: savedHandle.name }));
        return;
      }
    } catch (e) { /* 原文件不可写/被删 → 退回对话框重选 */ }
    clearSavedHandle();
  }
  const suggested = defaultFileName() + '.json';
  let fileName = suggested;
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: suggested, types: jsonTypes() });
      const w = await handle.createWritable();
      await w.write(data);
      await w.close();
      fileName = handle.name;
      state.project.name = fileName.replace(/\.json$/i, ''); // 与“另存为”一致：项目名跟随文件名
      storeHandle(handle);
    } else { // 降级：直接下载（浏览器默认保存行为）
      const blob = new Blob([data], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = suggested;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    state.dirty = false;
    markDirty({ dirty: false }); // 保持已保存状态，仅刷新界面
    refreshProps();
    ui.hint(t('hint.saved', { name: fileName }));
  } catch (err) {
    if (err && err.name === 'AbortError') { ui.hint(t('hint.saveCancelled')); return; } // 用户取消对话框
    ui.hint(t('hint.saveFailed', { msg: err && err.message || err }));
  }
  } finally { saving = false; }
}

/** 打开：原生文件选择对话框（Chrome/Edge）；不支持时降级为临时文件输入框 */
function openFileDialog() {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = () => { resolve(inp.files[0] || null); inp.remove(); };
    inp.click();
  });
}

/* ---------- 打开项目的加载遮罩（旋转圈 + 阶段文本 + 进度条） ---------- */
/** 显示/更新遮罩：stage 为 i18n 键，pct 为进度百分比；旋转圈走合成器线程动画，主线程阻塞时仍会转 */
function showLoading(stage, pct) {
  $('loading').hidden = false;
  $('ld-text').textContent = t(stage);
  $('ld-fill').style.width = pct + '%';
}
function hideLoading() { $('loading').hidden = true; }
/** 等两帧：确保遮罩真正上屏后再开始会阻塞主线程的重活 */
const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

$('btn-save').onclick = saveProject;
let opening = false; // 打开并发锁：与保存同理，选择框未关闭时屏蔽重复打开
$('btn-open').onclick = async () => {
  if (opening) { ui.hint(t('hint.pickerBusy')); return; }
  opening = true;
  try {
  if (state.dirty && !confirm(t('confirm.openUnsaved'))) return;
  let file = null, picked = null;
  try {
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({ types: jsonTypes(), multiple: false });
      picked = handle;
      file = await handle.getFile();
    } else {
      file = await openFileDialog();
    }
  } catch (err) {
    if (err && err.name === 'AbortError') { ui.hint(t('hint.openCancelled')); return; } // 用户取消对话框
    ui.hint(t('hint.openFailed', { msg: err && err.message || err }));
    return;
  }
  if (!file) { ui.hint(t('hint.openCancelled')); return; }
  // 大项目「解析+清洗+渲染」同步阻塞主线程可达数秒（现场低配机更甚）：先弹进度遮罩，
  // 每个阶段前等两帧让浏览器真正把遮罩绘上屏，再执行阻塞操作，避免“点了没反应”。
  showLoading('load.reading', 15);
  try {
    await nextFrame();
    const text = await file.text();
    showLoading('load.parsing', 45); await nextFrame();
    const p = JSON.parse(text);
    showLoading('load.preparing', 65); await nextFrame();
    sanitize(p);
    state.project = p;
    showLoading('load.rendering', 90); await nextFrame();
    afterLoad(file.name.replace(/\.json$/i, ''));
    if (picked) storeHandle(picked); else clearSavedHandle(); // 从文件打开的项目可直接覆盖保存回原文件
    ui.hint(t('hint.opened', { name: file.name }));
  } catch (err) { alert(t('hint.openFailed', { msg: err.message })); }
  finally { hideLoading(); }
  } finally { opening = false; }
};

function afterLoad(name) {
  runtime.drawing=null; runtime.drag=null; runtime.nudgeSig=null;
  state.selectedId = null;
  state.dirty = false;
  fitView({ render: false }); // 先算出最终视野
  markDirty({ dirty: false, deferDraft: true }); // 保持已保存状态；单次渲染；草稿延迟写盘不阻塞首开
}

$('btn-new').onclick = () => {
  if (state.dirty && !confirm(t('confirm.newUnsaved'))) return;
  newProject();
  clearSavedHandle(); // 新项目未保存过，作废旧文件句柄
  state.dirty = false;
  refreshProps();
  fitView();
  ui.hint(t('hint.newProject'));
};

/* ---------- 导出 ---------- */
$('btn-png').onclick = () => {
  if (is3DActive()) { // 3D 模式：导出整机 3D 全景图（与当前视角无关，全模型入画）
    exportFullPNG3D();
    return;
  }
  exportFullPNG2D();
};
// 导出 DXF 图纸（CAD 1:1 毫米图，分图层，含墙体开洞/门窗符号/尺寸标注）
$('btn-dxf').onclick = () => exportDXF();
// 导出 CSV 工程量清单（Excel/WPS 直接打开：项目信息 + 数量汇总 + 设备明细）
$('btn-csv').onclick = () => exportCSV();

/* ---------- 2D 平面图全景高清 PNG 导出 ----------
 * 与屏幕可见范围无关：按全部对象（墙/桥架含半宽、旋转矩形四角、门窗按挂墙洞口）的
 * 世界包围盒自动取景，全图白底入画。先按“屏幕适合窗口”的逻辑比例 sRef 布局（文字/线宽
 * 观感与屏幕一致），再把画布整体超采样 k 倍（矢量重绘，文字与线宽同步放大，不糊不虚）。
 * 输出长边基准 8192px、总像素预算 32M（超限时自动降档重试，兼容低配浏览器），
 * 左下角比例尺、右下角机房名/勘测人/日期落款随超采样同步放大。
 * 网格随图导出：固定 600×600 地板模数单级网格（见 render.js drawGrid 导出分支）。 */
function exportFullPNG2D() {
  const objs = state.project.objects;
  if (!objs.length) { ui.hint(t('hint.exportEmpty')); return; }
  // 1. 全对象世界包围盒（mm）
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, any = false;
  // 2D筛选只绘出当前可见管道：取景也跟随，避免隐藏系统把图幅撑大。
  for (const o of objs) {
    if(o.type==='pipe'&&!pipeVisible(o))continue;
    const poly = objOutline(o, getObj);
    if (!poly) continue;
    any = true;
    for (const p of poly) {
      minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
      miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
    }
  }
  if (!any) { ui.hint(t('hint.exportNoGraphic')); return; }
  const M = 800; // 四周留白（mm）
  const spanX = maxx - minx + M * 2, spanY = maxy - miny + M * 2;
  // 2. 逻辑比例：全图恰好放入 1800×1300 的“虚拟屏幕”，文字观感与屏幕一致
  const sRef = Math.min(1800 / spanX, 1300 / spanY);
  const W = Math.max(1, Math.round(spanX * sRef));
  const H = Math.max(1, Math.round(spanY * sRef));
  // 3. 输出像素比例：长边 ≤8192px 且总像素 ≤32M（高清上限与浏览器画布安全上限折中）
  const MAX_SIDE = 8192, MAX_AREA = 32e6;
  let sOut = Math.min(MAX_SIDE / Math.max(spanX, spanY), Math.sqrt(MAX_AREA / (spanX * spanY)));
  const saved = state.view;
  for (let attempt = 0; attempt < 3; attempt++) { // 画布超限（低配/旧内核）时自动降档重试
    const k = sOut / sRef; // 超采样倍率
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * k));
    c.height = Math.max(1, Math.round(H * k));
    let png = null;
    try {
      const c2 = c.getContext('2d');
      c2.setTransform(k, 0, 0, k, 0, 0);
      // 临时视图：包围盒居中映射到逻辑画布（导出完成/失败均恢复，不影响屏幕视图）
      state.view = { scale: sRef, ox: M * sRef - minx * sRef, oy: maxy * sRef + M * sRef };
      render(c2, W, H, { export: true });
      png = c.toDataURL('image/png');
    } catch (e) { /* 画布过大等异常 → 降档 */ }
    state.view = saved;
    if (png) {
      const a = document.createElement('a');
      a.download = (state.project.name || t('file.pngName')) + t('file.pngSuffix') + '.png';
      a.href = png;
      a.click();
      ui.hint(t('hint.exportedPNG', { w: c.width, h: c.height }));
      return;
    }
    sOut /= 2;
  }
  ui.hint(t('hint.exportFailed'));
}

/* ---------- 启动 ---------- */
initI18n();     // 语言环境：html lang/dir、静态文案、语言切换器（须最先执行）
// 刷新恢复：先读工作现场记忆（首帧渲染会把视图快照写回，故须在 resize 之前取；对象值取副本）
const savedUI = loadUI();
const savedView2D = savedUI.view2d ? { ...savedUI.view2d } : null;
const savedCam3D = savedUI.cam3d ? { ...savedUI.cam3d } : null;
const savedMode3D = savedUI.mode3d === true;
initSidebar(); // 统一右栏：恢复属性/AI 标签、收起状态和宽度
hydrateIcons(); // 静态工具栏/工具条图标注入 SVG
initTooltip();  // 即时提示浮层（替代慢速的原生 title）
initExportMenu(); // 导出合并入口：顶栏「导出」下拉菜单（PNG / DXF / CSV 三项，按钮 id 不变）
initViewer3D(); // 3D 查看器（右上角 2D/3D 切换）
resize();
// 恢复本地草稿：刷新页面不丢数据（草稿=未保存的修改，自动缓存于 localStorage）
let draftRestored = false;
const draft = loadDraft();
if (draft && Array.isArray(draft.objects)) {
  try {
    sanitize(draft);
    state.project = draft;
    draftRestored = true;
  } catch (e) { /* 草稿损坏则忽略，从空白开始 */ }
}
refreshProps();
tools.setTool('select');
wizard.initWizard();
checksPanel.initChecks(); // 合规自检面板（左侧，与向导互斥，允许与右侧 AI 并存）
livecheck.initLivecheck(); // 实时布局检查：编辑防抖后自动跑重叠/越界，红框标记 + btn-check 计数徽章
// 视图还原：必须在向导/自检/属性面板的开合都落定**之后**做——面板开合会改变画布宽度，
// 若在面板落定前还原，就会用“旧宽度算出的偏移”去对应“新宽度”，每刷新一次画面就漂移一点。
// 此处画布尺寸已稳定：还原用与快照一致的宽度，刷新后视野中心/缩放完全固定。
// （页面的第一次绘制在本段同步代码之后才发生，故无需在面板初始化前先 fitView 一遍）
if (savedView2D) { restoreView2D(savedView2D); doRender(); } else fitView();
if (draftRestored) {
  if (isDraftSaved()) { // 草稿=已保存内容（保存/打开成功后刷新）：按干净项目静默恢复，不再误报“未保存”
    state.dirty = false;
    markDirty({ dirty: false });
  } else {
    state.dirty = true;
    markDirty();
    ui.hint(t('hint.draftRestored'));
  }
}
// 恢复上次保存的文件句柄：若与当前项目同名，则“保存”直接覆盖原文件，不再弹对话框
idbGet(HANDLE_KEY).then(s => {
  if (s && s.handle && s.name && s.name === state.project.name) savedHandle = s.handle;
});

// 语言切换：静态文案已由 applyDom 同步；此处重建动态面板、重发状态栏提示并重绘画布
onLocaleChange(() => {
  // 项目名仍是默认“未命名”（任一语言）→ 同步为新语言，避免界面残留旧语言名字
  if (isDefaultName(state.project.name)) state.project.name = t('project.untitled');
  ctxmenu.dismissAll();          // 收起旧语言的菜单/提示条
  refreshProps();                // 属性面板（不切换右栏标签）
  wizard.refreshPanel();         // 工勘向导面板
  checksPanel.refreshChecks();   // 合规自检面板
  livecheck.refreshLivecheck();  // 实时检查徽章 tooltip
  tools.rehint();                // 状态栏：当前工具提示
  if (is3DActive()) {            // 3D 动态 title 不在 data-i18n-title 覆盖范围：按新语言重发，避免 3D 中显示 2D 文案
    $('btn-3d').title = t('hint.mode3dBack');
    $('btn-png').title = t('hint.export3dBtn');
    refreshIsolateI18n();        // 隔离条文案随语言更新（右键菜单每次打开都按当前语言重建）
    refreshStyleI18n();          // 显示风格按钮（实景/素模）文案也随语言更新
    refreshLabelsI18n();         // 机柜编号浮标按钮文案随语言更新
  }
  doRender();                    // 画布标签（原点/通道/桥架标注等）
});

/* 自动化/回归测试钩子：暴露页面真实模块实例（避免动态 import 因 HMR 查询串产生第二实例）。 */
if (new URLSearchParams(location.search).get('ai') === '1') import('./agent.js');

window.__dcd = Object.freeze({
  state, runtime, ui, newProject, markDirty, sanitize, undoDepth, flushDraft, loadDraft,
  tools, render: () => doRender(),
});

// 3D 视角恢复：刷新前就在 3D 视图里 → 重新进入 3D 并回到原视角（角度/距离/目标点）。
// 用异步 IIFE（不 top-level await）：渲染器初始化较慢，不阻塞 agent.js / license.js 等后续模块。
if (savedMode3D) {
  (async () => {
    await enter3D();
    if (is3DActive() && savedCam3D) applyView3D(savedCam3D);
    else patchUI('mode3d', false); // 环境不支持 3D（无 WebGPU/WebGL）：清掉记忆，避免每次刷新都重试
  })();
}
