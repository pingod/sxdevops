/**
 * 设计器入口：store（数据） + viewport（三维） + 表单/消息（UI）。
 *
 * 与平台的集成走 postMessage：
 *   out: ready / dirty / save {project}
 *   in:  load {project, id?, name?} / saved {id, name} / error {message}
 * 父页面持有鉴权令牌与项目库 API，设计器本身不碰网络。
 */
import './design.css';
import { createStore, POINT_TYPES, TOOL_DEFS } from './store.js';
import { createViewport } from './viewport.js';

const $ = (id) => document.getElementById(id);
const canvas = $('dz-canvas');

const store = createStore();
const embedded = window.parent !== window;
let viewport = null;

const state = {
  tool: null,
  pointer: null, // {mode:'orbit'|'pan'|'drag'|'line', ...}
  alt: false,
  loaded: false,
  fallbackTimer: null,
};

/* ---------------- 工具函数 ---------------- */

function snap(value) {
  const v = Math.round(value);
  return state.alt ? v : Math.round(v / 100) * 100;
}

function toast(message, error = false) {
  const el = $('dz-toast');
  el.textContent = message;
  el.classList.toggle('is-error', error);
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.hidden = true; }, error ? 3600 : 1800);
}

function post(type, payload = {}) {
  if (!embedded) return;
  window.parent.postMessage({ source: 'dc-designer', type, ...payload }, '*');
}

