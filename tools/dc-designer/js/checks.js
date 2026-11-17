/** 合规自检引擎 + 校验报告：把 query.status 的两条临时检查（重叠/越界）扩展为规则集
 *
 * 设计要点：
 * - runChecks(project, cfg) 为纯函数（不读全局 state，Node 单测直接调用，同 csv.js buildBOQ 模式）：
 *   按规则集校验当前设计，返回结构化问题清单 issue[]，面板报告 / CSV·MD 导出 / Agent query.checks 共用
 * - 阈值全部可配置（DEFAULT_CFG 默认值 + localStorage 覆盖 + Agent 临时覆盖）：
 *   规则代码只做比较，不把规范解读硬编码进判断逻辑——报告注明“阈值为用户配置的经验参考值”
 * - issue 形状：{ level, rule, cat, objectIds, actual, expect, msg, x, y }
 *   level ∈ error(严重)/warn(警告)/info(提示)；cat ∈ layout/clearance/power/cooling/fire/load/civil；
 *   actual/expect 为展示用字符串（各规则单位不同）；msg 固定中文（与 CSV 清单同一决策）；
 *   x,y 为定位点（世界坐标 mm，面板点击聚焦用）；objectIds 用于选中高亮
 * - 几何全部复用 geo.js 生产函数：pairClearance（任意旋转两对象净距）、wallClearances
 *   （到四面墙内表面净距，越界为负）、roomInnerBox（房间内空，矩形精确/L 形按外接矩形近似）
 * - 机柜/空调正面朝向约定（与 tools.js podGeometry 一致）：rotation 0=朝北(+Y) 90=朝东(+X) 180=朝南 270=朝西；
 *   前/后净距仅对 90° 倍数旋转求值（拖动/旋转工具均以 90° 步进），其他角度跳过
 */
import { checkPipes } from './pipe-checks.js';
import { deviceZ } from './device.js';
import {
  pairClearance, wallClearances, isSolid, rectOverlap, objOutline,
  roomInnerBox, segIntersectsRect,
} from './geo.js';

/* ---------- 阈值默认配置（全部为经验参考值，用户可在面板修改并持久化） ---------- */
export const DEFAULT_CFG = {
  // —— 净距（mm）——
  cabFront: 900,        // 柜前净距
  cabRear: 600,         // 柜后净距
  cabSideWall: 600,     // 柜侧与墙净距
  coldAisle: 1200,      // 冷通道宽
  hotAisle: 900,        // 热通道宽
  acService: 900,       // 空调检修面净距
  trayMinHeight: 2200,  // 桥架下沿距地最低
  trayAboveCab: 300,    // 桥架下沿高出其下方设备顶面
  // —— 电力 / 制冷 ——
  upsLoadMaxPct: 85,    // UPS 负载率上限(%)
  coolMinRatio: 1.0,    // 制冷量/机柜功率最小配比（冗余折算后）
  densityKW: 10,        // 单柜功率密度提示阈值(kW/柜)
  densityArea: 1.2,     // 面积功率密度提示阈值(kW/m²)
  // —— 消防疏散 ——
  doorMinWidth: 900,    // 疏散门最小净宽(mm)
  twoExitArea: 100,     // 房间面积超过该值(m²)需不少于两个安全出口
  extRadius: 15000,     // 灭火器保护半径(mm)
  extGrid: 500,         // 保护半径采样网格(mm)
  // —— 承重（重量估算系数；对象 props.weight 存在时优先用实测值）——
  floorLoadWarnPct: 80, // 承重占用预警线(%)
  kgPerCabKW: 150,      // 机柜估重 kg/kW
  kgPerUpsKVA: 9,       // UPS 估重 kg/kVA
  kgPerAhCell: 0.3,     // 蓄电池估重 kg/(Ah·只)
  kgPerAC: 350,         // 空调估重 kg/台
  kgPerPDU: 250,        // 列头柜估重 kg/台
  // —— 土建（mm）——
  clearHeightMin: 2400, // 吊顶下净高最低
  underfloorMin: 400,   // 下送风所需架空地板高
  // —— 引擎开关 ——
  disabled: [],               // 关闭的规则 id 列表
  clearIgnoreTypes: ['vent'], // 前/后净距不计为障碍的类型（地板风口与地面齐平，不挡维护通道）
};

/** 级别 / 类别中文名（报告与导出固定中文，面板 UI 经 i18n 另行翻译） */
export const LEVEL_CN = { error: '严重', warn: '警告', info: '提示' };
export const CAT_CN = {
  layout: '布局', clearance: '净距', power: '电力', cooling: '制冷',
  fire: '消防', load: '承重', civil: '土建',
};
/** 对象类型中文名（issue 文案用；与 i18n type.* 对应但报告固定中文） */
const TYPE_CN = {
  wall: '墙体', door: '机房门', window: '窗', grille: '格栅', column: '柱子', cabinet: '机柜',
  tray: '桥架', aisle: '通道', ac: '空调', ups: 'UPS', battery: '蓄电池', pdu: '列头柜', dbox: '配电箱',
  extinguisher: '灭火器', vent: '地板出风口', beam: '框架梁',
};

/* ---------- 小工具 ---------- */
const nm = o => (o.props && o.props.name) || TYPE_CN[o.type] || o.type;
const n0 = v => String(Math.round(+v || 0));
const n1 = v => String(Math.round((+v || 0) * 10) / 10);
const m2 = mm => String(Math.round(+mm / 10) / 100); // mm → m（2 位小数去尾零）

