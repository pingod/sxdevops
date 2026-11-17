/** 提交到 nVisual Studio —— 纯逻辑核心（不依赖 DOM，可 Node 单测）
 *
 * 场景：DCDesigner 完成机房工勘平面建模后，把成果一键回传 nVisual Studio 资源库。
 *
 * 接口（nVisual Studio 服务端 MigrationController.importSurvey）：
 *   POST {url}/diagramApi/wapi/v1/migration/import_survey?diagramId={视图节点ID}
 *   Content-Type: multipart/form-data —— 唯一文件字段 file，内容为**本工具导出的工勘 JSON**
 *     （与保存文件同格式：{ name, meta, objects:[…] }，单位毫米、西南角为原点）
 *   鉴权 Authorization: Bearer {API Key}（平台 API Key 即带 apiKey 声明的 JWT）；
 *   响应 { code:200, message, data:{ roomId, roomName, counts, racks, skipped, warnings } }，
 *   失败同样以 200 返回但 code=400/500 或平台错误码（如 800119 目标图非空）。
 *   平台侧映射：机柜/列头柜（含 PDU 电源）、UPS/蓄电池/灭火器/空调、墙/门/窗/柱/格栅/风口、
 *   桥架、通道；未识别的工勘类型记入 skipped（如框架梁 beam）。
 *
 * 请求统一经本机服务 POST /api/nvisual 代理转发（浏览器不发跨域请求、不会报 CORS 错），
 * 由运行本页面的 Node/Go 服务在服务端把该 JSON 组装成 multipart 表单并发出；
 * 凭据（API Key）随请求体内存转发，服务端不落盘、不记日志。
 *
 * 口径（固定，减少用户选择）：
 *   · 上传内容 = 项目 JSON 的深拷贝，经与「保存」同一套清洗（sanitize）后发送（不改动页面数据）；
 *   · 文件名 = 机房名 + 勘测日期（YYYYMMDD）+ .json（如 CFD-TEST20261005.json，非 ASCII 字符由代理按 RFC 5987 编码）；
 *   · diagramId = nVisual Studio 视图节点 ID（页面只记住它，不再让用户每次输入）。
 */

import { sanitize } from './state.js';
import { objOutline, beamEnds } from './geo.js';
import { apiUrl } from './api-base.js';

/** 配置存储键（平台地址 / API Key / 视图节点 ID 只存本浏览器 localStorage） */
export const CFG_KEY = 'idc2d_nvisual_v1';
/** 工勘导入接口路径（相对 nVisual Studio 平台地址） */
export const SURVEY_API_PATH = '/diagramApi/wapi/v1/migration/import_survey';
/** 请求超时（毫秒；服务端代理同口径限制） */
export const REQ_TIMEOUT_MS = 60000;

/** 类型 → 固定中文名（对话框统计展示用；不随界面语言变化） */
export const KIND_NAMES = {
  wall: '墙体', door: '机房门', window: '窗', grille: '格栅', column: '柱子', beam: '框架梁',
  ceiling: '吊顶', cabinet: '机柜', tray: '桥架', aisle: '通道', ac: '空调', ups: 'UPS',
  battery: '蓄电池', extinguisher: '灭火器', vent: '地板出风口', pdu: '列头柜', dbox: '配电箱',
};

/** 设备类（矩形对象，含配电箱；平台支持情况另见 SUPPORTED_KINDS） */
export const DEVICE_KINDS = ['cabinet', 'pdu', 'dbox', 'ups', 'battery', 'ac', 'extinguisher', 'vent'];
/** 线段类图形构件：墙体/桥架/框架梁 */
export const LINE_KINDS = ['wall', 'tray', 'beam'];
/** 矩形类图形构件：柱子/通道 */
export const RECT_KINDS = ['column', 'aisle'];
/** 挂墙洞口：机房门/窗/格栅 */
export const OPENING_KINDS = ['door', 'window', 'grille'];
/** 平台 import_survey 已支持的类型（其余类型平台记入 skipped，对话框提前提示）。
 * 配电箱 dbox 支持尚未联调确认，不冒充已支持；上传 JSON 仍完整保留对象。 */
export const SUPPORTED_KINDS = new Set([
  'cabinet', 'pdu', 'ups', 'battery', 'ac', 'extinguisher', 'vent',
  'wall', 'door', 'window', 'grille', 'column', 'tray', 'aisle',
]);

