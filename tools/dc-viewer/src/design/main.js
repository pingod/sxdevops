/**
 * 设计器入口：store（数据） + viewport（三维） + 表单/消息（UI）。
 *
 * 与平台的集成走 postMessage：
 *   out: ready / dirty / save {project} / error {message}
 *   in:  load {project, id?, name?} / saved {id, name} / error {message}
 *        new-room {name,width,depth,height,floorHeight} / request-save
 *        theme {theme} / monitor-targets {items}
 * 父页面持有鉴权令牌与项目库 API，设计器本身不碰网络。
 */
import './design.css';
import {
  createStore, TOOL_DEFS, POINT_TYPES, LINE_TYPES, OPENING_TYPES,
  openingWidth, isPoint, isLine,
} from './store.js';
import { createViewport } from './viewport.js';

const $ = (id) => document.getElementById(id);
const canvas = $('dz-canvas');

const store = createStore();
const embedded = window.parent !== window;
let viewport = null;

const DRAFT_DEBOUNCE = 2000;
const COLUMN_SNAP = 600;

const state = {
  tool: null,
  pointer: null,
  alt: false,
  loaded: false,
  fallbackTimer: null,
  draftTimer: null,
  draft: null,
  monitorTargets: [],
  theme: 'light',
  pointers: new Map(),
  pinch: null,
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

const findObject = (id) => store.project().objects.find(o => o.id === id) || null;

/* ---------------- 草稿 ---------------- */

function scheduleDraft() {
  clearTimeout(state.draftTimer);
  if (!store.dirty()) return;
  state.draftTimer = setTimeout(() => { store.writeDraft(); }, DRAFT_DEBOUNCE);
}

function hideDraftBanner() {
  state.draft = null;
  $('dz-draft-banner').hidden = true;
}

function checkDraft(loadedProject) {
  const draft = store.readDraft();
  if (!draft || !draft.project) { hideDraftBanner(); return; }
  let same = false;
  try {
    same = JSON.stringify(draft.project) === JSON.stringify(loadedProject);
  } catch {
    same = false;
  }
  if (same) { hideDraftBanner(); return; }
  state.draft = draft;
  const when = draft.savedAt ? new Date(draft.savedAt) : null;
  const stamp = when && !Number.isNaN(when.getTime())
    ? when.toLocaleString('zh-CN', { hour12: false })
    : '上次编辑';
  $('dz-draft-text').textContent = `发现 ${stamp} 的未保存草稿（${draft.project.objects?.length || 0} 个对象）`;
  $('dz-draft-banner').hidden = false;
}

$('dz-draft-restore').addEventListener('click', () => {
  const draft = state.draft;
  if (!draft) return;
  const meta = draft.source || {};
  store.load(draft.project, { id: meta.id ?? null, name: meta.name });
  store.markUnsaved();
  hideDraftBanner();
  toast('已恢复草稿，记得保存');
});

$('dz-draft-discard').addEventListener('click', () => {
  store.clearDraft();
  hideDraftBanner();
  toast('已丢弃草稿');
});

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
  post('dirty', { dirty: store.dirty() });
}

function toolHint(tool) {
  const def = TOOL_DEFS.find(t => t.type === tool);
  if (!def) return '左键选择与拖动，右键旋转视角';
  if (def.mode === 'opening') return `放置模式：${def.label}（点在墙上，Esc 退出）`;
  if (def.mode === 'line') return `放置模式：${def.label}（按住拖出走向，Esc 退出）`;
  return `放置模式：${def.label}（地面点击放置，Esc 退出）`;
}

