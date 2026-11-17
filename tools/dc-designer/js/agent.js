/**
 * AI Agent 指令执行器（页内）—— 外部 Agent 远程驱动编辑器
 *
 * 工作原理：长轮询服务端 /api/agent/next 领取指令 → 调用页内现有导出函数
 * （state/tools/collision/aislelink…）真实执行 → POST /api/agent/done 回传结果。
 * 与手工操作共享同一份 state、撤销栈与全部领域规则（自动编号/互斥推挤/通道宽联动），
 * 画布上实时呈现每一步效果；无指令时仅静默长轮询，对编辑器零影响。
 *
 * 接口契约：public/api/agent/openapi.json（GET /api/agent/openapi.json）
 * 返回给调用方的错误消息固定中文，便于 Agent 直接转述给用户。
 */
import {
  state, ui, pushUndo, markDirty, undo, redo, undoDepth,
  deleteObjects, getObj, autoName, sanitize, newProject, defaultProps,
} from './state.js';
import { uid, roomWalls, wallLen, beamEnds, clamp, rectOverlap, isSolid } from './geo.js';
import { resolveOverlaps } from './collision.js';
import { syncAisleWidth } from './aislelink.js';
import { parseTemplate } from './naming.js';
import { normalizeCabColor } from './cabinetcolor.js';
import { isDevice, deviceZ } from './device.js';
import { normalizePipe, translatePipe, pipeGeometry } from './pipe-geometry.js';
import { buildDXF } from './dxf.js';
import { buildBOQ } from './csv.js';
import { runChecks, summarize, loadCheckCfg, DEFAULT_CFG } from './checks.js';
import * as tools from './tools.js';
import { t } from './i18n.js';
import { apiUrl } from './api-base.js';
import { onPanelState, onPanelBusy } from './panels.js';
import { initAiPanel } from './ai/ai-panel.js';
import { unknownToolMessage } from './toolhints.js';

/* ---------- 参数校验（对 Agent 输出不信任：全部强校验，失败中文报错且不留半成品） ---------- */
class ArgError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function num(v, name, min, max, dflt) {
  if (v == null || v === '') {
    if (dflt !== undefined) return dflt;
    throw new ArgError('BAD_PARAM', `缺少必填参数 ${name}`);
  }
  const n = +v;
  if (!Number.isFinite(n)) throw new ArgError('BAD_PARAM', `参数 ${name} 必须为数字（当前值：${v}）`);
  if (n < min || n > max) throw new ArgError('BAD_PARAM', `参数 ${name}=${n} 超出允许范围 [${min}, ${max}]（单位 mm）`);
  return n;
}

function oneOf(v, name, list, dflt) {
  if (v == null || v === '') {
    if (dflt !== undefined) return dflt;
    throw new ArgError('BAD_PARAM', `缺少必填参数 ${name}（可选：${list.join(' / ')}）`);
  }
  if (!list.includes(v)) throw new ArgError('BAD_PARAM', `参数 ${name}=${v} 无效，必须是：${list.join(' / ')}`);
  return v;
}

function str(v, name, maxLen = 64) {
  if (v == null || v === '') throw new ArgError('BAD_PARAM', `缺少必填参数 ${name}`);
  return String(v).slice(0, maxLen);
}

function idsArray(v) {
  if (!Array.isArray(v) || !v.length) throw new ArgError('BAD_PARAM', 'ids 必须为非空数组（对象 id 列表）');
  return v.slice(0, 500).map(String);
}

function normRot(v) {
  const r = num(v, 'rotation', 0, 360, 0);
  if (r % 90 !== 0) throw new ArgError('BAD_PARAM', 'rotation 必须为 0 / 90 / 180 / 270');
  return r % 360;
}

/** 设备 Z 为顶层位置字段；与 props.h（高度）区分，非法输入在记撤销前拒绝。 */
function zPatch(a, targets) {
  if (a.z === undefined) return {};
  if (targets.some(o => !isDevice(o))) throw new ArgError('BAD_PARAM', 'z 仅适用于设备对象；管道请使用 z1/z2，建筑构件沿用原有标高字段');
  if (typeof a.z !== 'number' && typeof a.z !== 'string') throw new ArgError('BAD_PARAM', '参数 z 必须为有限数字（单位 mm）');
  return { z: num(a.z, 'z', -1000000, 1000000) };
}

/** 属性补丁白名单化：仅标量（字符串≤200/有限数字/布尔）、机柜 sockets 列表与设备颜色，结构性字段（id/type/wallId）不可改 */
function propsPatch(v) {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ArgError('BAD_PARAM', 'props 必须为对象');
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === 'id' || k === 'type' || k === 'wallId' || k === 'z') continue;
    if (k === 'color') { // 设备颜色：只收 #rgb/#rrggbb（空串=该类型默认色），非法值丢弃不写入数据
      if (typeof val !== 'string') continue;
      const c = normalizeCabColor(val);
      if (c || val.trim() === '') out[k] = c;
      continue;
    }
    if (typeof val === 'string') out[k] = val.slice(0, 200);
    else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    else if (typeof val === 'boolean') out[k] = val;
    else if (k === 'sockets' && Array.isArray(val)) {
      out[k] = val.filter(s => s && typeof s.type === 'string' && Number.isFinite(+s.count))
        .map(s => ({ type: String(s.type).slice(0, 40), count: +s.count }));
    }
  }
  return out;
}

