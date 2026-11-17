/**
 * 平台项目库桥接（postMessage）：
 *  - 平台 → 设计器：load / new-room / request-save / saved / cancel / error
 *  - 设计器 → 平台：ready / dirty / save / error
 *
 * 仅在 iframe 嵌入（?embed=1）时启用。平台负责项目库、版本与乐观锁；设计器只负责
 * 当前画布数据，不复用本地草稿，避免两套数据源互相覆盖。
 */
import { state, ui, newProject, markDirty, sanitize, onDirty, autoName } from './state.js';
import { roomWalls } from './geo.js';
import { t } from './i18n.js';

const embedded = window.parent !== window
  && new URLSearchParams(location.search).get('embed') === '1';

function post(type, payload = {}) {
  if (!embedded) return;
  window.parent.postMessage({ source: 'dc-designer', type, ...payload }, '*');
}

function toast(text, error = false) {
  // 设计器没有独立 toast；复用状态栏提示，平台错误由父页 ElMessage 展示。
  ui.hint(text);
  if (error) console.warn('[platform]', text);
}

function loadProject(project, name) {
  if (!project || !Array.isArray(project.objects)) {
    post('error', { message: '项目数据无效（缺少 objects）' });
    return;
  }
  const copy = JSON.parse(JSON.stringify(project));
  sanitize(copy);
  if (name) copy.name = name;
  state.project = copy;
  state.selectedIds = [];
  state.dirty = false;
  markDirty({ dirty: false });
  ui.fit();
  post('dirty', { dirty: false });
}

function newRoom(msg) {
  const name = String(msg.name || '未命名机房').slice(0, 120);
  const L = Math.max(1000, Number(msg.width) || 12000);
  const W = Math.max(1000, Number(msg.depth) || 8000);
  const H = Math.max(1000, Number(msg.height) || 3000);
  const floorH = Math.max(0, Number(msg.floorHeight) || 0);
  newProject(name);
  state.project.meta = { ...(state.project.meta || {}), roomHeight: H, floorHeight: floorH };
  for (const w of roomWalls(L, W, 240)) {
    w.props.height = H;
    w.props.name = autoName(t('auto.wall'));
    state.project.objects.push(w);
  }
  state.dirty = true;
  markDirty();
  ui.fit();
  // 平台已创建房间：向导前进一步，避免用户在 step 1 再次生成重复墙体
  document.querySelector('#wizard [data-act="next"]')?.click();
  toast(t('hint.roomDone', { l: L, w: W }));
}

function requestSave() {
  const project = JSON.parse(JSON.stringify(state.project));
  if (!project.objects.some(o => o.type === 'cabinet')) {
    post('error', { message: t('hint.saveNeedCabinet') });
    return;
  }
  post('save', { project });
}

function onMessage(event) {
  if (!embedded || event.source !== window.parent) return;
  const data = event.data || {};
  if (data.type === 'load' && data.project) loadProject(data.project, data.name);
  else if (data.type === 'new-room') newRoom(data);
  else if (data.type === 'request-save') requestSave();
  else if (data.type === 'saved') {
    if (data.name) state.project.name = data.name;
    state.dirty = false;
    markDirty({ dirty: false });
    post('dirty', { dirty: false });
    toast(t('hint.saved', { name: data.name || state.project.name }));
  } else if (data.type === 'error') {
    toast(data.message ? t('hint.saveFailed', { msg: data.message }) : t('hint.saveFailed', { msg: '' }), true);
  } else if (data.type === 'cancel') {
    post('dirty', { dirty: state.dirty });
  } else if (data.type === 'monitor-targets' || data.type === 'theme') {
    // 设计器为本地 CAD 工作台：不消费监控目标；浅色主题固定，忽略主题消息。
  }
}

export { requestSave as platformRequestSave };

export function initPlatformBridge() {
  if (!embedded) return;
  document.body.classList.add('is-embedded');
  window.addEventListener('message', onMessage);
  onDirty(() => post('dirty', { dirty: state.dirty }));
  post('ready');
}