/** 合并用户配置：仅接受 DEFAULT_CFG 已知键（数值型校验有限性），其余忽略 */
function mergeCfg(cfg) {
  const c = { ...DEFAULT_CFG, disabled: [...DEFAULT_CFG.disabled], clearIgnoreTypes: [...DEFAULT_CFG.clearIgnoreTypes] };
  if (cfg && typeof cfg === 'object') {
    for (const k of Object.keys(DEFAULT_CFG)) {
      if (k === 'disabled' || k === 'clearIgnoreTypes') continue;
      const v = +cfg[k];
      if (Number.isFinite(v)) c[k] = v;
    }
    if (Array.isArray(cfg.disabled)) c.disabled = cfg.disabled.map(String);
    if (Array.isArray(cfg.clearIgnoreTypes)) c.clearIgnoreTypes = cfg.clearIgnoreTypes.map(String);
  }
  return c;
}

/** 对象轴对齐包围盒（旋转矩形取外接框；墙/桥架取线段包围盒扩半宽） */
function aabbOf(o, resolve) {
  const poly = objOutline(o, resolve);
  if (!poly) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** 朝向表：rotation → 正面世界方向与对应墙方向（faceClearance 用） */
const FACE_DIRS = {
  0: { dx: 0, dy: 1, wall: 'top', back: 'bottom' },      // 正面朝北
  90: { dx: 1, dy: 0, wall: 'right', back: 'left' },     // 朝东
  180: { dx: 0, dy: -1, wall: 'bottom', back: 'top' },   // 朝南
  270: { dx: -1, dy: 0, wall: 'left', back: 'right' },   // 朝西
};

/** 某对象朝指定面（front/back）的净距：该方向走廊内最近实体净距与对应方向墙净距的较小者。
 * 走廊 = 对象与候选在垂直于朝向轴上的区间有重叠（斜对着的不算正面遮挡）。
 * 返回 { gap, obj|null }（obj=null 表示受制于墙）；无任何参照或旋转非 90° 倍数返回 null。 */
function faceClearance(ctx, o, face) {
  const rot = (((o.rotation || 0) % 360) + 360) % 360;
  if (rot % 90 !== 0) return null;
  const d = FACE_DIRS[rot];
  const dir = face === 'front' ? { dx: d.dx, dy: d.dy } : { dx: -d.dx, dy: -d.dy };
  const wallSide = face === 'front' ? d.wall : d.back;
  const horiz = d.dx !== 0; // 朝向沿 X 轴
  const oBB = aabbOf(o, ctx.resolve);
  if (!oBB) return null;
  let best = null;
  for (const c of ctx.solids) {
    if (c.id === o.id || ctx.ignore.has(c.type)) continue;
    const vx = c.x - o.x, vy = c.y - o.y;
    if (vx * dir.dx + vy * dir.dy <= 0) continue; // 不在该方向半平面
    const cBB = aabbOf(c, ctx.resolve);
    if (!cBB) continue;
    const overlapPerp = horiz
      ? Math.min(oBB.maxY, cBB.maxY) - Math.max(oBB.minY, cBB.minY)
      : Math.min(oBB.maxX, cBB.maxX) - Math.max(oBB.minX, cBB.minX);
    if (overlapPerp <= 1) continue; // 不在走廊内
    const pc = pairClearance(o, c, ctx.resolve);
    if (!pc) continue;
    const g = horiz ? pc.h : pc.v;
    if (!g) continue;
    if (!best || g.gap < best.gap) best = { gap: g.gap, obj: c };
  }
  // 对应方向墙净距（负值=越界，由 outRoom 规则负责，此处只取 ≥0 的）
  if (ctx.walls.length >= 3) {
    const wc = wallClearances(o, ctx.walls, ctx.resolve);
    if (wc && wc[wallSide] >= 0 && (!best || wc[wallSide] < best.gap)) best = { gap: wc[wallSide], obj: null };
  }
  return best;
}

/** 冗余折算：N+1 → (n-1)/n（n≥2）、N+2 → (n-2)/n（n≥3）；声明了冗余但台数不足时 bad=true。
 * 多台取声明中最保守（折算系数最小）的一档，负载按最不利口径报告。 */
function derate(units) {
  let factor = 1, red = '', bad = false;
  const n = units.length;
  for (const u of units) {
    const r = (u.props.redundancy || '').trim();
    if (r === 'N+1') {
      red = red || 'N+1';
      if (n >= 2) factor = Math.min(factor, (n - 1) / n); else bad = true;
    } else if (r === 'N+2') {
      red = 'N+2';
      if (n >= 3) factor = Math.min(factor, (n - 2) / n); else bad = true;
    }
  }
  return { factor, red, bad, n };
}

/* ---------- 规则实现（每条 run(ctx) 向 ctx.issues 追加问题） ---------- */

/** 布局 · 实体重叠（error） */
function checkOverlap(ctx) {
  const s = ctx.solids;
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j++) {
      if (rectOverlap(s[i], s[j])) {
        add(ctx, { level: 'error', rule: 'overlap', cat: 'layout', objects: [s[i], s[j]],
          actual: '重叠', expect: '无重叠',
          msg: `实体重叠：${nm(s[i])} 与 ${nm(s[j])} 占用同一位置，需调整` });
      }
    }
  }
}

/** 布局 · 越出房间（error；墙少于 3 段时跳过） */
function checkOutRoom(ctx) {
  if (ctx.walls.length < 3) return;
  for (const o of ctx.solids) {
    const wc = wallClearances(o, ctx.walls, ctx.resolve);
    if (!wc) continue;
    const min = Math.min(wc.left, wc.right, wc.bottom, wc.top);
    if (min < 0) {
      add(ctx, { level: 'error', rule: 'outRoom', cat: 'layout', objects: [o],
        actual: `越界 ${n0(-min)}mm`, expect: '位于房间内',
        msg: `越出房间：${nm(o)} 越出墙内表面 ${n0(-min)}mm` });
    }
  }
}