/* ---------- 房间范围预检（墙包围盒内缩半墙厚；无房间不约束） ---------- */
function roomInnerBBox() {
  const walls = state.project.objects.filter(o => o.type === 'wall');
  if (walls.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, th = 0;
  for (const w of walls) {
    minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
    th = Math.max(th, +w.props.thickness || 240);
  }
  return { minX: minX + th / 2, minY: minY + th / 2, maxX: maxX - th / 2, maxY: maxY - th / 2 };
}

function rectBB(cx, cy, rot, w, d) {
  const rad = (rot || 0) * Math.PI / 180, c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  const ex = w / 2 * c + d / 2 * s, ey = w / 2 * s + d / 2 * c;
  return { minX: cx - ex, maxX: cx + ex, minY: cy - ey, maxY: cy + ey };
}

/** 整体越界（外扩 2m 仍无交集）→ 抛错拒绝；部分越界 → 返回警告文案（不阻止，与手工行为一致） */
function roomCheck(bb, what) {
  const r = roomInnerBBox();
  if (!r) return null;
  const M = 2000;
  if (bb.maxX < r.minX - M || bb.minX > r.maxX + M || bb.maxY < r.minY - M || bb.minY > r.maxY + M) {
    throw new ArgError('OUT_OF_ROOM',
      `${what}整体位于房间墙包围盒之外（容差 2m），已取消；房间内空约 ${Math.round(r.maxX - r.minX)}×${Math.round(r.maxY - r.minY)}mm，请检查坐标`);
  }
  if (bb.minX < r.minX || bb.minY < r.minY || bb.maxX > r.maxX || bb.maxY > r.maxY) {
    return `${what}部分越出房间墙包围盒，请核对位置`;
  }
  return null;
}

/* ---------- 结果辅助 ---------- */
/** 对象摘要（id / 类型 / 名称 + 几何位置）：新建回传 added 与 query.objects 共用同一形状。
 *  坐标必须一起回传——AI 要凭实坐标试算落位、核对推挤结果与自检，不能靠记忆反推（矩形给 x,y,rotation；墙/桥架给两端点）。 */
const brief = o => {
  const p = o.props || {};
  const pos = o.x !== undefined
    ? { x: Math.round(o.x), y: Math.round(o.y), rotation: o.rotation || 0 }
    : (o.x1 !== undefined ? { x1: Math.round(o.x1), y1: Math.round(o.y1), x2: Math.round(o.x2), y2: Math.round(o.y2) } : {});
  return { id: o.id, type: o.type, name: p.name, ...pos,
    ...(isDevice(o) ? { z: deviceZ(o), color: normalizeCabColor(p.color) } : {}),
    ...(o.type==='pipe'?{x1:o.x1,y1:o.y1,z1:o.z1,x2:o.x2,y2:o.y2,z2:o.z2,systemId:o.systemId,circuitId:o.circuitId,pairId:o.pairId,props:{...p},length:pipeGeometry(o).length}: {}) };
};
const addedSince = n => state.project.objects.slice(n).map(brief);

function stats() {
  const byType = {};
  let power = 0;
  for (const o of state.project.objects) {
    byType[o.type] = (byType[o.type] || 0) + 1;
    if (o.type === 'cabinet') power += +o.props.power || 0;
  }
  return { total: state.project.objects.length, byType, powerKW: +power.toFixed(1) };
}

function shot(fit) {
  try {
    if (fit) ui.fit();
    const cv = document.getElementById('cv');
    return cv ? cv.toDataURL('image/png') : null;
  } catch (e) { return null; }
}

/** 视图缩放到指定对象（带 2.5 倍边距留白），供 view.shot focusId 使用 */
function focusObj(o) {
  const cv = document.getElementById('cv');
  if (!cv) return;
  const bb = o.x !== undefined
    ? rectBB(o.x, o.y, o.rotation, o.props.w || 600, o.props.d || 600)
    : { minX: Math.min(o.x1, o.x2), maxX: Math.max(o.x1, o.x2), minY: Math.min(o.y1, o.y2), maxY: Math.max(o.y1, o.y2) };
  const bw = Math.max(600, bb.maxX - bb.minX) * 2.5;
  const bh = Math.max(600, bb.maxY - bb.minY) * 2.5;
  const cw = cv.clientWidth || 800, ch = cv.clientHeight || 600;
  const scale = Math.min(cw / bw, ch / bh);
  const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
  state.view = { scale, ox: cw / 2 - cx * scale, oy: ch / 2 + cy * scale }; // 屏幕 y = oy - 世界y·scale
  if (ui.zoom) ui.zoom(scale); // 同步状态栏缩放百分比
  ui.render();
}

/* ---------- 指令集（每条指令 = 一步撤销；与手工操作同一撤销栈） ---------- */
/** 可旋转类型（唯一清单）：过滤与报错文案共用，避免“代码白名单”和“报错文案”两份名单走偏。
 *  须与 tools.js rotateSelected() 的可转范围一致（设备 + 柱子 + 管道）。 */
const ROTATE_TYPES = {
  cabinet: '机柜', column: '柱子', ac: '空调', ups: 'UPS', battery: '蓄电池',
  extinguisher: '灭火器', vent: '风口', pdu: '列头柜', dbox: '配电箱', pipe: '管道',
};
const ROTATE_HINT = Object.values(ROTATE_TYPES).join('/');
const HANDLERS = {
  /** 按内空尺寸建矩形房间四面墙（同向导第 1 步：墙中心线外移半墙厚，内空=输入尺寸）；x0/y0 可整体偏移（建子区域/多房间） */
  'room.rect'(a) {
    const L = num(a.lenX, 'lenX', 1000, 200000);
    const Wd = num(a.lenY, 'lenY', 1000, 200000);
    const wdp = defaultProps('wall'); // 未显式传参时默认值跟随上一次设置（与手工画墙一致）
    const th = num(a.thickness, 'thickness', 60, 1000, wdp.thickness || 240);
    const h = num(a.height, 'height', 2000, 10000, wdp.height || 3000);
    const mat = oneOf(a.material, 'material', ['砖墙', '混凝土', '轻钢龙骨', '玻璃隔断'], wdp.material || '砖墙');
    const x0 = num(a.x0, 'x0', -1000000, 1000000, 0);
    const y0 = num(a.y0, 'y0', -1000000, 1000000, 0);
    const before = state.project.objects.length;
    pushUndo();
    for (const w of roomWalls(L, Wd, th)) {
      w.props.name = autoName(t('auto.wall'));
      w.props.height = h;
      w.props.material = mat;
      w.x1 += x0; w.x2 += x0; w.y1 += y0; w.y2 += y0; // 整体偏移
      state.project.objects.push(w);
    }
    markDirty();
    ui.fit();
    ui.hint(t('hint.roomDone', { l: L, w: Wd }));
    return { added: addedSince(before), hint: `已创建矩形房间 ${L}×${Wd}mm（内空，西南角内表面位于 ${x0},${y0}），墙厚 ${th}mm，返回 4 段墙（南→东→北→西）的 id 供开洞使用` };
  },

  /** 自由墙段（风墙/隔断/异形房间/通道封端墙），线段两端点 + 厚度 */
  'wall.add'(a) {
    const x1 = num(a.x1, 'x1', -1000000, 1000000), y1 = num(a.y1, 'y1', -1000000, 1000000);
    const x2 = num(a.x2, 'x2', -1000000, 1000000), y2 = num(a.y2, 'y2', -1000000, 1000000);
    const L = Math.hypot(x2 - x1, y2 - y1);
    if (L < 100) throw new ArgError('BAD_PARAM', `墙段长度 ${Math.round(L)}mm 小于下限 100mm`);
    const wdp = defaultProps('wall'); // 默认值跟随上一次设置
    const th = num(a.thickness, 'thickness', 60, 1000, wdp.thickness || 240);
    const h = num(a.height, 'height', 2000, 10000, wdp.height || 3000);
    const mat = oneOf(a.material, 'material', ['砖墙', '混凝土', '轻钢龙骨', '玻璃隔断'], wdp.material || '砖墙');
    const before = state.project.objects.length;
    pushUndo();
    const o = {
      id: uid(), type: 'wall', x1, y1, x2, y2,
      props: { name: a.name ? String(a.name).slice(0, 64) : autoName(t('auto.wall')), thickness: th, height: h, material: mat },
    };
    state.project.objects.push(o);
    markDirty();
    return { added: addedSince(before), hint: `已绘制墙段 ${o.props.name}（长 ${Math.round(L)}mm，厚 ${th}mm，${mat}），可在其上 opening.add 开洞（如冷通道端门）` };
  },

  /** 通道 POD 批量生成（同向导第 2 步：冷=面对面、热=背对背、冷热交替、所选类型封闭） */
  'pod.create'(a) {
    const rows = num(a.rows, 'rows', 2, 26);
    const count = num(a.count, 'count', 1, 60);
    if (rows * count > 300) throw new ArgError('TOO_LARGE', `单次 POD 规模 ${rows}×${count}=${rows * count} 台超过上限 300`);
    const cfg = {
      kind: oneOf(a.firstAisle, 'firstAisle', ['cold', 'hot'], 'cold'),
      w: num(a.cabW, 'cabW', 400, 1200, 600),
      d: num(a.cabD, 'cabD', 600, 1600, 1200),
      rows, count,
      gap: num(a.gap, 'gap', 0, 1000, 50),
      aisleWC: num(a.coldW, 'coldW', 600, 3000, 1200),
      aisleWH: num(a.hotW, 'hotW', 600, 3000, 900),
      axis: oneOf(a.axis, 'axis', ['x', 'y'], 'x'),
      tpl: String(a.tpl || 'A##').toUpperCase(),
    };
    const pt = parseTemplate(cfg.tpl);
    if (!pt.ok || !pt.slot) throw new ArgError('BAD_TEMPLATE', `编号模板 ${cfg.tpl} 无效：POD 需含排号字母（如 A##、101-A##）`);
    const cabPatch = propsPatch(a.cabinetProps); // 柜级属性下发（power/voltage/sockets 等；w/d 由布局参数决定，忽略）
    delete cabPatch.w; delete cabPatch.d;
    const x = num(a.x, 'x', -1000000, 1000000);
    const y = num(a.y, 'y', -1000000, 1000000);
    // 布局包围盒预检（复用页内几何函数，与最终放置完全一致）
    const geo = tools.podGeometry(cfg, x, y);
    let bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const row of geo.rows) {
      for (let i = 0; i < count; i++) {
        const cx = geo.horiz ? x + i * geo.pitch : row.x;
        const cy = geo.horiz ? row.y : y + i * geo.pitch;
        const b = rectBB(cx, cy, row.rotation, cfg.w, cfg.d);
        bb = { minX: Math.min(bb.minX, b.minX), minY: Math.min(bb.minY, b.minY), maxX: Math.max(bb.maxX, b.maxX), maxY: Math.max(bb.maxY, b.maxY) };
      }
    }
    const warn = roomCheck(bb, `POD（${rows} 排×${count} 台）`);
    const before = state.project.objects.length;
    state.podCfg = cfg;
    tools.placeCabPod(x, y, true); // 内部：pushUndo→生成→互斥推挤→编号→通道带
    const added = addedSince(before);
    if (Object.keys(cabPatch).length) { // 同一步撤销内应用柜级属性
      for (const o of state.project.objects.slice(before)) if (o.type === 'cabinet') Object.assign(o.props, cabPatch);
      markDirty({ props: false });
    }
    const cabs = added.filter(o => o.type === 'cabinet');
    return {
      added,
      hint: `已放置 POD：${rows} 排×${count} 台机柜（${cabs[0]?.name || ''}~${cabs[cabs.length - 1]?.name || ''}），` +
        `${cfg.kind === 'cold' ? '冷' : '热'}通道封闭、冷热交替（冷 ${cfg.aisleWC} / 热 ${cfg.aisleWH}mm），生成通道带 ${added.length - cabs.length} 条` +
        (Object.keys(cabPatch).length ? `，柜级属性已下发（${Object.keys(cabPatch).join('、')}）` : ''),
      ...(warn ? { warnings: [warn] } : {}),
    };
  },

  /** 单排机柜批量放置 */
  'row.create'(a) {
    const count = num(a.count, 'count', 1, 100);
    const rotation = normRot(a.rotation);
    const cfg = {
      w: num(a.cabW, 'cabW', 400, 1200, 600),
      d: num(a.cabD, 'cabD', 600, 1600, 1200),
      gap: num(a.gap, 'gap', 0, 1000, 50),
      count, rotation,
      tpl: String(a.tpl || '').toUpperCase(),
    };
    if (cfg.tpl) {
      const pt = parseTemplate(cfg.tpl);
      if (!pt.ok) throw new ArgError('BAD_TEMPLATE', `编号模板 ${cfg.tpl} 无效（如 A##、101-A##；#=序号位）`);
    }
    const x = num(a.x, 'x', -1000000, 1000000);
    const y = num(a.y, 'y', -1000000, 1000000);
    const pitch = cfg.w + cfg.gap, axisX = rotation % 180 === 0;
    const bb = rectBB(
      axisX ? x + (count - 1) * pitch / 2 : x,
      axisX ? y : y + (count - 1) * pitch / 2,
      0,
      (axisX ? (count - 1) * pitch + cfg.w : cfg.d),
      (axisX ? cfg.d : (count - 1) * pitch + cfg.w));
    const warn = roomCheck(bb, `机柜排（${count} 台）`);
    const before = state.project.objects.length;
    state.rowCfg = cfg;
    tools.placeCabRow(x, y, true);
    const added = addedSince(before);
    const cabPatch = propsPatch(a.cabinetProps); // 柜级属性下发（w/d 由布局参数决定，忽略）
    delete cabPatch.w; delete cabPatch.d;
    if (Object.keys(cabPatch).length) {
      for (const o of state.project.objects.slice(before)) Object.assign(o.props, cabPatch);
      markDirty({ props: false });
    }
    return {
      added,
      hint: `已放置单排机柜 ${count} 台（${added[0]?.name || ''}~${added[added.length - 1]?.name || ''}，朝向 ${rotation}°）` +
        (Object.keys(cabPatch).length ? `，柜级属性已下发（${Object.keys(cabPatch).join('、')}）` : ''),
      ...(warn ? { warnings: [warn] } : {}),
    };
  },

  /** 单台对象：column/ac/ups/battery/extinguisher/vent/pdu/dbox/cabinet（坐标为中心点）、
   *  tray 桥架（线段）或 beam 框架梁（线段，端点落在柱子上自动附着柱心并随柱移动） */
  'obj.add'(a) {
    const type = oneOf(a.type, 'type', ['column', 'ac', 'ups', 'battery', 'extinguisher', 'vent', 'pdu', 'dbox', 'cabinet', 'tray', 'beam', 'pipe']);
    const patch = propsPatch(a.props);
    const elevation = zPatch(a, [{ type }]);
    if(type==='pipe') {
      // 不经宽松 propsPatch 吞掉坏尺寸/颜色：管道完整验证后才落库、记撤销。
      let o;
      try{o=normalizePipe({id:uid(),type:'pipe',...Object.fromEntries(['x1','y1','z1','x2','y2','z2','systemId','circuitId','pairId'].map(k=>[k,a[k]])),
        props:{...defaultProps('pipe'),...a.props,name:a.name||autoName(t('auto.pipe'))}});}catch(e){throw new ArgError('BAD_PARAM',e.message);}
      pushUndo();state.project.objects.push(o);markDirty();return {added:[brief(o)],hint:'已创建液冷直管（非管件拓扑）'};
    }
    const before = state.project.objects.length;
    if (type === 'beam') { // 框架梁：x1,y1→x2,y2 中心线；端点落在柱子包围盒内自动附着（记柱 id）
      let x1 = num(a.x1, 'x1', -1000000, 1000000), y1 = num(a.y1, 'y1', -1000000, 1000000);
      let x2 = num(a.x2, 'x2', -1000000, 1000000), y2 = num(a.y2, 'y2', -1000000, 1000000);
      const snapCol = (x, y) => state.project.objects.find(o => o.type === 'column' &&
        Math.abs(x - o.x) <= (o.props.w || 600) / 2 && Math.abs(y - o.y) <= (o.props.d || 600) / 2) || null;
      const c1 = snapCol(x1, y1), c2 = snapCol(x2, y2);
      if (c1) { x1 = c1.x; y1 = c1.y; }
      if (c2) { x2 = c2.x; y2 = c2.y; }
      if (Math.hypot(x2 - x1, y2 - y1) < 100) throw new ArgError('BAD_PARAM', '梁跨长度不能小于 100mm');
      const bdp = defaultProps('beam'); // 未显式传参时默认值跟随上一次设置（与手工绘制一致）
      const regTop = +(state.lastProps.beam && state.lastProps.beam.top) || 0;
      const colTop = Math.max(c1 ? (+c1.props.h || 0) : 0, c2 ? (+c2.props.h || 0) : 0);
      const props = {
        name: autoName(t('auto.beam')),
        b: num(a.b, 'b', 100, 2000, bdp.b || 300),                 // 梁宽
        h: num(a.h, 'h', 200, 3000, bdp.h || 600),                 // 梁高（截面高）
        top: num(a.top, 'top', 200, 20000, regTop > 0 ? regTop : (colTop > 0 ? colTop : (+bdp.top || 3000))), // 梁顶标高
        concrete: oneOf(a.concrete, 'concrete', ['C25', 'C30', 'C35', 'C40', 'C45', 'C50'], bdp.concrete || 'C30'),
        kind: oneOf(a.kind, 'kind', ['框架梁', '次梁', '悬挑梁'], bdp.kind || '框架梁'),
        ...patch,
      };
      if (a.name) props.name = String(a.name).slice(0, 64);
      pushUndo();
      state.project.objects.push({ id: uid(), type: 'beam', x1, y1, x2, y2, col1: c1 ? c1.id : null, col2: c2 ? c2.id : null, props });
      markDirty();
      const L = Math.round(Math.hypot(x2 - x1, y2 - y1));
      return { added: addedSince(before), hint: `已绘制${props.kind} ${props.name}（跨 ${L}mm，截面 ${props.b}×${props.h}，梁顶 ${props.top}，${props.concrete}）` +
        (c1 || c2 ? `，端点附着柱${[c1 && c1.props.name, c2 && c2.props.name].filter(Boolean).join('、')}` : '') };
    }
    if (type === 'tray') {
      const x1 = num(a.x1, 'x1', -1000000, 1000000), y1 = num(a.y1, 'y1', -1000000, 1000000);
      const x2 = num(a.x2, 'x2', -1000000, 1000000), y2 = num(a.y2, 'y2', -1000000, 1000000);
      if (Math.hypot(x2 - x1, y2 - y1) < 100) throw new ArgError('BAD_PARAM', '桥架长度不能小于 100mm');
      const tdp = defaultProps('tray'); // 未显式传参时默认值跟随上一次设置（与手工绘制一致）
      const props = {
        name: autoName(t('auto.tray')),
        width: num(a.width, 'width', 50, 2000, tdp.width || 300),
        height: num(a.height, 'height', 100, 8000, tdp.height || 2500), // 距地高度
        bodyH: +tdp.bodyH || 100,
        kind: oneOf(a.kind, 'kind', ['强电', '弱电', '光纤'], tdp.kind || '弱电'),
        ...patch,
      };
      if (a.name) props.name = String(a.name).slice(0, 64); // 自定义名称（与矩形对象一致）
      pushUndo();
      state.project.objects.push({ id: uid(), type: 'tray', x1, y1, x2, y2, props });
      markDirty();
      return { added: addedSince(before), hint: `已绘制${props.kind}桥架 ${Math.round(Math.hypot(x2 - x1, y2 - y1))}mm（宽 ${props.width}，距地 ${props.height}）` };
    }
    const x = num(a.x, 'x', -1000000, 1000000);
    const y = num(a.y, 'y', -1000000, 1000000);
    const rotation = normRot(a.rotation);
    // 默认属性与编辑器手工放置（tools.placeRect）保持同一来源：出厂默认 ⊕ 上一次设置
    const props = { name: autoName(t('auto.' + type)), ...defaultProps(type), ...patch };
    if (a.name) props.name = String(a.name).slice(0, 64);
    const warn = roomCheck(rectBB(x, y, rotation, props.w, props.d), props.name);
    pushUndo();
    const o = { id: uid(), type, x, y, rotation, ...(isDevice({ type }) ? { z: 0 } : {}), ...elevation, props };
    state.project.objects.push(o);
    const r = resolveOverlaps([o]); // 新对象为锚，推开重叠旧对象（与手工一致）
    markDirty();
    return {
      added: addedSince(before),
      hint: `已放置 ${props.name}（${props.w}×${props.d}mm）` + (r.moved ? `，推开 ${r.moved} 个重叠对象` : ''),
      ...(warn ? { warnings: [warn] } : {}),
    };
  },

  /** 门/窗/格栅开洞（依附墙体：wallId + t 沿墙 0~1） */
  'opening.add'(a) {
    const type = oneOf(a.type, 'type', ['door', 'window', 'grille']);
    const wall = getObj(str(a.wallId, 'wallId'));
    if (!wall || wall.type !== 'wall') throw new ArgError('NOT_FOUND', `墙体 ${a.wallId} 不存在（room.rect 返回的 added 列表含各段墙 id）`);
    const L = wallLen(wall);
    const odp = defaultProps(type); // 门/窗/格栅默认值跟随上一次设置（与手工 openingDown 一致）
    const width = num(a.width, 'width', 300, 6000, odp.width || 1500);
    if (L < width + 100) throw new ArgError('WALL_TOO_SHORT', `墙长 ${Math.round(L)}mm 放不下宽 ${width}mm 的洞口，请换更长的墙或减小宽度`);
    const tPos = clamp(num(a.t, 't', 0, 1, 0.5), width / 2 / L, 1 - width / 2 / L);
    const before = state.project.objects.length;
    pushUndo();
    const o = {
      id: uid(), type, wallId: wall.id, t: tPos,
      props: { name: autoName(t('auto.' + type)), ...odp, width, ...propsPatch(a.props) },
    };
    state.project.objects.push(o);
    markDirty();
    return { added: addedSince(before), hint: `已在 ${wall.props.name || '墙体'} 上开洞：${o.props.name}（宽 ${width}mm，距墙起点 ${Math.round(tPos * L)}mm）` };
  },

  /** 修改属性；通道带改 d（通道宽）自动触发整排联动平移；挂墙门窗/格栅可用 t 沿墙移位 */
  'obj.update'(a) {
    const o = getObj(str(a.id, 'id'));
    if (!o) throw new ArgError('NOT_FOUND', `对象 ${a.id} 不存在（可用 query.status 或前序指令返回值获取 id）`);
    const patch = propsPatch(a.props);
    const elevation = zPatch(a, [o]);
    if(o.type==='pipe') {
      const geo=Object.fromEntries(['x1','y1','z1','x2','y2','z2','systemId','circuitId','pairId'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]]));
      let n;try{n=normalizePipe({...o,...geo,props:{...o.props,...a.props}});}catch(e){throw new ArgError('BAD_PARAM',e.message);}
      pushUndo();Object.assign(o,n);markDirty();return {added:[],object:JSON.parse(JSON.stringify(o)),hint:'已更新管道几何/规格'};
    }
    if (!Object.keys(patch).length && a.t == null && a.z === undefined) throw new ArgError('BAD_PARAM', 'props 为空或无有效字段');
    pushUndo();
    const oldD = o.type === 'aisle' ? +o.props.d || 0 : 0;
    Object.assign(o.props, patch);
    Object.assign(o, elevation);
    let linked = null, movedT = false;
    if (o.type === 'aisle' && patch.d != null && +patch.d !== oldD) linked = syncAisleWidth(o, oldD);
    if (a.t != null && o.wallId) { // 挂墙洞口沿墙移位（t=0 墙起点 ~ 1 墙终点）
      const wall = getObj(o.wallId);
      if (wall) {
        const L = wallLen(wall), w = +o.props.width || 1000;
        o.t = clamp(num(a.t, 't', 0, 1), w / 2 / L, 1 - w / 2 / L);
        movedT = true;
      }
    }
    markDirty();
    return {
      added: [],
      hint: `已更新 ${o.props.name || o.type}（${[...Object.keys(patch), ...Object.keys(elevation), ...(movedT ? ['t'] : [])].join('、')}）` +
        (linked && !linked.unsupported && !linked.noRow ? '，通道宽联动：远侧整排机柜已平移' : ''),
    };
  },

  /** 批量修改属性（ids 或 selector 选择器），整批一步撤销；通道带批量改宽逐条联动 */
  'obj.updateBatch'(a) {
    const patch = propsPatch(a.props);
    if (!Object.keys(patch).length && a.z === undefined) throw new ArgError('BAD_PARAM', 'props 为空或无有效字段');
    let targets = [];
    if (a.ids) {
      targets = idsArray(a.ids).map(getObj).filter(Boolean);
    } else if (a.selector && typeof a.selector === 'object') {
      targets = state.project.objects.filter(o => {
        if (a.selector.type && o.type !== a.selector.type) return false;
        if (a.selector.name && !(o.props.name || '').startsWith(String(a.selector.name))) return false; // 名称前缀匹配
        return true;
      });
    } else {
      throw new ArgError('BAD_PARAM', '需要 ids 数组或 selector {type, name}');
    }
    if (!targets.length) throw new ArgError('NOT_FOUND', '没有匹配的对象（可用 query.objects 查询现有对象）');
    if (targets.length > 500) throw new ArgError('TOO_LARGE', `单次最多批量修改 500 个对象（当前匹配 ${targets.length}）`);
    const elevation = zPatch(a, targets); // 混入非设备整批拒绝，不留下半成品
    const pipeUpdates=new Map();
    for(const o of targets)if(o.type==='pipe'){try{pipeUpdates.set(o,normalizePipe({...o,props:{...o.props,...a.props}}));}catch(e){throw new ArgError('BAD_PARAM',e.message);}}
    pushUndo();
    let linked = 0;
    for (const o of targets) {
      if(pipeUpdates.has(o)){Object.assign(o,pipeUpdates.get(o));continue;}
      const oldD = o.type === 'aisle' ? +o.props.d || 0 : 0;
      Object.assign(o.props, patch);
      Object.assign(o, elevation);
      if (o.type === 'aisle' && patch.d != null && +patch.d !== oldD) {
        const r = syncAisleWidth(o, oldD);
        if (r && !r.unsupported && !r.noRow) linked++;
      }
    }
    markDirty();
    return {
      added: [],
      hint: `已批量更新 ${targets.length} 个对象（${[...Object.keys(patch), ...Object.keys(elevation)].join('、')}），整批一步撤销` +
        (linked ? `，${linked} 条通道带宽联动整排平移` : ''),
    };
  },

  /** 整体平移（墙/桥架两端点同移，挂墙门窗随墙自动跟随；实体间自动推挤） */
  'obj.move'(a) {
    const ids = idsArray(a.ids);
    const dx = num(a.dx, 'dx', -1000000, 1000000);
    const dy = num(a.dy, 'dy', -1000000, 1000000);
    const objs = ids.map(getObj).filter(Boolean);
    if (!objs.length) throw new ArgError('NOT_FOUND', '未找到任何指定 id 的对象');
    const pipeMoves=new Map();for(const o of objs)if(o.type==='pipe'){try{pipeMoves.set(o,translatePipe(o,dx,dy));}catch(e){throw new ArgError('BAD_PARAM',e.message);}}
    pushUndo();
    const moved = [];
    for (const o of objs) {
      if (o.wallId) continue; // 挂墙门窗/格栅随墙移动，不单独平移
      if(o.type==='pipe')Object.assign(o,pipeMoves.get(o));
      else if (o.type === 'wall' || o.type === 'tray') { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; }
      else if (o.type === 'beam') { // 框架梁：端点固化并脱离柱附着（柱不随梁动）
        const e = beamEnds(o, getObj);
        o.col1 = o.col2 = null;
        o.x1 = e.x1 + dx; o.y1 = e.y1 + dy; o.x2 = e.x2 + dx; o.y2 = e.y2 + dy;
      }
      else { o.x += dx; o.y += dy; }
      moved.push(o);
    }
    const r = resolveOverlaps(moved.filter(isSolid));
    markDirty();
    return { added: [], hint: `已平移 ${moved.length} 个对象（Δx=${dx}, Δy=${dy}）` + (r.moved ? `，推开 ${r.moved} 个重叠对象` : '') };
  },

  /** 删除（墙级联删其上门窗/格栅） */
  'obj.delete'(a) {
    const ids = idsArray(a.ids);
    const before = state.project.objects.length;
    deleteObjects(ids); // 内部 pushUndo
    const n = before - state.project.objects.length;
    return { added: [], hint: `已删除 ${n} 个对象` + (n < ids.length ? '（部分 id 不存在或随墙级联）' : '') };
  },

  /** 旋转 90°（机柜/柱子/空调/UPS/蓄电池/灭火器/风口/列头柜/配电箱/管道；管道绕自身中心转平面几何，z1/z2 不变） */
  'obj.rotate'(a) {
    const ids = idsArray(a.ids);
    const objs = ids.map(getObj).filter(o => o && ROTATE_TYPES[o.type]);
    if (!objs.length) throw new ArgError('NOT_FOUND', `未找到可旋转对象（仅${ROTATE_HINT}支持旋转；墙/桥架/梁/通道不可旋转，请重画或平移）`);
    state.selectedIds = objs.map(o => o.id);
    tools.rotateSelected(); // 内部 pushUndo + 推挤
    return { added: [], hint: `已旋转 ${objs.length} 个对象 90°` };
  },

  /** 撤销 / 重做（与人工 Ctrl+Z 同一撤销栈） */
  'project.undo'() { undo(); return { added: [], hint: '已撤销一步' }; },
  'project.redo'() { redo(); return { added: [], hint: '已重做一步' }; },

  /** 新建空白项目（清空当前画布；有未保存内容时需 force 确认，防误清） */
  'project.new'(a) {
    const cur = state.project.objects.length;
    if (cur > 0 && a.force !== true) {
      throw new ArgError('NOT_EMPTY',
        `当前项目「${state.project.name}」已有 ${cur} 个对象。若需保留请先 project.save 保存；确认要清空重新开始时，请带 force:true 重试`);
    }
    const name = a.name ? String(a.name).slice(0, 64) : t('project.untitled');
    newProject(name); // 重置项目、清空撤销栈
    return { added: [], hint: `已新建空白项目「${name}」，可开始设计（room.rect 建房间）`, name };
  },

  /** 保存项目到服务端 data/*.json（编辑器「打开」可继续编辑） */
  async 'project.save'(a) {
    const name = str(a.name || state.project.name, 'name');
    if (!/^[\w一-龥-]{1,64}$/.test(name)) throw new ArgError('BAD_NAME', `项目名 ${name} 非法（仅中英文、数字、_ -，1~64 字符）`);
    state.project.name = name;
    if (a.meta && typeof a.meta === 'object') { // 机房信息（勘测人/日期/园区楼宇等）可选合并
      state.project.meta = state.project.meta || {};
      for (const [k, v] of Object.entries(a.meta)) if (typeof v === 'string' || typeof v === 'number') state.project.meta[k] = v;
    }
    const p = JSON.parse(JSON.stringify(state.project));
    sanitize(p); // 与编辑器保存路径同一清洗标准
    const r = await fetch(apiUrl('/api/projects/') + encodeURIComponent(name), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
    });
    if (!r.ok) throw new ArgError('SAVE_FAILED', `保存失败（HTTP ${r.status}）`);
    markDirty({ props: false });
    return { added: [], hint: `已保存为「${name}」（服务端 data/${name}.json，编辑器「打开」可继续编辑）`, name };
  },

  /** 合规自检：对象统计 / 功率合计 / 重叠扫描 / 越界检查，返回中文报告 */
  'query.status'() {
    const s = stats();
    const solids = state.project.objects.filter(isSolid);
    let overlapPairs = 0;
    for (let i = 0; i < solids.length; i++) {
      for (let j = i + 1; j < solids.length; j++) if (rectOverlap(solids[i], solids[j])) overlapPairs++;
    }
    const r = roomInnerBBox();
    let outCount = 0;
    if (r) {
      for (const o of solids) {
        const bb = rectBB(o.x, o.y, o.rotation, o.props.w, o.props.d);
        if (bb.minX < r.minX || bb.minY < r.minY || bb.maxX > r.maxX || bb.maxY > r.maxY) outCount++;
      }
    }
    const lines = [
      `对象共 ${s.total} 个：机柜 ${s.byType.cabinet || 0} 台、墙 ${s.byType.wall || 0} 段、通道 ${s.byType.aisle || 0} 条、桥架 ${s.byType.tray || 0} 段、空调 ${s.byType.ac || 0} 台、列头柜 ${s.byType.pdu || 0} 台、配电箱 ${s.byType.dbox || 0} 台、UPS ${s.byType.ups || 0} 台、蓄电池 ${s.byType.battery || 0} 台、灭火器 ${s.byType.extinguisher || 0} 具、风口 ${s.byType.vent || 0} 个`,
      `机柜总功率约 ${s.powerKW} kW`,
      overlapPairs ? `⚠ 实体重叠 ${overlapPairs} 处（需调整）` : '实体对象无重叠',
      r ? (outCount ? `⚠ ${outCount} 个对象越出房间墙包围盒` : '全部实体在房间范围内') : '尚无墙体（未建房间）',
    ];
    return { added: [], hint: lines.join('；'), stats: s, overlaps: overlapPairs, outOfRoom: outCount };
  },

  /** 规则集合规自检：净距/电力/制冷/消防/承重/土建 → 结构化问题清单（level/rule/cat/msg/实测值/建议值/定位/涉及对象 id）。
   * 阈值取面板持久化配置；可用 a.cfg 临时覆盖（如 {cabFront:1000, disabled:["density"]}），仅本次生效。
   * 典型用法：出图后自检 → 按 issues 逐项 obj.move/obj.update 修正 → 再跑一次直至通过。 */
  'query.checks'(a) {
    const cfg = loadCheckCfg();
    if (a.cfg && typeof a.cfg === 'object') {
      for (const [k, v] of Object.entries(a.cfg)) {
        if (typeof v === 'number' && Number.isFinite(v) && k in DEFAULT_CFG) cfg[k] = v;
      }
      if (Array.isArray(a.cfg.disabled)) cfg.disabled = a.cfg.disabled.map(String).slice(0, 50);
    }
    const issues = runChecks(state.project, cfg);
    const s = summarize(issues);
    const hint = issues.length
      ? `自检完成：严重 ${s.error}、警告 ${s.warn}、提示 ${s.info}（共 ${s.total} 条；阈值可用参数 cfg 覆盖）`
      : '自检通过：全部规则无异常';
    return {
      added: [], hint, summary: s,
      issues: issues.slice(0, 200).map(i => ({
        level: i.level, rule: i.rule, cat: i.cat, msg: i.msg,
        actual: i.actual, expect: i.expect, objectIds: i.objectIds, x: i.x, y: i.y,
      })),
    };
  },

  /** 画布截图（fit=false 时保持当前视角；focusId 先缩放到指定对象），PNG dataURL */
  'view.shot'(a) {
    if (a.focusId) {
      const o = getObj(String(a.focusId));
      if (!o) throw new ArgError('NOT_FOUND', `对象 ${a.focusId} 不存在`);
      focusObj(o);
    }
    const s = shot(a.focusId ? false : a.fit !== false);
    if (!s) throw new ArgError('SHOT_FAILED', '截图失败（画布不可用）');
    return { added: [], hint: '已截取当前画布', shot: s };
  },

  /** 对象清单（紧凑：id/类型/名称/坐标），可按类型与名称子串过滤 */
  'query.objects'(a) {
    const type = a.type ? String(a.type) : null;
    const name = a.name ? String(a.name) : null;
    const list = state.project.objects
      .filter(o => (!type || o.type === type) && (!name || (o.props.name || '').includes(name)))
      .slice(0, 1000)
      .map(brief);
    return { added: [], hint: `共 ${list.length} 个对象` + (type ? `（类型 ${type}）` : ''), objects: list };
  },

  /** 单对象完整详情（含全部 props，如空调工勘属性/机柜电气参数） */
  'obj.get'(a) {
    const o = getObj(str(a.id, 'id'));
    if (!o) throw new ArgError('NOT_FOUND', `对象 ${a.id} 不存在`);
    return { added: [], hint: `${o.props.name || o.type}（${o.type}）`, object: JSON.parse(JSON.stringify(o)) };
  },

  /** 服务端项目列表（data/*.json） */
  async 'project.list'() {
    const r = await fetch(apiUrl('/api/projects'));
    if (!r.ok) throw new ArgError('LIST_FAILED', `读取项目列表失败（HTTP ${r.status}）`);
    const names = await r.json();
    return { added: [], hint: `服务端共有 ${names.length} 个项目${names.length ? '：' + names.join('、') : ''}`, projects: names };
  },

  /** 打开服务端已保存项目（页面重载后 Agent 重新接管）；当前有未保存修改时需 force 确认 */
  async 'project.open'(a) {
    const name = str(a.name, 'name');
    const cur = state.project.objects.length;
    if (cur > 0 && state.dirty && a.force !== true) {
      throw new ArgError('NOT_EMPTY',
        `当前项目「${state.project.name}」有未保存修改（${cur} 个对象）。请先 project.save 保存，或确认放弃修改后带 force:true 重试`);
    }
    const r = await fetch(apiUrl('/api/projects/') + encodeURIComponent(name));
    if (r.status === 404) throw new ArgError('NOT_FOUND', `项目「${name}」不存在（可用 project.list 查看服务端项目列表）`);
    if (!r.ok) throw new ArgError('OPEN_FAILED', `打开项目失败（HTTP ${r.status}）`);
    const p = await r.json();
    sanitize(p);
    newProject(p.name || name); // 清空撤销栈
    state.project = p;
    state.selectedIds = [];
    state.dirty = false;
    markDirty({ dirty: false });
    ui.fit();
    return { added: [], hint: `已打开项目「${p.name || name}」（${p.objects.length} 个对象），可继续设计`, name: p.name || name };
  },

  /** 导出 DXF 图纸 / CSV 工程量清单文本（复用编辑器同款纯函数，几何离线核对用） */
  'project.export'(a) {
    const kind = oneOf(a.kind, 'kind', ['dxf', 'csv']);
    if (!state.project.objects.length) throw new ArgError('EMPTY', '当前项目为空，无内容可导出');
    const content = kind === 'dxf' ? buildDXF(state.project) : '\uFEFF' + buildBOQ(state.project);
    return {
      added: [],
      hint: `已生成${kind === 'dxf' ? ' DXF 图纸' : ' CSV 工程量清单'}（${content.length} 字符）`,
      kind, content,
      filename: `${state.project.name || '机房'}-${kind === 'dxf' ? '平面图.dxf' : '工程量清单.csv'}`,
    };
  },
};

