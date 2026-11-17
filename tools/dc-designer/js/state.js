/** 全局状态、坐标变换、撤销/重做、项目数据操作 */
import { t } from './i18n.js';
import { normalizeCabColor } from './cabinetcolor.js';
import { isDevice, deviceZ, DEVICE_TYPES } from './device.js';
import { DISTRIBUTION_BOX_DEFAULTS } from './distribution-box.js';
import { PIPE_DEFAULTS, normalizePipe, normalizePipeWork, cleanPipePairs } from './pipe-geometry.js';

export const state = {
  project: { name: t('project.untitled'), objects: [], meta: { surveyor: '', date: '' } },
  tool: 'select',                              // 当前工具
  view: { scale: 0.06, ox: 100, oy: 100, boot: true }, // 屏幕坐标=世界(mm)*scale+offset；boot=首次布局把原点放画布左下角
  selectedIds: [],   // 选中对象 id 列表（支持框选多选）
  // 单选兼容访问器：仅当恰好选中 1 个时返回其 id；赋值等效于单选/清空
  get selectedId() { return this.selectedIds.length === 1 ? this.selectedIds[0] : null; },
  set selectedId(v) { this.selectedIds = v ? [v] : []; },
  grid: true,      // 显示网格
  snap: true,      // 100mm 捕捉
  dirty: false,    // 有未保存修改
  defaults: { cabWidth: 600, columnSize: 800, columnHeight: 3000 }, // 机柜规格（G/B 快捷键）/柱子尺寸的兼容底值；各类型属性默认值以 lastProps 注册表为准（见下方"默认值跟随上一次设置"节）
  lastProps: {},   // 属性默认值注册表：lastProps[类型][字段]=上次设置值（模块加载时从 localStorage 恢复）
  rowCfg: null,    // 机柜排批量放置配置（向导设定）
  podCfg: null,    // 通道POD批量放置配置（向导设定：首个通道冷/热、排数、冷/热通道宽等）
  liveIssues: [],  // 实时布局问题（livecheck.js 写入；render.js 画红框标记，导出时忽略）
};

/** 对象类型显示名（状态栏提示 / 属性面板标题共用）。
 * Proxy 代理到 i18n.t('type.xxx')：语言切换后自动更新，无需重建本对象 */
export const TYPE_NAMES = new Proxy({}, {
  get: (_t, key) => t('type.' + key, { d: String(key) }),
});

export const runtime = { // 交互临时状态（不持久化）
  drawing: null,        // 墙体链式绘制 { last:{x,y} }
  drag: null,           // 拖动 { kind:'move'|'handle', obj/items, ... }
  dragTick: null,       // 拖动中的碰撞轮询定时器（停留判定/回弹：鼠标停住时仍推进推挤）
  rubber: null,         // 框选 { x0, y0, x1, y1, add, brush }（世界坐标，add=Shift 追加，brush=格式刷批量应用）
  brush: null,          // 格式刷 { sourceId }（sourceId=null 表示待拾取源对象）
  panning: null,        // 平移 { sx, sy }
  lpTimer: null,        // 长按计时器（select 按住实体对象 ≥500ms 显示墙距标尺）
  rulerObj: null,       // 长按墙距标尺的对象 id（松手/开始拖动即隐）
  nudgeSig: null,       // 方向键微调合并撤销的选中集签名（同集且间隔≤1s 的连续微调=一步撤销）
  nudgeAt: 0,           // 上一次微调时间戳
  nudgeHinted: false,   // 方向键微调提示是否已显示过（每会话一次）
  nudgeRuler: null,     // 键盘微调中显示标尺的对象 id 列表（同拖动标尺，停止按键 1s 后隐去）
  nudgeRulerTimer: null, // 微调标尺自动隐去计时器
  spacePan: false,      // 空格按下中
  shiftKey: false,
  altKey: false,        // Alt 按住中：临时关闭网格捕捉（精细微调）
  altHinted: false,     // Alt 微调提示是否已显示过（每会话一次）
  hoverOpening: null,   // 门窗放置预览 { wall, t }
  guideCand: null,      // 拖动时其他对象的对齐线候选 { v:[], h:[] }（世界坐标，拖起时构建）
  guides: null,         // 当前命中的对齐参考线 { v:[], h:[] }（世界坐标，渲染用）
  rowPreview: null,     // 重排编号预览 { items:[{obj, newName}] }（灰色虚线框+灰字新编号）
  gapPreview: null,     // 空位补插预览 { slots:[{x,y,rotation,w,d}] }（灰色虚线槽位框）
  mouse: { sx: 0, sy: 0, wx: 0, wy: 0 },
};

