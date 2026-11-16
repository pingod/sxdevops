/**
 * 方案对比的纯数据层：按稳定 id 对比两个项目 JSON，给出新增 / 删除 / 移动 / 属性变化。
 *
 * 约定：
 *   · A = 基准方案，B = 对比方案；只比真实 JSON，不伪造配置；
 *   · 对象身份只认 id：缺少稳定 id 的对象会同时落成新增 + 删除；
 *   · 位置字段（x/y/x1/y1/x2/y2/t/rotation/wallId）变化 → 移动；
 *     其它属性变化 → 属性变化；同一对象既移动又改属性时只计「移动」，
 *     但 changes 里仍保留全部字段，UI 不丢信息；
 *   · 容差默认 0.5mm：坐标取整/导出误差不产生噪声；属性数值沿用同一容差；
 *   · 纯函数、不依赖 DOM / three，可直接 Node 单测。
 */

/** 差异类型（顺序 = 图例顺序；same 不进图例） */
export const DIFF_ORDER = Object.freeze(['added', 'removed', 'moved', 'changed']);

/** 差异文案与默认颜色 */
export const DIFF_META = Object.freeze({
  added: Object.freeze({ label: '新增', hint: 'B 有 · A 无', color: '#22c55e' }),
  removed: Object.freeze({ label: '删除', hint: 'A 有 · B 无', color: '#ef4444' }),
  moved: Object.freeze({ label: '移动', hint: '位置 / 朝向变化', color: '#f59e0b' }),
  changed: Object.freeze({ label: '属性变化', hint: '尺寸 / 参数 / 名称', color: '#8b5cf6' }),
  same: Object.freeze({ label: '相同', hint: '未变化', color: '#94a3b8' }),
});

/** 位置字段：任一变化判为 moved（type 单独判 changed） */
export const PLACEMENT_KEYS = Object.freeze([
  'x', 'y', 'rotation', 'x1', 'y1', 'x2', 'y2', 't', 'wallId',
]);

const DEFAULT_EPS = 0.5;
const MAX_ITEMS = 100000; // 防异常 JSON 把页面拖死（远大于实际机房规模）

/** 数值统一按 0 处理（与数据清洗的数值白名单一致） */
function num(v) {
  const n = +v;
  return Number.isFinite(n) ? n : 0;
}

/** 名称：props.name 优先，其次 id（与拾取浮层/搜索一致） */
export function objectName(o) {
  if (!o) return '';
  const n = o && o.props && o.props.name;
  return n != null && String(n).trim() !== '' ? String(n) : String(o.id || '');
}

/** 对象摘要（UI/自检用，不含 three 对象） */
export function objectSummary(o) {
  if (!o) return null;
  return {
    id: o.id == null ? null : String(o.id),
    type: o.type == null ? null : String(o.type),
    name: objectName(o),
  };
}

/** 位置快照：缺省数值按 0、wallId 归一为字符串/null */
export function placementOf(o) {
  const src = o || {};
  return {
    x: num(src.x), y: num(src.y), rotation: num(src.rotation),
    x1: num(src.x1), y1: num(src.y1), x2: num(src.x2), y2: num(src.y2),
    t: num(src.t),
    wallId: src.wallId == null ? null : String(src.wallId),
  };
}

/** 两个位置快照的差异字段（数值容差 eps；wallId 精确比较） */
export function placementChanges(a, b, eps = DEFAULT_EPS) {
  const pa = placementOf(a), pb = placementOf(b);
  const e = Math.abs(Number.isFinite(+eps) ? +eps : DEFAULT_EPS);
  const out = [];
  for (const k of PLACEMENT_KEYS) {
    if (k === 'wallId') {
      if (pa.wallId !== pb.wallId) out.push(k);
    } else if (Math.abs(pa[k] - pb[k]) > e) out.push(k);
  }
  return out;
}

/** 深比较（对象键排序；数值容差 eps） */
export function deepEqual(a, b, eps = DEFAULT_EPS) {
  const e = Math.abs(Number.isFinite(+eps) ? +eps : DEFAULT_EPS);
  const walk = (x, y) => {
    if (x === y) return true;
    if (typeof x === 'number' && typeof y === 'number') {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return String(x) === String(y);
      return Math.abs(x - y) <= e;
    }
    if (x == null || y == null) return x == null && y == null;
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (!walk(x[i], y[i])) return false;
      return true;
    }
    if (typeof x === 'object' || typeof y === 'object') {
      if (typeof x !== 'object' || typeof y !== 'object') return false;
      const kx = Object.keys(x).filter(k => x[k] !== undefined).sort();
      const ky = Object.keys(y).filter(k => y[k] !== undefined).sort();
      if (kx.length !== ky.length) return false;
      for (let i = 0; i < kx.length; i++) {
        if (kx[i] !== ky[i]) return false;
        if (!walk(x[kx[i]], y[ky[i]])) return false;
      }
      return true;
    }
    return false;
  };
  return walk(a, b);
}