/* ---------- 执行与回传 ---------- */
let executedCount = 0; // 本次会话已执行的 AI 指令数（弹窗状态行显示）
/** 合法指令名（唯一事实来源 = HANDLERS 键）：UNKNOWN_TOOL 自纠错文案、契约一致性测试共用，
 *  新增指令只改 HANDLERS，提示与名单自动同步，不存在第二份名单。 */
const TOOL_NAMES = Object.keys(HANDLERS);

/** 指令到达：顶栏 AI 按钮呼吸闪烁，给用户“AI 正在作图”的可见反馈 */
function flashAiButton() {
  const b = document.getElementById('btn-ai');
  if (!b) return;
  b.classList.remove('ai-active');
  void b.offsetWidth; // 重触发动画
  b.classList.add('ai-active');
  clearTimeout(flashAiButton._t);
  flashAiButton._t = setTimeout(() => b.classList.remove('ai-active'), 1300);
}

async function exec(cmd) {
  const h = HANDLERS[cmd.tool];
  if (!h) return { id: cmd.id, ok: false, tool: cmd.tool, code: 'UNKNOWN_TOOL', message: unknownToolMessage(cmd.tool, TOOL_NAMES) };
  flashAiButton();
  try {
    const result = await h(cmd.args || {});
    executedCount++;
    result.stats = stats();
    if (cmd.args && cmd.args.shot && !result.shot) result.shot = shot(false); // 任何指令可带 shot:true 要求随结果截图
    return { id: cmd.id, ok: true, tool: cmd.tool, result };
  } catch (e) {
    return { id: cmd.id, ok: false, tool: cmd.tool, code: e.code || 'EXEC_ERROR', message: e.message || String(e) };
  }
}

