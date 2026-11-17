/** CSV 工程量清单导出：把当前项目导出为 CSV 清单文件（Excel/WPS 双击直接打开）
 *
 * 设计要点：
 * - 清单内容固定为中文：对象的属性值（材质/桥架类型/送风方式等）本身以中文存储，
 *   清单表头与内容固定中文，界面语言切换只影响按钮/提示等 UI 文案
 * - 下载文件带 UTF-8 BOM（\uFEFF），Excel 双击打开中文不乱码；换行用 CRLF（RFC 4180）
 * - 分三部分：项目信息（名称/勘测人/日期）→ 工程量汇总（按 类别+规格 聚合，
 *   长度 mm→m 两位小数、数量取整数、功率/制冷量合计）→ 设备明细（机柜/列头柜/空调/
 *   风口逐台列出，含编号、规格、距西/距南位置与电气参数，可溯源到每台设备）
 * - 含逗号/引号/换行的字段按 CSV 规范转义（双引号包裹、内部引号翻倍）
 * - buildBOQ 为纯函数（Node 单测直接调用）；exportCSV 为浏览器下载入口 */
import { state, ui } from './state.js';
import { wallLen, beamEnds, roomInnerBox } from './geo.js';
import { t } from './i18n.js';
import { pipeSummaryRows, pipeDetailRows } from './pipe-export.js';
import { deviceZ } from './device.js';
import { distributionBoxParams } from './distribution-box.js';
import { normalizeCabColor } from './cabinetcolor.js';

/* ---------- CSV 基础工具 ---------- */
/** 单元格转义：含逗号/引号/换行时用双引号包裹，内部引号翻倍（RFC 4180） */
const cell = v => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const row = arr => arr.map(cell).join(',');

/** 毫米 → 米（2 位小数，去尾零）：42000 → "42"、12345 → "12.35" */
const m2 = mm => String(Math.round(+mm / 10) / 100);
/** 数值（最多 2 位小数，去尾零） */
const n2 = v => String(Math.round((+v || 0) * 100) / 100);
/** 尺寸串：600×1200×2000（跳过空/零值，全空返回 '—'） */
const dims = (...nums) => {
  const parts = nums.map(v => Math.round(+v || 0)).filter(v => v > 0);
  return parts.length ? parts.join('×') : '—';
};
/** 毫米尺寸串：600×1200×2000mm */
const specMm = (...nums) => {
  const d = dims(...nums);
  return d === '—' ? d : d + 'mm';
};

/** 按 key 聚合对象：Map(key → items[])，保持首次出现顺序 */
function groupBy(objs, keyFn) {
  const m = new Map();
  for (const o of objs) {
    const k = keyFn(o);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(o);
  }
  return m;
}

/** 机柜接口配置（与 props.js sockList 同规则：新格式 sockets=[{type,count}…]，
 * 旧格式 socket+sockets 单类型迁移；无数据按默认 IEC C13×16 + C19×6） */
function sockList(p) {
  if (Array.isArray(p.sockets)) return p.sockets;
  if (typeof p.sockets === 'number') return [{ type: p.socket || 'IEC C13', count: p.sockets }];
  return [{ type: 'IEC C13', count: 16 }, { type: 'IEC C19', count: 6 }];
}

/** 房间内空尺寸（mm）：与 geo.js 墙距标尺同一口径（roomInnerBox），
 * 对矩形/近矩形房间精确；异形房间按外接矩形近似。墙少于 3 段或内空小于 1m 返回 null */
function roomInnerSize(walls) {
  const b = roomInnerBox(walls);
  if (!b || b.L < 1000 || b.W < 1000) return null;
  return { L: b.L, W: b.W };
}

