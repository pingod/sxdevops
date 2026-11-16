/**
 * 分类显隐纯规则（附录 A §7 / 附录 D §1）：对象类型 → 分类 → 隐藏集合。
 *
 * 设计约定：
 *   · 只做对象级整组可见性，不改材质、不切几何、不写持久化；
 *   · 地板 floor / __floor 永远保留（隐藏后设备会悬空、失去空间参照）；
 *   · 门窗/格栅在场景构建时挂在墙体分组内，统一归入「围护」；
 *   · 未识别的顶层类型归入 other；空类型/地板返回 null（不参与显隐）；
 *   · 本模块不依赖 DOM / three，可直接 Node 单测。
 */

/** 分类顺序即 UI 顺序（也是 URL 序列化顺序） */
export const TYPE_GROUPS = Object.freeze([
  Object.freeze({
    id: 'cabinet', label: '机柜', ico: '▤', types: Object.freeze(['cabinet']),
    hint: '机柜 / 列头柜',
  }),
  Object.freeze({
    id: 'power', label: '配电', ico: '⚡', types: Object.freeze(['pdu', 'ups', 'battery']),
    hint: 'PDU / UPS / 电池',
  }),
  Object.freeze({
    id: 'cooling', label: '制冷', ico: '❄', types: Object.freeze(['ac', 'vent']),
    hint: '空调 / 通风',
  }),
  Object.freeze({
    id: 'safety', label: '消防', ico: '◉', types: Object.freeze(['extinguisher']),
    hint: '灭火器 / 消防设施',
  }),
  Object.freeze({
    id: 'aisle', label: '通道', ico: '▥', types: Object.freeze(['aisle']),
    hint: '冷通道 / 封闭通道',
  }),
  Object.freeze({
    id: 'tray', label: '桥架', ico: '⌁', types: Object.freeze(['tray']),
    hint: '桥架 / 走线架',
  }),
  Object.freeze({
    id: 'structure', label: '结构', ico: '╫', types: Object.freeze(['column', 'beam']),
    hint: '柱 / 梁',
  }),
  Object.freeze({
    id: 'wall', label: '围护', ico: '▯',
    types: Object.freeze(['wall', 'door', 'window', 'grille']),
    hint: '墙体 / 门 / 窗 / 格栅（门窗随墙分组）',
  }),
  Object.freeze({
    id: 'ceiling', label: '吊顶', ico: '▔', types: Object.freeze(['ceiling']),
    hint: '吊顶 / 顶棚',
  }),
  Object.freeze({
    id: 'other', label: '其它', ico: '◆', types: Object.freeze([]),
    hint: '未识别的对象类型',
  }),
]);

/** 分类 id 顺序（URL / 预设 / UI 共用） */
export const TYPE_ORDER = Object.freeze(TYPE_GROUPS.map(g => g.id));
export const TYPE_GROUP_BY_ID = Object.freeze(Object.fromEntries(TYPE_GROUPS.map(g => [g.id, g])));

/** 永远保留、不参与分类显隐的类型 */
export const ALWAYS_VISIBLE_TYPES = Object.freeze(['floor', '__floor']);

/** 已知类型 → 分类（other 由 categoryOf 兜底） */
const TYPE_TO_GROUP = Object.freeze((() => {
  const map = Object.create(null);
  for (const g of TYPE_GROUPS) for (const t of g.types) map[t] = g.id;
  return map;
})());

/** 设备类：只看设备预设保留的分类 */
export const DEVICE_GROUPS = Object.freeze(['cabinet', 'power', 'cooling', 'safety']);
/** 围护类：只看围护预设保留的分类（结构/吊顶是空间参照） */
export const ENVELOPE_GROUPS = Object.freeze(['wall', 'structure', 'ceiling']);
/** 顶架：最常用的「隐藏吊顶与桥架」 */
export const TOP_GROUPS = Object.freeze(['ceiling', 'tray']);

/** 预设（顺序即 UI 顺序） */
export const TYPE_PRESETS = Object.freeze([
  Object.freeze({ id: 'all', label: '全部显示', hint: '恢复全部类型', ico: '○' }),
  Object.freeze({ id: 'devices', label: '只看设备', hint: '隐藏围护 / 吊顶 / 桥架 / 结构', ico: '▤' }),
  Object.freeze({ id: 'envelope', label: '只看围护', hint: '隐藏设备 / 通道 / 桥架', ico: '▯' }),
  Object.freeze({ id: 'no-top', label: '隐藏顶架', hint: '隐藏吊顶与桥架', ico: '⌁' }),
]);
export const PRESET_IDS = Object.freeze(TYPE_PRESETS.map(p => p.id));
export const ALL_PRESET = 'all';
export const CUSTOM_PRESET = 'custom';