/* ---------- 长轮询循环（无指令时静默等待，对编辑器零影响） ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 页面身份：服务端据此做粘性单页路由（多页面并存时指令不分批）。localStorage 持久化，刷新不变 */
const CLIENT_ID = (() => {
  try {
    let id = localStorage.getItem('agentClientId');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2));
      localStorage.setItem('agentClientId', id);
    }
    return id;
  } catch (e) { return 'c' + Date.now() + Math.random().toString(16).slice(2); }
})();
let pageBg = document.hidden; // 后台标签页也可被驱动，但服务端优先派给前台页面
let pollAbort = null; // 当前挂起的长轮询：切回前台时主动打断，立即以 bg=0 重发并接管活动页（服务端前台认领规则）
document.addEventListener('visibilitychange', () => {
  pageBg = document.hidden;
  // 变为可见：立即打断本轮长轮询重新上报身份，把接管延迟从最多 25s（一轮空返周期）压到秒级
  if (!pageBg && pollAbort) pollAbort.abort();
});

async function pollLoop() {
  let failures = 0;
  for (;;) {
    let cmd = null;
    pollAbort = new AbortController();
    try {
      const r = await fetch(apiUrl('/api/agent/next') + `?client=${encodeURIComponent(CLIENT_ID)}&bg=${pageBg ? 1 : 0}`, { cache: 'no-store', signal: pollAbort.signal });
      if (r.ok) { cmd = await r.json(); failures = 0; } else failures++;
    } catch (e) {
      if (e && e.name === 'AbortError') { pollAbort = null; continue; } // 主动打断（切前台接管）：立即重发，不计失败退避
      failures++;
    }
    pollAbort = null;
    if (!cmd) { // 空返=长轮询到期，立即重发；失败则指数退避（上限 10s）
      if (failures) await sleep(Math.min(10000, 1000 * failures));
      continue;
    }
    const res = { ...await exec(cmd), client: CLIENT_ID };
    for (let i = 0; i < 3; i++) { // 回传失败重试 2 次（避免调用方无谓超时）
      try {
        await fetch(apiUrl('/api/agent/done'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(res),
        });
        break;
      } catch (e) { await sleep(300 * (i + 1)); }
    }
  }
}

