/**
 * 对象搜索规则（纯逻辑，无 DOM / 无 three，可直接 Node 单测）。
 *
 * 只查当前项目 JSON，不连后端：
 *   · 匹配 `props.name` 与对象 `id`，忽略大小写与首尾空白；
 *   · 精确匹配优先于前缀匹配，名称优先于 id；最多返回 10 条；
 *   · 结果按「精确名称 > 精确 ID > 名称前缀 > ID 前缀」排序，
 *     同分按命中文本长度、label 字典序、id 字典序、原始顺序稳定排序；
 *   · 空查询 / 含控制字符 / 超长查询返回空结果，不抛错。
 *
 * 真正的选中与聚焦由 UI 调用查看器门面完成，这里只负责“候选列表”。
 */

/** 搜索参数（结果上限写死 10，避免一次铺开整机房） */
export const SEARCH = Object.freeze({
  limit: 10,
  hardLimit: 10,
  maxQueryLen: 160,
  inputMaxLen: 64,
  minQueryLen: 1,
});

/** 结果排序权重（精确 > 前缀；名称 > id） */
export const SEARCH_SCORE = Object.freeze({
  nameExact: 1000,
  idExact: 950,
  namePrefix: 800,
  idPrefix: 750,
});

/** 对象类型显示名（与拾取浮层共用同一份字面量） */
const TYPE_NAMES = Object.freeze({
  wall: '墙体', door: '机房门', window: '窗', grille: '格栅', column: '柱子',
  beam: '框架梁', cabinet: '机柜', tray: '桥架', ceiling: '吊顶', aisle: '通道',
  ac: '空调', ups: 'UPS', battery: '蓄电池', extinguisher: '灭火器',
  vent: '地板出风口', pdu: '列头柜',
});

/** 对象显示名（props.name 去首尾空白；没有则空串） */
function objectName(obj) {
  const p = obj && obj.props;
  if (!p || p.name == null) return '';
  return String(p.name).trim();
}

/** 查询归一化：去首尾空格、拒绝空/超长/控制字符；非法返回 null */
function normalizeFocusQuery(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || s.length > SEARCH.maxQueryLen) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

/** 查询归一化：非法返回空串（UI 与测试共用同一入口） */
export function normalizeSearchQuery(value) {
  return normalizeFocusQuery(value) || '';
}

/** 类型显示名（未知类型回退原始 type，避免显示空白） */
export function typeLabelOf(type) {
  const t = type == null ? '' : String(type);
  return TYPE_NAMES[t] || t || '对象';
}

/**
 * 把项目对象转成搜索条目（保持输入只读；不复制 props）。
 * 没有名称也没有 id 的对象无法定位，直接跳过。
 * @param {Array} objects 当前项目对象
 * @returns {Array<{obj:object,index:number,id:string,name:string,label:string,
 *                  type:string,typeLabel:string,nameLower:string,idLower:string}>}
 */
export function buildSearchIndex(objects) {
  const list = Array.isArray(objects) ? objects : [];
  const entries = [];
  let index = 0;
  for (const obj of list) {
    if (!obj) continue;
    const id = obj.id == null ? '' : String(obj.id).trim();
    const name = objectName(obj);
    const i = index++;
    if (!id && !name) continue;
    const type = obj.type == null ? '' : String(obj.type);
    entries.push({
      obj, index: i, id, name,
      label: name || id,
      type,
      typeLabel: typeLabelOf(type),
      nameLower: name.toLowerCase(),
      idLower: id.toLowerCase(),
    });
  }
  return entries;
}

/** 结果上限归一化：1–10 的整数；非法回退默认 10 */
export function normalizeLimit(limit) {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return SEARCH.limit;
  return Math.min(SEARCH.hardLimit, n);
}

/**
 * 在已建索引里搜索（大小写不敏感；只做精确/前缀匹配）。
 * @param {Array} index buildSearchIndex 的结果
 * @param {string} query 用户输入
 * @param {{limit?:number}} [opts]
 * @returns {{query:string, limit:number, results:Array, total:number,
 *            truncated:boolean, empty:boolean}}
 */