// 由 main.js 注入的 UI 回调（避免模块循环依赖）
export const ui = {
  render() {}, props() {}, hint() {}, coords() {}, info() {}, syncTool() {}, cursor() {},
  fit() {}, resize() {}, save() {}, exportPNG() {}, exportDXF() {}, exportCSV() {},
  render3d() {}, // 3D 查看器数据变更钩子（viewer3d 注入；2D 模式下为空操作）
};

/* ---------- 坐标变换 ----------
 * 世界坐标：毫米 mm，原点在房间左下角（西南角），X 轴向东、Y 轴向北（Y 向上）
 * 屏幕坐标：Y 向下，故 Y 需翻转 */
export function w2s(wx, wy) {
  const v = state.view;
  return { x: wx * v.scale + v.ox, y: v.oy - wy * v.scale };
}
export function s2w(sx, sy) {
  const v = state.view;
  return { x: (sx - v.ox) / v.scale, y: (v.oy - sy) / v.scale };
}
/** 100mm 网格捕捉；按住 Alt 临时关闭（精细微调端点/位置），与工具栏捕捉开关叠加 */
export function snapVal(v) { return (state.snap && !runtime.altKey) ? Math.round(v / 100) * 100 : v; }

/* ---------- 撤销 / 重做 ---------- */
const undoStack = [], redoStack = [];
export function pushUndo() {
  undoStack.push(JSON.stringify(state.project.objects));
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
}
export function undo() {
  if (!undoStack.length) { ui.hint(t('hint.nothingToUndo')); return; }
  redoStack.push(JSON.stringify(state.project.objects));
  state.project.objects = JSON.parse(undoStack.pop());
  state.selectedId = null; runtime.drawing = null; runtime.nudgeSig = null; // 撤销后微调重新记撤销
  markDirty(); ui.hint(t('hint.undone'));
}
export function redo() {
  if (!redoStack.length) { ui.hint(t('hint.nothingToRedo')); return; }
  undoStack.push(JSON.stringify(state.project.objects));
  state.project.objects = JSON.parse(redoStack.pop());
  state.selectedId = null; runtime.drawing = null; runtime.nudgeSig = null; // 重做后微调重新记撤销
  markDirty(); ui.hint(t('hint.redone'));
}

/** 当前撤销栈深度（AI 面板「撤销本轮」按步数连续回退用） */
export function undoDepth() { return undoStack.length; }

/** 取消进行中的操作：弹出并恢复最近一步撤销快照（不动 redo 栈；无快照返回 false）。
 * 用于 Esc 取消拖动——拖动开始时的 pushUndo 快照即操作前状态，恢复后等价于操作从未发生 */
export function revertLastUndo() {
  if (!undoStack.length) return false;
  state.project.objects = JSON.parse(undoStack.pop());
  return true;
}

/* ---------- 数据操作 ---------- */
export function getObj(id) {
  return state.project.objects.find(o => o.id === id) || null;
}

export function newProject(name = t('project.untitled')) {
  state.project = { name, objects: [], meta: { surveyor: '', date: '' } };
  state.selectedId = null;
  runtime.drawing = null;
  undoStack.length = 0; redoStack.length = 0;
  markDirty();
}