function syncTools() {
  for (const button of document.querySelectorAll('.dz-tool')) {
    const type = button.dataset.type;
    button.classList.toggle('is-active', store.tool() === type);
    button.setAttribute('aria-pressed', store.tool() === type ? 'true' : 'false');
  }
  $('dz-hint').textContent = toolHint(store.tool());
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
    button.setAttribute('aria-label', `放置${def.label}`);
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
const LEAF_OPTIONS = [{ value: 'single', label: '单扇' }, { value: 'double', label: '双扇' }];
const SWING_OPTIONS = [{ value: 'left', label: '左开' }, { value: 'right', label: '右开' }];
const AISLE_KIND_OPTIONS = [{ value: 'cold', label: '冷通道' }, { value: 'hot', label: '热通道' }];
const VENT_KIND_OPTIONS = ['格栅', '孔板'];

const sizeFields = (specs, keys = ['w', 'd', 'h']) => {
  const labels = { w: '宽 mm', d: '深 mm', h: '高 mm' };
  for (const key of keys) specs.push({ key: `props.${key}`, label: labels[key], type: 'number', step: 100 });
  return specs;
};

function fieldSpecs(obj) {
  const specs = [{ key: 'props.name', label: '名称', type: 'text' }];

  if (OPENING_TYPES.includes(obj.type)) {
    const wall = findObject(obj.wallId);
    specs.push({
      key: 'wallId', label: '所属墙', type: 'readonly',
      value: wall?.props?.name || wall?.id || '未绑定',
    });
    specs.push({ key: 't', label: '沿墙位置 t（0–1）', type: 'number', step: 0.01 });
    specs.push({ key: 'props.width', label: '宽 mm', type: 'number', step: 100 });
    specs.push({ key: 'props.height', label: '高 mm', type: 'number', step: 100 });
    if (obj.type !== 'door') specs.push({ key: 'props.sill', label: '窗台高 mm', type: 'number', step: 100 });
    if (obj.type === 'door') {
      specs.push({ key: 'props.leaf', label: '门扇', type: 'select', options: LEAF_OPTIONS });
      specs.push({ key: 'props.swing', label: '开向', type: 'select', options: SWING_OPTIONS });
    }
    return specs;
  }

  if (isPoint(obj)) {
    specs.push({ key: 'x', label: 'X mm', type: 'number', step: 100 });
    specs.push({ key: 'y', label: 'Y mm', type: 'number', step: 100 });
    specs.push({ key: 'rotation', label: '旋转 °', type: 'number', step: 90 });
  } else if (isLine(obj)) {
    for (const key of ['x1', 'y1', 'x2', 'y2']) {
      specs.push({ key, label: `${key.toUpperCase()} mm`, type: 'number', step: 100 });
    }
  }

  switch (obj.type) {
    case 'cabinet':
      sizeFields(specs);
      specs.push({ key: 'props.u', label: 'U 数', type: 'number', step: 1 });
      specs.push({ key: 'props.color', label: '柜体颜色 #rrggbb', type: 'text', placeholder: '留空用默认色' });
      specs.push({ key: 'monitor', label: '监控绑定（网络设备）', type: 'multi', options: monitorOptions() });
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
    case 'beam':
      specs.push({ key: 'props.b', label: '梁宽 mm', type: 'number', step: 50 });
      specs.push({ key: 'props.h', label: '梁高 mm', type: 'number', step: 50 });
      specs.push({ key: 'props.top', label: '梁顶标高 mm', type: 'number', step: 100 });
      break;
    case 'ac':
      sizeFields(specs);
      specs.push({ key: 'props.acType', label: '类型', type: 'select', options: AC_OPTIONS });
      break;
    case 'aisle':
      specs.push({ key: 'props.w', label: '宽 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.d', label: '深 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.kind', label: '类型', type: 'select', options: AISLE_KIND_OPTIONS });
      break;
    case 'vent':
      specs.push({ key: 'props.w', label: '宽 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.d', label: '深 mm', type: 'number', step: 100 });
      specs.push({ key: 'props.kind', label: '类型', type: 'select', options: VENT_KIND_OPTIONS });
      break;
    case 'pdu':
    case 'ups':
    case 'column':
    case 'battery':
    case 'extinguisher':
      sizeFields(specs);
      break;
    default:
      break;
  }
  return specs;
}

function monitorOptions() {
  return state.monitorTargets.map(item => ({
    value: String(item.id),
    label: `${item.name}${item.location ? ` · ${item.location}` : ''}`,
  }));
}

function currentValue(obj, spec) {
  if (spec.type === 'readonly') return spec.value ?? '';
  if (spec.key === 'monitor') {
    const ids = obj.props?.monitor?.deviceIds;
    return Array.isArray(ids) ? ids.map(String) : [];
  }
  if (spec.key.startsWith('props.')) {
    const value = obj.props?.[spec.key.slice(6)];
    return value === undefined || value === null ? '' : value;
  }
  const value = obj[spec.key];
  return value === undefined || value === null ? '' : value;
}

function buildInspector() {
  const objects = store.selectedObjects();
  const form = $('dz-inspector-form');
  const empty = $('dz-inspector-empty');
  form.innerHTML = '';
  empty.hidden = objects.length > 0;
  form.hidden = objects.length === 0;
  if (!objects.length) return;

  if (objects.length > 1) {
    const hint = document.createElement('div');
    hint.className = 'dz-selection-hint';
    hint.textContent = `已选 ${objects.length} 个对象：用画布顶部的对齐/等距按钮批量调整，拖动会整组移动。`;
    form.appendChild(hint);
    const actions = document.createElement('div');
    actions.className = 'dz-inspector-actions';
    const ids = store.selection();
    for (const [label, fn] of [
      ['旋转 90°', () => store.rotateMany(ids, 90)],
      ['复制', () => store.duplicateMany(ids)],
      ['删除', () => store.removeMany(ids)],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', fn);
      actions.appendChild(button);
    }
    form.appendChild(actions);
    return;
  }

  const obj = objects[0];
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

    if (spec.type === 'readonly') {
      const value = document.createElement('div');
      value.className = 'dz-readonly';
      value.textContent = currentValue(obj, spec) || '—';
      wrapper.appendChild(value);
      form.appendChild(wrapper);
      continue;
    }

    let input;
    if (spec.type === 'select' || spec.type === 'multi') {
      input = document.createElement('select');
      if (spec.type === 'multi') input.multiple = true;
      if (spec.type === 'multi' && !spec.options.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '暂无可绑定网络设备';
        option.disabled = true;
        input.appendChild(option);
        input.disabled = true;
      }
      for (const option of spec.options) {
        const el = document.createElement('option');
        el.value = typeof option === 'object' ? option.value : option;
        el.textContent = typeof option === 'object' ? option.label : option;
        input.appendChild(el);
      }
    } else {
      input = document.createElement('input');
      input.type = spec.type;
      input.step = spec.step || 'any';
      input.placeholder = spec.placeholder || '';
    }
    input.dataset.key = spec.key;
    input.setAttribute('aria-label', spec.label);
    const current = currentValue(obj, spec);
    if (spec.type === 'multi') {
      const wanted = new Set(current);
      for (const option of input.options) option.selected = wanted.has(option.value);
    } else {
      input.value = current === undefined || current === null ? '' : String(current);
    }
    wrapper.appendChild(input);
    form.appendChild(wrapper);
  }

  const actions = document.createElement('div');
  actions.className = 'dz-inspector-actions';
  for (const [label, fn] of [
    ['旋转 90°', () => store.rotate(obj.id, 90)],
    ['复制', () => store.duplicate(obj.id)],
    ['删除', () => store.remove(obj.id)],
  ]) {
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
  if (!input.dataset.key || input.dataset.key === 'wallId') return;
  const objects = store.selectedObjects();
  if (objects.length !== 1) return;
  const obj = objects[0];
  const key = input.dataset.key;

  if (key === 'monitor') {
    const ids = [...input.selectedOptions]
      .map(option => Number(option.value))
      .filter(value => Number.isInteger(value));
    store.updateObject(obj.id, {}, { props: { monitor: { deviceIds: ids } } });
    return;
  }

  const patch = {};
  const props = {};
  const numeric = input.type === 'number';
  const raw = input.value;
  let value = raw;
  if (numeric) {
    const num = Number(raw);
    if (raw === '' || !Number.isFinite(num)) return;
    value = key === 't' ? num : Math.round(num);
  }
  if (key.startsWith('props.')) props[key.slice(6)] = value;
  else patch[key] = value;

  // 改 t 时必须落在洞口不越界的区间内，否则墙会自己穿洞。
  if (key === 't') {
    store.beginGesture();
    const result = store.setOpeningT(obj.id, value);
    if (result === null) {
      store.cancelGesture();
      toast('该位置放不下洞口，已忽略', true);
      return;
    }
    store.endGesture('model', { ids: [obj.id], structural: false, wallIds: [obj.wallId] });
    return;
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

/* ---------------- 多选工具条 ---------------- */

function syncAlignBar() {
  const bar = $('dz-align');
  const ids = store.selection();
  bar.hidden = ids.length < 2;
  $('dz-align-count').textContent = `已选 ${ids.length} 个`;
  for (const button of bar.querySelectorAll('button[data-distribute]')) {
    button.disabled = ids.length < 3;
  }
}

$('dz-align').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.align) store.align(button.dataset.align);
  else if (button.dataset.distribute) store.distribute(button.dataset.distribute);
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
    input.setAttribute('aria-label', field.label);
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
    hideDraftBanner();
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
      hideDraftBanner();
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

function axisLock(start, current) {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  if (Math.abs(dx) >= Math.abs(dy) * 4) return { x: current.x, y: start.y };
  if (Math.abs(dy) >= Math.abs(dx) * 4) return { x: start.x, y: current.y };
  return current;
}

/** 横梁端点吸附：600mm 内有立柱就写 col1/col2，否则只留端点坐标。 */
function columnAttach(x1, y1, x2, y2) {
  const columns = store.project().objects.filter(o => o.type === 'column');
  if (!columns.length) return {};
  const near = (x, y) => {
    let best = null;
    for (const column of columns) {
      const distance = Math.hypot(column.x - x, column.y - y);
      if (distance <= COLUMN_SNAP && (!best || distance < best.distance)) best = { column, distance };
    }
    return best ? best.column.id : null;
  };
  const extra = {};
  const col1 = near(x1, y1);
  const col2 = near(x2, y2);
  if (col1) extra.col1 = col1;
  if (col2) extra.col2 = col2;
  return extra;
}

function placeTool(tool, clientX, clientY) {
  const def = TOOL_DEFS.find(t => t.type === tool);
  if (!def) return false;

  if (def.mode === 'opening') {
    const width = def.props.width;
    const hit = viewport.wallHit(clientX, clientY, width);
    if (!hit) {
      const loose = viewport.wallHit(clientX, clientY, 0);
      toast(loose ? '墙体太短，放不下该洞口' : '请点在墙体上放置门窗/格栅', true);
      return true;
    }
    store.addOpening(tool, hit.wall.id, hit.t);
    return true;
  }

  const ground = currentGround(clientX, clientY);
  if (!ground) return false;
  if (def.mode === 'point') {
    store.addPoint(tool, snap(ground.x), snap(ground.y));
    return true;
  }
  return false;
}

function beginMarquee(event) {
  state.pointer = {
    mode: 'marquee', startX: event.clientX, startY: event.clientY,
    x: event.clientX, y: event.clientY,
  };
  $('dz-marquee').hidden = false;
  canvas.setPointerCapture(event.pointerId);
}

function updateMarquee(event) {
  const pointer = state.pointer;
  const left = Math.min(pointer.startX, event.clientX);
  const top = Math.min(pointer.startY, event.clientY);
  const width = Math.abs(event.clientX - pointer.startX);
  const height = Math.abs(event.clientY - pointer.startY);
  const box = $('dz-marquee');
  const rect = canvas.getBoundingClientRect();
  box.style.left = `${left - rect.left}px`;
  box.style.top = `${top - rect.top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  if (width < 4 && height < 4) return;

  const hits = [];
  for (const obj of store.project().objects) {
    const bounds = viewport.screenBounds(obj);
    if (!bounds) continue;
    if (bounds.maxX < left || bounds.minX > left + width) continue;
    if (bounds.maxY < top || bounds.minY > top + height) continue;
    hits.push(obj.id);
  }
  store.selectMany(hits);
}

function endMarquee() {
  state.pointer = null;
  $('dz-marquee').hidden = true;
}

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch') {
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pointers.size === 2) {
      const [a, b] = [...state.pointers.values()];
      state.pinch = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      };
      state.pointer = null;
      viewport.clearGhost();
      return;
    }
  }

  if (event.button === 2) {
    state.pointer = { mode: 'orbit', x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.button === 1) {
    state.pointer = { mode: 'pan', x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;

  const tool = store.tool();
  if (tool) {
    const def = TOOL_DEFS.find(t => t.type === tool);
    if (def?.mode === 'line') {
      const ground = currentGround(event.clientX, event.clientY);
      if (!ground) return;
      const start = { x: snap(ground.x), y: snap(ground.y) };
      state.pointer = { mode: 'line', tool, start, x: event.clientX, y: event.clientY };
      viewport.showLineGhost(start.x, start.y, start.x, start.y);
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (placeTool(tool, event.clientX, event.clientY)) return;
  }

  const picked = viewport.pick(event.clientX, event.clientY);
  const selection = store.selection();

  if (event.shiftKey) {
    if (picked) {
      store.select(picked.id, { additive: true });
      return;
    }
    beginMarquee(event);
    return;
  }

  if (!picked) {
    store.clearSelection();
    state.pointer = { mode: 'orbit', x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    return;
  }

  if (!selection.includes(picked.id)) store.select(picked.id);
  const ids = store.selection();

  if (OPENING_TYPES.includes(picked.type)) {
    store.beginGesture();
    state.pointer = { mode: 'opening', obj: picked, x: event.clientX, y: event.clientY, moved: false };
    canvas.setPointerCapture(event.pointerId);
    return;
  }

  const ground = currentGround(event.clientX, event.clientY);
  state.pointer = {
    mode: 'drag', ids, anchor: picked, start: ground, x: event.clientX, y: event.clientY, moved: false,
  };
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch' && state.pointers.has(event.pointerId)) {
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pinch && state.pointers.size >= 2) {
      const [a, b] = [...state.pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (state.pinch.distance > 0) viewport.zoom((state.pinch.distance - distance) * 1.2);
      viewport.pan(midX - state.pinch.midX, midY - state.pinch.midY);
      state.pinch = { distance, midX, midY };
      return;
    }
  }

  const ground = currentGround(event.clientX, event.clientY);
  if (ground) $('dz-cursor').textContent = `x ${snap(ground.x)} / y ${snap(ground.y)}`;

  const pointer = state.pointer;
  if (!pointer) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  pointer.x = event.clientX;
  pointer.y = event.clientY;

  if (pointer.mode === 'orbit') {
    viewport.orbit(dx, dy);
  } else if (pointer.mode === 'pan') {
    viewport.pan(dx, dy);
  } else if (pointer.mode === 'marquee') {
    updateMarquee(event);
  } else if (pointer.mode === 'opening') {
    const hit = viewport.wallHit(event.clientX, event.clientY, openingWidth(pointer.obj));
    if (!hit || hit.wall.id !== pointer.obj.wallId) return;
    pointer.moved = true;
    store.setOpeningT(pointer.obj.id, hit.t);
  } else if (pointer.mode === 'drag') {
    if (!pointer.moved && Math.hypot(dx, dy) < 3) return;
    pointer.moved = true;
    if (ground && pointer.start) {
      const sdx = snap(ground.x - pointer.start.x);
      const sdy = snap(ground.y - pointer.start.y);
      pointer.delta = { dx: sdx, dy: sdy };
      viewport.previewMany(pointer.ids.map(findObject).filter(Boolean), sdx, sdy);
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

function finishPointer(event) {
  if (event.pointerType === 'touch') {
    state.pointers.delete(event.pointerId);
    if (state.pointers.size < 2) state.pinch = null;
  }
  const pointer = state.pointer;
  if (!pointer) return;
  state.pointer = null;

  if (pointer.mode === 'marquee') {
    endMarquee();
    return;
  }
  if (pointer.mode === 'opening') {
    store.endGesture('model', { ids: [pointer.obj.id], structural: false, wallIds: [pointer.obj.wallId] });
    return;
  }
  if (pointer.mode === 'drag') {
    if (pointer.moved && pointer.delta) {
      store.translateMany(pointer.ids, pointer.delta.dx, pointer.delta.dy);
    } else {
      viewport.setSelection(store.selectedObjects());
    }
    $('dz-hint').textContent = toolHint(store.tool());
    return;
  }
  if (pointer.mode === 'line') {
    viewport.clearGhost();
    const ground = currentGround(event.clientX, event.clientY);
    if (ground) {
      const current = { x: snap(ground.x), y: snap(ground.y) };
      const end = state.alt ? current : axisLock(pointer.start, current);
      const extra = pointer.tool === 'beam'
        ? columnAttach(pointer.start.x, pointer.start.y, end.x, end.y)
        : {};
      store.addLine(pointer.tool, pointer.start.x, pointer.start.y, end.x, end.y, extra);
    }
  }
  syncTools();
}

canvas.addEventListener('pointerup', finishPointer);
canvas.addEventListener('pointercancel', (event) => {
  if (state.pointer?.mode === 'opening') store.cancelGesture();
  endMarquee();
  finishPointer(event);
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
    if (!$('dz-dialog').hidden) {
      $('dz-dialog').hidden = true;
      return;
    }
    if (state.pointer) {
      if (state.pointer.mode === 'opening') store.cancelGesture();
      state.pointer = null;
      viewport.clearGhost();
      endMarquee();
    }
    if (store.tool()) store.setTool(null);
    else store.clearSelection();
    syncTools();
    return;
  }
  if (key === 'alt') state.alt = true;
  if (key === 'delete' || key === 'backspace') {
    if (store.selection().length) store.removeMany(store.selection());
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
    if (store.selection().length) store.duplicateMany(store.selection());
    return;
  }
  if (key === 'r') {
    if (store.selection().length) store.rotateMany(store.selection(), 90);
    return;
  }
  if (key === 'f') viewport.fitView();
});

window.addEventListener('keyup', (event) => {
  if (event.key.toLowerCase() === 'alt') state.alt = false;
});

window.addEventListener('blur', () => { state.alt = false; });

window.addEventListener('beforeunload', (event) => {
  if (store.dirty()) {
    store.writeDraft();
    event.preventDefault();
    event.returnValue = '';
  }
});

/* ---------------- 数据同步 ---------------- */

function applyIncremental(detail) {
  if (!viewport) return;
  const wallIds = detail?.wallIds || [];
  for (const wallId of wallIds) viewport.rebuildWallGroup(wallId);
  let ok = true;
  for (const id of detail?.ids || []) {
    const obj = findObject(id);
    if (!obj) { ok = false; continue; }
    if (obj.wallId && wallIds.includes(obj.wallId)) continue;
    if (!viewport.updateObject(obj)) ok = false;
  }
  if (!ok) viewport.rebuild(store.project());
  viewport.setSelection(store.selectedObjects());
}

function refresh(reason, detail) {
  if (reason === 'tool') {
    syncTools();
    return;
  }
  if (reason === 'selection') {
    buildInspector();
    syncAlignBar();
    if (viewport) viewport.setSelection(store.selectedObjects());
    syncDirty();
    return;
  }
  if (reason === 'saved' || reason === 'name') {
    syncHeader();
    syncDirty();
    return;
  }
  if (reason === 'dirty') {
    syncDirty();
    scheduleDraft();
    return;
  }
  if (reason === 'preview') {
    applyIncremental(detail);
    return;
  }
  if (reason === 'model' && detail && !detail.structural) {
    applyIncremental(detail);
  } else if (viewport) {
    // load / restore / meta / 结构变化：包围盒、网格与阴影都要重算。
    viewport.rebuild(store.project(), { fit: reason === 'load' });
    viewport.setSelection(store.selectedObjects());
  }
  buildInspector();
  syncAlignBar();
  syncHeader();
  syncStats();
  syncRoomForm();
  syncDirty();
  $('dz-empty').hidden = store.project().objects.length > 0;
  if (reason !== 'preview') scheduleDraft();
}

store.subscribe(refresh);

/* ---------------- 主题 ---------------- */

function applyTheme(theme) {
  const next = ['light', 'charcoal', 'dark'].includes(theme) ? theme : 'light';
  state.theme = next;
  document.documentElement.dataset.theme = next;
  if (viewport) viewport.setTheme(next);
}

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
    checkDraft(data.project);
  } else if (data.type === 'new-room') {
    clearTimeout(state.fallbackTimer);
    store.newProject({
      name: data.name || '未命名机房',
      width: Number(data.width) || 12000,
      depth: Number(data.depth) || 8000,
      height: Number(data.height) || 3000,
      floorHeight: Number(data.floorHeight) || 400,
    });
    hideDraftBanner();
    toast('已创建机房，可继续放置机柜');
  } else if (data.type === 'request-save') {
    requestSave();
  } else if (data.type === 'saved') {
    store.markSaved({ id: data.id, name: data.name });
    showBusy('', false);
    hideDraftBanner();
    toast('已保存到项目库');
  } else if (data.type === 'cancel') {
    // 父页面在版本冲突弹窗里选了「另存为副本」或直接关掉：清忙碌态，不改数据。
    showBusy('', false);
  } else if (data.type === 'error') {
    showBusy('', false);
    toast(data.message || '保存失败', true);
  } else if (data.type === 'theme') {
    applyTheme(data.theme);
  } else if (data.type === 'monitor-targets') {
    state.monitorTargets = Array.isArray(data.items) ? data.items : [];
    if (store.selectedObjects().some(o => o.type === 'cabinet')) buildInspector();
  }
});

async function boot() {
  if (embedded) document.body.classList.add('is-embedded');
  buildToolbar();
  syncTools();
  // 先握手：工具栏不依赖 3D 初始化结果，否则浏览器没有 WebGL 时父页面按钮会永久置灰。
  if (embedded) post('ready');
  try {
    viewport = await createViewport(canvas);
    viewport.setTheme(state.theme);
  } catch (error) {
    $('dz-busy').hidden = true;
    $('dz-hint').textContent = `三维初始化失败：${error.message}（请开启硬件加速或使用 Chrome/Edge）`;
    post('error', { message: `三维视图初始化失败：${error.message}（请开启硬件加速或使用 Chrome/Edge）` });
    return;
  }

  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  if (src) {
    showBusy('加载项目…', true);
    try {
      const response = await fetch(src, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const loaded = await response.json();
      store.load(loaded);
      state.loaded = true;
      showBusy('', false);
      checkDraft(loaded);
    } catch (error) {
      showBusy('', false);
      toast(`项目加载失败：${error.message}`, true);
      store.load({ name: '未命名机房', meta: { roomHeight: 3000, floorHeight: 400 }, objects: [] });
    }
    return;
  }

  if (embedded) {
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
  bench: () => (viewport ? viewport.bench() : { objects: 0, fullMs: 0, incrementalMs: 0 }),
  selection: () => store.selection(),
  theme: () => state.theme,
  monitorTargets: () => state.monitorTargets.slice(),
  types: { point: POINT_TYPES, line: LINE_TYPES, opening: OPENING_TYPES },
};