const norm = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const uniq = list => [...new Set(list)];

/**
 * 对象类型 → 分类 id；地板/空类型返回 null（不参与显隐）。
 * 未识别类型归入 other。
 * @param {string} type
 * @returns {string|null}
 */
export function categoryOf(type) {
  const t = norm(type);
  if (!t || ALWAYS_VISIBLE_TYPES.includes(t)) return null;
  return TYPE_TO_GROUP[t] || 'other';
}

/** 分类文案（未知 id 回退为 id 本身） */
export function categoryLabel(id) {
  const g = TYPE_GROUP_BY_ID[id];
  return g ? g.label : String(id == null ? '' : id);
}

/**
 * 当前场景实际存在的分类（含对象/分组数），顺序固定；不修改入参。
 * @param {object[]} objects 项目对象（兜底）
 * @param {{sceneTypes?:string[]}} [opts] sceneTypes = 场景顶层分组类型（更准确：
 *        已包含派生吊顶 __ceiling、且门窗不单独计数）；不传时按 objects 统计
 */
export function buildTypeCatalog(objects, opts = {}) {
  const counts = Object.create(null);
  const types = Object.create(null);
  let total = 0;
  const sceneTypes = Array.isArray(opts.sceneTypes) ? opts.sceneTypes : null;
  const list = sceneTypes
    ? sceneTypes.map(t => ({ type: t }))
    : (Array.isArray(objects) ? objects : []);
  for (const o of list) {
    if (!o || !o.type) continue;
    const cat = categoryOf(o.type);
    if (!cat) continue;
    counts[cat] = (counts[cat] || 0) + 1;
    types[cat] = types[cat] || Object.create(null);
    const t = norm(o.type);
    types[cat][t] = (types[cat][t] || 0) + 1;
    total++;
  }
  const items = TYPE_GROUPS
    .filter(g => (counts[g.id] || 0) > 0)
    .map(g => Object.freeze({
      id: g.id,
      label: g.label,
      ico: g.ico,
      hint: g.hint,
      types: Object.freeze(g.types.slice()),
      count: counts[g.id] || 0,
      typeCounts: Object.freeze({ ...(types[g.id] || {}) }),
    }));
  return Object.freeze({
    items: Object.freeze(items),
    total,
    counts: Object.freeze({ ...counts }),
    available: Object.freeze(items.map(i => i.id)),
  });
}

/** 项目里存在、且可以参与显隐的分类 id（floor 永远不出现） */
export function availableGroups(catalog) {
  if (catalog && Array.isArray(catalog.items)) return catalog.items.map(i => i.id);
  return TYPE_ORDER.slice();
}

/**
 * 归一化隐藏集合：支持字符串（逗号/空格分隔）、数组、Set。
 * 只保留已知分类 id，去重并按 TYPE_ORDER 排序；floor/未知值丢弃。
 * @returns {string[]}
 */
export function normalizeHidden(value) {
  const raw = [];
  const push = v => {
    if (typeof v === 'string') raw.push(...v.split(/[,\s]+/));
    else if (v != null) raw.push(String(v));
  };
  if (Array.isArray(value) || value instanceof Set) {
    for (const v of value) push(v);
  } else if (value != null) {
    push(value);
  }
  const seen = new Set();
  for (const v of raw) {
    const id = norm(v);
    if (TYPE_GROUP_BY_ID[id]) seen.add(id);
  }
  return TYPE_ORDER.filter(id => seen.has(id));
}

/**
 * 解析 URL 的 hide 参数：返回有效分类与无法识别的 token（用于 issues）。
 * @param {string|null|undefined} value
 * @returns {{hidden:string[], unknown:string[]}}
 */
export function parseHiddenParam(value) {
  const hidden = normalizeHidden(value);
  const known = new Set(TYPE_ORDER);
  const unknown = uniq(
    String(value == null ? '' : value)
      .split(/[,\s]+/)
      .map(norm)
      .filter(v => v && !known.has(v)),
  );
  return { hidden, unknown };
}