/** 净距 · 柜前 / 柜后 / 柜侧与墙（warn） */
function checkCabFront(ctx) {
  for (const o of ctx.of('cabinet')) {
    const r = faceClearance(ctx, o, 'front');
    if (r && r.gap < ctx.cfg.cabFront) {
      add(ctx, { level: 'warn', rule: 'cabFront', cat: 'clearance', objects: r.obj ? [o, r.obj] : [o],
        actual: `${n0(r.gap)}mm`, expect: `≥${n0(ctx.cfg.cabFront)}mm`,
        msg: `柜前净距不足：${nm(o)} 正面距${r.obj ? nm(r.obj) : '墙'} ${n0(r.gap)}mm（建议 ≥${n0(ctx.cfg.cabFront)}mm）` });
    }
  }
}
function checkCabRear(ctx) {
  for (const o of ctx.of('cabinet')) {
    const r = faceClearance(ctx, o, 'back');
    if (r && r.gap < ctx.cfg.cabRear) {
      add(ctx, { level: 'warn', rule: 'cabRear', cat: 'clearance', objects: r.obj ? [o, r.obj] : [o],
        actual: `${n0(r.gap)}mm`, expect: `≥${n0(ctx.cfg.cabRear)}mm`,
        msg: `柜后净距不足：${nm(o)} 背面距${r.obj ? nm(r.obj) : '墙'} ${n0(r.gap)}mm（建议 ≥${n0(ctx.cfg.cabRear)}mm）` });
    }
  }
}
function checkCabSideWall(ctx) {
  if (ctx.walls.length < 3) return;
  for (const o of ctx.of('cabinet')) {
    const rot = (((o.rotation || 0) % 360) + 360) % 360;
    if (rot % 90 !== 0) continue;
    const wc = wallClearances(o, ctx.walls, ctx.resolve);
    if (!wc) continue;
    const sides = (rot === 0 || rot === 180) ? [wc.left, wc.right] : [wc.bottom, wc.top];
    const min = Math.min(...sides);
    if (min >= 0 && min < ctx.cfg.cabSideWall) {
      add(ctx, { level: 'warn', rule: 'cabSideWall', cat: 'clearance', objects: [o],
        actual: `${n0(min)}mm`, expect: `≥${n0(ctx.cfg.cabSideWall)}mm`,
        msg: `柜侧与墙净距偏小：${nm(o)} 侧面距墙 ${n0(min)}mm（建议 ≥${n0(ctx.cfg.cabSideWall)}mm）` });
    }
  }
}

/** 净距 · 通道宽（warn：按冷/热分别对阈值） */
function checkAisleW(ctx) {
  for (const o of ctx.of('aisle')) {
    const cold = (o.props.kind || 'cold') === 'cold';
    const th = cold ? ctx.cfg.coldAisle : ctx.cfg.hotAisle;
    const d = +o.props.d || 0;
    if (d > 0 && d < th) {
      add(ctx, { level: 'warn', rule: 'aisleW', cat: 'clearance', objects: [o],
        actual: `${n0(d)}mm`, expect: `≥${n0(th)}mm`,
        msg: `${cold ? '冷' : '热'}通道宽不足：${nm(o)} 宽 ${n0(d)}mm（建议 ≥${n0(th)}mm）` });
    }
  }
}

/** 净距 · 空调检修面（warn：正面走廊净距） */
function checkAcFront(ctx) {
  for (const o of ctx.of('ac')) {
    const r = faceClearance(ctx, o, 'front');
    if (r && r.gap < ctx.cfg.acService) {
      add(ctx, { level: 'warn', rule: 'acFront', cat: 'clearance', objects: r.obj ? [o, r.obj] : [o],
        actual: `${n0(r.gap)}mm`, expect: `≥${n0(ctx.cfg.acService)}mm`,
        msg: `空调检修面不足：${nm(o)} 正面距${r.obj ? nm(r.obj) : '墙'} ${n0(r.gap)}mm（建议 ≥${n0(ctx.cfg.acService)}mm）` });
    }
  }
}

/** 净距 · 桥架净高（warn/info：距地、下方设备顶距、超吊顶面） */
function checkTrayH(ctx) {
  const ceil = +ctx.meta.ceilHeight || 0;
  for (const o of ctx.of('tray')) {
    const h = +o.props.height || 0;
    if (h <= 0) continue;
    if (h < ctx.cfg.trayMinHeight) {
      add(ctx, { level: 'warn', rule: 'trayH', cat: 'clearance', objects: [o],
        actual: `${n0(h)}mm`, expect: `≥${n0(ctx.cfg.trayMinHeight)}mm`,
        msg: `桥架距地偏低：${nm(o)} 下沿距地 ${n0(h)}mm（建议 ≥${n0(ctx.cfg.trayMinHeight)}mm）` });
    }
    // 桥架与下方设备的垂直净距（取最小者）
    let worst = null;
    for (const s of ctx.solids) {
      if (deviceZ(s) >= h + (+o.props.bodyH || 100)) continue; // 整台设备在桥架上方，不属于下方净高检查
      const sh = +s.props.h || 0;
      if (!sh) continue;
      const bb = aabbOf(s, ctx.resolve);
      if (!bb) continue;
      if (!segIntersectsRect(o.x1, o.y1, o.x2, o.y2, bb.minX, bb.minY, bb.maxX, bb.maxY)) continue;
      const vgap = h - deviceZ(s) - sh;
      if (vgap < ctx.cfg.trayAboveCab && (!worst || vgap < worst.vgap)) worst = { vgap, s };
    }
    if (worst) {
      add(ctx, { level: 'warn', rule: 'trayH', cat: 'clearance', objects: [o, worst.s],
        actual: `${n0(worst.vgap)}mm`, expect: `≥${n0(ctx.cfg.trayAboveCab)}mm`,
        msg: `桥架与下方设备净高不足：${nm(o)} 下沿距 ${nm(worst.s)} 顶面 ${n0(worst.vgap)}mm（建议 ≥${n0(ctx.cfg.trayAboveCab)}mm）` });
    }
    if (ceil > 0 && h + (+o.props.bodyH || 100) > ceil) {
      add(ctx, { level: 'info', rule: 'trayH', cat: 'clearance', objects: [o],
        actual: `${n0(h + (+o.props.bodyH || 100))}mm`, expect: `≤${n0(ceil)}mm`,
        msg: `桥架上沿超出吊顶面：${nm(o)} 上沿 ${n0(h + (+o.props.bodyH || 100))}mm > 吊顶 ${n0(ceil)}mm，请核对敷设路径` });
    }
  }
}