console.info('[agent] AI Agent 指令执行器已启动（/api/agent/*）');
pollLoop();

/* 真实用户交互自动接管：可信输入（点击/按键/滚轮/触摸）= 用户正在操作本页面，
 * 自动显式接管并锁定 AI 指令路由（每事件最多 20s 一次）。Agent 自开的无头/隐藏页面
 * 由 API 中继驱动、没有本地输入事件，永远无权竞争——活动页面无需手动点按钮，
 * 哪个页面被真实操作，指令就自动归哪个页面；本页关闭离线后锁定自动释放（故障转移）。
 * 不含 pointermove：自动化工具常模拟鼠标移动，蓄意操作（点/按/滚）才是可靠的人类信号。 */
let lastAutoClaim = 0, autoClaimLogged = false;
async function autoClaim() {
  const now = Date.now();
  if (now - lastAutoClaim < 20000) return;
  lastAutoClaim = now;
  try {
    const r = await fetch(apiUrl('/api/agent/claim'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: CLIENT_ID }),
    });
    if ((await r.json()).ok && !autoClaimLogged) {
      autoClaimLogged = true;
      console.info('[agent] 检测到用户交互：已自动接管并锁定 AI 指令路由到本页面');
    }
  } catch (e) { /* 服务不可达时静默（离线编辑不受影响） */ }
}
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  window.addEventListener(ev, () => { if (!document.hidden) autoClaim(); }, { passive: true });
}

