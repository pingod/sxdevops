/** 机柜排操作：排识别（纯几何聚类）、序号连续重排、原位替换（柱子/列间空调/列头柜）、
 * 反向原位替换（列间空调/列头柜 → 机柜）、空位检测补插
 * 应用场景：先按标准布局（通道POD/单排）生成机柜，再按现场实况把部分机柜换成柱子、
 * 列间空调、列头柜，机柜序号随之连续重排（A01、101-A01、A01-主 等任意带前缀/后缀
 * 编号均可识别，不留空洞号）。
 * 排识别不依赖任何历史记录：rotation 一致（允许相差 180° 的对向排）且中心线共线
 * （容差 50mm）即同排；沿排方向 X 向排西→东、Y 向排南→北排序。 */
import { deviceZ } from './device.js';
import { state, ui, pushUndo, markDirty, getObj, autoName, defaultProps } from './state.js';
import { uid, isSolid, rectOverlap } from './geo.js';
import { inferRowTemplate, lastLetters, parseTemplate, lettersSeq, escRe } from './naming.js';
import { t } from './i18n.js';

/* ---------- 排识别 ---------- */

/** 旋转角归类：0=正面朝北/南（排沿X排开）、90=朝东/西（排沿Y排开）；非常规角度返回 null。
 * 导出供 aislelink（通道宽联动）按朝向类匹配通道带与机柜排 */
export function rotClass(o) {
  const r = ((Math.round(o.rotation || 0) % 180) + 180) % 180;
  if (r <= 2 || r >= 178) return 0;
  if (Math.abs(r - 90) <= 2) return 90;
  return null; // 旋转混杂 → 不归属任何排
}

/** 把机柜聚类成排：同 rotation 类 + 中心线共线（垂直方向坐标差 ≤50mm 链式归并）。
 * 返回排数组，每排为沿排方向排序（西→东 / 南→北）的机柜数组 */
export function groupRows() {
  const cabs = state.project.objects.filter(o => o.type === 'cabinet' && rotClass(o) !== null);
  const rows = [];
  for (const cls of [0, 90]) {
    const perp = o => (cls === 0 ? o.y : o.x);  // 排中心线坐标
    const along = o => (cls === 0 ? o.x : o.y); // 沿排方向坐标
    const list = cabs.filter(o => rotClass(o) === cls).sort((a, b) => perp(a) - perp(b));
    let cur = [];
    for (const o of list) {
      if (cur.length && perp(o) - perp(cur[cur.length - 1]) > 50) {
        cur.sort((a, b) => along(a) - along(b));
        rows.push(cur); cur = [];
      }
      cur.push(o);
    }
    if (cur.length) { cur.sort((a, b) => along(a) - along(b)); rows.push(cur); }
  }
  return rows;
}

/** 找到包含指定机柜的排；找不到返回 null（孤立/旋转混杂机柜不归属任何排） */
export function rowOf(cabId) {
  for (const row of groupRows()) if (row.some(o => o.id === cabId)) return row;
  return null;
}

/* ---------- 序号重排 ---------- */

/** 重排计划（不落数据，供预览/确认）：
 * 排模板 = 排内多数派 (Head, Tail)：Head/Tail 可含机房编号/分隔符等恒定文字（如 101-A-、-主），
 * 序号 = 随柜位递增的数字段（A01、101-A01、301-1-01 均识别；A01 为无前缀退化的特例，行为不变），
 * 位数取排内多数派、超出 10^w 自动扩位，沿排方向从 01 起连续编号。
 * 非本排模板的编号/自定义名默认跳过；opts.includeCustom=true 整排按位置强制统一。
 * opts.voteExclude=不参与模板投票的对象 id（反向替换新机柜的自动名“机柜-N”会干扰多数派
 * 投票——与排编号平票时“长 Head 优先”规则会误选它）；opts.foldExcluded=true 时这些对象
 * 作为排成员按位置一并重排（反向替换的新机柜顺势编入连续序号），其余自定义名仍跳过。
 * opts.tpl=显式编号模板（重排提示条输入，与向导第二步同一语法，如 C##、101-A###-主）：
 * 排号/前缀/后缀/位数以输入为准（Head=headPrefix+排号槽+headAfter），成员仍按多数派投票
 * 确定（自定义名默认跳过，includeCustom 整排强制）；模板非法时回退排内推断模板。
 * 返回 { head, tail, width, tpl, letter, count, changes, skipped, customOnly } */