/* ══════════════════════════ 一、配置（localStorage，仅本浏览器） ══════════════════════════ */

/** 读取已保存配置（无/损坏时回退空配置） */
export function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
    return {
      url: typeof c.url === 'string' ? c.url : '',
      apiKey: typeof c.apiKey === 'string' ? c.apiKey : '',
      diagramId: c.diagramId == null ? '' : String(c.diagramId),
    };
  } catch (e) {
    return { url: '', apiKey: '', diagramId: '' };
  }
}

/** 保存配置（隐私模式等写失败不阻断使用） */
export function saveCfg(cfg) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify({
      url: cfg.url || '', apiKey: cfg.apiKey || '', diagramId: cfg.diagramId == null ? '' : String(cfg.diagramId),
    }));
  } catch (e) { /* 忽略 */ }
}

/** 规范化平台地址：无协议自动补 http://，去末尾斜杠；无法解析为 http(s) 返回 null */
export function normalizeUrl(raw) {
  let u = String(raw ?? '').trim();
  if (!u) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = 'http://' + u;
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    return x.origin + (x.pathname === '/' ? '' : x.pathname.replace(/\/+$/, ''));
  } catch (e) {
    return null;
  }
}

/** 视图节点 ID：nVisual Studio 的节点 ID 为长整型数字；非数字返回 null */
export function normalizeDiagramId(raw) {
  const s = String(raw ?? '').replace(/[\s,，]/g, '');
  return /^\d{1,20}$/.test(s) ? s : null;
}

/** API Key 形如 JWT 但签名段短于其算法应有长度（复制/粘贴被截断）时返回
 * {sigLen, need, alg}，否则 null（避免残缺 token 造成平台 token_error）。 */
export function truncatedJwt(key) {
  const m = /^(eyJ[A-Za-z0-9_-]*)\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  let alg = '';
  try {
    const json = typeof atob === 'function' ? atob(m[1].replace(/-/g, '+').replace(/_/g, '/')) : '';
    alg = String(JSON.parse(json).alg || '');
  } catch (e) { return null; }
  const NEED = { HS256: 43, HS384: 64, HS512: 86, ES256: 86, ES384: 128, ES512: 176, RS256: 342, RS384: 342, RS512: 342, PS256: 342, PS384: 342, PS512: 342 };
  const need = NEED[alg] || 43;
  return m[3].length < need ? { sigLen: m[3].length, need, alg: alg || '未知' } : null;
}

/* ══════════════════════════ 二、上传数据与预览统计（纯函数） ══════════════════════════ */

const num = (v, d = 0) => { const n = +v; return Number.isFinite(n) ? n : d; };