/* ---------- 工程量汇总（按 类别+规格 聚合） ---------- */
function summaryRows(objs, room) {
  const rows = [];
  let i = 1;
  const push = (cat, name, spec, unit, qty, remark) =>
    rows.push([i++, cat, name, spec, unit, qty, remark]);
  const of = type => objs.filter(o => o.type === type);

  if (room) push('建筑', '机房', `${m2(room.L)}×${m2(room.W)} m`, '间', 1,
    `内空面积约 ${n2(room.L * room.W / 1e6)} m²`);

  // 墙体：按 厚度×高度×材质 聚合，数量 = 总长（m）
  for (const [, g] of groupBy(of('wall'),
    o => `${o.props.thickness || 240}|${o.props.height || 0}|${o.props.material || ''}`)) {
    const p = g[0].props;
    const len = g.reduce((s, o) => s + wallLen(o), 0);
    push('建筑', '墙体',
      `厚${Math.round(p.thickness || 240)}mm${p.height ? ` · 高${Math.round(p.height)}mm` : ''}`,
      'm', m2(len), p.material || '');
  }
  // 门：按 门扇×宽×高×朝向 聚合（朝向记备注）
  for (const [, g] of groupBy(of('door'),
    o => `${o.props.leaf || 'single'}|${o.props.width || 900}|${o.props.height || 0}|${o.props.side || 'out'}`)) {
    const p = g[0].props;
    push('建筑', '机房门',
      `${p.leaf === 'double' ? '双开门' : '单开门'} ${specMm(p.width || 900, p.height)}`,
      '樘', g.length, p.side === 'in' ? '朝内' : '朝外');
  }
  // 窗：按 宽×高×窗台高 聚合
  for (const [, g] of groupBy(of('window'),
    o => `${o.props.width || 900}|${o.props.height || 0}|${o.props.sill || 0}`)) {
    const p = g[0].props;
    push('建筑', '窗', specMm(p.width || 900, p.height), '樘', g.length,
      +p.sill > 0 ? `窗台高 ${Math.round(p.sill)}mm` : '');
  }
  // 格栅：按 送/回风×宽×高 聚合
  for (const [, g] of groupBy(of('grille'),
    o => `${o.props.kind || '送风'}|${o.props.width || 900}|${o.props.height || 0}`)) {
    const p = g[0].props;
    push('建筑', '格栅', `${p.kind || '送风'} ${specMm(p.width || 900, p.height)}`,
      '个', g.length, '');
  }
  // 柱子：按 宽×深×高 聚合
  for (const [, g] of groupBy(of('column'),
    o => `${o.props.w || 600}|${o.props.d || 600}|${o.props.h || 0}`)) {
    const p = g[0].props;
    push('建筑', '柱子', specMm(p.w || 600, p.d || 600, p.h), '根', g.length, '');
  }
  // 框架梁：按 类型×截面×混凝土强度×梁顶标高 聚合（备注含合计总长）
  const byId = new Map(objs.map(o => [o.id, o]));
  const beamLenOf = o => {
    const e = beamEnds(o, id => byId.get(id) || null);
    return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  };
  for (const [, g] of groupBy(of('beam'),
    o => `${o.props.kind || '框架梁'}|${o.props.b || 300}|${o.props.h || 600}|${o.props.concrete || ''}|${o.props.top || 0}`)) {
    const p = g[0].props;
    const len = g.reduce((s, o) => s + beamLenOf(o), 0);
    push('建筑', p.kind || '框架梁',
      `截面 ${Math.round(p.b || 300)}×${Math.round(p.h || 600)}mm` + (p.concrete ? ` · ${p.concrete}` : ''),
      '根', g.length,
      [`总长 ${m2(len)} m`, +p.top > 0 ? `梁顶标高 ${Math.round(p.top)}mm` : ''].filter(Boolean).join(' · '));
  }
  // 机柜：按 宽×深×高 聚合，备注含总功率
  for (const [, g] of groupBy(of('cabinet'),
    o => `${o.props.w || 600}|${o.props.d || 1200}|${o.props.h || 0}`)) {
    const p = g[0].props;
    const power = g.reduce((s, o) => s + (+o.props.power || 0), 0);
    push('机柜配电', '机柜', specMm(p.w || 600, p.d || 1200, p.h), '台', g.length,
      power > 0 ? `总功率 ${n2(power)} kW` : '');
  }
  // 列头柜：按 宽×深×高×电压×电流 聚合
  for (const [, g] of groupBy(of('pdu'),
    o => `${o.props.w || 600}|${o.props.d || 1200}|${o.props.h || 0}|${o.props.voltage || ''}|${o.props.current || ''}`)) {
    const p = g[0].props;
    push('机柜配电', '列头柜', specMm(p.w || 600, p.d || 1200, p.h), '台', g.length,
      `${+p.voltage || 0}V/${+p.current || 0}A`);
  }
  // 配电箱：按尺寸和完整配电参数聚合，避免不同用途/回路被错误合并。
  for (const [, g] of groupBy(of('dbox'), o => JSON.stringify([
    o.props.w, o.props.d, o.props.h, o.props.boxUse, o.props.mounting,
    o.props.voltage, o.props.current, o.props.outCircuits,
  ]))) {
    const p = g[0].props;
    push('机柜配电', '配电箱', specMm(p.w || 600, p.d || 200, p.h), '台', g.length, distributionBoxParams(p));
  }
  // UPS：按 宽×深×高×容量×电压×电流 聚合（备注含后备时间）
  for (const [, g] of groupBy(of('ups'),
    o => `${o.props.w || 800}|${o.props.d || 800}|${o.props.h || 0}|${o.props.kva || 0}|${o.props.voltage || ''}|${o.props.current || ''}`)) {
    const p = g[0].props;
    push('机柜配电', 'UPS',
      specMm(p.w || 800, p.d || 800, p.h) + (+p.kva > 0 ? ` · 容量 ${n2(p.kva)} kVA` : ''),
      '台', g.length,
      `${+p.voltage || 0}V/${+p.current || 0}A` + (+p.backup > 0 ? ` · 后备 ${n2(p.backup)} min` : ''));
  }
  // 蓄电池：按 宽×深×高×电池类型×单只容量 聚合（备注含只数合计与组电压）
  for (const [, g] of groupBy(of('battery'),
    o => `${o.props.w || 800}|${o.props.d || 800}|${o.props.h || 0}|${o.props.batType || ''}|${o.props.ah || 0}|${o.props.voltage || 0}`)) {
    const p = g[0].props;
    const cells = g.reduce((s, o) => s + (+o.props.cells || 0), 0);
    push('机柜配电', '蓄电池',
      specMm(p.w || 800, p.d || 800, p.h) + (p.batType ? ` · ${p.batType}` : '') + (+p.ah > 0 ? ` · ${n2(p.ah)} Ah` : ''),
      '台', g.length,
      (cells > 0 ? `共 ${cells} 只` : '') + (+p.voltage > 0 ? ` · 组电压 ${n2(p.voltage)} V` : ''));
  }
  // 灭火器：按 宽×深×高×类型×充装量 聚合
  for (const [, g] of groupBy(of('extinguisher'),
    o => `${o.props.w || 400}|${o.props.d || 400}|${o.props.h || 0}|${o.props.extType || ''}|${o.props.kg || 0}`)) {
    const p = g[0].props;
    push('消防安全', '灭火器',
      specMm(p.w || 400, p.d || 400, p.h) + (p.extType ? ` · ${p.extType}` : '') + (+p.kg > 0 ? ` · ${n2(p.kg)} kg` : ''),
      '具', g.length, '');
  }
  // 空调：按 宽×深×高×制冷量 聚合（制冷量记规格、送风方式记备注）
  for (const [, g] of groupBy(of('ac'),
    o => `${o.props.w || 2500}|${o.props.d || 1300}|${o.props.h || 0}|${o.props.cool || 0}|${o.props.supply || ''}`)) {
    const p = g[0].props;
    push('暖通制冷', '空调',
      specMm(p.w || 2500, p.d || 1300, p.h) + (+p.cool > 0 ? ` · 制冷 ${n2(p.cool)} kW` : ''),
      '台', g.length, p.supply || '');
  }
  // 地板出风口：按 宽×深×类型 聚合，备注合计风量
  for (const [, g] of groupBy(of('vent'),
    o => `${o.props.w || 600}|${o.props.d || 600}|${o.props.kind || '格栅'}`)) {
    const p = g[0].props;
    const air = g.reduce((s, o) => s + (+o.props.air || 0), 0);
    push('暖通制冷', '地板出风口', `${specMm(p.w || 600, p.d || 600)} · ${p.kind || '格栅'}`,
      '个', g.length, air > 0 ? `合计风量 ${n2(air)} m³/h` : '');
  }
  // 桥架：按 类型×结构类型×宽度×距地高度 聚合，数量 = 总长（m）
  for (const [, g] of groupBy(of('tray'),
    o => `${o.props.kind || '弱电'}|${o.props.structure || ''}|${o.props.width || 300}|${o.props.height || 0}`)) {
    const p = g[0].props;
    const len = g.reduce((s, o) => s + wallLen(o), 0);
    push('综合布线', '桥架', `${p.kind || '弱电'} · 宽${Math.round(p.width || 300)}mm`,
      'm', m2(len), [p.structure || '', +p.height > 0 ? `距地 ${Math.round(p.height)}mm` : ''].filter(Boolean).join(' · '));
  }
  // 通道：按 冷/热×封闭×通道宽×通道高×端门配置 聚合（封闭通道规格含端门：推拉/双开/单开×数量，非全宽门洞注净宽）
  for (const [, g] of groupBy(of('aisle'),
    o => `${o.props.kind || 'cold'}|${o.props.enclosed !== false}|${o.props.d || 0}|${o.props.h || 0}` +
      `|${o.props.endDoors || 'both'}|${o.props.doorType || 'sliding'}|${o.props.doorW || 0}`)) {
    const p = g[0].props;
    const cold = (p.kind || 'cold') === 'cold';
    const enc = p.enclosed !== false;
    let spec = `${enc ? '封闭' : '不封闭'} · 宽${Math.round(p.d || 0)}mm` + (enc && +p.h > 0 ? ` · 高${Math.round(p.h)}mm` : '');
    if (enc) { // 端门（旧数据无字段按两端推拉门）
      const nD = { both: 2, one: 1, none: 0 }[p.endDoors || 'both'];
      const dt = { sliding: '推拉', double: '双开', single: '单开' }[p.doorType || 'sliding'];
      const dw = +p.doorW > 0 ? Math.min(+p.doorW, p.d || 0) : 0;
      spec += nD ? ` · 端门：${dt}×${nD}` + (dw && dw < (p.d || 0) ? `（净宽${Math.round(dw)}mm）` : '') : ' · 无端门（两端封板）';
    }
    push('通道', `${cold ? '冷' : '热'}通道`, spec, '个', g.length, '');
  }
  return rows;
}

