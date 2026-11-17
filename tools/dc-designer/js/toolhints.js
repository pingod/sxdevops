/**
 * 指令名纠错提示（UNKNOWN_TOOL 自纠错）—— 纯函数、零依赖，node 可直接单测
 *
 * 背景：模型（内置 AI 面板 / 外部 Agent）偶尔会按「<对象>.create」的习惯
 * 编出并不存在的指令名（如 ac.create / cabinet.create / 空调.create），页内指令层只按
 * HANDLERS 白名单查表，于是回一条 UNKNOWN_TOOL。本模块把这条拒收文案变成**可照做的自纠错**：
 *   1) 由调用方传入的合法指令名单（Object.keys(HANDLERS)，唯一事实来源，不在此复制）
 *      拼出完整名单，模型/Agent 不必再去 48KB 契约里翻找；
 *   2) 对常见误名猜出「它真正想做什么」，给一句可直接照抄的正确调用。
 *
 * **只提示、不改名转发**：纠正由调用方（模型）重新下发合法指令完成。本地不做工具名映射，
 * 避免出现第二套事实来源（见 内部设计文档 §4 第 4 条）。
 */

/** obj.add 的 type 取值（与 public/js/agent.js 的 obj.add、契约 ObjAddArgs.type 一致） */
export const OBJ_ADD_TYPES = ['column', 'ac', 'ups', 'battery', 'extinguisher', 'vent', 'pdu', 'dbox', 'cabinet', 'tray', 'beam', 'pipe'];

/** 同义词 / 中英文别名 → obj.add 的 type */
const TYPE_ALIAS = {
  aircon: 'ac', airconditioner: 'ac', airconditioning: 'ac', aircondition: 'ac', precisionac: 'ac',
  cooler: 'ac', air: 'ac', 空调: 'ac', 精密空调: 'ac',
  rack: 'cabinet', serverrack: 'cabinet', enclosure: 'cabinet', 机柜: 'cabinet', 柜子: 'cabinet',
  pillar: 'column', pole: 'column', post: 'column', 柱子: 'column', 柱: 'column',
  beam: 'beam', framebeam: 'beam', girder: 'beam', lintel: 'beam', 梁: 'beam', 框架梁: 'beam', 次梁: 'beam',
  rpp: 'pdu', powerheadcabinet: 'pdu', powerdistribution: 'pdu', 列头柜: 'pdu', 配电柜: 'pdu', 配电列头柜: 'pdu',
  dbox: 'dbox', distributionbox: 'dbox', distributionboard: 'dbox', 配电箱: 'dbox',
  ups: 'ups', uninterruptiblepowersupply: 'ups', 不间断电源: 'ups',
  batterycabinet: 'battery', batteries: 'battery', 电池: 'battery', 蓄电池: 'battery', 电池柜: 'battery',
  fireextinguisher: 'extinguisher', extinguishers: 'extinguisher', 灭火器: 'extinguisher',
  floorvent: 'vent', flooroutlet: 'vent', airvent: 'vent', grillevent: 'vent', 风口: 'vent', 地板风口: 'vent',
  liquidpipe:'pipe', liquidcooling:'pipe', 液冷管:'pipe', 管道:'pipe',
  cabletray: 'tray', cableladder: 'tray', traysegment: 'tray', 桥架: 'tray',
};

/** 出现在误名里的动词（glued 形式也剥）：ac.create / create_ac / makeCabinet … */
const VERBS = ['create', 'add', 'new', 'insert', 'place', 'put', 'make', 'append', 'build', 'draw'];

/** 关键词 → 该功能的合法指令（按顺序取第一个真实存在的名字） */
const FAMILY_HINTS = [
  [/shot|screenshot|snapshot|canvas|截图|预览图/, ['view.shot']],
  [/status|overview|summary|统计|总览|盘点/, ['query.status']],
  [/list|列表|清单/, ['project.list', 'query.objects']],
  [/save|保存|存档/, ['project.save']],
  [/open|load|打开|载入/, ['project.open']],
  [/undo|撤销|回退/, ['project.undo']],
  [/redo|重做/, ['project.redo']],
  [/export|dxf|csv|导出/, ['project.export']],
  [/rotate|旋转/, ['obj.rotate']],
  [/delete|remove|del|删除|清除/, ['obj.delete']],
  [/move|平移|移动/, ['obj.move']],
  [/updatebatch|batchupdate|批量/, ['obj.updateBatch']],
  [/update|modify|edit|修改|改属性/, ['obj.update']],
  [/get|detail|详情|查看对象/, ['obj.get']],
  [/query|find|search|查询|检索/, ['query.objects']],
  [/room|房间|建房/, ['room.rect']],
  [/wall|墙体|隔墙|风墙/, ['wall.add']],
  [/opening|door|window|grille|洞口|门窗|门|窗|格栅/, ['opening.add']],
  [/pod|冷通道|热通道|通道封闭/, ['pod.create']],
  [/row|机柜排|一整排/, ['row.create']],
];

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[\s_\-/]/g, '');