/** 墙体围合的房间净包围盒（内边）；墙体不足 3 段返回 null（与 agent.js 的 roomInnerBBox 同口径） */
export function roomInnerBBox(objects) {
  const walls = (objects || []).filter(o => o && o.type === 'wall');
  if (walls.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, th = 0;
  for (const w of walls) {
    minX = Math.min(minX, num(w.x1), num(w.x2));
    maxX = Math.max(maxX, num(w.x1), num(w.x2));
    minY = Math.min(minY, num(w.y1), num(w.y2));
    maxY = Math.max(maxY, num(w.y1), num(w.y2));
    th = Math.max(th, num(w.props && w.props.thickness, 240));
  }
  if (!(maxX > minX && maxY > minY)) return null;
  const r = { minX: minX + th / 2, minY: minY + th / 2, maxX: maxX - th / 2, maxY: maxY - th / 2 };
  return (r.maxX > r.minX && r.maxY > r.minY) ? r : null;
}

/** 全对象（含外轮廓外扩）世界包围盒；无有效对象返回 null */
export function objectsBBox(objects, resolve) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (const o of objects || []) {
    const poly = objOutline(o, resolve);
    if (!poly) continue;
    any = true;
    for (const p of poly) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

/** 统计：各类型数量 + 机柜总功率（kW，与向导/自检同口径） */
export function summarize(objects) {
  const byKind = {};
  let powerKW = 0;
  for (const o of objects || []) {
    byKind[o.type] = (byKind[o.type] || 0) + 1;
    if (o.type === 'cabinet') powerKW += num(o.props && o.props.power);
  }
  return { byKind, powerKW: +powerKW.toFixed(1) };
}

/**
 * 上传内容：项目 JSON 深拷贝（只保留 name / meta / objects，与保存文件同形），
 * 经与「保存」同一套清洗（sanitize：剔除无效对象与失墙门窗、数值强转、旧字段迁移）后返回。
 * 纯函数：不改动页面中的项目数据。
 */
export function buildSurveyPayload(project) {
  const src = project && typeof project === 'object' ? project : {};
  const copy = {
    name: String(src.name || ''),
    meta: src.meta && typeof src.meta === 'object' ? JSON.parse(JSON.stringify(src.meta)) : { surveyor: '', date: '' },
    objects: Array.isArray(src.objects) ? JSON.parse(JSON.stringify(src.objects)) : [],
  };
  try { sanitize(copy); } catch (e) { /* 清洗失败（脏数据）：原样提交，平台侧自行容错 */ }
  return copy;
}

/** 对话框预览统计：房间净尺寸 / 设备 / 图形构件 / 挂墙洞口 / 机柜功率 / 逐类型数量 / 平台不支持的类型。
 * 统计口径与上传内容一致（同一套清洗：失墙门窗、无效对象不计），所见即所提交。 */
export function surveyStats(project) {
  const objects = buildSurveyPayload(project).objects;
  const byId = new Map(objects.map(o => [o.id, o]));
  const inner = roomInnerBBox(objects);
  const walls = objects.filter(o => o.type === 'wall');
  const stat = summarize(objects);
  const count = kinds => objects.filter(o => kinds.includes(o.type)).length;
  const unsupported = Object.entries(stat.byKind)
    .filter(([k]) => !SUPPORTED_KINDS.has(k))
    .map(([k, n]) => ({ type: k, kindName: KIND_NAMES[k] || k, count: n }));
  return {
    room: inner ? {
      width: Math.round(inner.maxX - inner.minX),
      depth: Math.round(inner.maxY - inner.minY),
      height: walls.reduce((m, w) => Math.max(m, num(w.props && w.props.height)), 0) || 3000,
    } : null,
    devices: count(DEVICE_KINDS),
    shapes: count(LINE_KINDS.concat(RECT_KINDS)),
    openings: count(OPENING_KINDS),
    cabinets: stat.byKind.cabinet || 0,
    powerKW: stat.powerKW,
    byKind: stat.byKind,
    unsupported,
    bbox: objectsBBox(objects, id => byId.get(id)),
  };
}

/** 上传文件名：机房名 + 勘测日期（YYYYMMDD）+ .json（如 CFD-TEST20261005.json）。
 * 非法文件名字符替换为 '-'，无名称回退 survey；日期取项目勘测日期，缺失/非法则取当天。 */
export function buildSurveyFilename(project, now = new Date()) {
  const meta = (project && project.meta) || {};
  const m = /(\d{4})\D?(\d{2})\D?(\d{2})/.exec(String(meta.date || '').trim());
  const ymd = m ? m[1] + m[2] + m[3]
    : `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const name = String((project && project.name) || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '-').replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${name || 'survey'}${ymd}.json`.slice(0, 120);
}

/* ══════════════════════════ 三、请求（固定经本机服务 /api/nvisual 代理） ══════════════════════════ */

/** 带类型的请求错误：kind 用于区分失败原因（network/proxy/api=平台业务错误/viewBusy=目标视图非空防覆盖守卫/http/parse）
 *  code/message 等附加信息由 extra 带入（如平台错误码），便于 UI 做针对性提示。 */
export class NvRequestError extends Error {
  constructor(message, kind, extra) {
    super(message);
    this.kind = kind;
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

/** 目标视图非空（平台防覆盖守卫，不是接口故障）：错误码 800119，或提示语明确为“当前视图已有对象 / 请新建视图” */
export function isViewBusy(code, message) {
  if (Number(code) === 800119) return true;
  return /there are objects in the current view|create a new view|delete the current view objects|current view (?:is|has)|当前视图(?:中|下)?(?:已|存在)|目标图(?:中|下)?(?:已|存在)|已有对象/i
    .test(String(message || ''));
}

function withTimeout(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

async function fetchJson(url, init) {
  const timer = withTimeout(REQ_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...init, signal: timer.signal });
  } catch (e) {
    throw new NvRequestError(e && e.name === 'AbortError'
      ? `请求超时（${Math.round(REQ_TIMEOUT_MS / 1000)} 秒）`
      : `无法连接（${(e && e.message) || e}）`, 'network');
  } finally {
    timer.done();
  }
  let text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  if (!res.ok) {
    // HTTP 层错误也做一次“目标视图非空”识别：部分部署把防覆盖守卫放成 4xx/5xx + 同一句提示
    let msg = text ? text.slice(0, 300) : '', bizCode = null;
    try {
      const j = JSON.parse(text);
      if (j && typeof j === 'object' && (j.message || j.msg)) { msg = String(j.message || j.msg); bizCode = Number(j.code); }
    } catch (e) { /* 非 JSON：保留原文 */ }
    const busy = isViewBusy(bizCode, msg);
    throw new NvRequestError(`HTTP ${res.status}${msg ? '：' + msg : ''}`, busy ? 'viewBusy' : 'http', { code: bizCode });
  }
  try { return JSON.parse(text); }
  catch (e) { throw new NvRequestError(`响应不是 JSON：${text.slice(0, 200)}`, 'parse'); }
}

/** 代理不可用（而非 nVisual 业务错误）：同源网络失败 / 响应非 JSON（静态托管返回 index.html 等）/ 代理路由缺失 404、405 */
const proxyUnavailable = e =>
  e instanceof NvRequestError &&
  (e.kind === 'network' || e.kind === 'parse' || (e.kind === 'http' && /^HTTP (404|405)\b/.test(e.message)));

/**
 * 提交工勘 JSON 到 nVisual Studio（统一经本机服务 /api/nvisual 代理，浏览器不发跨域请求）。
 * 代理在服务端把 body 组装为 multipart/form-data（文件字段 file）并带上 diagramId 查询参数，
 * 鉴权头 Authorization: Bearer / X-Api-Key 同样由代理注入。
 * 平台业务错误（HTTP 200 但 code≠200）抛出 NvRequestError(kind='api'，UI 直接展示 message）；
 * 目标视图非空（防覆盖守卫，如 800119）抛 kind='viewBusy'，由 UI 给“换空视图/清空视图”的友好说明。
 * @returns {Promise<object>} nVisual 响应 { code, message, data }
 */
export async function postDcSync(cfg, payload, filename) {
  const diagramId = normalizeDiagramId(cfg.diagramId) || String(cfg.diagramId || '').trim();
  const envelope = {
    url: cfg.url,
    apiKey: cfg.apiKey,
    path: SURVEY_API_PATH,
    query: 'diagramId=' + encodeURIComponent(diagramId),
    filename: filename || 'survey.json',
    body: payload,
  };
  let res;
  try {
    res = await fetchJson(apiUrl('/api/nvisual'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
  } catch (e) {
    if (proxyUnavailable(e)) {
      throw new NvRequestError('本机服务未提供 /api/nvisual 代理：请用 node server.js 或 DCDesigner.exe 启动本工具后再提交（浏览器直连 nVisual 会因未开放跨域 CORS 被拦截）', 'proxy');
    }
    throw e;
  }
  const code = Number(res && res.code);
  if (Number.isFinite(code) && code !== 200) {
    const msg = String((res && res.message) || '').trim();
    // 目标视图非空是平台的防覆盖守卫（800119 等）：单独归类，UI 给可操作的友好说明而非“接口错误”
    const busy = isViewBusy(code, msg);
    throw new NvRequestError(msg || `平台返回错误码 ${code}`, busy ? 'viewBusy' : 'api', { code });
  }
  return res;
}

/** 从 nVisual 响应里取导入结果（缺字段/结构不符时返回 null，UI 用通用成功文案兜底） */
export function syncResultStats(res) {
  const d = res && res.data;
  if (!d || typeof d !== 'object') return null;
  const counts = d.counts && typeof d.counts === 'object' ? d.counts : {};
  const list = (v, fn) => (Array.isArray(v) ? v.slice(0, 50).map(fn) : []);
  return {
    roomId: d.roomId == null ? null : String(d.roomId),
    roomName: String(d.roomName || ''),
    counts,
    racks: Array.isArray(d.racks) ? d.racks.length : 0,
    skipped: list(d.skipped, s => ({
      type: String((s && s.type) || ''),
      name: String((s && s.name) || ''),
      reason: String((s && s.reason) || ''),
    })),
    warnings: list(d.warnings, String),
  };
}