/** 电力 · 总功率 vs 机房总供电容量（error/warn；meta.powerCap 未填给 info） */
function checkPowerCap(ctx) {
  const cap = +ctx.meta.powerCap || 0;
  const total = ctx.cabPower;
  if (total <= 0) return;
  if (!cap) {
    add(ctx, { level: 'info', rule: 'pwrCap', cat: 'power', objects: [],
      actual: `${n1(total)}kW`, expect: '填写机房总供电容量',
      msg: `机柜总功率约 ${n1(total)}kW；未填写「机房总供电容量」（属性面板·汇总页），无法校验供电裕度` });
    return;
  }
  if (total > cap) {
    add(ctx, { level: 'error', rule: 'pwrCap', cat: 'power', objects: [],
      actual: `${n1(total)}kW`, expect: `≤${n1(cap)}kW`,
      msg: `总功率超限：机柜合计 ${n1(total)}kW > 机房总供电容量 ${n1(cap)}kW` });
  } else if (total > cap * 0.8) {
    add(ctx, { level: 'warn', rule: 'pwrCap', cat: 'power', objects: [],
      actual: `${n1(total)}kW`, expect: `≤${n1(cap)}kW（80% 裕度提示）`,
      msg: `供电裕度偏小：机柜合计 ${n1(total)}kW，已达总供电容量 ${n1(cap)}kW 的 ${Math.round(total / cap * 100)}%` });
  }
}

/** 电力 · UPS 负载率与冗余（error/warn/info） */
function checkUpsLoad(ctx) {
  const total = ctx.cabPower;
  if (total <= 0) return;
  const ups = ctx.of('ups');
  if (!ups.length) {
    add(ctx, { level: 'info', rule: 'upsLoad', cat: 'power', objects: [],
      actual: '0 台', expect: '按供电架构配置',
      msg: `机柜总功率 ${n1(total)}kW，但未放置 UPS（如有市电直供/高压直流回路请忽略）` });
    return;
  }
  const kw = ups.reduce((s, o) => s + (+o.props.power || 0), 0);
  const d = derate(ups);
  if (d.bad) {
    add(ctx, { level: 'error', rule: 'upsLoad', cat: 'power', objects: ups,
      actual: `${d.n} 台`, expect: `${d.red} 至少 ${d.red === 'N+2' ? 3 : 2} 台`,
      msg: `UPS 冗余不成立：声明 ${d.red} 但只有 ${d.n} 台` });
  }
  const eff = kw * d.factor;
  if (eff <= 0) {
    add(ctx, { level: 'warn', rule: 'upsLoad', cat: 'power', objects: ups,
      actual: '0kW', expect: '>0kW',
      msg: `UPS 输出功率合计为 0，请核对容量参数` });
    return;
  }
  const rate = total / eff;
  const effTxt = d.factor < 1 ? `（${d.red} 折算 ${n1(eff)}kW）` : '';
  if (rate > 1) {
    add(ctx, { level: 'error', rule: 'upsLoad', cat: 'power', objects: ups,
      actual: `${Math.round(rate * 100)}%`, expect: `≤${n0(ctx.cfg.upsLoadMaxPct)}%`,
      msg: `UPS 超载：机柜负载 ${n1(total)}kW > UPS 合计 ${n1(kw)}kW${effTxt}` });
  } else if (rate > ctx.cfg.upsLoadMaxPct / 100) {
    add(ctx, { level: 'warn', rule: 'upsLoad', cat: 'power', objects: ups,
      actual: `${Math.round(rate * 100)}%`, expect: `≤${n0(ctx.cfg.upsLoadMaxPct)}%`,
      msg: `UPS 负载率偏高：负载 ${n1(total)}kW / 合计 ${n1(kw)}kW${effTxt} = ${Math.round(rate * 100)}%（建议 ≤${n0(ctx.cfg.upsLoadMaxPct)}%）` });
  }
}

/** 电力 · 机柜 A/B 双路（warn：rpdu<2 的机柜汇总一条） */
function checkCabAB(ctx) {
  const single = ctx.of('cabinet').filter(o => (+o.props.rpdu || 0) < 2);
  if (!single.length) return;
  const names = single.slice(0, 8).map(nm).join('、') + (single.length > 8 ? ` 等 ${single.length} 台` : '');
  add(ctx, { level: 'warn', rule: 'cabAB', cat: 'power', objects: single,
    actual: `${single.length} 台单路`, expect: 'RPDU ≥ 2',
    msg: `机柜 A/B 双路不齐全：${names}（RPDU<2，单路供电）` });
}

/** 电力 · 列头柜回路与机柜路数粗核（info：outCircuits 为自由文本，按「N路」解析合计，不逐排挂接） */
function checkPduCap(ctx) {
  const cabN = ctx.of('cabinet').length;
  if (!cabN) return;
  const pdus = ctx.of('pdu');
  if (!pdus.length) {
    add(ctx, { level: 'info', rule: 'pduCap', cat: 'power', objects: [],
      actual: '0 台', expect: '按供电架构配置',
      msg: `已放置 ${cabN} 台机柜但未放置列头柜，请核对机柜供电回路来源` });
    return;
  }
  let circuits = 0, missing = 0;
  for (const p of pdus) {
    const ms = String(p.props.outCircuits || '').match(/(\d+)\s*路/g);
    if (!ms) { missing++; continue; }
    circuits += ms.reduce((s, m) => s + parseInt(m, 10), 0);
  }
  const need = cabN * 2; // A/B 双路
  if (circuits > 0 && circuits < need) {
    add(ctx, { level: 'info', rule: 'pduCap', cat: 'power', objects: pdus,
      actual: `${circuits} 路`, expect: `约 ${need} 路`,
      msg: `列头柜输出回路合计 ${circuits} 路，机柜 A/B 双路需求约 ${need} 路（按总量粗核，未逐排挂接），请核对回路配置` });
  }
  if (missing) {
    add(ctx, { level: 'info', rule: 'pduCap', cat: 'power',
      objects: pdus.filter(p => !/(\d+)\s*路/.test(String(p.props.outCircuits || ''))),
      actual: `${missing} 台未记录`, expect: '记录输出回路',
      msg: `${missing} 台列头柜未记录输出回路（outCircuits），回路校核不完整` });
  }
}

