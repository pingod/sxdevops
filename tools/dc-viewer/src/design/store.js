/**
 * 设计器状态：项目 JSON 是唯一真相，UI 与三维场景都从这里派生。
 *
 * 撤销/重做按「整份项目快照」处理（对象量级约 10²–10³，快照是几十 KB），
 * 比给每种操作写反向补丁更不容易漏掉字段；代价是栈深限制在 80 步。
 *
 * 选择支持多选：`selection()` 返回 id 数组，`selectedObjects()` 按选择顺序返回对象。
 * 拖动、开洞这类连续手势用 beginGesture/mutateLive/endGesture 合成一次撤销。
 */

import { clampTOnWall } from './opening.js';

const MAX_UNDO = 80;
const DRAFT_PREFIX = 'dc-designer:draft:v1:';

const uid = () => `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 点对象：定位用 x/y + rotation。 */
export const POINT_TYPES = [
  'cabinet', 'ac', 'pdu', 'ups', 'column', 'extinguisher', 'vent', 'battery', 'aisle',
];
/** 线对象：端点用 x1/y1/x2/y2。 */
export const LINE_TYPES = ['wall', 'tray', 'beam'];
/** 开洞对象：挂在 wallId 上，用 t（0–1）表示沿墙位置。 */
export const OPENING_TYPES = ['door', 'window', 'grille'];

/** 影响包围盒/网格/阴影的类型：改动它们要整场重建。 */
const STRUCTURAL_TYPES = new Set([...LINE_TYPES, ...OPENING_TYPES]);

/** 构件库条目：默认 props 与放置方式（point / line / opening）。 */
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
    type: 'door', label: '门', mode: 'opening',
    props: { width: 900, height: 2100, leaf: 'single', swing: 'left', name: '门' },
  },
  {
    type: 'window', label: '窗', mode: 'opening',
    props: { width: 1200, height: 1500, sill: 900, name: '窗' },
  },
  {
    type: 'grille', label: '格栅', mode: 'opening',
    props: { width: 900, height: 1200, sill: 0, name: '格栅' },
  },
  {
    type: 'column', label: '立柱', mode: 'point',
    props: { w: 600, d: 600, h: 3000, name: '立柱' },
  },
  {
    type: 'beam', label: '横梁', mode: 'line',
    props: { b: 300, h: 600, top: 3000, name: '横梁' },
  },
  {
    type: 'tray', label: '桥架', mode: 'line',
    props: { width: 300, height: 100, name: '桥架' },
  },
  {
    type: 'aisle', label: '通道', mode: 'point',
    props: { w: 1000, d: 1200, kind: 'cold', enclosed: true, name: '通道' },
  },
  {
    type: 'vent', label: '风口', mode: 'point',
    props: { w: 600, d: 600, kind: '格栅', name: '风口' },
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
    type: 'battery', label: '蓄电池', mode: 'point',
    props: { w: 800, d: 800, h: 2000, name: '蓄电池' },
  },
  {
    type: 'extinguisher', label: '灭火器', mode: 'point',
    props: { w: 400, d: 400, h: 1200, name: '灭火器' },
  },
];

const TOOL_BY_TYPE = Object.fromEntries(TOOL_DEFS.map(t => [t.type, t]));

export const isPoint = (obj) => !!obj && obj.x !== undefined;
export const isLine = (obj) => !!obj && obj.x1 !== undefined && obj.x === undefined;

/** 对象在平面上的中心点（mm）。 */
export function centerOf(obj) {
  if (!obj) return null;
  if (isLine(obj)) {
    return { x: (Number(obj.x1) + Number(obj.x2)) / 2, y: (Number(obj.y1) + Number(obj.y2)) / 2 };
  }
  return { x: Number(obj.x) || 0, y: Number(obj.y) || 0 };
}

/** 开关洞宽度，取不到时按类型默认值。 */
export function openingWidth(obj) {
  const width = Number(obj?.props?.width);
  if (Number.isFinite(width) && width > 0) return width;
  return obj?.type === 'window' ? 1200 : 900;
}

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

const isStructural = (obj) => !!obj && STRUCTURAL_TYPES.has(obj.type);

export function createStore({ storage = globalThis.localStorage } = {}) {
  let project = blankProject();
  let selectedIds = [];
  let tool = null;
  let source = { id: null, name: '' };
  let savedSnapshot = JSON.stringify(project);
  let gesture = null;
  const undoStack = [];
  const redoStack = [];
  const listeners = new Set();

  const emit = (reason = 'change', detail = null) => {
    for (const fn of listeners) fn(reason, detail);
  };
  const snapshot = () => JSON.stringify(project);
  const dirty = () => snapshot() !== savedSnapshot;
  const find = (id) => project.objects.find(o => o.id === id) || null;
  const pruneSelection = () => {
    const alive = selectedIds.filter(id => project.objects.some(o => o.id === id));
    if (alive.length !== selectedIds.length) selectedIds = alive;
  };

  function pushUndo(snap) {
    undoStack.push(snap);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  }

  function commit(mutate, reason = 'model', detail = null) {
    pushUndo(snapshot());
    mutate(project);
    pruneSelection();
    emit(reason, detail);
  }

  function structuralDetail(changed) {
    const ids = changed.filter(Boolean).map(o => o.id);
    const walls = changed.filter(o => o && OPENING_TYPES.includes(o.type)).map(o => o.wallId);
    return {
      ids,
      structural: changed.some(isStructural),
      wallIds: [...new Set(walls.filter(Boolean))],
    };
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

  const draftKey = () => `${DRAFT_PREFIX}${source.id ?? 'new'}`;

  function readDraft(key = draftKey()) {
    if (!storage || !key) return null;
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || !data.project) return null;
      return data;
    } catch {
      return null;
    }
  }

  function writeDraft(key = draftKey()) {
    if (!storage || !key) return false;
    try {
      storage.setItem(key, JSON.stringify({
        savedAt: new Date().toISOString(),
        project: project,
        source: { ...source },
      }));
      return true;
    } catch {
      return false;
    }
  }

  function clearDraft(key = draftKey()) {
    if (!storage || !key) return;
    try {
      storage.removeItem(key);
    } catch {
      /* 隐私模式下可能禁用存储：草稿只是兜底，写不进去不影响编辑 */
    }
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    project: () => project,
    selection: () => [...selectedIds],
    selectedObjects: () => selectedIds.map(find).filter(Boolean),
    tool: () => tool,
    dirty,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    source: () => source,

    load(raw, meta = {}) {
      project = normalize(raw);
      source = { id: meta.id ?? null, name: meta.name || project.name };
      selectedIds = [];
      tool = null;
      gesture = null;
      undoStack.length = 0;
      redoStack.length = 0;
      savedSnapshot = snapshot();
      emit('load');
    },

    newProject({ name, width, depth, height, floorHeight }) {
      project = roomProject(name, width, depth, height, floorHeight);
      source = { id: null, name: project.name };
      selectedIds = [];
      tool = null;
      gesture = null;
      undoStack.length = 0;
      redoStack.length = 0;
      savedSnapshot = '';
      emit('load');
    },

    setTool(type) {
      tool = tool === type ? null : type;
      emit('tool');
    },

    /* ---------- 选择 ---------- */

    select(id, { additive = false } = {}) {
      if (!id) {
        if (!selectedIds.length) return;
        selectedIds = [];
        emit('selection');
        return;
      }
      if (additive) {
        selectedIds = selectedIds.includes(id)
          ? selectedIds.filter(item => item !== id)
          : [...selectedIds, id];
      } else {
        selectedIds = [id];
      }
      emit('selection');
    },

    selectMany(ids) {
      selectedIds = [...new Set((ids || []).filter(id => project.objects.some(o => o.id === id)))];
      emit('selection');
    },

    clearSelection() {
      if (!selectedIds.length) return;
      selectedIds = [];
      emit('selection');
    },

    /* ---------- 手势（拖动/开洞连续更新合成一次撤销） ---------- */

    beginGesture() {
      gesture = snapshot();
    },

    mutateLive(mutate, reason = 'preview', detail = null) {
      mutate(project);
      pruneSelection();
      emit(reason, detail);
    },

    endGesture(reason = 'model', detail = null) {
      const before = gesture;
      gesture = null;
      if (before === null) return;
      if (before === snapshot()) return;
      pushUndo(before);
      emit(reason, detail);
    },

    cancelGesture() {
      if (gesture === null) return;
      project = JSON.parse(gesture);
      gesture = null;
      pruneSelection();
      emit('restore');
    },

    /* ---------- 几何编辑 ---------- */

    setProjectName(name) {
      commit(p => { p.name = String(name).slice(0, 120); }, 'name');
    },

    setMeta(patch) {
      commit(p => { Object.assign(p.meta, patch); }, 'meta');
    },

    addPoint(type, x, y) {
      const def = TOOL_BY_TYPE[type];
      if (!def || def.mode !== 'point') return null;
      const obj = {
        id: uid(), type, x: Math.round(x), y: Math.round(y), rotation: 0,
        props: { ...def.props },
      };
      commit(p => { p.objects.push(obj); }, 'model', { ids: [obj.id], structural: false, wallIds: [] });
      selectedIds = [obj.id];
      emit('selection');
      return obj;
    },

    addLine(type, x1, y1, x2, y2, extra = {}) {
      const def = TOOL_BY_TYPE[type];
      if (!def || def.mode !== 'line') return null;
      if (Math.hypot(x2 - x1, y2 - y1) < 200) return null;
      const obj = {
        id: uid(), type,
        x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2),
        props: { ...def.props },
        ...extra,
      };
      commit(p => { p.objects.push(obj); });
      selectedIds = [obj.id];
      emit('selection');
      return obj;
    },

    /** 开洞：t 自动夹到洞口不越界；墙不存在或太短返回 null。 */
    addOpening(type, wallId, t) {
      const def = TOOL_BY_TYPE[type];
      if (!def || def.mode !== 'opening') return null;
      const wall = find(wallId);
      if (!wall || wall.type !== 'wall') return null;
      const width = def.props.width;
      const clamped = clampTOnWall(wall, width, t);
      if (clamped === null) return null;
      const obj = {
        id: uid(), type, wallId, t: Number(clamped.toFixed(5)), props: { ...def.props },
      };
      commit(p => { p.objects.push(obj); }, 'model', { ids: [obj.id], structural: false, wallIds: [wallId] });
      selectedIds = [obj.id];
      emit('selection');
      return obj;
    },

    /** 拖动开洞：不提交，由 endGesture 合成一次撤销。 */
    setOpeningT(id, t) {
      const obj = find(id);
      if (!obj || !OPENING_TYPES.includes(obj.type)) return null;
      const wall = find(obj.wallId);
      const clamped = clampTOnWall(wall, openingWidth(obj), t);
      if (clamped === null) return null;
      obj.t = Number(clamped.toFixed(5));
      emit('preview', { ids: [obj.id], structural: false, wallIds: [obj.wallId] });
      return obj.t;
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
      commit(p => { p.objects.push(...objects); }, 'model', {
        ids: objects.map(o => o.id), structural: false, wallIds: [],
      });
      selectedIds = [objects[0].id];
      emit('selection');
      return objects.length;
    },

    /** 直接位移一个对象（不提交撤销；拖动预览与批量移动都走这里）。 */
    translate(id, dx, dy) {
      const obj = find(id);
      if (!obj) return;
      if (isPoint(obj)) {
        obj.x = Math.round(obj.x + dx);
        obj.y = Math.round(obj.y + dy);
      } else if (isLine(obj)) {
        obj.x1 = Math.round(obj.x1 + dx);
        obj.y1 = Math.round(obj.y1 + dy);
        obj.x2 = Math.round(obj.x2 + dx);
        obj.y2 = Math.round(obj.y2 + dy);
      }
    },

    translateMany(ids, dx, dy, { commit: shouldCommit = true } = {}) {
      const targets = (ids || []).filter(id => find(id));
      if (!targets.length) return;
      const apply = (p) => {
        for (const id of targets) {
          const obj = p.objects.find(o => o.id === id);
          if (!obj) continue;
          if (isPoint(obj)) {
            obj.x = Math.round(obj.x + dx);
            obj.y = Math.round(obj.y + dy);
          } else if (isLine(obj)) {
            obj.x1 = Math.round(obj.x1 + dx);
            obj.y1 = Math.round(obj.y1 + dy);
            obj.x2 = Math.round(obj.x2 + dx);
            obj.y2 = Math.round(obj.y2 + dy);
          }
        }
      };
      if (shouldCommit) commit(apply, 'model', structuralDetail(targets));
      else apply(project);
    },

    updateObject(id, patch, { props = {} } = {}) {
      const target = find(id);
      if (!target) return;
      commit(p => {
        const obj = p.objects.find(o => o.id === id);
        if (!obj) return;
        Object.assign(obj, patch);
        obj.props = { ...(obj.props || {}), ...props };
      }, 'model', structuralDetail([target]));
    },

    rotate(id, delta = 90) {
      this.rotateMany([id], delta);
    },

    rotateMany(ids, delta = 90) {
      const targets = (ids || []).filter(id => isPoint(find(id)));
      if (!targets.length) return;
      commit(p => {
        for (const id of targets) {
          const obj = p.objects.find(o => o.id === id);
          if (obj) obj.rotation = ((Number(obj.rotation) || 0) + delta + 360) % 360;
        }
      }, 'model', { ids: targets, structural: false, wallIds: [] });
    },

    remove(id) {
      this.removeMany([id]);
    },

    removeMany(ids) {
      const targets = new Set((ids || []).filter(id => find(id)));
      if (!targets.size) return 0;
      // 删墙会连带删掉挂在它上面的开洞，否则会留下悬空引用。
      for (const obj of project.objects) {
        if (OPENING_TYPES.includes(obj.type) && targets.has(obj.wallId)) targets.add(obj.id);
      }
      commit(p => {
        p.objects = p.objects.filter(o => !targets.has(o.id));
      }, 'model', { ids: [...targets], structural: true, wallIds: [] });
      selectedIds = selectedIds.filter(id => !targets.has(id));
      emit('selection');
      return targets.size;
    },

    duplicate(id) {
      return this.duplicateMany([id])[0] || null;
    },

    duplicateMany(ids) {
      const originals = (ids || []).map(find).filter(Boolean);
      if (!originals.length) return [];
      const copies = originals.map((obj) => {
        const copy = JSON.parse(JSON.stringify(obj));
        copy.id = uid();
        if (isLine(copy)) {
          copy.x1 += 400; copy.x2 += 400;
        } else if (isPoint(copy)) {
          copy.x += 400;
        }
        if (copy.props?.name) copy.props.name = `${copy.props.name}-副本`;
        return copy;
      });
      commit(p => { p.objects.push(...copies); }, 'model', { ids: copies.map(c => c.id), structural: true, wallIds: [] });
      selectedIds = copies.map(c => c.id);
      emit('selection');
      return copies;
    },

    /** 对齐：minX|maxX|minY|maxY。线对象按包围盒边缘对齐。 */
    align(kind) {
      const objects = selectedIds.map(find).filter(o => o && (isPoint(o) || isLine(o)));
      if (objects.length < 2) return;
      const edges = (obj) => {
        if (isLine(obj)) {
          return {
            minX: Math.min(obj.x1, obj.x2), maxX: Math.max(obj.x1, obj.x2),
            minY: Math.min(obj.y1, obj.y2), maxY: Math.max(obj.y1, obj.y2),
          };
        }
        return { minX: obj.x, maxX: obj.x, minY: obj.y, maxY: obj.y };
      };
      const bounds = objects.map(edges);
      const target = kind.startsWith('min')
        ? Math.min(...bounds.map(b => (kind === 'minX' ? b.minX : b.minY)))
        : Math.max(...bounds.map(b => (kind === 'maxX' ? b.maxX : b.maxY)));
      commit(() => {
        objects.forEach((obj, index) => {
          const edge = bounds[index];
          if (kind === 'minX') this.translate(obj.id, target - edge.minX, 0);
          else if (kind === 'maxX') this.translate(obj.id, target - edge.maxX, 0);
          else if (kind === 'minY') this.translate(obj.id, 0, target - edge.minY);
          else this.translate(obj.id, 0, target - edge.maxY);
        });
      }, 'model', { ids: objects.map(o => o.id), structural: false, wallIds: [] });
    },

    /** 等距分布：首尾不动，中间按中心等距重排（至少 3 个对象）。 */
    distribute(axis) {
      const objects = selectedIds.map(find).filter(o => o && (isPoint(o) || isLine(o)));
      if (objects.length < 3) return;
      const key = axis === 'y' ? 'y' : 'x';
      const sorted = [...objects].sort((a, b) => centerOf(a)[key] - centerOf(b)[key]);
      const first = centerOf(sorted[0])[key];
      const last = centerOf(sorted[sorted.length - 1])[key];
      const step = (last - first) / (sorted.length - 1);
      commit(() => {
        sorted.forEach((obj, index) => {
          if (index === 0 || index === sorted.length - 1) return;
          const delta = first + step * index - centerOf(find(obj.id) || obj)[key];
          this.translate(obj.id, key === 'x' ? delta : 0, key === 'y' ? delta : 0);
        });
      }, 'model', { ids: sorted.map(o => o.id), structural: false, wallIds: [] });
    },

    undo() {
      if (!undoStack.length) return false;
      redoStack.push(snapshot());
      project = JSON.parse(undoStack.pop());
      pruneSelection();
      emit('restore');
      return true;
    },

    redo() {
      if (!redoStack.length) return false;
      undoStack.push(snapshot());
      project = JSON.parse(redoStack.pop());
      pruneSelection();
      emit('restore');
      return true;
    },

    markSaved(meta = {}) {
      const previousKey = draftKey();
      if (meta.id !== undefined) source = { id: meta.id, name: meta.name || project.name };
      savedSnapshot = snapshot();
      clearDraft(previousKey);
      if (draftKey() !== previousKey) clearDraft();
      emit('saved');
    },

    /** 把当前内容标成「未保存」（草稿恢复用）：不进撤销栈，只改脏标记。 */
    markUnsaved() {
      savedSnapshot = '';
      emit('dirty');
    },

    draftKey,
    readDraft,
    writeDraft,
    clearDraft,

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