function downloadProject() {
  const project = store.toJSON();
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${project.name || 'room'}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function showBusy(text, on) {
  const el = $('dz-busy');
  $('dz-busy-text').textContent = text || '加载中…';
  el.hidden = !on;
}

/* ---------------- 顶部栏与工具 ---------------- */

function syncHeader() {
  const project = store.project();
  $('dz-project').textContent = project.name;
  document.title = `三维机房设计器 · ${project.name}`;
}

function syncDirty() {
  $('dz-dirty').hidden = !store.dirty();
  $('dz-undo').disabled = !store.canUndo();
  $('dz-redo').disabled = !store.canRedo();
}

function syncTools() {
  for (const button of document.querySelectorAll('.dz-tool')) {
    const type = button.dataset.type;
    button.classList.toggle('is-active', store.tool() === type);
  }
  const hint = $('dz-hint');
  const tool = store.tool();
  hint.textContent = tool
    ? `放置模式：${TOOL_DEFS.find(t => t.type === tool)?.label || tool}（点/拖画，Esc 退出）`
    : '左键选择与拖动，右键旋转视角';
}

function buildToolbar() {
  const container = $('dz-tools');
  container.innerHTML = '';
  for (const def of TOOL_DEFS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dz-tool';
    button.dataset.type = def.type;
    button.title = def.label;
    button.innerHTML = `<i aria-hidden="true"></i>${def.label}`;
    button.addEventListener('click', () => {
      store.setTool(def.type);
      syncTools();
    });
    container.appendChild(button);
  }
}

/* ---------------- 状态栏 ---------------- */

function syncStats() {
  const { total, counts } = store.stats();
  const parts = Object.entries(counts)
    .map(([type, count]) => `${TOOL_DEFS.find(t => t.type === type)?.label || type} ${count}`)
    .join(' · ');
  $('dz-stats').textContent = total ? `${total} 个对象 · ${parts}` : '0 个对象';
}

/* ---------------- 属性检查器 ---------------- */

const TYPE_LABELS = Object.fromEntries(TOOL_DEFS.map(t => [t.type, t.label]));

const MATERIAL_OPTIONS = ['砖墙', '混凝土', '轻钢龙骨', '玻璃隔断'];
const AC_OPTIONS = ['房间级空调', '远端风墙空调', '风墙末端'];

function fieldSpecs(obj) {
  const specs = [
    { key: 'props.name', label: '名称', type: 'text' },
  ];
  if (obj.x !== undefined) {
    specs.push({ key: 'x', label: 'X mm', type: 'number', step: 100 });
    specs.push({ key: 'y', label: 'Y mm', type: 'number', step: 100 });
    specs.push({ key: 'rotation', label: '旋转 °', type: 'number', step: 90 });
  } else {
    for (const key of ['x1', 'y1', 'x2', 'y2']) {
      specs.push({ key, label: `${key.toUpperCase()} mm`, type: 'number', step: 100 });
    }
  }
  switch (obj.type) {
    case 'cabinet':
      specs.push({ key: 'props.w', label: '宽 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.d', label: '深 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.h', label: '高 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.u', label: 'U 数', type: 'number', step: 1 });
      specs.push({ key: 'props.color', label: '柜体颜色 #rrggbb', type: 'text', placeholder: '留空用默认色' });
      break;
    case 'wall':
      specs.push({ key: 'props.thickness', label: '厚 mm', type: 'number', step: 20 });
      specs.push({ key: 'props.height', label: '高 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.material', label: '材质', type: 'select', options: MATERIAL_OPTIONS });
      break;
    case 'tray':
      specs.push({ key: 'props.width', label: '宽 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.height', label: '高 mm', type: 'number', step: 20 });
      break;
    case 'ac':
      specs.push({ key: 'props.w', label: '宽 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.d', label: '深 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.h', label: '高 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.acType', label: '类型', type: 'select', options: AC_OPTIONS });
      break;
    case 'pdu':
    case 'ups':
    case 'column':
      specs.push({ key: 'props.w', label: '宽 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.d', label: '深 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.h', label: '高 mm', type: 'number', step: 100 });
      break;
    default:
      break;
  }
  return specs;
}

function buildInspector(obj) {
  const form = $('dz-inspector-form');
  $('dz-inspector-empty').hidden = !!obj;
  form.hidden = !obj;
  form.innerHTML = '';
  if (!obj) return;

  const badge = document.createElement('span');
  badge.className = 'dz-type-badge';
  badge.textContent = TYPE_LABELS[obj.type] || obj.type;
  form.appendChild(badge);

  for (const spec of fieldSpecs(obj)) {
    const wrapper = document.createElement('label');
    wrapper.className = 'dz-field';
    const title = document.createElement('span');
    title.textContent = spec.label;
    wrapper.appendChild(title);
    let input;
    if (spec.type === 'select') {
      input = document.createElement('select');
      for (const option of spec.options) {
        const el = document.createElement('option');
        el.value = option;
        el.textContent = option;
        input.appendChild(el);
      }
    } else {
      input = document.createElement('input');
      input.type = spec.type;
      input.step = spec.step || 'any';
      input.placeholder = spec.placeholder || '';
    }
    input.dataset.key = spec.key;
    const current = spec.key.startsWith('props.')
      ? obj.props?.[spec.key.slice(6)]
      : obj[spec.key];
    input.value = current === undefined || current === null ? '' : String(current);
    wrapper.appendChild(input);
    form.appendChild(wrapper);
  }

  const actions = document.createElement('div');
  actions.className = 'dz-inspector-actions';
  for (const [label, fn] of [['旋转 90°', () => store.rotate(obj.id, 90)], ['复制', () => store.duplicate(obj.id)], ['删除', () => store.remove(obj.id)]]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', fn);
    actions.appendChild(button);
  }
  form.appendChild(actions);
}

$('dz-inspector-form').addEventListener('change', (event) => {
  const input = event.target;
  const obj = store.selected();
  if (!obj || !input.dataset.key) return;
  const key = input.dataset.key;
  const raw = input.value;
  const patch = {};
  const props = {};
  if (input.type === 'number') {
    const num = Number(raw);
    if (Number.isFinite(num) && raw !== '') {
      if (key.startsWith('props.')) props[key.slice(6)] = Math.round(num);
      else patch[key] = Math.round(num);
    }
  } else {
    if (key.startsWith('props.')) props[key.slice(6)] = raw;
    else patch[key] = raw;
  }
  store.updateObject(obj.id, patch, { props });
});

function syncRoomForm() {
  const project = store.project();
  $('dz-name').value = project.name;
  $('dz-room-height').value = project.meta.roomHeight;
  $('dz-floor-height').value = project.meta.floorHeight;
}

$('dz-name').addEventListener('change', (e) => store.setProjectName(e.target.value));
$('dz-room-height').addEventListener('change', (e) => {
  const value = Number(e.target.value);
  if (Number.isFinite(value) && value >= 2000) store.setMeta({ roomHeight: Math.round(value) });
});
$('dz-floor-height').addEventListener('change', (e) => {
  const value = Number(e.target.value);
  if (Number.isFinite(value) && value >= 0) store.setMeta({ floorHeight: Math.round(value) });
});

/* ---------------- 弹窗 ---------------- */

function openDialog(title, fields, onSubmit) {
  $('dz-dialog-title').textContent = title;
  const body = $('dz-dialog-body');
  body.innerHTML = '';
  const values = {};
  for (const field of fields) {
    const wrapper = document.createElement('label');
    wrapper.className = 'dz-field';
    const label = document.createElement('span');
    label.textContent = field.label;
    wrapper.appendChild(label);
    let input;
    if (field.options) {
      input = document.createElement('select');
      for (const option of field.options) {
        const el = document.createElement('option');
        el.value = option.value ?? option;
        el.textContent = option.label ?? option;
        input.appendChild(el);
      }
    } else {
      input = document.createElement('input');
      input.type = field.type || 'number';
      input.min = field.min ?? '';
      input.max = field.max ?? '';
      input.step = field.step ?? 'any';
    }
    input.value = String(field.value ?? '');
    input.dataset.key = field.key;
    wrapper.appendChild(input);
    body.appendChild(wrapper);
    values[field.key] = input;
  }
  $('dz-dialog').hidden = false;
  const close = (result) => {
    $('dz-dialog').hidden = true;
    if (result) {
      const data = {};
      for (const field of fields) {
        const raw = values[field.key].value;
        data[field.key] = (field.type && field.type !== 'number') || field.options ? raw : Number(raw);
      }
      onSubmit(data);
    }
  };
  $('dz-dialog-ok').onclick = () => close(true);
  $('dz-dialog-cancel').onclick = () => close(false);
  const first = body.querySelector('input, select');
  if (first) first.focus();
}

$('dz-new').addEventListener('click', () => openDialog('新建机房', [
  { key: 'width', label: '房间宽 mm', value: 12000, min: 2000, step: 1000 },
  { key: 'depth', label: '房间深 mm', value: 8000, min: 2000, step: 1000 },
  { key: 'height', label: '层高 mm', value: 3000, min: 2000, step: 100 },
  { key: 'floorHeight', label: '架空地板 mm', value: 400, min: 0, step: 50 },
], ({ width, depth, height, floorHeight }) => {
  const name = store.project().name === '未命名机房' ? '' : store.project().name;
  openDialog('机房名称', [
    { key: 'name', label: '名称', type: 'text', value: name },
  ], ({ name: finalName }) => {
    store.newProject({
      name: finalName || '未命名机房',
      width, depth, height, floorHeight,
    });
  });
}));

$('dz-row').addEventListener('click', () => openDialog('机柜排', [
  { key: 'x', label: '起始 X mm', value: 1000, step: 100 },
  { key: 'y', label: '起始 Y mm', value: 1000, step: 100 },
  { key: 'count', label: '机柜数量', value: 10, min: 1, max: 200, step: 1 },
  { key: 'gap', label: '柜间距 mm', value: 0, min: 0, step: 50 },
  { key: 'direction', label: '排列方向', value: 'x', options: [{ value: 'x', label: '沿 X（横向）' }, { value: 'y', label: '沿 Y（纵向）' }] },
  { key: 'prefix', label: '柜号前缀', type: 'text', value: 'A' },
  { key: 'w', label: '柜宽 mm', value: 600, step: 100 },
  { key: 'd', label: '柜深 mm', value: 1200, step: 100 },
  { key: 'h', label: '柜高 mm', value: 2000, step: 100 },
  { key: 'u', label: 'U 数', value: 42, step: 1 },
], (values) => {
  const added = store.addCabinetRow({
    ...values,
    prefix: String(values.prefix || 'A').slice(0, 12),
  });
  if (added > 0) toast(`已放置 ${added} 台机柜`);
}));

$('dz-fit').addEventListener('click', () => viewport.fitView());
$('dz-walls').addEventListener('click', () => {
  const next = !viewport.enclosureTranslucent;
  viewport.setEnclosure(next);
  $('dz-walls').textContent = next ? '围护：半透明' : '围护：实心';
});
$('dz-export').addEventListener('click', downloadProject);

$('dz-open').addEventListener('click', () => $('dz-file').click());
$('dz-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      store.load(JSON.parse(String(reader.result)));
      toast(`已打开 ${file.name}`);
    } catch (error) {
      toast(`项目文件无效：${error.message}`, true);
    }
  };
  reader.readAsText(file);
});