/** 制冷 · 冷量与功率配比（warn：冗余折算后配比低于阈值） */
function checkCoolCap(ctx) {
  const total = ctx.cabPower;
  if (total <= 0) return;
  const acs = ctx.of('ac');
  if (!acs.length) {
    add(ctx, { level: 'warn', rule: 'coolCap', cat: 'cooling', objects: [],
      actual: '0kW', expect: `≥${n1(total)}kW`,
      msg: `机柜发热约 ${n1(total)}kW，但未配置空调` });
    return;
  }
  const cool = acs.reduce((s, o) => s + (+o.props.cool || 0), 0);
  const d = derate(acs);
  if (d.bad) {
    add(ctx, { level: 'warn', rule: 'coolCap', cat: 'cooling', objects: acs,
      actual: `${d.n} 台`, expect: `${d.red} 至少 ${d.red === 'N+2' ? 3 : 2} 台`,
      msg: `空调冗余不成立：声明 ${d.red} 但只有 ${d.n} 台` });
  }
  const eff = cool * d.factor;
  const ratio = eff / total;
  if (ratio < ctx.cfg.coolMinRatio) {
    const effTxt = d.factor < 1 ? `（${d.red} 折算 ${n1(eff)}kW）` : '';
    add(ctx, { level: 'warn', rule: 'coolCap', cat: 'cooling', objects: acs,
      actual: `配比 ${n1(ratio)}`, expect: `≥${n1(ctx.cfg.coolMinRatio)}`,
      msg: `冷量不足：制冷量合计 ${n1(cool)}kW${effTxt} < 机柜发热 ${n1(total)}kW × ${n1(ctx.cfg.coolMinRatio)}` });
  }
}

/** 制冷 · 功率密度提示（info：超阈值才提示） */
function checkDensity(ctx) {
  const cabN = ctx.of('cabinet').length;
  const total = ctx.cabPower;
  if (!cabN || total <= 0) return;
  const avg = total / cabN;
  if (avg > ctx.cfg.densityKW) {
    add(ctx, { level: 'info', rule: 'density', cat: 'cooling', objects: [],
      actual: `${n1(avg)}kW/柜`, expect: `≤${n1(ctx.cfg.densityKW)}kW/柜`,
      msg: `功率密度较高：平均 ${n1(avg)}kW/柜（超过 ${n1(ctx.cfg.densityKW)}kW/柜 提示线），请确认制冷与通道封闭方案` });
  }
  if (ctx.room) {
    const area = ctx.room.L * ctx.room.W / 1e6;
    const da = total / area;
    if (da > ctx.cfg.densityArea) {
      add(ctx, { level: 'info', rule: 'density', cat: 'cooling', objects: [],
        actual: `${n1(da)}kW/m²`, expect: `≤${n1(ctx.cfg.densityArea)}kW/m²`,
        msg: `面积功率密度较高：${n1(da)}kW/m²（房间约 ${n1(area)}m²，超过 ${n1(ctx.cfg.densityArea)}kW/m² 提示线）` });
    }
  }
}

/** 制冷 · 封闭通道识别（info：正向确认 / 高密未封闭建议） */
function checkEnclosed(ctx) {
  const aisles = ctx.of('aisle');
  if (!aisles.length) return;
  const enc = aisles.filter(o => o.props.enclosed !== false);
  if (enc.length) {
    const cold = enc.filter(o => (o.props.kind || 'cold') === 'cold').length;
    add(ctx, { level: 'info', rule: 'enclosed', cat: 'cooling', objects: enc,
      actual: `${enc.length} 条`, expect: '—',
      msg: `已识别封闭通道 ${enc.length} 条（冷 ${cold} / 热 ${enc.length - cold}）` });
  } else {
    const cabN = ctx.of('cabinet').length;
    const avg = cabN ? ctx.cabPower / cabN : 0;
    if (avg > ctx.cfg.densityKW) {
      add(ctx, { level: 'info', rule: 'enclosed', cat: 'cooling', objects: aisles,
        actual: `${n1(avg)}kW/柜 未封闭`, expect: '评估封闭通道',
        msg: `功率密度较高（${n1(avg)}kW/柜）且通道未封闭，建议评估封闭冷/热通道` });
    }
  }
}

/** 消防 · 疏散门（warn：净宽不足 / 向房内开启） */
function checkDoors(ctx) {
  for (const o of ctx.of('door')) {
    const probs = [];
    const w = +o.props.width || 900;
    if (w < ctx.cfg.doorMinWidth) probs.push(`净宽 ${n0(w)}mm < ${n0(ctx.cfg.doorMinWidth)}mm`);
    if (o.props.side === 'in') probs.push('向房内开启（疏散门宜向外开启）');
    if (probs.length) {
      add(ctx, { level: 'warn', rule: 'doorW', cat: 'fire', objects: [o],
        actual: `${n0(w)}mm${o.props.side === 'in' ? ' 朝内' : ''}`, expect: `≥${n0(ctx.cfg.doorMinWidth)}mm 向外`,
        msg: `疏散门问题：${nm(o)} ${probs.join('；')}` });
    }
  }
}