/** 序列化隐藏集合（按分类顺序，省略空值） */
export function serializeHidden(value) {
  return normalizeHidden(value).join(',');
}

/** 隐藏集合里是否包含某个分类 */
export function isHiddenGroup(hidden, id) {
  return normalizeHidden(hidden).includes(norm(id));
}

/** 某个对象类型是否被当前隐藏集合隐藏（floor 永远 false） */
export function isTypeHidden(type, hidden) {
  const cat = categoryOf(type);
  if (!cat) return false;
  return normalizeHidden(hidden).includes(cat);
}

/** 隐藏集合展开成原始类型集合（用于自检/说明；other 不展开） */
export function hiddenTypes(hidden) {
  const out = [];
  for (const id of normalizeHidden(hidden)) {
    const g = TYPE_GROUP_BY_ID[id];
    if (g) out.push(...g.types);
  }
  return uniq(out);
}

/**
 * 预设 → 隐藏分类集合。
 * 只按当前项目实际存在的分类计算（all 永远为空）。
 * @param {string} preset
 * @param {object|null} catalog buildTypeCatalog 结果
 * @returns {string[]}
 */
export function presetHidden(preset, catalog) {
  const id = norm(preset);
  const available = availableGroups(catalog);
  if (id === ALL_PRESET) return [];
  if (id === 'devices') return available.filter(g => !DEVICE_GROUPS.includes(g));
  if (id === 'envelope') return available.filter(g => !ENVELOPE_GROUPS.includes(g));
  if (id === 'no-top') return available.filter(g => TOP_GROUPS.includes(g));
  return [];
}

/** 当前隐藏集合最接近哪个预设（完全一致才算；否则 custom） */
export function matchPreset(hidden, catalog) {
  const set = normalizeHidden(hidden);
  const eq = list => list.length === set.length && list.every((v, i) => v === set[i]);
  for (const p of TYPE_PRESETS) {
    if (eq(presetHidden(p.id, catalog))) return p.id;
  }
  return CUSTOM_PRESET;
}

/** 预设文案 */
export function presetLabel(id) {
  const p = TYPE_PRESETS.find(x => x.id === id);
  return p ? p.label : (id === CUSTOM_PRESET ? '自定义' : '全部显示');
}

/**
 * 分类状态摘要（UI / info 共用，纯数据）。
 * @param {object} catalog
 * @param {string[]} hidden
 */
export function typeVisPlan(catalog, hidden) {
  const set = normalizeHidden(hidden);
  const source = (catalog && catalog.items) || [];
  const items = availableGroups(catalog).map(id => {
    const src = source.find(i => i.id === id) || TYPE_GROUP_BY_ID[id] || { id };
    return {
      id,
      label: src.label || categoryLabel(id),
      ico: src.ico || '◆',
      hint: src.hint || '',
      count: src.count || 0,
      types: (src.types || []).slice(),
      hidden: set.includes(id),
    };
  });
  const hiddenItems = items.filter(i => i.hidden);
  const hiddenObjects = hiddenItems.reduce((n, i) => n + i.count, 0);
  const preset = matchPreset(set, catalog);
  return {
    active: set.length > 0,
    hidden: set.slice(),
    hiddenTypes: hiddenTypes(set),
    preset,
    presetLabel: presetLabel(preset),
    label: labelOf(set, hiddenItems, hiddenObjects),
    items,
    counts: {
      totalCategories: items.length,
      hiddenCategories: hiddenItems.length,
      totalObjects: items.reduce((n, i) => n + i.count, 0),
      hiddenObjects,
    },
  };
}

/** 状态文案：全部显示 / 已隐藏「吊顶、桥架」· 41 个对象 */
function labelOf(set, hiddenItems, hiddenObjects) {
  if (!set.length) return '全部显示';
  const names = hiddenItems.map(i => i.label).join('、');
  if (!names) return '已隐藏 ' + set.map(categoryLabel).join('、');
  return '已隐藏 ' + names + ' · ' + hiddenObjects + ' 个对象';
}

/** 简短的读屏/上下文文案 */
export function summarizeTypeVis(info) {
  if (!info || !info.active || !info.hidden.length) return '全部分类显示';
  const names = (info.items || []).filter(i => i.hidden).map(i => i.label);
  return '已隐藏：' + (names.length ? names.join('、') : info.hidden.map(categoryLabel).join('、'));
}