/** 批量删除对象；删除墙体时级联删除其上门窗 */
export function deleteObjects(ids) {
  if (!ids || !ids.length) return;
  pushUndo();
  const set = new Set(ids);
  for (const o of state.project.objects) { // 级联：墙上门窗一并删除
    if (o.type === 'wall' && set.has(o.id)) {
      for (const x of state.project.objects) if (x.wallId === o.id) set.add(x.id);
    }
  }
  for (const o of state.project.objects) { // 框架梁端点附着的柱被删：端点固化为柱心坐标并脱离（梁保留，不随删）
    if (o.type !== 'beam') continue;
    if (o.col1 && set.has(o.col1)) { const c = getObj(o.col1); if (c) { o.x1 = c.x; o.y1 = c.y; } o.col1 = null; }
    if (o.col2 && set.has(o.col2)) { const c = getObj(o.col2); if (c) { o.x2 = c.x; o.y2 = c.y; } o.col2 = null; }
  }
  state.project.objects = state.project.objects.filter(x => !set.has(x.id));
  cleanPipePairs(state.project.objects);
  state.selectedIds = state.selectedIds.filter(id => !set.has(id));
  markDirty();
}

/** 删除单个对象 */
export function deleteObject(id) {
  if (getObj(id)) deleteObjects([id]);
}

/* ---------- 项目数据清洗（打开项目 / 草稿恢复两条入口统一调用） ---------- */
/** 数值字段白名单：坐标/尺寸/电气参数必须为数字。项目 JSON 可被手工编辑或来自外部，
 * 字符串注入（如把 HTML 塞进数字字段）会在属性面板渲染时破出 value 属性执行脚本，
 * 统一在数据入口强制转型（非法值归零），从根上堵住该类注入。 */
const numOr = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const NUM_TOP = ['x', 'y', 'z', 'x1', 'y1', 'x2', 'y2', 'rotation', 't'];
const NUM_PROPS = ['thickness', 'height', 'width', 'sill', 'bodyH', 'w', 'd', 'h',
  'u', 'power', 'rpdu', 'voltage', 'current', 'cool', 'air', 'temp', 'supplyRh', 'returnTemp',
  'kva', 'backup', // kva=UPS 额定容量 / backup=UPS 电池后备时间
  'doorW',         // doorW=封闭通道端门门洞净宽（0=全宽）
  'ah', 'cells',  // ah=蓄电池单只容量 / cells=蓄电池只数
  'b', 'top',     // b=框架梁梁宽 / top=框架梁梁顶标高（梁高复用 h）
  'kg'];          // kg=灭火器充装量
/** 非负物理量（温度类 temp/returnTemp 允许负值除外）：外部/手改 JSON 中的负值无物理意义，清洗时归零，不参与统计 */
const NONNEG_PROPS = new Set(NUM_PROPS.filter(k => k !== 'temp' && k !== 'returnTemp'));

/** 数据清洗：去无效对象、去丢失墙体的门窗、数值字段强制转型、补工勘信息、旧版字段迁移 */
export function sanitize(p) {
  if (!p || !Array.isArray(p.objects)) throw new Error(t('err.badData'));
  p.objects = p.objects.filter(o => o && o.id && o.type);
  // 管道严格验证：损坏导入整次拒绝，不悄悄补外径/标高或丢弃管段。
  p.objects = p.objects.map(o => o.type === 'pipe' ? normalizePipe(o) : o);
  const ids = new Set(p.objects.map(o => o.id));
  p.objects = p.objects.filter(o =>
    !((o.type === 'door' || o.type === 'window' || o.type === 'grille') && !ids.has(o.wallId)));
  for (const o of p.objects) {
    o.props = o.props || {};
    for (const k of NUM_TOP) if (o[k] !== undefined) o[k] = numOr(o[k]);
    if (isDevice(o)) o.z = deviceZ(o); // 旧项目未设 Z = 落地；坐标允许负数
    for (const k of NUM_PROPS) if (o.props[k] !== undefined) {
      o.props[k] = numOr(o.props[k]);
      if (NONNEG_PROPS.has(k) && o.props[k] < 0) o.props[k] = 0;
    }
    // 旧版开门朝向 side:left/right → 朝外/朝内 迁移（房间内部自动识别上线前的老数据）
    if (o.type === 'door' && o.props.side === 'left') o.props.side = 'out';
    else if (o.type === 'door' && o.props.side === 'right') o.props.side = 'in';
    // 机柜不再保留品牌字段（2026-09 起），旧项目加载时清除
    if (o.type === 'cabinet' && 'brand' in o.props) delete o.props.brand;
    // 对象颜色：仅接受 #rgb/#rrggbb（非法值删除=回默认色）。颜色会写进属性面板 input[type=color]
    // 与 CSS/画布填充，统一在此规范化，堵住手改 JSON 塞入非颜色串的路径
    if (o.type !== 'pipe' && o.props.color !== undefined) {
      const c = normalizeCabColor(o.props.color);
      if (c) o.props.color = c; else delete o.props.color;
    }
    // 空调类型旧值「风墙末端」→「远端风墙空调」（风墙空调细分为近端/远端两类）
    if (o.type === 'ac' && o.props.acType === '风墙末端') o.props.acType = '远端风墙空调';
  }
  if (!p.meta || typeof p.meta !== 'object') p.meta = { surveyor: '', date: '' };
  if(p.meta.pipeWork)p.meta.pipeWork=normalizePipeWork(p.meta.pipeWork);
  cleanPipePairs(p.objects);
}