/* ---------- 设备明细（机柜/列头柜/UPS/空调/风口逐台列出，可溯源） ---------- */
function detailRows(objs) {
  const rows = [];
  let i = 1;
  const push = (type, o, spec, params) =>
    rows.push([i++, type, o.props.name || o.id, spec, '台', 1,
      m2(o.x), m2(o.y), params, o.props.remark || '', n2(deviceZ(o)), normalizeCabColor(o.props.color) || '默认色']);
  for (const o of objs) {
    const p = o.props;
    if (o.type === 'cabinet') {
      const parts = [];
      if (+p.power > 0) parts.push(`功率 ${n2(p.power)} kW`);
      if (+p.rpdu > 0) parts.push(`RPDU ${p.rpdu}`);
      if (p.wireSize) parts.push(`线径 ${p.wireSize}`);
      if (+p.voltage || +p.current) parts.push(`${+p.voltage || 0}V/${+p.current || 0}A`);
      const socks = sockList(p).filter(s => s && +s.count > 0);
      if (socks.length) parts.push(`接口 ${socks.map(s => `${s.type}×${s.count}`).join('+')}`);
      push('机柜', o, specMm(p.w || 600, p.d || 1200, p.h), parts.join(' · '));
    } else if (o.type === 'pdu') {
      push('列头柜', o, specMm(p.w || 600, p.d || 1200, p.h),
        `${+p.voltage || 0}V/${+p.current || 0}A` + (p.outCircuits ? ` · 输出 ${p.outCircuits}` : ''));
    } else if (o.type === 'dbox') {
      push('配电箱', o, specMm(p.w || 600, p.d || 200, p.h), distributionBoxParams(p));
    } else if (o.type === 'ups') {
      const parts = [];
      if (p.upsType) parts.push(p.upsType);
      if (+p.kva > 0) parts.push(`容量 ${n2(p.kva)} kVA`);
      if (+p.power > 0) parts.push(`输出 ${n2(p.power)} kW`);
      if (+p.voltage || +p.current) parts.push(`${+p.voltage || 0}V/${+p.current || 0}A`);
      if (+p.backup > 0) parts.push(`后备 ${n2(p.backup)} min`);
      if (p.redundancy) parts.push(`冗余 ${p.redundancy}`);
      push('UPS', o, specMm(p.w || 800, p.d || 800, p.h), parts.join(' · '));
    } else if (o.type === 'battery') {
      const parts = [];
      if (p.batType) parts.push(p.batType);
      if (+p.ah > 0) parts.push(`单只 ${n2(p.ah)} Ah`);
      if (+p.cells > 0) parts.push(`${p.cells} 只`);
      if (+p.voltage > 0) parts.push(`组电压 ${n2(p.voltage)} V`);
      push('蓄电池', o, specMm(p.w || 800, p.d || 800, p.h), parts.join(' · '));
    } else if (o.type === 'extinguisher') {
      const parts = [];
      if (p.extType) parts.push(p.extType);
      if (+p.kg > 0) parts.push(`充装量 ${n2(p.kg)} kg`);
      push('灭火器', o, specMm(p.w || 400, p.d || 400, p.h), parts.join(' · '));
    } else if (o.type === 'ac') {
      const parts = [];
      if (p.acType) parts.push(p.acType);
      if (+p.cool > 0) parts.push(`制冷 ${n2(p.cool)} kW`);
      if (+p.air > 0) parts.push(`风量 ${n2(p.air)} m³/h`);
      if (+p.temp > 0) parts.push(`送风温度 ${n2(p.temp)} °C`);
      if (+p.supplyRh > 0) parts.push(`送风湿度 ${n2(p.supplyRh)} %RH`);
      if (p.returnTemp) parts.push(`回风设定 ${n2(p.returnTemp)} °C`);
      if (p.supply) parts.push(p.supply);
      if (p.ctrlMode) parts.push(p.ctrlMode);
      if (p.redundancy) parts.push(`冗余 ${p.redundancy}`);
      push('空调', o, specMm(p.w || 2500, p.d || 1300, p.h), parts.join(' · '));
    } else if (o.type === 'vent') {
      const parts = [p.kind || '格栅'];
      if (+p.air > 0) parts.push(`风量 ${n2(p.air)} m³/h`);
      push('地板出风口', o, specMm(p.w || 600, p.d || 600), parts.join(' · '));
    }
  }
  return rows;
}