function requestSave() {
  const project = store.toJSON();
  if (!project.objects.some(o => o.type === 'cabinet')) {
    toast('至少需要一台机柜才能保存（平台校验）', true);
    return;
  }
  if (embedded) {
    post('save', { project });
    showBusy('保存中…', true);
  } else {
    downloadProject();
  }
}

$('dz-save').addEventListener('click', requestSave);

$('dz-undo').addEventListener('click', () => store.undo());
$('dz-redo').addEventListener('click', () => store.redo());

/* ---------------- 画布交互 ---------------- */

function currentGround(clientX, clientY) {
  return viewport.groundPoint(clientX, clientY);
}

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 2) {
    state.pointer = { mode: 'orbit', x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.button === 1 || (event.button === 0 && event.shiftKey)) {
    state.pointer = { mode: 'pan', x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;

  const ground = currentGround(event.clientX, event.clientY);
  const tool = store.tool();

  if (tool && POINT_TYPES.includes(tool)) {
    if (ground) store.addPoint(tool, snap(ground.x), snap(ground.y));
    return;
  }
  if (tool === 'wall' || tool === 'tray') {
    if (ground) {
      const start = { x: snap(ground.x), y: snap(ground.y) };
      state.pointer = { mode: 'line', tool, start, x: event.clientX, y: event.clientY };
      viewport.showLineGhost(start.x, start.y, start.x, start.y);
      canvas.setPointerCapture(event.pointerId);
    }
    return;
  }

  const obj = viewport.pick(event.clientX, event.clientY);
  if (obj) {
    store.select(obj.id);
    if (ground) state.pointer = { mode: 'drag', obj, start: ground, moved: false };
  } else {
    store.select(null);
    state.pointer = { mode: 'orbit', x: event.clientX, y: event.clientY };
  }
  if (state.pointer) canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  const ground = currentGround(event.clientX, event.clientY);
  if (ground) {
    $('dz-cursor').textContent = `x ${snap(ground.x)} / y ${snap(ground.y)}`;
  }
  const pointer = state.pointer;
  if (!pointer) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  pointer.x = event.clientX;
  pointer.y = event.clientY;

  if (pointer.mode === 'orbit') viewport.orbit(dx, dy);
  else if (pointer.mode === 'pan') viewport.pan(dx, dy);
  else if (pointer.mode === 'drag') {
    if (!pointer.moved && Math.hypot(dx, dy) < 3) return;
    pointer.moved = true;
    if (ground) {
      const sdx = snap(ground.x - pointer.start.x);
      const sdy = snap(ground.y - pointer.start.y);
      viewport.previewOffset(pointer.obj, sdx, sdy);
      $('dz-hint').textContent = `x ${sdx} / y ${sdy}`;
    }
  } else if (pointer.mode === 'line') {
    if (ground) {
      const current = { x: snap(ground.x), y: snap(ground.y) };
      const end = state.alt ? current : axisLock(pointer.start, current);
      viewport.showLineGhost(pointer.start.x, pointer.start.y, end.x, end.y);
    }
  }
});

function axisLock(start, current) {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  if (Math.abs(dx) >= Math.abs(dy) * 4) return { x: current.x, y: start.y };
  if (Math.abs(dy) >= Math.abs(dx) * 4) return { x: start.x, y: current.y };
  return current;
}

canvas.addEventListener('pointerup', (event) => {
  const pointer = state.pointer;
  if (!pointer) return;
  state.pointer = null;
  if (pointer.mode === 'drag') {
    if (pointer.moved) {
      const ground = currentGround(event.clientX, event.clientY);
      if (ground) {
        const sdx = snap(ground.x - pointer.start.x);
        const sdy = snap(ground.y - pointer.start.y);
        store.translate(pointer.obj.id, sdx, sdy);
      }
    }
    $('dz-hint').textContent = '';
  } else if (pointer.mode === 'line') {
    viewport.clearGhost();
    const ground = currentGround(event.clientX, event.clientY);
    if (ground) {
      const current = { x: snap(ground.x), y: snap(ground.y) };
      const end = state.alt ? current : axisLock(pointer.start, current);
      store.addLine(pointer.tool, pointer.start.x, pointer.start.y, end.x, end.y);
    }
  }
  syncTools();
});

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  viewport.zoom(event.deltaY);
}, { passive: false });

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
    || event.target instanceof HTMLTextAreaElement) return;
  const key = event.key.toLowerCase();
  if (key === 'escape') {
    if (state.pointer) {
      state.pointer = null;
      viewport.clearGhost();
    }
    if (store.tool()) store.setTool(null);
    else store.select(null);
    syncTools();
    return;
  }
  if (key === 'delete' || key === 'backspace') {
    const obj = store.selected();
    if (obj) store.remove(obj.id);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'z') {
    event.preventDefault();
    if (event.shiftKey) store.redo();
    else store.undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'y') {
    event.preventDefault();
    store.redo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'd') {
    event.preventDefault();
    const obj = store.selected();
    if (obj) store.duplicate(obj.id);
    return;
  }
  if (key === 'r') {
    const obj = store.selected();
    if (obj) store.rotate(obj.id, 90);
    return;
  }
  if (key === 'f') {
    viewport.fitView();
  }
  if (key === 'alt') state.alt = true;
});