/* ---------- AI 功能入口（顶栏按钮 → 内置 AI 建模(试验) 面板，见 public/js/ai/） ----------
 * 面板复用本文件的 exec()/HANDLERS（与外部 Agent 中继同一执行入口，语义零漂移）：
 * 模型输出 JSON 计划 → 页内逐条 exec() → 一步撤销/条 → 画布实时呈现。
 * 模型凭据与转发由服务端 /api/ai/* 代理（Key 不回传浏览器）。 */

/** 撤销本轮：连续回退 k 步（每条 AI 指令 = 一步撤销；撤销栈为空时停止），返回实际回退步数 */
function undoRound(k) {
  let done = 0;
  for (let i = 0; i < k && undoDepth(); i++) { undo(); done++; }
  return done;
}

const aiPanel = initAiPanel({
  exec, undoRound,
  clientId: CLIENT_ID,
  getExecutedCount: () => executedCount,
});
const aiBtn = document.getElementById('btn-ai');
if (aiBtn) aiBtn.addEventListener('click', () => aiPanel.toggle());
// 顶栏 AI 按钮的按下态跟随右栏标签 / 收起状态
onPanelState(d => { if (d.name === 'ai' && aiBtn) {
  aiBtn.classList.toggle('active', !!d.open);
  aiBtn.setAttribute('aria-pressed', String(!!d.open));
} });
// 注册面板时可能已经恢复 AI 标签，补一次初始按下态。
if (aiBtn) {
  aiBtn.classList.toggle('active', aiPanel.isOpen());
  aiBtn.setAttribute('aria-pressed', String(aiPanel.isOpen()));
}
// AI 工作中（模型往返/指令执行）顶栏按钮**持续呼吸**：面板收起后请求仍在跑，同样要看得见
onPanelBusy(d => { if (d.name === 'ai' && aiBtn) aiBtn.classList.toggle('ai-busy', !!d.busy); });

/* 导出给 AI 编排层与测试复用：与外部 Agent 中继同一条指令执行路径 */
export { HANDLERS, exec, stats, TOOL_NAMES, aiPanel };