export function searchIndex(index, query, opts = {}) {
  const q = normalizeSearchQuery(query);
  const limit = normalizeLimit(opts.limit);
  const out = { query: q, limit, results: [], total: 0, truncated: false, empty: !q };
  if (!q) return out;
  const ql = q.toLowerCase();
  const entries = Array.isArray(index) ? index : [];
  const hits = [];
  for (const e of entries) {
    if (!e) continue;
    let score = 0, via = null, mode = null, matched = '';
    if (e.nameLower && e.nameLower === ql) {
      score = SEARCH_SCORE.nameExact; via = 'name'; mode = 'exact'; matched = e.name;
    } else if (e.idLower && e.idLower === ql) {
      score = SEARCH_SCORE.idExact; via = 'id'; mode = 'exact'; matched = e.id;
    } else if (e.nameLower && e.nameLower.startsWith(ql)) {
      score = SEARCH_SCORE.namePrefix - Math.min(49, e.nameLower.length - ql.length);
      via = 'name'; mode = 'prefix'; matched = e.name;
    } else if (e.idLower && e.idLower.startsWith(ql)) {
      score = SEARCH_SCORE.idPrefix - Math.min(49, e.idLower.length - ql.length);
      via = 'id'; mode = 'prefix'; matched = e.id;
    } else {
      continue;
    }
    hits.push({
      obj: e.obj,
      index: e.index,
      id: e.id,
      name: e.name,
      label: e.label,
      type: e.type,
      typeLabel: e.typeLabel,
      score,
      via,
      mode,
      matched,
    });
  }
  out.total = hits.length;
  hits.sort((a, b) => b.score - a.score
    || a.matched.length - b.matched.length
    || a.label.localeCompare(b.label, 'zh-Hans-CN')
    || a.id.localeCompare(b.id)
    || a.index - b.index);
  out.results = hits.slice(0, limit);
  out.truncated = out.total > out.results.length;
  return out;
}

/**
 * 便捷入口：直接从项目对象搜索（UI 请缓存 buildSearchIndex 结果，避免每次输入重建）。
 * @param {Array} objects
 * @param {string} query
 * @param {{limit?:number}} [opts]
 */
export function searchObjects(objects, query, opts = {}) {
  return searchIndex(buildSearchIndex(objects), query, opts);
}

/**
 * 按查询拆分文本用于高亮（仅前缀匹配；大小写不敏感）。
 * 返回 text/hit 片段，UI 用 textContent 渲染以保证安全。
 * @returns {Array<{text:string, hit:boolean}>}
 */
export function matchSegments(text, query) {
  const s = text == null ? '' : String(text);
  if (!s) return [];
  const q = normalizeSearchQuery(query);
  if (!q) return [{ text: s, hit: false }];
  const lower = s.toLowerCase();
  const ql = q.toLowerCase();
  if (!lower.startsWith(ql)) return [{ text: s, hit: false }];
  const parts = [];
  if (s.slice(0, q.length)) parts.push({ text: s.slice(0, q.length), hit: true });
  if (s.slice(q.length)) parts.push({ text: s.slice(q.length), hit: false });
  return parts;
}

/** 状态栏文案（UI / 测试共用；不拼接 HTML） */
export function searchStatus(result) {
  const q = result && result.query ? String(result.query) : '';
  const count = result && Array.isArray(result.results) ? result.results.length : 0;
  if (!q) {
    return { kind: 'idle', text: '输入柜号 / 名称 / ID 定位对象', hint: '精确或前缀匹配 · 最多 10 条' };
  }
  if (!count) {
    const echo = q.length > 40 ? q.slice(0, 39) + '…' : q;
    return { kind: 'empty', text: '未找到 · ' + echo, hint: '试试完整柜号 / 名称 / ID' };
  }
  const total = Number.isFinite(result.total) ? result.total : count;
  if (result.truncated || total > count) {
    return {
      kind: 'more', text: `找到 ${total} 个 · 显示前 ${count} 个`,
      hint: '继续输入缩小范围 · ↑↓ 选择 · Enter 定位',
    };
  }
  return {
    kind: 'ok', text: `找到 ${count} 个结果`,
    hint: 'Enter 定位第一个 · ↑↓ 选择 · Esc 清空',
  };
}

/** 结果项的说明文案（类型 + 命中原因；ID 命中时显示 id） */
export function resultHint(result) {
  if (!result) return '';
  const type = result.typeLabel || typeLabelOf(result.type);
  if (result.via === 'id') {
    const id = result.id ? result.id : result.matched;
    return `${type} · ID ${id}`;
  }
  return `${type} · ${result.mode === 'exact' ? '名称精确' : '名称前缀'}`;
}