/** props / 其它顶层字段的变化（不含 id/type/props 与位置字段） */
export function propertyChanges(a, b, eps = DEFAULT_EPS) {
  const out = [];
  const pa = (a && a.props) || {};
  const pb = (b && b.props) || {};
  const keys = [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort();
  for (const k of keys) {
    if (!deepEqual(pa[k], pb[k], eps)) {
      out.push({ field: 'props.' + k, from: pa[k], to: pb[k] });
    }
  }
  const skip = new Set(['id', 'type', 'props', ...PLACEMENT_KEYS]);
  const ka = Object.keys(a || {}).filter(k => !skip.has(k) && a[k] !== undefined).sort();
  const kb = Object.keys(b || {}).filter(k => !skip.has(k) && b[k] !== undefined).sort();
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b || {}, k) || !deepEqual(a[k], b[k], eps)) {
      out.push({ field: k, from: a[k], to: b == null ? undefined : b[k] });
    }
  }
  for (const k of kb) {
    if (!Object.prototype.hasOwnProperty.call(a || {}, k)) {
      out.push({ field: k, from: undefined, to: b[k] });
    }
  }
  return out;
}

/** 从项目对象数组建立 id → 对象索引（重复 id 保留第一个并记入 duplicateIds） */
export function indexObjects(project) {
  const list = project && Array.isArray(project.objects) ? project.objects : [];
  const map = new Map();
  const duplicateIds = [];
  for (const o of list) {
    if (!o || o.id == null || String(o.id) === '') continue;
    const id = String(o.id);
    if (map.has(id)) { duplicateIds.push(id); continue; }
    map.set(id, o);
  }
  return { map, duplicateIds: [...new Set(duplicateIds)], count: map.size, rawCount: list.length };
}

/** 该差异类型是否应在某一侧高亮显示 */
export function isVisibleKind(side, kind) {
  if (kind === 'same') return false;
  if (side === 'a') return kind === 'removed' || kind === 'moved' || kind === 'changed';
  if (side === 'b') return kind === 'added' || kind === 'moved' || kind === 'changed';
  return false;
}

/** 某一侧参与高亮的差异类型（固定顺序，UI 图例用） */
export function visibleKinds(side) {
  return DIFF_ORDER.filter(k => isVisibleKind(side, k));
}

/** 比较两个项目：返回 counts / items / changes / get(id) / 摘要 */
export function compareProjects(a, b, opts = {}) {
  const eps = Number.isFinite(+opts.eps) ? Math.abs(+opts.eps) : DEFAULT_EPS;
  const A = indexObjects(a);
  const B = indexObjects(b);

  const counts = { added: 0, removed: 0, moved: 0, changed: 0, same: 0, total: 0 };
  const items = [];
  const byId = Object.create(null);
  const seen = new Set();

  const push = item => {
    if (items.length >= MAX_ITEMS) return;
    items.push(item);
    if (item.id != null) byId[item.id] = item;
  };

  // A 顺序：共同对象 + 删除；B 顺序补充新增，输出顺序稳定、可复现
  for (const [id, oa] of A.map) {
    const ob = B.map.get(id);
    if (!ob) {
      const item = {
        id, kind: 'removed', type: objectSummary(oa).type, name: objectName(oa),
        a: objectSummary(oa), b: null, changes: [],
      };
      counts.removed++; counts.total++; push(item);
      continue;
    }
    const typeChanged = String(oa.type || '') !== String(ob.type || '');
    seen.add(id);
    const movedFields = placementChanges(oa, ob, eps);
    const props = propertyChanges(oa, ob, eps);
    let kind = 'same';
    if (typeChanged || props.length) kind = 'changed';
    if (movedFields.length) kind = 'moved'; // 位置变化优先于属性变化（仍保留 changes）
    const changes = [
      ...movedFields.map(f => ({ field: f, from: oa[f], to: ob[f] })),
      ...(typeChanged ? [{ field: 'type', from: oa.type, to: ob.type }] : []),
      ...props,
    ];
    if (kind === 'moved') counts.moved++;
    else if (kind === 'changed') counts.changed++;
    else counts.same++;
    counts.total++;
    push({
      id, kind, type: objectSummary(ob).type, name: objectName(ob),
      a: objectSummary(oa), b: objectSummary(ob), changes,
    });
  }
  for (const [id, ob] of B.map) {
    if (seen.has(id)) continue;
    const item = {
      id, kind: 'added', type: objectSummary(ob).type, name: objectName(ob),
      a: null, b: objectSummary(ob), changes: [],
    };
    counts.added++; counts.total++; push(item);
  }

  const changes = items.filter(i => i.kind !== 'same');
  const duplicateIds = [...new Set([...A.duplicateIds, ...B.duplicateIds])];
  return {
    a: { name: (a && a.name) || '', count: A.count, rawCount: A.rawCount },
    b: { name: (b && b.name) || '', count: B.count, rawCount: B.rawCount },
    eps,
    counts,
    items,
    changes,
    byId,
    duplicateIds,
    get: id => (id == null ? null : byId[String(id)] || null),
  };
}

/** 单行摘要（日志/自检/标题提示用） */
export function summarizeDiff(diff) {
  const c = (diff && diff.counts) || { added: 0, removed: 0, moved: 0, changed: 0, same: 0, total: 0 };
  return `新增 ${c.added} · 删除 ${c.removed} · 移动 ${c.moved} · 属性 ${c.changed} · 相同 ${c.same}`;
}