export function renumberPlan(row, opts = {}) {
  const excl = opts.voteExclude ? new Set(opts.voteExclude) : null;
  const names = row.map(o => (excl && excl.has(o.id)) ? '' : ((o.props && o.props.name) || ''));
  const inf = inferRowTemplate(names);
  const pt = opts.tpl ? parseTemplate(opts.tpl) : null;
  const explicit = !!(pt && pt.ok);
  if (!inf && !explicit) return { customOnly: true, changes: [], skipped: row.length, count: row.length, letter: '' };
  const memberSet = new Set(inf ? inf.members : []);
  const fold = opts.foldExcluded && excl;
  const targets = row.filter((o, i) => opts.includeCustom || memberSet.has(i) || (fold && excl.has(o.id)));
  const head = explicit ? pt.headPrefix + pt.slot + pt.headAfter : inf.head;
  const tail = explicit ? pt.tail : inf.tail;
  const width = Math.max(explicit ? pt.width : inf.width, String(targets.length).length); // 超出 10^w 自动扩位
  const changes = [];
  targets.forEach((o, i) => {
    const newName = head + String(i + 1).padStart(width, '0') + tail;
    if (o.props.name !== newName) changes.push({ obj: o, newName });
  });
  return {
    head, tail, width,
    tpl: head + '#'.repeat(width) + tail, // 消息/预览用模板（如 101-A##）
    letter: lastLetters(head),
    count: targets.length, changes,
    skipped: opts.includeCustom ? 0 : row.length - targets.length, // 其他格式编号/自定义名（默认跳过）
    customOnly: false,
  };
}

/** 排数组按几何顺序排序（先 X 向排 南→北，再 Y 向排 西→东），与 groupRows 输出顺序一致。
 * 多排模板重置据此分配排号（首排=输入模板排号，逐排递增），保证结果可预期 */