/** 消防 · 安全出口数量（error：无门；面积超阈值且出口少于两个） */
function checkExits(ctx) {
  if (!ctx.room) return;
  const doors = ctx.of('door');
  const area = ctx.room.L * ctx.room.W / 1e6;
  if (!doors.length) {
    add(ctx, { level: 'error', rule: 'exits', cat: 'fire', objects: [],
      actual: '0 个', expect: '≥1 个',
      msg: `房间约 ${n1(area)}m²，未放置机房门（无安全出口）` });
  } else if (area > ctx.cfg.twoExitArea && doors.length < 2) {
    add(ctx, { level: 'error', rule: 'exits', cat: 'fire', objects: doors,
      actual: `${doors.length} 个`, expect: '≥2 个',
      msg: `安全出口不足：房间约 ${n1(area)}m² > ${n0(ctx.cfg.twoExitArea)}m²，安全出口应不少于 2 个（当前 ${doors.length} 个）` });
  }
}

/** 消防 · 灭火器保护半径（warn：房间内网格采样最远点超半径；未配置也 warn） */
function checkExtCover(ctx) {
  const exts = ctx.of('extinguisher');
  if (!exts.length) {
    add(ctx, { level: 'warn', rule: 'extCover', cat: 'fire', objects: [],
      actual: '0 具', expect: '按危险等级配置',
      msg: '未配置灭火器' });
    return;
  }
  if (!ctx.room) return;
  // 内空包围盒网格采样（L 形房间按外接矩形近似，与墙距标尺同口径）；采样点过多时自适应放大网格
  let step = Math.max(100, ctx.cfg.extGrid);
  const nx0 = Math.ceil((ctx.room.L / step) * (ctx.room.W / step));
  if (nx0 > 40000) step = Math.ceil(Math.sqrt(ctx.room.L * ctx.room.W / 40000));
  let worst = 0, wx = 0, wy = 0;
  for (let x = ctx.room.minX + step / 2; x < ctx.room.maxX; x += step) {
    for (let y = ctx.room.minY + step / 2; y < ctx.room.maxY; y += step) {
      let dmin = Infinity;
      for (const e of exts) dmin = Math.min(dmin, Math.hypot(e.x - x, e.y - y));
      if (dmin > worst) { worst = dmin; wx = x; wy = y; }
    }
  }
  if (worst > ctx.cfg.extRadius) {
    add(ctx, { level: 'warn', rule: 'extCover', cat: 'fire', objects: exts, at: { x: wx, y: wy },
      actual: `${m2(worst)}m`, expect: `≤${m2(ctx.cfg.extRadius)}m`,
      msg: `灭火器保护半径覆盖不足：房间内最远点距最近灭火器约 ${m2(worst)}m（限 ${m2(ctx.cfg.extRadius)}m，按内空包围盒网格采样近似）` });
  }
}

/** 承重 · 楼板荷载（error/warn：重量按系数估算、props.weight 优先；meta.floorLoad 未填给 info） */
function checkFloorLoad(ctx) {
  if (!ctx.room) return;
  const cap = +ctx.meta.floorLoad || 0;
  if (!cap) {
    add(ctx, { level: 'info', rule: 'floorLoad', cat: 'load', objects: [],
      actual: '—', expect: '填写楼板承重',
      msg: '未填写「地面承重(kg/m²)」（属性面板·汇总页），无法校验楼板荷载' });
    return;
  }
  const C = ctx.cfg;
  const wOf = o => {
    const p = o.props;
    if (+p.weight > 0) return +p.weight; // 实测重量优先
    switch (o.type) {
      case 'cabinet': return (+p.power || 0) * C.kgPerCabKW;
      case 'ups': return (+p.kva || 0) * C.kgPerUpsKVA;
      case 'battery': return (+p.ah || 0) * (+p.cells || 0) * C.kgPerAhCell;
      case 'ac': return C.kgPerAC;
      case 'pdu': return C.kgPerPDU;
      default: return 0; // 柱子/风口/灭火器忽略
    }
  };
  const kg = ctx.solids.reduce((s, o) => s + wOf(o), 0);
  if (kg <= 0) return;
  const area = ctx.room.L * ctx.room.W / 1e6;
  const load = kg / area;
  const basis = `重量≈${n0(kg)}kg（估算系数可配置，props.weight 优先），房间≈${n1(area)}m²`;
  if (load > cap) {
    add(ctx, { level: 'error', rule: 'floorLoad', cat: 'load', objects: [],
      actual: `${n0(load)}kg/m²`, expect: `≤${n0(cap)}kg/m²`,
      msg: `楼板荷载超限：${basis}，荷载约 ${n0(load)}kg/m² > 承重 ${n0(cap)}kg/m²` });
  } else if (load > cap * C.floorLoadWarnPct / 100) {
    add(ctx, { level: 'warn', rule: 'floorLoad', cat: 'load', objects: [],
      actual: `${n0(load)}kg/m²`, expect: `≤${n0(cap)}kg/m²（${n0(C.floorLoadWarnPct)}% 预警）`,
      msg: `楼板荷载偏高：${basis}，荷载约 ${n0(load)}kg/m²，已达承重 ${n0(cap)}kg/m² 的 ${Math.round(load / cap * 100)}%` });
  }
}