/** 反复剥掉首尾动词：createac → ac、addcabinet → cabinet */
function stripVerbs(tk) {
  let s = tk, changed = true;
  while (changed) {
    changed = false;
    for (const v of VERBS) {
      if (s.length > v.length && s.startsWith(v)) { s = s.slice(v.length); changed = true; }
      else if (s.length > v.length && s.endsWith(v)) { s = s.slice(0, s.length - v.length); changed = true; }
    }
  }
  return s;
}

/** 从误名里猜出 obj.add 的 type（猜不出返回 null） */
export function guessObjType(name) {
  for (const raw of norm(name).split('.')) {
    if (!raw) continue;
    for (const tk of [raw, stripVerbs(raw)]) {
      if (!tk) continue;
      if (OBJ_ADD_TYPES.includes(tk)) return tk;
      if (TYPE_ALIAS[tk]) return TYPE_ALIAS[tk];
    }
  }
  return null;
}

/**
 * 对常见误名给一句照做即可的纠正建议；给不出返回 null。
 * @param {string} name 调用方下发的指令名
 * @param {string[]} [toolNames] 合法指令名单（用于把关：只建议真实存在的指令）
 */
export function suggestToolFix(name, toolNames = []) {
  const names = Array.isArray(toolNames) ? toolNames : [];
  const pick = list => list.find(n => !names.length || names.includes(n));
  const t = guessObjType(name);
  if (t) {
    return t === 'pipe' ? 'obj.add { type:"pipe", x1,y1,z1,x2,y2,z2, props:{outsideDiameter:60.3,insulationThickness:0} }（中心标高，DN不是外径）' : t === 'tray'
      ? 'obj.add { type:"tray", x1, y1, x2, y2 }'
      : t === 'beam'
        ? 'obj.add { type:"beam", x1, y1, x2, y2 }（端点落在柱子上自动附着柱心）'
        : `obj.add { type:"${t}", x, y, rotation }`;
  }
  const n = norm(name);
  if (/aisle|通道带/.test(n)) {
    const hit = pick(['pod.create', 'obj.update']);
    if (hit === 'pod.create') return '通道带不能单独新增：由 pod.create 自动生成；改宽/封闭用 obj.update（id 取自 pod.create 的 added）';
    if (hit) return `请改用 ${hit}`;
  }
  for (const [re, cand] of FAMILY_HINTS) {
    if (!re.test(n)) continue;
    const hit = pick(cand);
    if (hit) return hit;
  }
  return null;
}

/**
 * UNKNOWN_TOOL 的完整拒收文案（固定中文，与页内其它错误一致；会同时进模型回灌与外部 Agent 响应）。
 * @param {string} name 未知指令名
 * @param {string[]} toolNames 合法指令名单（Object.keys(HANDLERS)）
 */
export function unknownToolMessage(name, toolNames = []) {
  const list = (Array.isArray(toolNames) ? toolNames : []).filter(Boolean);
  const parts = [`未知指令 ${name}`];
  parts.push(list.length ? `本页合法指令共 ${list.length} 条：${list.join(' ')}` : '本页指令名单不可用（契约未加载）');
  if (list.includes('obj.add')) {
    parts.push(`新增单台对象一律用 obj.add + type（type 取 ${OBJ_ADD_TYPES.join(' / ')}；矩形给 x/y/rotation，桥架/框架梁给 x1/y1/x2/y2）` +
      '——除 pod.create / row.create 外，没有 xxx.create 这类指令');
  }
  const sug = suggestToolFix(name, list);
  if (sug) parts.push(`疑似想执行：${sug}`);
  parts.push('（可用指令见 /api/agent/openapi.json）');
  return parts.join('；');
}