/* ---------- 属性默认值跟随上一次设置（lastProps 注册表） ----------
 * 字段级两级注册表：lastProps[类型][字段] = 上次设置值。属性面板/向导/快捷键修改属性时
 * 经 notePropEdit 写回；创建同类对象时经 defaultProps 合并进出厂默认（注册表优先）。
 * name/remark 不跟随（身份/备注类）；坐标/旋转/t 在 props 之外天然不跟随。
 * 注册表是跨项目/跨会话的用户习惯（非项目数据）：持久化到 localStorage、不参与撤销、
 * 新建项目不重置；加载时按数值白名单清洗（同 sanitize 规则），损坏回退空表。 */
const FOLLOW_EXCLUDE = new Set(['name', 'remark']);
const LASTPROPS_KEY = 'idc2d_lastprops_v1';
let lpTimer = 0, lpSavedAt = 0;

/** 深拷贝（注册表值均为 JSON 可序列化：sockets 数组等不共享引用） */
const lpCopy = v => (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;

/** 启动读取持久化注册表；数值字段按项目数据同一白名单清洗，剔除不跟随字段 */
function loadLastProps() {
  try {
    const raw = localStorage.getItem(LASTPROPS_KEY);
    const data = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== 'object') return {};
    const out = {};
    for (const [type, fields] of Object.entries(data)) {
      if (!fields || typeof fields !== 'object') continue;
      const f = {};
      for (const [k, v] of Object.entries(fields)) {
        if (FOLLOW_EXCLUDE.has(k) || k === 'z') continue; // Z 是位置，不作为属性默认值跟随
        if (NUM_PROPS.includes(k)) { // 数值白名单字段：非法值丢弃、非负物理量负值归零（同 sanitize）
          const n = +v;
          if (!Number.isFinite(n)) continue;
          f[k] = NONNEG_PROPS.has(k) && n < 0 ? 0 : n;
        } else if (k === 'color') { // 机柜颜色：非法值丢弃（同 sanitize）
          const c = normalizeCabColor(v);
          if (c) f[k] = c;
        } else f[k] = lpCopy(v);
      }
      out[type] = f;
    }
    return out;
  } catch (e) { return {}; }
}
state.lastProps = loadLastProps();

/** 立即把注册表写入 localStorage（页面隐藏/关闭前由 main.js 调用） */
export function flushLastProps() {
  clearTimeout(lpTimer);
  lpSavedAt = Date.now();
  try { localStorage.setItem(LASTPROPS_KEY, JSON.stringify(state.lastProps)); } catch (e) { /* 存储满/隐私模式时忽略 */ }
}

/** 节流写盘（同 saveDraft：密集修改最多 800ms 一次，末尾定时器补齐） */
export function saveLastProps() {
  const now = Date.now();
  if (now - lpSavedAt >= 800) { flushLastProps(); return; }
  clearTimeout(lpTimer);
  lpTimer = setTimeout(flushLastProps, 850 - (now - lpSavedAt));
}

/** 机柜默认电气属性（RPDU/电压/电流/接口配置）。sockets 为接口配置列表（类型×数量，可多类型并存） */
const cabElec = () => ({
  rpdu: 2, voltage: 220, current: 32,
  sockets: [{ type: 'IEC C13', count: 16 }, { type: 'IEC C19', count: 6 }],
});