/** 土建 · 房间净高与架空地板（error/warn：墙高 vs 结构层高、吊顶关系、净高、下送风地板高） */
function checkHeight(ctx) {
  const C = ctx.cfg;
  const roomH = +ctx.meta.roomHeight || 0;
  const ceil = +ctx.meta.ceilHeight || 0;
  const walls = ctx.of('wall');
  if (walls.length && roomH > 0) {
    const maxWallH = Math.max(...walls.map(o => +o.props.height || 0));
    if (maxWallH > roomH) {
      add(ctx, { level: 'error', rule: 'height', cat: 'civil', objects: walls.filter(o => (+o.props.height || 0) > roomH),
        actual: `${n0(maxWallH)}mm`, expect: `≤${n0(roomH)}mm`,
        msg: `墙高超过结构层高：墙高 ${n0(maxWallH)}mm > 结构层高 ${n0(roomH)}mm` });
    }
  }
  if (ceil > 0 && roomH > 0 && ceil >= roomH) {
    add(ctx, { level: 'error', rule: 'height', cat: 'civil', objects: [],
      actual: `${n0(ceil)}mm`, expect: `<${n0(roomH)}mm`,
      msg: `吊顶面高 ${n0(ceil)}mm ≥ 结构层高 ${n0(roomH)}mm，请核对汇总页参数` });
  }
  const fh = ctx.meta.floorHeight === undefined || ctx.meta.floorHeight === '' ? 400 : (+ctx.meta.floorHeight || 0);
  const clearH = (ceil > 0 ? ceil : roomH) - fh;
  if ((ceil > 0 || roomH > 0) && clearH > 0 && clearH < C.clearHeightMin) {
    add(ctx, { level: 'warn', rule: 'height', cat: 'civil', objects: [],
      actual: `${n0(clearH)}mm`, expect: `≥${n0(C.clearHeightMin)}mm`,
      msg: `净高不足：${ceil > 0 ? '吊顶面' : '结构层高'} ${n0(ceil > 0 ? ceil : roomH)}mm - 架空地板 ${n0(fh)}mm = ${n0(clearH)}mm（建议 ≥${n0(C.clearHeightMin)}mm）` });
  }
  const downflow = ctx.of('ac').filter(o => o.props.supply === '下送风');
  if (downflow.length && fh < C.underfloorMin) {
    add(ctx, { level: 'warn', rule: 'height', cat: 'civil', objects: downflow,
      actual: `${n0(fh)}mm`, expect: `≥${n0(C.underfloorMin)}mm`,
      msg: `存在下送风空调但架空地板高 ${n0(fh)}mm < ${n0(C.underfloorMin)}mm，静压箱高度不足` });
  }
}

/* ---------- 规则注册表（报告顺序=注册顺序；面板规则开关同用） ---------- */
export const CHECK_RULES = [
  { id: 'pipes', cat: 'cooling', name: '液冷管三维风险与数据', run: checkPipes },
  { id: 'overlap', cat: 'layout', name: '实体重叠', run: checkOverlap },
  { id: 'outRoom', cat: 'layout', name: '越出房间', run: checkOutRoom },
  { id: 'cabFront', cat: 'clearance', name: '柜前净距', run: checkCabFront },
  { id: 'cabRear', cat: 'clearance', name: '柜后净距', run: checkCabRear },
  { id: 'cabSideWall', cat: 'clearance', name: '柜侧与墙净距', run: checkCabSideWall },
  { id: 'aisleW', cat: 'clearance', name: '通道宽度', run: checkAisleW },
  { id: 'acFront', cat: 'clearance', name: '空调检修面', run: checkAcFront },
  { id: 'trayH', cat: 'clearance', name: '桥架净高', run: checkTrayH },
  { id: 'pwrCap', cat: 'power', name: '总供电容量', run: checkPowerCap },
  { id: 'upsLoad', cat: 'power', name: 'UPS负载与冗余', run: checkUpsLoad },
  { id: 'cabAB', cat: 'power', name: '机柜A/B双路', run: checkCabAB },
  { id: 'pduCap', cat: 'power', name: '列头柜回路', run: checkPduCap },
  { id: 'coolCap', cat: 'cooling', name: '冷量配比', run: checkCoolCap },
  { id: 'density', cat: 'cooling', name: '功率密度', run: checkDensity },
  { id: 'enclosed', cat: 'cooling', name: '封闭通道识别', run: checkEnclosed },
  { id: 'doorW', cat: 'fire', name: '疏散门', run: checkDoors },
  { id: 'exits', cat: 'fire', name: '安全出口', run: checkExits },
  { id: 'extCover', cat: 'fire', name: '灭火器保护半径', run: checkExtCover },
  { id: 'floorLoad', cat: 'load', name: '楼板承重', run: checkFloorLoad },
  { id: 'height', cat: 'civil', name: '房间净高', run: checkHeight },
];

/* ---------- 引擎 ---------- */
function add(ctx, { level, rule, cat, objects = [], actual = '', expect = '', msg, at }) {
  const ids = objects.filter(Boolean).map(o => o.id).slice(0, 200);
  let x = at && at.x, y = at && at.y;
  if (x === undefined && objects[0]) {
    const o = objects[0];
    x = o.x !== undefined ? o.x : (o.x1 + o.x2) / 2;
    y = o.y !== undefined ? o.y : (o.y1 + o.y2) / 2;
  }
  ctx.issues.push({
    level, rule, cat, objectIds: ids,
    actual: String(actual), expect: String(expect), msg,
    x: Math.round(x || 0), y: Math.round(y || 0),
  });
}

/** 运行全部规则，返回 issue[]（纯函数；单条规则异常不影响其他规则，异常记为 info 项） */
export function runChecks(project, cfg) {
  const C = mergeCfg(cfg);
  const objs = (project && Array.isArray(project.objects) ? project.objects : [])
    .filter(o => o && o.type)
    .map(o => o.props ? o : { ...o, props: {} });
  const byId = new Map(objs.map(o => [o.id, o]));
  const ctx = {
    project: project || {}, cfg: C, objs,
    meta: (project && project.meta) || {},
    issues: [],
    resolve: id => byId.get(id) || null,
    walls: objs.filter(o => o.type === 'wall'),
    solids: objs.filter(isSolid),
    of: type => objs.filter(o => o.type === type),
    ignore: new Set(C.clearIgnoreTypes),
    cabPower: objs.filter(o => o.type === 'cabinet').reduce((s, o) => s + (+o.props.power || 0), 0),
  };
  ctx.room = roomInnerBox(ctx.walls);
  const disabled = new Set(C.disabled);
  for (const r of CHECK_RULES) {
    if (disabled.has(r.id)) continue;
    try {
      r.run(ctx);
    } catch (e) {
      ctx.issues.push({
        level: 'info', rule: r.id, cat: r.cat, objectIds: [],
        actual: '', expect: '', msg: `规则「${r.name}」执行异常：${e && e.message || e}`, x: 0, y: 0,
      });
    }
  }
  return ctx.issues;
}

