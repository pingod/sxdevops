/**
 * 设计器状态：项目 JSON 是唯一真相，UI 与三维场景都从这里派生。
 *
 * 撤销/重做按「整份项目快照」处理（对象量级约 10²–10³，快照是几十 KB），
 * 比给每种操作写反向补丁更不容易漏掉字段；代价是栈深限制在 80 步。
 */

const MAX_UNDO = 80;

const uid = () => `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const POINT_TYPES = ['cabinet', 'ac', 'pdu', 'ups', 'column', 'extinguisher', 'vent', 'battery'];
export const LINE_TYPES = ['wall', 'tray'];

/** 构件库条目：默认 props 与放置方式（点 / 线）。 */
export const TOOL_DEFS = [
  {
    type: 'cabinet', label: '机柜', mode: 'point',
    props: { w: 600, d: 1200, h: 2000, u: 42, name: '机柜', color: '' },
  },
  {
    type: 'wall', label: '墙体', mode: 'line',
    props: { thickness: 240, height: 3000, material: '砖墙', name: '墙' },
  },
  {
    type: 'tray', label: '桥架', mode: 'line',
    props: { width: 300, height: 100, name: '桥架' },
  },
  {
    type: 'ac', label: '空调', mode: 'point',
    props: { w: 1200, d: 800, h: 2000, acType: '房间级空调', name: '空调' },
  },
  {
    type: 'pdu', label: 'PDU', mode: 'point',
    props: { w: 600, d: 1200, h: 2000, name: 'PDU' },
  },
  {
    type: 'ups', label: 'UPS', mode: 'point',
    props: { w: 600, d: 1200, h: 2000, name: 'UPS' },
  },
  {
    type: 'column', label: '立柱', mode: 'point',
    props: { w: 600, d: 600, h: 3000, name: '立柱' },
  },
];

const TOOL_BY_TYPE = Object.fromEntries(TOOL_DEFS.map(t => [t.type, t]));

export function blankProject(name = '未命名机房') {
  return {
    name,
    meta: { roomHeight: 3000, floorHeight: 400, surveyor: '', date: '' },
    objects: [],
  };
}

/** 矩形机房：四面墙 + 层高/地板高度。 */
export function roomProject(name, width, depth, height = 3000, floorHeight = 400, thickness = 240) {
  const w = Math.max(2000, Math.round(width));
  const d = Math.max(2000, Math.round(depth));
  const walls = [
    { x1: 0, y1: 0, x2: w, y2: 0 },
    { x1: w, y1: 0, x2: w, y2: d },
    { x1: w, y1: d, x2: 0, y2: d },
    { x1: 0, y1: d, x2: 0, y2: 0 },
  ].map((line, index) => ({
    id: uid(),
    type: 'wall',
    ...line,
    props: { thickness, height, material: '砖墙', name: `墙-${index + 1}` },
  }));
  return {
    name,
    meta: { roomHeight: height, floorHeight, surveyor: '', date: '' },
    objects: walls,
  };
}

export function createStore() {
  let project = blankProject();
  let selectedId = null;
  let tool = null;
  let source = { id: null, name: '' };
  let savedSnapshot = JSON.stringify(project);
  const undoStack = [];
  const redoStack = [];
  const listeners = new Set();

  const emit = (reason = 'change') => {
    for (const fn of listeners) fn(reason);
  };
  const snapshot = () => JSON.stringify(project);
  const dirty = () => snapshot() !== savedSnapshot;

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  }

  function commit(mutate, reason = 'model') {
    pushUndo();
    mutate(project);
    if (selectedId && !project.objects.some(o => o.id === selectedId)) selectedId = null;
    emit(reason);
  }

  function normalize(raw) {
    const next = {
      name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : '未命名机房',
      meta: {
        roomHeight: Number(raw?.meta?.roomHeight) > 0 ? Number(raw.meta.roomHeight) : 3000,
        floorHeight: Number.isFinite(Number(raw?.meta?.floorHeight)) ? Math.max(0, Number(raw.meta.floorHeight)) : 400,
        surveyor: typeof raw?.meta?.surveyor === 'string' ? raw.meta.surveyor : '',
        date: typeof raw?.meta?.date === 'string' ? raw.meta.date : '',
      },
      objects: Array.isArray(raw?.objects) ? raw.objects.filter(o => o && o.id && o.type).map(o => ({ ...o, props: o.props || {} })) : [],
    };
    return next;
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    project: () => project,
    selectedId: () => selectedId,
    selected: () => project.objects.find(o => o.id === selectedId) || null,
    tool: () => tool,
    dirty,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    source: () => source,

    load(raw, meta = {}) {
      project = normalize(raw);
      source = { id: meta.id ?? null, name: meta.name || project.name };
      selectedId = null;
      tool = null;
      undoStack.length = 0;
      redoStack.length = 0;
      savedSnapshot = snapshot();
      emit('load');
    },

    newProject({ name, width, depth, height, floorHeight }) {
      project = roomProject(name, width, depth, height, floorHeight);
      source = { id: null, name: project.name };
      selectedId = null;
      tool = null;
      undoStack.length = 0;
      redoStack.length = 0;
      savedSnapshot = '';
      emit('load');
    },

    setTool(type) {
      tool = tool === type ? null : type;
      emit('tool');
    },

    select(id) {
      selectedId = id || null;
      emit('selection');
    },

    setProjectName(name) {
      commit(p => { p.name = String(name).slice(0, 120); }, 'name');
    },

    setMeta(patch) {
      commit(p => { Object.assign(p.meta, patch); }, 'meta');
    },

    addPoint(type, x, y) {
      const def = TOOL_BY_TYPE[type];
      if (!def) return null;
      const obj = {
        id: uid(), type, x: Math.round(x), y: Math.round(y), rotation: 0,
        props: { ...def.props },
      };
      commit(p => { p.objects.push(obj); });
      selectedId = obj.id;
      emit('selection');
      return obj;
    },

    addLine(type, x1, y1, x2, y2) {
      const def = TOOL_BY_TYPE[type];
      if (!def) return null;
      if (Math.hypot(x2 - x1, y2 - y1) < 200) return null;
      const obj = {
        id: uid(), type,
        x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2),
        props: { ...def.props },
      };
      commit(p => { p.objects.push(obj); });
      selectedId = obj.id;
      emit('selection');
      return obj;
    },

    addCabinetRow({ x, y, count, gap, direction, prefix, u, w, d, h }) {
      const step = direction === 'y' ? 0 : (w + gap);
      const stepY = direction === 'y' ? (d + gap) : 0;
      const objects = [];
      for (let i = 0; i < count; i += 1) {
        objects.push({
          id: uid(), type: 'cabinet',
          x: Math.round(x + step * i),
          y: Math.round(y + stepY * i),
          rotation: 0,
          props: { w, d, h, u, name: `${prefix}${String(i + 1).padStart(2, '0')}`, color: '' },
        });
      }
      commit(p => { p.objects.push(...objects); });
      selectedId = objects[0].id;
      emit('selection');
      return objects.length;
    },

    translate(id, dx, dy) {
      const obj = project.objects.find(o => o.id === id);
      if (!obj) return;
      if (obj.x1 !== undefined) {
        obj.x1 = Math.round(obj.x1 + dx);
        obj.y1 = Math.round(obj.y1 + dy);
        obj.x2 = Math.round(obj.x2 + dx);
        obj.y2 = Math.round(obj.y2 + dy);
      } else {
        obj.x = Math.round(obj.x + dx);
        obj.y = Math.round(obj.y + dy);
      }
    },

    updateObject(id, patch, { props = {} } = {}) {
      commit(p => {
        const obj = p.objects.find(o => o.id === id);
        if (!obj) return;
        Object.assign(obj, patch);
        obj.props = { ...(obj.props || {}), ...props };
      });
    },

    rotate(id, delta = 90) {
      commit(p => {
        const obj = p.objects.find(o => o.id === id);
        if (!obj) return;
        if (obj.x !== undefined) obj.rotation = ((Number(obj.rotation) || 0) + delta + 360) % 360;
      });
    },

    remove(id) {
      commit(p => {
        p.objects = p.objects.filter(o => o.id !== id);
      });
      selectedId = null;
      emit('selection');
    },

    duplicate(id) {
      const obj = project.objects.find(o => o.id === id);
      if (!obj) return null;
      const copy = JSON.parse(JSON.stringify(obj));
      copy.id = uid();
      if (copy.x1 !== undefined) {
        const dx = 400;
        copy.x1 += dx; copy.x2 += dx;
      } else {
        copy.x += 400;
      }
      if (copy.props?.name) copy.props.name = `${copy.props.name}-副本`;
      commit(p => { p.objects.push(copy); });
      selectedId = copy.id;
      emit('selection');
      return copy;
    },

    undo() {
      if (!undoStack.length) return false;
      redoStack.push(snapshot());
      project = JSON.parse(undoStack.pop());
      if (selectedId && !project.objects.some(o => o.id === selectedId)) selectedId = null;
      emit('restore');
      return true;
    },

    redo() {
      if (!redoStack.length) return false;
      undoStack.push(snapshot());
      project = JSON.parse(redoStack.pop());
      if (selectedId && !project.objects.some(o => o.id === selectedId)) selectedId = null;
      emit('restore');
      return true;
    },

    markSaved(meta = {}) {
      if (meta.id !== undefined) source = { id: meta.id, name: meta.name || project.name };
      savedSnapshot = snapshot();
      emit('saved');
    },

    stats() {
      const counts = {};
      for (const obj of project.objects) counts[obj.type] = (counts[obj.type] || 0) + 1;
      return { total: project.objects.length, counts };
    },

    /** 交给平台保存/导出的纯数据（去掉 three 运行时残留）。 */
    toJSON() {
      return {
        name: project.name,
        meta: { ...project.meta },
        objects: project.objects.map(o => ({ ...o, props: { ...(o.props || {}) } })),
      };
    },
  };
}