/* ---------- CSV 组装（纯函数，便于 Node 单测） ---------- */
export function buildBOQ(project) {
  const objs = (project && Array.isArray(project.objects) ? project.objects : [])
    .filter(o => o && o.type)
    .map(o => o.props ? o : { ...o, props: {} }); // 残缺对象补空 props，容错导出
  const meta = (project && project.meta) || {};
  const room = roomInnerSize(objs.filter(o => o.type === 'wall'));

  const lines = [];
  lines.push(row(['机房工程量清单']));
  lines.push(row(['项目名称', project && project.name || '']));
  if (meta.site) lines.push(row(['所属园区/楼宇', meta.site]));
  lines.push(row(['勘测人', meta.surveyor || '']));
  lines.push(row(['勘测日期', meta.date || '']));
  if (meta.coolArch) lines.push(row(['制冷架构', meta.coolArch]));
  if (+meta.powerModule > 0) lines.push(row(['电力模块容量(kVA)', +meta.powerModule]));
  lines.push('');
  lines.push(row(['一、工程量汇总']));
  lines.push(row(['序号', '项目类别', '项目名称', '规格参数', '单位', '数量', '备注']));
  for (const r of summaryRows(objs, room)) lines.push(row(r));
  for (const [i,r] of pipeSummaryRows(objs).entries()) lines.push(row(['LC-'+(i+1),...r]));
  lines.push('');
  lines.push(row(['二、设备明细']));
  lines.push(row(['序号', '设备类型', '编号', '规格', '单位', '数量', '距西(m)', '距南(m)', '参数', '备注', 'Z坐标·底部标高(mm)', '颜色']));
  for (const r of detailRows(objs)) lines.push(row(r));
  for (const r of pipeDetailRows(objs,meta)) lines.push(row(r));
  return lines.join('\r\n') + '\r\n';
}

/* ---------- 导出入口（浏览器下载） ---------- */
export function exportCSV() {
  if (!state.project.objects.length) { ui.hint(t('hint.exportEmpty')); return; }
  const csv = '\uFEFF' + buildBOQ(state.project); // UTF-8 BOM：Excel 双击打开中文不乱码
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.project.name || t('file.pngName')) + t('file.csvSuffix') + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  ui.hint(t('hint.csvDone'));
}