/** 问题统计：{ error, warn, info, total } */
export function summarize(issues) {
  const s = { error: 0, warn: 0, info: 0, total: (issues || []).length };
  for (const i of issues || []) if (s[i.level] !== undefined) s[i.level]++;
  return s;
}

/** 命中的规则 id 集合（报告「通过 x/y 条规则」用；执行异常的规则不算通过） */
export function passedRules(issues) {
  const hit = new Set((issues || []).map(i => i.rule));
  return CHECK_RULES.filter(r => !hit.has(r.id)).map(r => r.id);
}

/* ---------- 阈值配置持久化（localStorage；Node 环境自动绕过） ---------- */
const CFG_KEY = 'idc2d_checkcfg_v1';

export function loadCheckCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return mergeCfg(data || {});
  } catch (e) { return mergeCfg({}); }
}

export function saveCheckCfg(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(mergeCfg(cfg))); } catch (e) { /* 隐私模式忽略 */ }
}

export function resetCheckCfg() {
  try { localStorage.removeItem(CFG_KEY); } catch (e) { /* ignore */ }
  return mergeCfg({});
}

/* ---------- 校验报告导出（CSV / Markdown；固定中文，与工程量清单同一决策） ---------- */
const cell = v => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = arr => arr.map(cell).join(',');
const now = ts => {
  const d = ts ? new Date(ts) : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const DISCLAIMER = [
  '说明：本报告按用户可配置阈值生成，阈值为经验参考值，不构成对规范条文的符合性结论。',
  '异形（L 形等）房间按外接矩形近似；承重为估算口径（系数可配置，对象 props.weight 优先）；灭火器覆盖为网格采样近似。',
];

/** CSV 校验报告（不带 BOM，由调用方添加；CRLF 换行同工程量清单） */
export function buildCheckCSV(project, issues, ts) {
  const meta = (project && project.meta) || {};
  const s = summarize(issues);
  const pass = passedRules(issues);
  const lines = [];
  lines.push(csvRow(['机房合规自检报告']));
  lines.push(csvRow(['项目名称', (project && project.name) || '']));
  if (meta.site) lines.push(csvRow(['所属园区/楼宇', meta.site]));
  lines.push(csvRow(['勘测人', meta.surveyor || '']));
  lines.push(csvRow(['勘测日期', meta.date || '']));
  lines.push(csvRow(['报告生成时间', now(ts)]));
  lines.push('');
  lines.push(csvRow(['一、结果概览']));
  lines.push(csvRow(['严重', s.error]));
  lines.push(csvRow(['警告', s.warn]));
  lines.push(csvRow(['提示', s.info]));
  lines.push(csvRow(['通过规则', `${pass.length}/${CHECK_RULES.length}`]));
  lines.push('');
  lines.push(csvRow(['二、问题明细']));
  lines.push(csvRow(['序号', '级别', '类别', '规则', '涉及对象', '实测值', '建议值', '说明', '定位X(m)', '定位Y(m)']));
  let i = 1;
  for (const it of issues) {
    lines.push(csvRow([
      i++, LEVEL_CN[it.level] || it.level, CAT_CN[it.cat] || it.cat,
      (CHECK_RULES.find(r => r.id === it.rule) || {}).name || it.rule,
      it.objectIds.join(' '), it.actual, it.expect, it.msg, m2(it.x), m2(it.y),
    ]));
  }
  if (!issues.length) lines.push(csvRow(['—', '—', '—', '—', '—', '—', '—', '全部规则通过，未发现问题', '', '']));
  lines.push('');
  for (const d of DISCLAIMER) lines.push(csvRow([d]));
  return lines.join('\r\n') + '\r\n';
}

/** Markdown 校验报告 */
export function buildCheckMD(project, issues, ts) {
  const meta = (project && project.meta) || {};
  const s = summarize(issues);
  const pass = passedRules(issues);
  const L = [];
  L.push(`# 机房合规自检报告`);
  L.push('');
  L.push(`- 项目名称：${(project && project.name) || ''}`);
  if (meta.site) L.push(`- 所属园区/楼宇：${meta.site}`);
  L.push(`- 勘测人：${meta.surveyor || ''}　勘测日期：${meta.date || ''}`);
  L.push(`- 报告生成时间：${now(ts)}`);
  L.push('');
  L.push(`## 结果概览`);
  L.push('');
  L.push(`| 严重 | 警告 | 提示 | 通过规则 |`);
  L.push(`| ---: | ---: | ---: | ---: |`);
  L.push(`| ${s.error} | ${s.warn} | ${s.info} | ${pass.length}/${CHECK_RULES.length} |`);
  L.push('');
  L.push(`## 问题明细`);
  L.push('');
  if (!issues.length) {
    L.push(`全部规则通过，未发现问题。`);
  } else {
    L.push(`| # | 级别 | 类别 | 规则 | 实测值 | 建议值 | 说明 | 定位 |`);
    L.push(`| ---: | --- | --- | --- | --- | --- | --- | --- |`);
    issues.forEach((it, idx) => {
      const rn = (CHECK_RULES.find(r => r.id === it.rule) || {}).name || it.rule;
      L.push(`| ${idx + 1} | ${LEVEL_CN[it.level] || it.level} | ${CAT_CN[it.cat] || it.cat} | ${rn} | ${it.actual} | ${it.expect} | ${it.msg} | (${m2(it.x)}, ${m2(it.y)}) |`);
    });
  }
  L.push('');
  L.push(`---`);
  for (const d of DISCLAIMER) L.push(`> ${d}`);
  L.push('');
  return L.join('\n');
}