export function sortRowsGeo(rows) {
  const key = row => {
    const cls = rotClass(row[0]);
    return [cls === 90 ? 1 : 0, cls === 90 ? row[0].x : row[0].y];
  };
  return [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
}

/** 显式模板 → 逐排模板：单排原样（整体生效，含排号）；多排为“全部重置”——
 * 输入排号=首排排号，其余按几何顺序逐排递增（如 C## + 3 排 → C##、D##、E##），
 * 前缀/后缀/位数全排统一（与向导 POD 的 lettersSeq 心智模型一致）。rows 须先经 sortRowsGeo 排序。
 * 模板非法、或多排但无排号字母（各排会重号）时返回 null（调用方判非法并提示）。 */
export function tplsForRows(rows, tpl) {
  const p = parseTemplate(tpl);
  if (!p.ok) return null;
  if (rows.length <= 1) return [tpl];
  if (!p.slot) return null;
  return lettersSeq(p.slot, rows.length)
    .map(L => p.headPrefix + L + p.headAfter + '#'.repeat(p.width) + p.tail);
}

/** 排号冲突检测：letters 中哪些排号已被受影响排之外的机柜占用（同模板字面前/后缀）。
 * 供重排提示条轻量警示（不阻止，与逐台改名的宽容策略一致） */
export function slotConflicts(tpl, letters, excludeIds) {
  const p = parseTemplate(tpl);
  if (!p.ok || !p.slot || !letters.length) return [];
  const re = new RegExp('^' + escRe(p.headPrefix) + '([A-Za-z]+)' + escRe(p.headAfter) + '\\d+' + escRe(p.tail) + '$', 'i');
  const excl = new Set(excludeIds || []);
  const used = new Set();
  for (const o of state.project.objects) {
    if (o.type !== 'cabinet' || excl.has(o.id)) continue;
    const m = re.exec((o.props && o.props.name) || '');
    if (m) used.add(m[1].toUpperCase());
  }
  return letters.filter(L => used.has(String(L).toUpperCase()));
}

/** 应用重排计划（整批为一步撤销）。返回实际改名台数 */
export function applyRenumber(plans) {
  pushUndo();
  let n = 0;
  for (const p of plans) {
    for (const c of p.changes) { c.obj.props.name = c.newName; n++; }
  }
  markDirty();
  return n;
}

/* ---------- 原位替换（柱子 / 列间空调 / 列头柜） ---------- */

/** 替换目标类型显示名（ctxmenu/props 提示语共用）；Proxy 代理到 i18n.t('rep.xxx') */
export const REPLACE_KIND_NAMES = new Proxy({}, {
  get: (_t, k) => t('rep.' + k, { d: String(k) }),
});

/** 新对象规格：柱子=600×600 居中落原柜位；列间空调/列头柜=与原柜同宽深、2000 高（保持排间距模数），
 * 继承 rotation（送风方向/正面=原机柜正面），props.kind='row' 标记列间（无该字段=精密空调，旧数据零影响） */
function replacementOf(cab, kind) {
  const base = { id: uid(), x: cab.x, y: cab.y, rotation: cab.rotation || 0 };
  const appearance = { z: deviceZ(cab) }; // 原位设备替换继承底部标高，颜色取目标类型默认
  if (kind === 'column') { // 柱尺寸/高度跟随上一次设置（defaultProps：出厂默认 ⊕ 注册表）
    return { ...base, type: 'column', props: { name: autoName(t('auto.column')), ...defaultProps('column') } };
  }
  if (kind === 'pdu') { // 列头柜：与原柜同宽深，其余属性跟随上一次设置（同工具放置默认来源）
    return {
      ...base, ...appearance, type: 'pdu',
      props: {
        ...defaultProps('pdu'),
        name: autoName(t('auto.pdu')),
        w: cab.props.w || 600, d: cab.props.d || 1200,
      },
    };
  }
  return {
    ...base, ...appearance, type: 'ac',
    props: {
      color: defaultProps('ac').color,
      name: autoName(t('auto.acrow')), kind: 'row', acType: '行级（列间）空调',
      w: cab.props.w || 600, d: cab.props.d || 1200, h: 2000,
      cool: 35, air: 6000, temp: 18, supply: '水平送风',
      remark: t('rep.acrowRemark'),
    },
  };
}

/** 批量原位替换机柜（同槽转换，继承 x/y/rotation，不触发推挤），整批为一步撤销。
 * kind: 'column'（柱子）| 'acrow'（列间空调）| 'pdu'（列头柜）。
 * 返回 { count, kind, affected }：affected=被替换机柜所在排的剩余成员（供重排提示） */
export function replaceCabinets(ids, kind) {
  const cabs = [...new Set(ids)].map(getObj).filter(o => o && o.type === 'cabinet');
  if (!cabs.length) return null;
  pushUndo();
  // 记录受影响排的“排签名”（rotation 类 + 中心线坐标），替换后据此找回同排剩余机柜
  const sigs = new Set(cabs.map(o => rotClass(o) + '|' + (rotClass(o) === 0 ? o.y : o.x)));
  const objs = state.project.objects;
  const removed = new Set(cabs.map(o => o.id));
  for (const cab of cabs) {
    const i = objs.indexOf(cab);
    objs.splice(i, 1, replacementOf(cab, kind));
  }
  state.selectedIds = state.selectedIds.filter(id => !removed.has(id));
  const affected = groupRows().filter(row =>
    row.length && sigs.has(rotClass(row[0]) + '|' + (rotClass(row[0]) === 0 ? row[0].y : row[0].x)));
  markDirty();
  return { count: cabs.length, kind, affected };
}

/* ---------- 反向原位替换（列间空调 / 列头柜 → 机柜） ---------- */

/** 可替换回机柜的对象：列头柜（pdu）与列间空调（ac 且 props.kind='row'；
 * 无 kind='row' 标记的精密空调不参与，与正向替换的产物一一对应） */
export function isRevertible(o) {
  return !!o && (o.type === 'pdu' || (o.type === 'ac' && o.props && o.props.kind === 'row'));
}

/** 新机柜规格：与原对象同位同向同宽深，高取原对象高（列间替换产物为 2000，
 * 保持排间距模数），电气属性与工具放置的新机柜默认一致（rpdu/电压/电流/接口配置） */
function cabinetOf(o) {
  const w = o.props.w || 600, d = o.props.d || 1200;
  return {
    id: uid(), type: 'cabinet', x: o.x, y: o.y, z: deviceZ(o), rotation: o.rotation || 0,
    props: {
      color: defaultProps('cabinet').color,
      name: autoName(t('auto.cabinet')), w, d, h: o.props.h || 2000, u: 42,
      power: w === 600 ? 4 : 6, remark: '',
      rpdu: 2, voltage: 220, current: 32,
      sockets: [{ type: 'IEC C13', count: 16 }, { type: 'IEC C19', count: 6 }],
    },
  };
}

/** 批量原位替换列间空调/列头柜回机柜（同槽转换，继承 x/y/rotation，不触发推挤），整批为一步撤销。
 * 替换后选中新机柜（方便立即查看/改属性）。
 * 返回 { count, kind, affected, added }：affected=新机柜所在排（含新机柜；新机柜名为自定义名，
 * 重排提示中可用「整排按位置重排」顺势把新机柜编入连续序号）；added=新机柜对象数组
 * （调用方作 renumberPlan 的 voteExclude，避免自动名干扰排模板投票） */
export function revertToCabinets(ids) {
  const targets = [...new Set(ids)].map(getObj).filter(isRevertible);
  if (!targets.length) return null;
  pushUndo();
  const objs = state.project.objects;
  const added = [];
  for (const o of targets) {
    const cab = cabinetOf(o);
    objs.splice(objs.indexOf(o), 1, cab);
    added.push(cab);
  }
  state.selectedIds = added.map(o => o.id);
  const newIds = new Set(added.map(o => o.id));
  const affected = groupRows().filter(row => row.some(o => newIds.has(o.id)));
  markDirty();
  return { count: targets.length, kind: 'cabinet', affected, added };
}

/* ---------- 空位检测补插 ---------- */

/** 检测排内缺失槽位（旧图删过机柜留下的坑）：按剩余机柜的几何间距（最窄相邻
 * 中心距=标准间距）外推缺失槽位。原则：不管两台机柜之间的连续空位有多宽（缺几个槽位），
 * 每段连续空位只插入 1 个对象，且在空位两柜之间居中（正中位置被柱子/空调等
 * 实体占用时，退到离中心最近的空闲槽位）。返回 [{x,y,rotation,w,d}] */
export function findGaps(row) {
  if (!row || row.length < 2) return [];
  const cls = rotClass(row[0]);
  const along = o => (cls === 0 ? o.x : o.y);
  const diffs = [];
  for (let i = 1; i < row.length; i++) diffs.push(along(row[i]) - along(row[i - 1]));
  // 基准间距 pitch：良好排内最窄相邻中心距即标准间距（缺槽位只会更宽），
  // 排除小于柜宽 95% 的异常紧贴（手动微调所致），缺失槽位较多时依然可靠
  const minW = Math.min(...row.map(o => o.props.w || 600));
  const plausible = diffs.filter(d => d >= minW * 0.95);
  const pitch = plausible.length ? Math.min(...plausible) : 0;
  if (!(pitch > 100)) return [];
  const slots = [];
  for (let i = 1; i < row.length; i++) {
    const a = row[i - 1], b = row[i];
    const g = along(b) - along(a);
    const missing = Math.round(g / pitch) - 1; // 这段空位缺几个槽位
    if (missing < 1 || missing > 20 || g < pitch * 1.5) continue;
    // 每段空位只取 1 个，且在两柜之间居中：正中位置优先，被占用时按离中心距离退到最近空闲槽位
    const mid = along(a) + g / 2;
    const cands = [{ p: mid }]; // 正中（100mm 取整）
    for (let k = 1; k <= missing; k++) cands.push({ p: along(a) + k * pitch, k });
    cands.sort((p, q) => Math.abs(p.p - mid) - Math.abs(q.p - mid));
    for (const c of cands) {
      const frac = (c.p - along(a)) / (along(b) - along(a)); // 槽位在空位两柜间的位置比例（勿命名 t：遮蔽 i18n 翻译函数）
      const x = a.x + (b.x - a.x) * frac, y = a.y + (b.y - a.y) * frac;
      const slot = {
        x: Math.round(x / 100) * 100, y: Math.round(y / 100) * 100,
        rotation: a.rotation || 0,
        w: a.props.w || 600, d: a.props.d || 1200,
      };
      // 位置已被实体对象占用（如先前替换的柱子/空调）→ 退到下一个离中心最近的候选
      const probe = { x: slot.x, y: slot.y, rotation: slot.rotation, props: { w: slot.w, d: slot.d } };
      if (state.project.objects.some(o => isSolid(o) && rectOverlap(probe, o))) continue;
      slots.push(slot);
      break; // 一段连续空位只插入一个对象
    }
  }
  return slots;
}

/** 空位补插：在每个槽位放置柱子/列间空调（一键补插全部，整批一步撤销）。返回补插数量 */
export function insertGapFillers(slots, kind) {
  if (!slots || !slots.length) return 0;
  pushUndo();
  for (const s of slots) {
    state.project.objects.push(replacementOf({
      x: s.x, y: s.y, rotation: s.rotation,
      props: { w: s.w, d: s.d },
    }, kind));
  }
  markDirty();
  return slots.length;
}

/** 选中集合涉及的排（去重）：菜单/面板"重排本排"按整排处理 */
export function rowsOfSelection(ids) {
  const rows = groupRows();
  const picked = new Set();
  const out = [];
  for (const id of ids) {
    const row = rows.find(r => r.some(o => o.id === id));
    if (row && !picked.has(row)) { picked.add(row); out.push(row); }
  }
  return out;
}