window.addEventListener('keyup', (event) => {
  if (event.key.toLowerCase() === 'alt') state.alt = false;
});

window.addEventListener('blur', () => { state.alt = false; });

window.addEventListener('beforeunload', (event) => {
  if (store.dirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

/* ---------------- 数据同步 ---------------- */

function refresh(reason) {
  if (reason === 'tool') {
    syncTools();
    return;
  }
  if (reason === 'selection') {
    buildInspector(store.selected());
    viewport.setSelection(store.selected());
    syncDirty();
    return;
  }
  if (reason === 'saved' || reason === 'name') {
    syncHeader();
    syncDirty();
    return;
  }
  // model / load / meta / restore
  viewport.rebuild(store.project(), { fit: reason === 'load' });
  viewport.setSelection(store.selected());
  buildInspector(store.selected());
  syncHeader();
  syncStats();
  syncRoomForm();
  syncDirty();
  $('dz-empty').hidden = store.project().objects.length > 0;
  post('dirty', { dirty: store.dirty() });
}

store.subscribe(refresh);

/* ---------------- 消息与启动 ---------------- */

window.addEventListener('message', (event) => {
  if (!embedded || event.source !== window.parent) return;
  const data = event.data || {};
  if (data.type === 'load' && data.project) {
    // 初始自动加载不带 force：用户已经动手（或刚新建机房）时不能被异步加载覆盖。
    if (!data.force && store.dirty()) return;
    clearTimeout(state.fallbackTimer);
    store.load(data.project, { id: data.id, name: data.name });
    state.loaded = true;
    showBusy('', false);
  } else if (data.type === 'new-room') {
    clearTimeout(state.fallbackTimer);
    store.newProject({
      name: data.name || '未命名机房',
      width: Number(data.width) || 12000,
      depth: Number(data.depth) || 8000,
      height: Number(data.height) || 3000,
      floorHeight: Number(data.floorHeight) || 400,
    });
    toast('已创建机房，可继续放置机柜');
  } else if (data.type === 'request-save') {
    requestSave();
  } else if (data.type === 'saved') {
    store.markSaved({ id: data.id, name: data.name });
    showBusy('', false);
    toast('已保存到项目库');
  } else if (data.type === 'error') {
    showBusy('', false);
    toast(data.message || '保存失败', true);
  }
});

async function boot() {
  if (embedded) document.body.classList.add('is-embedded');
  buildToolbar();
  syncTools();
  try {
    viewport = await createViewport(canvas);
  } catch (error) {
    $('dz-busy').hidden = true;
    $('dz-hint').textContent = `3D 初始化失败：${error.message}`;
    return;
  }

  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  if (src) {
    showBusy('加载项目…', true);
    try {
      const response = await fetch(src, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      store.load(await response.json());
      state.loaded = true;
      showBusy('', false);
    } catch (error) {
      showBusy('', false);
      toast(`项目加载失败：${error.message}`, true);
      store.load({ name: '未命名机房', meta: { roomHeight: 3000, floorHeight: 400 }, objects: [] });
    }
    return;
  }

  if (embedded) {
    post('ready');
    // 父页面没有项目时给一个空机房占位；只在用户还没动手时生效，
    // 否则 1.5s 后的兜底会覆盖用户刚新建的机房（实测过）。
    state.fallbackTimer = setTimeout(() => {
      if (state.loaded || store.dirty() || store.project().objects.length) return;
      store.load({ name: '未命名机房', meta: { roomHeight: 3000, floorHeight: 400 }, objects: [] });
      showBusy('', false);
    }, 1500);
    return;
  }

  store.load({ name: '未命名机房', meta: { roomHeight: 3000, floorHeight: 400 }, objects: [] });
}

boot();

// 调试/自动化自检
window.__dz = {
  get project() { return store.toJSON(); },
  get store() { return store; },
  get viewport() { return viewport; },
  stats: () => store.stats(),
};