/** 各类型出厂默认属性（不含 name；创建点唯一来源，与注册表合并后即为新对象 props）。
 * 机柜宽/功率规则按“生效宽度”（注册表 w 优先于兼容底值 cabWidth）推导，保证 800 规格默认 6kW */
export function factoryProps(type) {
  return { ...(DEVICE_TYPES.includes(type) ? { color: '' } : {}), ...typeFactoryProps(type) };
}

function typeFactoryProps(type) {
  switch (type) {
    case 'wall': return { thickness: 240, height: 3000, material: '砖墙' };
    case 'pipe': return { ...PIPE_DEFAULTS };
    case 'tray': return { width: 300, height: 2500, bodyH: 100, kind: '弱电' };
    case 'door': return { width: 1500, height: 2700, swing: 'left', side: 'out', leaf: 'double' };
    case 'window': return { width: 1500, height: 1500, sill: 900 };
    case 'grille': return { width: 2500, height: 2750, sill: 10, kind: '送风' };
    case 'column': {
      const cs = state.defaults.columnSize || 800;
      return { w: cs, d: cs, h: state.defaults.columnHeight || 3000 };
    }
    // 框架梁（GB 50010 / 22G101 平法）：默认 300×600、梁顶标高 3000（创建跨柱时自动取两柱较高者）、
    // C30 混凝土（≥C20 即可，机房常用 C30）、类型 框架梁(KL)/次梁(L)/悬挑梁(XL)；
    // 截面估算惯例：梁高≈跨度 1/10~1/18、梁宽≈梁高 1/2~1/3（见属性面板提示）
    case 'beam': return { b: 300, h: 600, top: 3000, concrete: 'C30', kind: '框架梁', remark: '' };
    case 'cabinet': {
      const w = +(state.lastProps.cabinet && state.lastProps.cabinet.w) || state.defaults.cabWidth || 600;
      // color='' 表示默认柜色（跟随主题配色）；设了颜色则 2D/3D 都按该色渲染
      return { w, d: 1200, h: 2000, u: 42, power: w === 600 ? 4 : 6, color: '', remark: '', ...cabElec() };
    }
    case 'pdu': return { w: state.defaults.cabWidth || 600, d: 1200, h: 2000, voltage: 380, current: 250, remark: '' };
    case 'dbox': return { ...DISTRIBUTION_BOX_DEFAULTS };
    case 'ac': return { acType: '房间级精密空调', w: 2500, d: 1300, h: 2800, cool: 25, air: 2800, temp: 18, supply: '水平送风', remark: '' };
    // UPS（不间断电源）：默认 800×800×2000 单机柜，200kVA/160kW（功率因数 0.8）、380V 输入、后备 15min
    case 'ups': return { upsType: '工频机', w: 800, d: 800, h: 2000, kva: 200, power: 160, voltage: 380, current: 400, backup: 15, redundancy: '', remark: '' };
    // 蓄电池（UPS 电池柜）：默认 800×800×2000 单柜，阀控铅酸 100Ah×32 只、组电压 384V
    case 'battery': return { batType: '阀控铅酸', w: 800, d: 800, h: 2000, ah: 100, cells: 32, voltage: 384, remark: '' };
    // 灭火器：默认 400×400×1200 放置点（手提式干粉 5kg），类型/充装量可改
    case 'extinguisher': return { extType: '手提式干粉', w: 400, d: 400, h: 1200, kg: 5, remark: '' };
    case 'vent': return { w: 600, d: 600, kind: '格栅', air: 1000, remark: '' };
    case 'aisle': return { kind: 'cold', w: 1000, d: 1200, h: 2000, enclosed: true,
      endDoors: 'both', doorType: 'sliding', doorW: 0 }; // 封闭通道端门：两端/单端/无 × 推拉/双开/单开；doorW=0 全宽（=通道宽）
    default: return {};
  }
}

/** 创建对象默认值：出厂默认 ⊕ 上次设置（注册表值深拷贝，sockets 等数组不共享引用） */
export function defaultProps(type, factory = factoryProps(type)) {
  const saved = state.lastProps[type];
  const out = { ...factory };
  if (saved) for (const k of Object.keys(saved)) {
    if (!FOLLOW_EXCLUDE.has(k) && k !== 'z') out[k] = lpCopy(saved[k]);
  }
  if (type === 'pipe') {
    // 规格默认值必须交叉验证（外径与壁厚不是互不相关的非负数）。
    try { return normalizePipe({ x1: 0, y1: 0, z1: 0, x2: 1, y2: 0, z2: 0, props: out }).props; }
    catch { return { ...factory }; }
  }
  return out;
}

/** 属性修改写回注册表：下次创建同类对象时该字段取本次值。
 * 机柜宽联动兼容底值 cabWidth（列头柜默认宽/G、B 快捷键沿用） */
export function notePropEdit(type, key, value) {
  if (!type || FOLLOW_EXCLUDE.has(key) || key === 'z') return;
  (state.lastProps[type] = state.lastProps[type] || {})[key] = lpCopy(value);
  if (type === 'cabinet' && key === 'w') state.defaults.cabWidth = +value || state.defaults.cabWidth;
  saveLastProps();
}

/** 自动编号名称，如 机柜-1 */
export function autoName(prefix) {
  const names = new Set(state.project.objects.map(o => o.props && o.props.name));
  let i = 1;
  while (names.has(prefix + '-' + i)) i++;
  return prefix + '-' + i;
}

/* ---------- 本地草稿缓存：刷新/关闭页面不丢数据 ---------- */
const DRAFT_KEY = 'idc2d_draft_v1'; // 当前项目草稿（localStorage）
const DRAFT_SAVED_KEY = 'idc2d_draft_saved_v1'; // 草稿=已保存文件内容的标记（保存/打开成功后置位，任何真实修改清除）
let draftTimer = 0, lastDraftAt = 0;

/** 节流写入草稿：修改密集时最多 800ms 一次，末尾由定时器补齐 */
export function saveDraft() {
  const now = Date.now();
  if (now - lastDraftAt >= 800) { flushDraft(); return; }
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 850 - (now - lastDraftAt));
}

/** 立即把当前项目写入 localStorage（页面隐藏/关闭前调用） */
export function flushDraft() {
  clearTimeout(draftTimer);
  lastDraftAt = Date.now();
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state.project));
    // dirty=false 时的草稿与已保存文件一致：置位标记，刷新后按干净项目恢复，不再误报“未保存内容”
    if (state.dirty) localStorage.removeItem(DRAFT_SAVED_KEY);
    else localStorage.setItem(DRAFT_SAVED_KEY, '1');
  } catch (e) { /* 存储满/隐私模式时忽略 */ }
}

/** 草稿是否与已保存文件内容一致（保存/打开后刷新页面时据此按干净状态静默恢复） */
export function isDraftSaved() {
  try { return localStorage.getItem(DRAFT_SAVED_KEY) === '1'; } catch (e) { return false; }
}

/** 读取草稿；无或损坏时返回 null */
export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/* ---------- 编辑钩子（livecheck.js 等挂接：任何修改经 markDirty 单点广播，无循环依赖） ---------- */
const dirtyHooks = [];
export function onDirty(fn) { dirtyHooks.push(fn); }

/** 标记修改并刷新界面；opts.props=false 时跳过属性面板重建（拖动中）；opts.dirty=false 时保持当前未保存标记（用于保存/打开后刷新）；
 * opts.deferDraft=true 时草稿延迟 1.2s 写盘（打开项目首开路径：避免同步 JSON.stringify+localStorage 写盘阻塞首屏渲染） */
export function markDirty(opts = {}) {
  if (opts.dirty !== false) state.dirty = true;
  ui.render();
  ui.render3d(); // 3D 查看中则同步重建三维场景
  if (opts.props !== false) ui.props();
  if (opts.deferDraft) {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(flushDraft, 1200);
  } else {
    saveDraft(); // 自动缓存草稿，刷新页面不丢数据
  }
  for (const fn of dirtyHooks) { try { fn(); } catch (e) { /* 钩子异常不影响编辑主流程 */ } }
}
