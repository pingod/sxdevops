/** Canvas 渲染：网格、墙体（含门窗开洞）、门窗符号、柱子、机柜、桥架、选中高亮、操作预览 */
import { state, runtime, w2s, snapVal, getObj, defaultProps } from './state.js';
import { wallLen, beamEnds, roomInwardSign, pairClearance, nearestClearance, wallClearances, groupWallClearances, objOutline, isSolid, trayDiamonds, segIntersectsRect, grilleSnapAC } from './geo.js';
import { podGeometry } from './tools.js';
import { cabPaint } from './cabinetcolor.js';
import { t } from './i18n.js';
import { isDevice } from './device.js';
import { drawDistributionBox, DISTRIBUTION_BOX_PALETTE } from './distribution-box.js';
import { drawPipes, drawPipePreview } from './pipe-render.js';
import { pipeVisible } from './pipe-tools.js';

/* ---------- 视图配色系统（优雅 / 工程感 / 现代；详见 docs/配色方案.md） ----------
 * 按系统分族：建筑结构=墨线灰系（墙/门/柱/窗），电气走线=铜金（桥架），
 *   核心设备=白描近墨（机柜），制冷送风=蓝族（空调/冷通道/送风格栅/风口），回风散热=红绿族（热通道/回风格栅）；
 * 功能色按族分级：深=文字 / 中=描边 / 浅=填充（tint 由主色派生，保证同族和谐）；
 * 语义固定：冷=蓝、热=砖红、送风=蓝、回风=青绿、选中=琥珀、警示=红、净距=青绿、格式刷=紫。 */
const P = {
  canvas:  { bg: '#f6f8fa', exportBg: '#ffffff' },       // 画布底色 / 导出白底
  grid:    { minor: '#e9edf3', major: '#d6dde5' },       // 网格细线 / 600 模数粗线
  wall:    { body: '#2f3641', dim: '#8993a2' },          // 墙体墨线 / 墙尺寸标注
  door:    { line: '#7a8494' },                          // 门扇与开启弧（中性灰蓝）
  window:  { line: '#4d92d4' },                          // 窗（亮蓝，玻璃感）
  grille:  { supply: '#2f6fb2', ret: '#2e9e6e' },        // 格栅：送风蓝 / 回风绿
  column:  { fill: '#cdd3db', edge: '#55606c', hatch: '#a6adb8' }, // 混凝土柱
  beam:    { edge: '#55606c', mid: '#a6adb8', dim: '#6c7683' },   // 框架梁（混凝土族同柱；中线点划用浅一档）
  cabinet: { body: '#e8edf4', edge: '#22272e', front: '#4d5560', ghost: '#3b424d' }, // 机柜：浅灰蓝底 + 白描 + 正面深灰条（ghost 仅作放置预览 tint 基色）
  tray:    { line: '#b8860b', dim: '#8a6415' },          // 桥架（电气铜金；标注用深一档保证白底可读）
  ac:      { fill: '#dce9f6' },                          // 空调填充（描边/符号用 blue.main）
  ups:     { fill: '#f1e7cf', edge: '#a97c14', text: '#7a5a0d' }, // UPS：暖金填充 / 铜金描边 / 深铜金文字（电气族同桥架·列头柜，符号=电池组）
  battery: { fill: '#f7ecd3', edge: '#8f6a12', text: '#6d520c' }, // 蓄电池：同电气族，比 UPS 浅一档（符号=并排电池单元）
  extinguisher: { fill: '#fae3df', edge: '#c0392b', text: '#8e2b20' }, // 灭火器：消防红族（浅红填充 / 消防红描边 / 深红文字）
  vent:    { fill: '#e6f0fa', name: '#2b6aa6' },         // 地板出风口（描边/点孔用 blue.soft）
  aisle:   { hotEdge: '#c64634', hotText: '#92362b' },   // 热通道砖红（冷通道用 blue 族）
  label:   { main: '#33404f' },                          // 通用对象标签
  blue:    { strong: '#1d4e7a', main: '#2f6fb2', soft: '#4d92d4', sub: '#5f7f9d', subSoft: '#6e8aa8' }, // 技术蓝色阶
  ui:      { dim: '#5b6470' },                           // 比例尺 / 导出落款
  fb: {                                                  // 交互反馈色（非对象本体色）
    sel: '#f39c12', selDeep: '#e67e22',                  // 选中琥珀 / 深琥珀（原点、标注文字）
    warn: '#e74c3c', pair: '#0e9f8f', brush: '#8e44ad',  // 警示红 / 净距青绿 / 格式刷紫
    wall: '#1d6fbe',                                     // 四周墙距蓝（拖动/放置预览）
    halo: 'rgba(255,255,255,.88)',                       // 文字白底光晕
    rowLine: '#95a0ad', rowText: '#7d8894',              // 重排/空位预览灰
  },
};
/** 主色 + 透明度派生浅填充 tint（同族取色，保证画面和谐） */
const tint = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function render(ctx, W, H, opts = {}) {
  // 画布文字统一 LTR 基向：RTL（阿语）页面下 canvas 默认继承 rtl，会使「数字+单位」等技术串 bidi 乱序
  // （如 12240 mm 显示为 mm 12240）。强制 ltr 后数字/负号/小数/单位顺序与各语言界面一致；
  // 纯阿语词仍按 Unicode bidi 自动 RTL 渲染，不受影响（AR-07，PNG 导出走同一 render 同步生效）
  ctx.direction = 'ltr';
  ctx.fillStyle = opts.export ? P.canvas.exportBg : P.canvas.bg;
  ctx.fillRect(0, 0, W, H);
  if (state.grid) drawGrid(ctx, W, H, opts);
  drawObjects(ctx, opts);
  if (!opts.export) drawOrigin(ctx, W, H);
  drawScaleBar(ctx, W, H);
  if (opts.export) drawExportInfo(ctx, W, H);
  if (!opts.export) {
    // 对象绘制（如墙体按厚度设线宽）会遗留 canvas 状态，复位线宽避免虚线预览被意外加粗
    ctx.save(); ctx.lineWidth = 1.5;
    drawGhost(ctx); drawPreview(ctx); drawPipePreview(ctx); drawRubber(ctx); drawGuide(ctx, W, H);
    drawLiveIssues(ctx); // 实时布局问题红框（livecheck.js）
    drawBrushMark(ctx); drawRowGapPreview(ctx); drawPairDims(ctx); drawLiveDims(ctx); drawWallDims(ctx);
    ctx.restore();
  }
}

/** 是否选中（支持多选） */
const isSel = id => state.selectedIds.includes(id);

/* ---------- 格式刷源对象标记（紫色短虚线，与选中橙色区分） ---------- */
function drawBrushMark(ctx) {
  const b = runtime.brush;
  if (!b || !b.sourceId) return;
  const o = getObj(b.sourceId);
  if (!o || (o.type==='pipe'&&!pipeVisible(o))) return;
  ctx.save();
  ctx.strokeStyle = P.fb.brush; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
  if (o.type === 'wall' || o.type === 'tray' || o.type === 'beam' || o.type === 'pipe') { // 线段对象：沿线 + 两端圆点（梁端点随附着柱求解）
    const e = o.type === 'beam' ? beamEnds(o, getObj) : o;
    const p1 = w2s(e.x1, e.y1), p2 = w2s(e.x2, e.y2);
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = P.fb.brush;
    for (const p of [p1, p2]) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
  } else if (o.type === 'door' || o.type === 'window' || o.type === 'grille') { // 门窗：洞口外扩虚线框
    const w = getObj(o.wallId);
    const L = w ? wallLen(w) : 0;
    if (w && L > 0) {
      const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
      const nx = -uy, ny = ux;
      const half = (o.props.width || 900) / 2 + 200;
      const th = (w.props.thickness || 240) / 2 + 200;
      const cx = w.x1 + ux * o.t * L, cy = w.y1 + uy * o.t * L;
      const pts = [
        w2s(cx - ux * half + nx * th, cy - uy * half + ny * th),
        w2s(cx + ux * half + nx * th, cy + uy * half + ny * th),
        w2s(cx + ux * half - nx * th, cy + uy * half - ny * th),
        w2s(cx - ux * half - nx * th, cy - uy * half - ny * th)];
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath(); ctx.stroke();
    }
  } else { // 矩形对象：旋转外扩虚线框
    const s = state.view.scale;
    const p = w2s(o.x, o.y);
    const wpx = (o.props.w || 600) * s, dpx = (o.props.d || 600) * s;
    ctx.translate(p.x, p.y);
    ctx.rotate((o.rotation || 0) * Math.PI / 180);
    ctx.strokeRect(-wpx / 2 - 7, -dpx / 2 - 7, wpx + 14, dpx + 14);
  }
  ctx.restore();
}

/* ---------- 实时布局问题标记（livecheck.js 写入 state.liveIssues；红色虚线框，与选中琥珀区分；导出自动忽略） ---------- */
function drawLiveIssues(ctx) {
  const list = state.liveIssues;
  if (!list || !list.length) return;
  const ids = new Set();
  for (const it of list) for (const id of it.objectIds) ids.add(id);
  if (!ids.size) return;
  const pad = 120; // 外扩 120mm（世界坐标），与对象本体描边留出间隙
  ctx.save();
  ctx.strokeStyle = P.fb.warn; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
  for (const id of ids) {
    const o = getObj(id);
    if (!o) continue;
    const poly = objOutline(o, getObj);
    if (!poly) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const tl = w2s(minX - pad, maxY + pad), br = w2s(maxX + pad, minY - pad); // 屏幕 y 向下：世界 maxY 在上方
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  }
  ctx.restore();
}

/* ---------- 重排编号 / 空位补插预览（灰色虚线框 + 灰字，确认后转实色） ---------- */
function drawRowGapPreview(ctx) {
  const rp = runtime.rowPreview;
  if (rp && rp.items) { // 重排预览：原位灰虚线框 + 灰色新编号
    ctx.save();
    ctx.strokeStyle = P.fb.rowLine; ctx.fillStyle = P.fb.rowText;
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.3;
    for (const it of rp.items) {
      const o = it.obj;
      if (!o || o.x === undefined) continue;
      const s = state.view.scale;
      const p = w2s(o.x, o.y);
      const wpx = (o.props.w || 600) * s, dpx = (o.props.d || 600) * s;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((o.rotation || 0) * Math.PI / 180);
      ctx.strokeRect(-wpx / 2 - 4, -dpx / 2 - 4, wpx + 8, dpx + 8);
      ctx.restore();
      if (Math.max(wpx, dpx) >= 24) { // 新编号（文字不随旋转，保证可读）
        ctx.save();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(it.newName, p.x, p.y - 16, Math.max(wpx, dpx) + 16);
        ctx.restore();
      }
    }
    ctx.restore();
  }
  const gp = runtime.gapPreview;
  if (gp && gp.slots) { // 空位预览：缺失槽位灰色虚线框 + “空位”标注
    ctx.save();
    ctx.strokeStyle = P.fb.rowLine; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.3;
    const s = state.view.scale;
    for (const sl of gp.slots) {
      const p = w2s(sl.x, sl.y);
      const wpx = (sl.w || 600) * s, dpx = (sl.d || 600) * s;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((sl.rotation || 0) * Math.PI / 180);
      ctx.fillStyle = tint(P.fb.rowLine, .12);
      ctx.fillRect(-wpx / 2, -dpx / 2, wpx, dpx);
      ctx.strokeRect(-wpx / 2, -dpx / 2, wpx, dpx);
      ctx.restore();
      if (Math.max(wpx, dpx) >= 24) {
        ctx.save();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = P.fb.rowText; ctx.font = '10px sans-serif';
        ctx.fillText(t('preview.gap'), p.x, p.y);
        ctx.restore();
      }
    }
    ctx.restore();
  }
}

/* ---------- 框选矩形（选择工具空白处拖动） ---------- */
function drawRubber(ctx) {
  const r = runtime.rubber;
  if (!r) return;
  const a = w2s(r.x0, r.y0), b = w2s(r.x1, r.y1);
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  ctx.save();
  ctx.fillStyle = tint(P.blue.main, .12);
  ctx.strokeStyle = P.blue.main; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

/* ---------- 对齐参考线（拖动智能对齐：红色虚线贯穿画布） ---------- */
function drawGuide(ctx, W, H) {
  const g = runtime.guides;
  if (!g || (!g.v.length && !g.h.length)) return;
  ctx.save();
  ctx.strokeStyle = P.fb.warn;
  ctx.lineWidth = 0.5;
  ctx.setLineDash([6, 4]);
  for (const x of g.v) {
    ctx.beginPath(); ctx.moveTo(w2s(x, 0).x, 0); ctx.lineTo(w2s(x, 0).x, H); ctx.stroke();
  }
  for (const y of g.h) {
    ctx.beginPath(); ctx.moveTo(0, w2s(0, y).y); ctx.lineTo(W, w2s(0, y).y); ctx.stroke();
  }
  ctx.restore();
}

/* ---------- 两对象垂足正交标尺（恰好选中 2 个对象时显示正交净距） ---------- */
const PAIR_COL = P.fb.pair; // 青绿色（与选中橙/对齐红区分）
const fmtMm = d => Math.round(d) + ' mm'; // 长度标注统一 mm（与属性面板输入一致，消除 10m 阈值跳变）

function drawPairDims(ctx) {
  if (state.selectedIds.length !== 2) return;
  const o1 = getObj(state.selectedIds[0]), o2 = getObj(state.selectedIds[1]);
  if (!o1 || !o2) return;
  const pc = pairClearance(o1, o2, getObj);
  if (!pc) return;
  ctx.save();
  ctx.strokeStyle = PAIR_COL; ctx.fillStyle = PAIR_COL;
  drawOneDim(ctx, pc.h, true, w2s(pc.center.a.x, pc.center.a.y), w2s(pc.center.b.x, pc.center.b.y));
  drawOneDim(ctx, pc.v, false, w2s(pc.center.a.x, pc.center.a.y), w2s(pc.center.b.x, pc.center.b.y));
  ctx.restore();
}

/** 单条正交标尺：horiz=true 为水平标注线（X向净距），false 为垂直标注线（Y向净距）
 * ca/cb 为两对象中心屏幕坐标（直角符号开口背向各自中心）；col 为标尺颜色。
 * 相贴（净距 0，屏幕上标注线过短）时只出数字不出线，便于确认“已贴齐” */
function drawOneDim(ctx, d, horiz, ca, cb, col = PAIR_COL) {
  if (!d) return;
  const a = w2s(d.a.x, d.a.y), b = w2s(d.b.x, d.b.y);
  // 标注线两端点（dim 为标注线坐标：水平=Y / 垂直=X）
  let p1, p2;
  if (horiz) { const y = w2s(0, d.dim).y; p1 = { x: a.x, y }; p2 = { x: b.x, y }; }
  else { const x = w2s(d.dim, 0).x; p1 = { x, y: a.y }; p2 = { x, y: b.y }; }
  ctx.strokeStyle = col; ctx.fillStyle = col;
  if (Math.hypot(p2.x - p1.x, p2.y - p1.y) >= 4) {
    if (d.ext) { // 对角分布：垂足 → 标注线的正交延长虚线
      ctx.save();
      ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(p1.x, p1.y);
      ctx.moveTo(b.x, b.y); ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.restore();
    }
    // 标注线 + 端头垂直短 tick
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    const tick = horiz ? [{ x: 0, y: -4 }, { x: 0, y: 4 }] : [{ x: -4, y: 0 }, { x: 4, y: 0 }];
    ctx.beginPath();
    for (const p of [p1, p2]) {
      ctx.moveTo(p.x + tick[0].x, p.y + tick[0].y);
      ctx.lineTo(p.x + tick[1].x, p.y + tick[1].y);
    }
    ctx.stroke();
    // 垂足：实心圆点 + 直角符号（开口背向对象中心）
    const foot = (fp, tp, ctr) => {
      ctx.beginPath(); ctx.arc(fp.x, fp.y, 2.5, 0, Math.PI * 2); ctx.fill();
      let dx = tp.x - fp.x, dy = tp.y - fp.y;
      const L0 = Math.hypot(dx, dy);
      if (L0 < 0.01) return;
      dx /= L0; dy /= L0; // 垂线方向（指向标注线/对方）
      const px = -dy, py = dx; // 边方向（垂直于垂线）
      const s = (ctr.x - fp.x) * px + (ctr.y - fp.y) * py > 0 ? -1 : 1;
      const L = 6;
      ctx.beginPath();
      ctx.moveTo(fp.x + px * s * L, fp.y + py * s * L);
      ctx.lineTo(fp.x + px * s * L + dx * L, fp.y + py * s * L + dy * L);
      ctx.lineTo(fp.x + dx * L, fp.y + dy * L);
      ctx.stroke();
    };
    // 垂足在标注线上时（ext=false），方向取沿标注线指向对方端点
    foot(a, d.ext ? p1 : p2, ca);
    foot(b, d.ext ? p2 : p1, cb);
  }
  // 尺寸文字：标注线中点，向外偏移，白底光晕保证可读
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const label = fmtMm(d.gap);
  ctx.save();
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const ox = horiz ? 0 : 9, oy = horiz ? -9 : 0;
  ctx.lineWidth = 3; ctx.strokeStyle = P.fb.halo;
  ctx.strokeText(label, mx + ox, my + oy);
  ctx.fillStyle = col;
  ctx.fillText(label, mx + ox, my + oy);
  ctx.restore();
}

/* ---------- 摆放/拖动实时净距（红色：与最近对象的 X/Y 向净距，松手即隐去） ---------- */
const LIVE_COL = P.fb.warn;

/** 实时净距的参照对象与排除集：拖动移动=基准拖动对象（排除选中组）；
 * 放置工具（机柜/柱子/空调/风口）=鼠标处放置预览伪对象（位置捕捉与尺寸同 placeRect） */
function liveMeasureTarget() {
  const dr = runtime.drag;
  if (dr && (dr.kind === 'move' || dr.kind === 'copy')) {
    const base = dr.items.find(it => it.obj.type !== 'door' && it.obj.type !== 'window');
    if (!base) return null;
    return { obj: base.obj, exclude: new Set(state.selectedIds) };
  }
  if (runtime.nudgeRuler) { // 键盘微调中：与拖动同规则（基准=第一个非门窗对象，排除选中组）
    const objs = runtime.nudgeRuler.map(getObj).filter(Boolean);
    const base = objs.find(o => o.type !== 'door' && o.type !== 'window');
    if (!base) return null;
    return { obj: base, exclude: new Set(state.selectedIds) };
  }
  const t = state.tool;
  if (dr || (!isDevice({ type: t }) && t !== 'column')) return null;
  const m = runtime.mouse;
  const dp = defaultProps(t); // 与 placeRect 真实放置尺寸一致（跟随上一次设置）
  const w = dp.w || 600, dpt = dp.d || 600;
  return {
    obj: { type: 'cabinet', x: snapVal(m.wx), y: snapVal(m.wy), rotation: 0, props: { w, d: dpt } },
    exclude: null,
  };
}

function drawLiveDims(ctx) {
  const t = liveMeasureTarget();
  if (!t) return;
  const cands = [];
  for (const o of state.project.objects) {
    if (o.type === 'aisle') continue; // 通道带为区域标注，不作净距参考
    if (t.exclude && t.exclude.has(o.id)) continue;
    cands.push(o);
  }
  const r = nearestClearance(t.obj, cands, getObj);
  if (!r) return;
  const ca = w2s(r.cA.x, r.cA.y);
  if (r.h) drawOneDim(ctx, r.h.dim, true, ca, w2s(r.h.cB.x, r.h.cB.y), LIVE_COL);
  if (r.v) drawOneDim(ctx, r.v.dim, false, ca, w2s(r.v.cB.x, r.v.cB.y), LIVE_COL);
}

/* ---------- 四周墙距（拖动/放置预览：蓝色标尺显示对象到上下左右墙内表面净距） ---------- */
const WALL_COL = P.fb.wall;

function drawWallDims(ctx) {
  // 长按实体对象：静态墙距标尺（松手/开始拖动即隐）；拖动移动/复制：整组实体对象的外沿（联合 AABB）测墙距；放置预览：单个预览对象
  const dr = runtime.drag;
  let objs = null;
  if (runtime.rulerObj) {
    const o = getObj(runtime.rulerObj);
    if (!o || !isSolid(o)) return;
    objs = [o];
  } else if (dr && (dr.kind === 'move' || dr.kind === 'copy')) {
    objs = dr.items.map(it => it.obj).filter(isSolid); // 墙/桥架/门窗/通道带不入外沿
    if (!objs.length) return;
  } else if (runtime.nudgeRuler) { // 键盘微调中：整组实体外沿测墙距（同拖动规则）
    objs = runtime.nudgeRuler.map(getObj).filter(Boolean).filter(isSolid);
    if (!objs.length) return;
  } else {
    const t = liveMeasureTarget();
    if (!t) return;
    objs = [t.obj];
  }
  const walls = state.project.objects.filter(x => x.type === 'wall');
  const d = objs.length > 1 ? groupWallClearances(objs, walls, getObj) : wallClearances(objs[0], walls, getObj);
  if (!d) return;
  const b = d.box;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  // 四个方向：外沿边中点 → 对应墙内表面（对象已越出该方向墙时跳过，避免负值误导）
  const items = [];
  if (d.left >= 0) items.push({ a: { x: b.minX, y: cy }, b: { x: b.minX - d.left, y: cy }, label: fmtMm(d.left) });
  if (d.right >= 0) items.push({ a: { x: b.maxX, y: cy }, b: { x: b.maxX + d.right, y: cy }, label: fmtMm(d.right) });
  if (d.bottom >= 0) items.push({ a: { x: cx, y: b.minY }, b: { x: cx, y: b.minY - d.bottom }, label: fmtMm(d.bottom) });
  if (d.top >= 0) items.push({ a: { x: cx, y: b.maxY }, b: { x: cx, y: b.maxY + d.top }, label: fmtMm(d.top) });
  if (!items.length) return;
  ctx.save();
  ctx.strokeStyle = WALL_COL; ctx.fillStyle = WALL_COL;
  for (const it of items) {
    const a = w2s(it.a.x, it.a.y), b = w2s(it.b.x, it.b.y);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= 4) { // 线太短时只出数字（已贴墙）
      ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      const horiz = Math.abs(b.y - a.y) < Math.abs(b.x - a.x);
      const t1 = horiz ? { x: 0, y: -4 } : { x: -4, y: 0 }, t2 = horiz ? { x: 0, y: 4 } : { x: 4, y: 0 };
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x + t1.x, a.y + t1.y); ctx.lineTo(a.x + t2.x, a.y + t2.y);
      ctx.moveTo(b.x + t1.x, b.y + t1.y); ctx.lineTo(b.x + t2.x, b.y + t2.y);
      ctx.stroke();
    }
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const horiz = Math.abs(b.y - a.y) < Math.abs(b.x - a.x);
    const ox = horiz ? 0 : 9, oy = horiz ? -9 : 0;
    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = P.fb.halo;
    ctx.strokeText(it.label, mx + ox, my + oy);
    ctx.fillStyle = WALL_COL;
    ctx.fillText(it.label, mx + ox, my + oy);
    ctx.restore();
  }
  ctx.restore();
}

/* ---------- 比例尺（左下角） ---------- */
function drawScaleBar(ctx, W, H) {
  const v = state.view;
  const candidates = [100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c * v.scale - 100) < Math.abs(best * v.scale - 100)) best = c;
  }
  const px = best * v.scale, x = 16, y = H - 18;
  ctx.save();
  ctx.strokeStyle = P.ui.dim; ctx.fillStyle = P.ui.dim; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + px, y);
  ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
  ctx.moveTo(x + px / 2, y - 3); ctx.lineTo(x + px / 2, y + 3);
  ctx.moveTo(x + px, y - 4); ctx.lineTo(x + px, y + 4);
  ctx.stroke();
  ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(best + ' mm', x + px / 2, y - 7);
  ctx.restore();
}

/* ---------- 原点标记（世界坐标 0,0 = 房间西南角，带东/北方向提示） ---------- */
function drawOrigin(ctx, W, H) {
  const v = state.view, m = 60;
  const x = v.ox, y = v.oy;
  if (x < -m || y < -m || x > W + m || y > H + m) return; // 原点在画布外则不画
  ctx.save();
  ctx.strokeStyle = P.fb.selDeep; ctx.fillStyle = P.fb.selDeep; ctx.lineWidth = 1.5;
  // 十字 + 圆点
  ctx.beginPath();
  ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y);
  ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  // X 向东 / Y 向北 方向箭头（固定像素，不随缩放）
  ctx.beginPath();
  ctx.moveTo(x + 10, y); ctx.lineTo(x + 30, y);
  ctx.lineTo(x + 24, y - 4); ctx.moveTo(x + 30, y); ctx.lineTo(x + 24, y + 4);
  ctx.moveTo(x, y - 10); ctx.lineTo(x, y - 30);
  ctx.lineTo(x - 4, y - 24); ctx.moveTo(x, y - 30); ctx.lineTo(x + 4, y - 24);
  ctx.stroke();
  ctx.font = '11px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(t('origin.x'), x + 34, y + 4);
  ctx.textAlign = 'center'; // y 北居中放在向上箭头正上方
  ctx.fillText(t('origin.y'), x, y - 36);
  // 原点说明放十字左下角，避免遮挡东/北箭头与十字；长文（如阿语）右移防止裁出画布
  ctx.textAlign = 'right';
  const ol = t('origin.label');
  ctx.fillText(ol, Math.max(x - 10, ctx.measureText(ol).width + 4), y + 24);
  ctx.restore();
}

/* ---------- 导出 PNG 时的工勘落款（右下角） ---------- */
function drawExportInfo(ctx, W, H) {
  const meta = state.project.meta || {};
  const info = [state.project.name,
    meta.surveyor ? t('export.surveyor') + meta.surveyor : '',
    meta.date || ''].filter(Boolean).join('  |  ');
  if (!info) return;
  ctx.save();
  ctx.fillStyle = P.ui.dim; ctx.font = '12px sans-serif'; ctx.textAlign = 'right';
  ctx.fillText(info, W - 12, H - 12);
  ctx.restore();
}

/* ---------- 网格（屏幕：细线 100mm 级 + 粗线 600mm 模数级，随缩放自适应；
 * 导出：固定 600×600 地板模数单级网格，不随导出比例变化，大机房导出仍是 600 网格） ---------- */
function drawGrid(ctx, W, H, opts = {}) {
  const v = state.view;
  let minor, major;
  if (opts.export) { minor = 600; major = 600; } // 单级：逐线均为 600 模数线（模数粗线色）
  else {
    const steps = [100, 500, 1000, 5000, 10000];
    minor = steps.find(s => s * v.scale >= 6) || 10000;
    major = minor * 6;
  }
  // 世界坐标范围（Y 轴向上，屏幕上边缘为世界 Y 大值）
  const xMin = -v.ox / v.scale, xMax = (W - v.ox) / v.scale;
  const yMin = (v.oy - H) / v.scale, yMax = v.oy / v.scale;
  const x0 = Math.floor(xMin / minor) * minor;
  const y0 = Math.floor(yMin / minor) * minor;
  ctx.lineWidth = 1;
  for (let x = x0; x <= xMax; x += minor) {
    const sx = Math.round(x * v.scale + v.ox) + 0.5;
    ctx.strokeStyle = x % major === 0 ? P.grid.major : P.grid.minor;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
  }
  for (let y = y0; y <= yMax; y += minor) {
    const sy = Math.round(v.oy - y * v.scale) + 0.5;
    ctx.strokeStyle = y % major === 0 ? P.grid.major : P.grid.minor;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
  }
}

/* ---------- 对象 ---------- */
function drawObjects(ctx, opts) {
  const objs = state.project.objects;
  for (const w of objs) {
    if (w.type !== 'wall') continue;
    const ops = objs.filter(o => (o.type === 'door' || o.type === 'window' || o.type === 'grille') && o.wallId === w.id);
    drawWall(ctx, w, ops, opts);
  }
  for (const o of objs) {
    if (o.type === 'aisle') drawAisle(ctx, o, opts);
    else if (o.type === 'column') drawColumn(ctx, o, opts);
    else if (o.type === 'cabinet') drawCabinet(ctx, o, opts);
    else if (o.type === 'pdu') drawPdu(ctx, o, opts);
    else if (o.type === 'dbox') {
      const selected = !opts.export && isSel(o.id);
      drawDistributionBox(ctx, o, { point: w2s(o.x, o.y), scale: state.view.scale, selected, selectionColor: P.fb.sel });
      if (selected) drawSelRect(ctx, o, o.props.w * state.view.scale, o.props.d * state.view.scale);
    }
    else if (o.type === 'ac') drawAC(ctx, o, opts);
    else if (o.type === 'ups') drawUPS(ctx, o, opts);
    else if (o.type === 'battery') drawBattery(ctx, o, opts);
    else if (o.type === 'extinguisher') drawExtinguisher(ctx, o, opts);
    else if (o.type === 'vent') drawVent(ctx, o, opts);
  }
  drawGrilleOverlay(ctx, objs, opts); // 格栅被实体压住时置顶补画（桥架仍保持最上层）
  for (const o of objs) { // 框架梁为顶部结构，画在设备层之上（仅次桥架）
    if (o.type === 'beam') drawBeam(ctx, o, opts);
  }
  for (const o of objs) { // 桥架为顶部走线，画在最上层
    if (o.type === 'tray') drawTray(ctx, o, opts);
  }
  drawPipes(ctx, opts);
}

/** 框架梁（柱间混凝土梁）：浅填充 + 两侧边线 + 端头线 + 中线点划（结构平面惯例），
 * 标注 编号+截面（如 KL-1 300×600，沿梁方向）；端点附着柱子时随柱移动。 */
function drawBeam(ctx, o, opts) {
  const s = state.view.scale;
  const e = beamEnds(o, getObj);
  const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  if (L < 1) return;
  const ux = (e.x2 - e.x1) / L, uy = (e.y2 - e.y1) / L;
  const nx = -uy, ny = ux;
  const b = o.props.b || 300;
  const sel = !opts.export && isSel(o.id);
  const single = sel && state.selectedIds.length === 1;
  const colEdge = sel ? P.fb.sel : P.beam.edge;
  const p1 = w2s(e.x1, e.y1), p2 = w2s(e.x2, e.y2);
  const pt = (t, v) => w2s(e.x1 + ux * t + nx * v, e.y1 + uy * t + ny * v); // 局部(沿/跨)→屏幕

  ctx.save();
  // 梁体填充（混凝土浅灰，与柱同族更浅一档，可透出下层地板网格）
  ctx.beginPath();
  const c1 = pt(0, -b / 2), c2 = pt(L, -b / 2), c3 = pt(L, b / 2), c4 = pt(0, b / 2);
  ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y); ctx.lineTo(c4.x, c4.y);
  ctx.closePath();
  ctx.fillStyle = tint(P.beam.edge, .10); ctx.fill();
  // 两侧边线 + 两端头线
  ctx.strokeStyle = colEdge; ctx.lineWidth = 1.2; ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const off of [-b / 2, b / 2]) {
    const a = pt(0, off), q = pt(L, off);
    ctx.moveTo(a.x, a.y); ctx.lineTo(q.x, q.y);
  }
  for (const t of [0, L]) {
    const a = pt(t, -b / 2), q = pt(t, b / 2);
    ctx.moveTo(a.x, a.y); ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  // 中线点划（轴线，结构图惯例）
  ctx.strokeStyle = sel ? P.fb.sel : P.beam.mid; ctx.lineWidth = 0.8;
  ctx.setLineDash([12, 4, 3, 4]);
  ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
  ctx.setLineDash([]);

  // 标注：编号 + 截面 b×h（沿梁方向，与桥架标注同规则防倒置）
  const segPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (segPx > 80) {
    let ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    if (ang > Math.PI / 2) ang -= Math.PI;
    if (ang < -Math.PI / 2) ang += Math.PI;
    ctx.translate((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    ctx.rotate(ang);
    ctx.font = (sel ? 'bold ' : '') + '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = sel ? P.fb.sel : P.beam.dim;
    ctx.fillText(t('label.beam', { name: o.props.name || t('type.beam'), b, h: o.props.h || 600 }),
      0, -(b * s / 2 + 8), segPx - 10);
  }
  ctx.restore();

  if (sel) { // 选中虚线 + 端点手柄（仅单选时给手柄，可拖拽重挂柱子）
    ctx.save();
    ctx.strokeStyle = P.fb.sel; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    ctx.setLineDash([]);
    if (single) {
      ctx.fillStyle = '#fff';
      for (const p of [p1, p2]) { ctx.beginPath(); ctx.rect(p.x - 4, p.y - 4, 8, 8); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
  }
}

/** 线段是否与旋转矩形实体（按 pad 外扩）相交：变换到矩形局部坐标后按轴对齐判定 */
function segHitsSolid(x1, y1, x2, y2, o, pad) {
  const r = -(o.rotation || 0) * Math.PI / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const loc = (x, y) => {
    const dx = x - o.x, dy = y - o.y;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  };
  const a = loc(x1, y1), b = loc(x2, y2);
  const hw = (o.props.w || 0) / 2 + pad, hd = (o.props.d || 0) / 2 + pad;
  return segIntersectsRect(a.x, a.y, b.x, b.y, -hw, -hd, hw, hd);
}

/** 格栅置顶补偿：空调等实体压住墙上格栅时，在实体层之上补画格栅符号——
 *  支持“空调叠在格栅上”的画法（风墙送/回风与空调直联），叠加后两者皆可见。
 *  （绘制顺序为墙体/洞口先画、实体实心填充后画，不补画时格栅会被完全遮住） */
function drawGrilleOverlay(ctx, objs, opts) {
  const solids = objs.filter(isSolid);
  if (!solids.length) return;
  for (const o of objs) {
    if (o.type !== 'grille') continue;
    const w = getObj(o.wallId);
    if (!w) continue;
    const L = wallLen(w);
    if (L < 1) continue;
    const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
    const th = w.props.thickness || 240;
    const c = o.t * L, hw = (o.props.width || 900) / 2;
    const ax = w.x1 + ux * (c - hw), ay = w.y1 + uy * (c - hw);
    const bx = w.x1 + ux * (c + hw), by = w.y1 + uy * (c + hw);
    if (!solids.some(s => segHitsSolid(ax, ay, bx, by, s, th / 2))) continue;
    drawOpening(ctx, w, ux, uy, L, o, th, opts);
  }
}

/** 桥架：矩形外框 + 菱形交叉网格（45° 斜线，格宽=桥架宽）+ 名称/宽度/长度标注 */
function drawTray(ctx, o, opts) {
  const s = state.view.scale;
  const L = wallLen(o);
  if (L < 1) return;
  const ux = (o.x2 - o.x1) / L, uy = (o.y2 - o.y1) / L;
  const nx = -uy, ny = ux;
  const w = o.props.width || 300;
  const sel = !opts.export && isSel(o.id);
  const single = sel && state.selectedIds.length === 1;
  const col = sel ? P.fb.sel : P.tray.line;
  const p1 = w2s(o.x1, o.y1), p2 = w2s(o.x2, o.y2);

  ctx.save();
  ctx.strokeStyle = col; ctx.lineWidth = 0.5; ctx.lineCap = 'butt';
  const pt = (t, v) => w2s(o.x1 + ux * t + nx * v, o.y1 + uy * t + ny * v); // 局部(沿/跨)→屏幕
  ctx.beginPath();
  for (const off of [-w / 2, w / 2]) { // 两侧边线
    const a = pt(0, off), b = pt(L, off);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  for (const t of [0, L]) { // 两端封头线
    const a = pt(t, -w / 2), b = pt(t, w / 2);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  for (const [a, b] of trayDiamonds(L, w)) { // 菱形交叉网格（格宽=桥架宽）
    const p = pt(a[0], a[1]), q = pt(b[0], b[1]);
    ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();

  // 标注：名称 + 宽度 + 长度（沿桥架方向）
  const segPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (segPx > 80) {
    let ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    if (ang > Math.PI / 2) ang -= Math.PI;
    if (ang < -Math.PI / 2) ang += Math.PI;
    ctx.translate((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    ctx.rotate(ang);
    ctx.font = (sel ? 'bold ' : '') + '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = sel ? P.fb.sel : P.tray.dim; // 标注用深一档铜金，白底可读
    ctx.fillText(t('label.tray', { name: o.props.name || t('type.tray'), w, len: Math.round(L) }),
      0, -(w * s / 2 + 8), segPx - 10);
  }
  ctx.restore();

  if (sel) { // 选中虚线 + 端点手柄（仅单选时给手柄）
    ctx.save();
    ctx.strokeStyle = P.fb.sel; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    ctx.setLineDash([]);
    if (single) {
      ctx.fillStyle = '#fff';
      for (const p of [p1, p2]) { ctx.beginPath(); ctx.rect(p.x - 4, p.y - 4, 8, 8); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
  }
}

function drawWall(ctx, w, ops, opts) {
  const L = wallLen(w);
  if (L < 1) return;
  ctx.save(); // 隔离 lineWidth/lineCap 等状态，避免泄漏给后续绘制（如放置预览虚线框变粗）
  const scale = state.view.scale;
  const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
  const th = w.props.thickness || 240;

  // 门窗开洞区间（沿墙参数 0~1），重叠时合并
  const ivs = ops.map(o => {
    const half = (o.props.width || 900) / 2, c = o.t * L;
    return { a: Math.max(0, (c - half) / L), b: Math.min(1, (c + half) / L), o };
  }).sort((p, q) => p.a - q.a);
  const merged = [];
  for (const iv of ivs) {
    const last = merged[merged.length - 1];
    if (last && iv.a <= last.b) { last.b = Math.max(last.b, iv.b); last.list.push(iv.o); }
    else merged.push({ a: iv.a, b: iv.b, list: [iv.o] });
  }

  // 墙体实体段
  const segs = [];
  let cur = 0;
  for (const m of merged) { if (m.a > cur) segs.push([cur, m.a]); cur = Math.max(cur, m.b); }
  if (cur < 1) segs.push([cur, 1]);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = P.wall.body;
  ctx.lineWidth = Math.max(2, th * scale);
  ctx.beginPath();
  for (const [a, b] of segs) {
    const p1 = w2s(w.x1 + ux * L * a, w.y1 + uy * L * a);
    const p2 = w2s(w.x1 + ux * L * b, w.y1 + uy * L * b);
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();

  // 门窗符号
  for (const m of merged) for (const o of m.list) drawOpening(ctx, w, ux, uy, L, o, th, opts);

  const sel = !opts.export && isSel(w.id);
  const single = sel && state.selectedIds.length === 1; // 仅单选时显示端点手柄
  const p1 = w2s(w.x1, w.y1), p2 = w2s(w.x2, w.y2);

  // 全部墙体自动尺寸标注（工勘读图），选中时橙色高亮
  const segPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (segPx > 70) {
    let ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    // 文字防倒立翻转 180° 时局部 +y 随之镜像到对侧，取反使锚点始终在墙向右法线侧
    // （向导房间=外墙侧，建筑制图外部尺寸惯例，避开贴墙机柜/通道带；与 DXF 导出一致）
    let side = 1;
    if (ang > Math.PI / 2) { ang -= Math.PI; side = -1; }
    if (ang < -Math.PI / 2) { ang += Math.PI; side = -1; }
    ctx.save();
    ctx.translate((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    ctx.rotate(ang);
    ctx.font = (sel ? 'bold ' : '') + '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = sel ? P.fb.selDeep : P.wall.dim;
    ctx.fillText(Math.round(L) + ' mm', 0, side * (th * scale / 2 + 8));
    ctx.restore();
  }

  // 选中高亮 + 端点手柄（仅单选时给手柄）
  if (sel) {
    ctx.save();
    ctx.strokeStyle = P.fb.sel; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    ctx.setLineDash([]);
    if (single) {
      ctx.fillStyle = '#fff';
      for (const p of [p1, p2]) { ctx.beginPath(); ctx.rect(p.x - 4, p.y - 4, 8, 8); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
  }
  ctx.restore();
}

function drawOpening(ctx, w, ux, uy, L, o, th, opts) {
  const scale = state.view.scale;
  const wd = o.props.width || 900;
  const c = o.t * L, half = wd / 2;
  const a = { x: w.x1 + ux * (c - half), y: w.y1 + uy * (c - half) };
  const b = { x: w.x1 + ux * (c + half), y: w.y1 + uy * (c + half) };
  const nx = -uy, ny = ux;
  const sel = !opts.export && isSel(o.id);

  // 洞口端头线
  ctx.strokeStyle = P.wall.body; ctx.lineWidth = 1.5;
  for (const p of [a, b]) {
    const q1 = w2s(p.x + nx * th / 2, p.y + ny * th / 2);
    const q2 = w2s(p.x - nx * th / 2, p.y - ny * th / 2);
    ctx.beginPath(); ctx.moveTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y); ctx.stroke();
  }

  if (o.type === 'door') {
    // 门：门扇 90° 全开（垂直于墙面）+ 1/4 开启弧线，弧从洞口闭合位扫到门扇尖端
    // （经典建筑平面图符号，与工具栏门图标一致）。统一在屏幕坐标系计算，保证门扇尖端与弧端点重合
    const ap = w2s(a.x, a.y), bp = w2s(b.x, b.y);
    const theta = Math.atan2(bp.y - ap.y, bp.x - ap.x); // 墙方向 a→b 的屏幕角
    // 开门朝向：side=out（默认）门朝房间外开、side=in 朝房间内开；
    // 房间内部由墙体自动识别（闭合环有向面积优先，退回包围盒中心启发式），旧数据 left/right 兼容映射为 out/in
    const rawSide = o.props.side || 'out';
    const inward = roomInwardSign(w, state.project.objects.filter(x => x.type === 'wall')); // +1=内部在墙方向左侧
    const s = (rawSide === 'in' || rawSide === 'right' ? -1 : 1) * (inward ?? 1);
    const normal = theta + s * Math.PI / 2; // 门扇全开方向（垂直墙）
    // 画单扇：铰链点 hp、闭合角 closed（门扇贴墙位）、半径 r；门扇线到全开位 + 1/4 开启弧（取闭合→全开最短 90° 楔形）
    const drawLeaf = (hp, closed, r) => {
      ctx.beginPath(); ctx.moveTo(hp.x, hp.y);
      ctx.lineTo(hp.x + Math.cos(normal) * r, hp.y + Math.sin(normal) * r); ctx.stroke();
      const sweep = ((normal - closed) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, r, closed, normal, sweep > Math.PI); // sweep>π 时反向画最短弧
      ctx.stroke();
    };
    ctx.strokeStyle = sel ? P.fb.sel : P.door.line; ctx.lineWidth = 1.2;
    if (o.props.leaf === 'double') {
      // 双开门：两端铰链，两扇门扇各宽一半、90° 对称全开，各带一条 1/4 开启弧
      const r = (wd / 2) * scale;
      drawLeaf(ap, theta, r);              // 左扇（铰链在洞口起点端 a）
      drawLeaf(bp, theta + Math.PI, r);    // 右扇（铰链在洞口终点端 b）
    } else {
      // 单开门：铰链在洞口一端，门扇 90° 全开 + 1/4 开启弧
      const right = o.props.swing === 'right';
      drawLeaf(right ? bp : ap, right ? theta + Math.PI : theta, wd * scale);
    }
  } else if (o.type === 'grille') {
    // 格栅（百叶风口，风墙送/回风）：洞口上下两条边框线 + 45° 斜向百叶片，送风蓝/回风绿
    const gcol = sel ? P.fb.sel : ((o.props.kind || '送风') === '回风' ? P.grille.ret : P.grille.supply);
    ctx.strokeStyle = gcol; ctx.lineWidth = 1.2;
    const gy1 = -th / 4, gy2 = th / 4; // 百叶片两侧边界（沿墙法向）
    for (const off of [gy1, gy2]) {
      const q1 = w2s(a.x + nx * off, a.y + ny * off);
      const q2 = w2s(b.x + nx * off, b.y + ny * off);
      ctx.beginPath(); ctx.moveTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y); ctx.stroke();
    }
    const slant = th / 2; // 斜片沿墙方向偏移 = 法向跨度，呈 45°
    ctx.beginPath();
    for (let d = 0; d < wd; d += 200) { // 百叶片间距 200mm
      const d2 = Math.min(d + slant, wd);
      const q1 = w2s(a.x + ux * d + nx * gy1, a.y + uy * d + ny * gy1);
      const q2 = w2s(a.x + ux * d2 + nx * gy2, a.y + uy * d2 + ny * gy2);
      ctx.moveTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y);
    }
    ctx.stroke();
  } else {
    // 窗：洞口内两条平行线
    ctx.strokeStyle = sel ? P.fb.sel : P.window.line; ctx.lineWidth = 1.2;
    for (const off of [-th / 4, th / 4]) {
      const q1 = w2s(a.x + nx * off, a.y + ny * off);
      const q2 = w2s(b.x + nx * off, b.y + ny * off);
      ctx.beginPath(); ctx.moveTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y); ctx.stroke();
    }
  }

  if (sel) { // 选中虚线框
    ctx.save();
    ctx.strokeStyle = P.fb.sel; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
    const pts = [
      w2s(a.x + nx * th / 2, a.y + ny * th / 2), w2s(b.x + nx * th / 2, b.y + ny * th / 2),
      w2s(b.x - nx * th / 2, b.y - ny * th / 2), w2s(a.x - nx * th / 2, a.y - ny * th / 2)];
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.stroke();
    ctx.restore();
  }
}

/** 通道带（冷/热通道）：半透明色带 + 虚线边 + 名称/宽度标注。
 * 封闭通道（enclosed）：四边闭合，两端端线带端门符号（endDoors=两端/单端/无 × doorType=推拉/双开/单开，
 * doorW>0 时门洞居中、两侧为固定封窗段；推拉门=两片错位实线，平开门=门扇 90° 外开 + 1/4 开启弧，
 * 无端门端=整端虚线封板），标注「（封闭）」；不封闭通道两端开口，仅画两侧长边。
 * 旧数据无 enclosed/endDoors/doorType 字段时按 封闭+两端推拉门 处理 */
function drawAisle(ctx, o, opts) {
  const s = state.view.scale;
  const p = w2s(o.x, o.y);
  const cold = (o.props.kind || 'cold') === 'cold';
  const enclosed = o.props.enclosed !== false;
  const wpx = o.props.w * s, dpx = o.props.d * s;
  const sel = !opts.export && isSel(o.id);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((o.rotation || 0) * Math.PI / 180);
  ctx.fillStyle = cold ? tint(P.blue.main, .12) : tint(P.aisle.hotEdge, .11); // 冷=蓝 热=红
  ctx.strokeStyle = sel ? P.fb.sel : (cold ? P.blue.main : P.aisle.hotEdge);
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 5]);
  ctx.fillRect(-wpx / 2, -dpx / 2, wpx, dpx);
  // 两侧长边（封闭/不封闭均画）
  ctx.beginPath();
  ctx.moveTo(-wpx / 2, -dpx / 2); ctx.lineTo(wpx / 2, -dpx / 2);
  ctx.moveTo(-wpx / 2, dpx / 2); ctx.lineTo(wpx / 2, dpx / 2);
  ctx.stroke();
  if (enclosed) { // 封闭通道两端：端门符号 / 封板端线
    const ed = o.props.endDoors || 'both';            // both=两端门 / one=仅局部起点端(-x) / none=两端封板
    const dtype = o.props.doorType || 'sliding';      // sliding=推拉 / double=双开 / single=单开
    const owpx = (+o.props.doorW > 0 ? Math.min(+o.props.doorW, o.props.d) : o.props.d) * s; // 门洞宽（0=全宽）
    for (const sx of [-1, 1]) {
      const ex = sx * wpx / 2;
      const hasDoor = ed === 'both' || (ed === 'one' && sx === -1);
      if (!hasDoor) { // 封板端：整端虚线
        ctx.beginPath(); ctx.moveTo(ex, -dpx / 2); ctx.lineTo(ex, dpx / 2); ctx.stroke();
        continue;
      }
      if (owpx < dpx) { // 门洞两侧固定封窗段（虚线）
        ctx.beginPath();
        ctx.moveTo(ex, -dpx / 2); ctx.lineTo(ex, -owpx / 2);
        ctx.moveTo(ex, owpx / 2); ctx.lineTo(ex, dpx / 2);
        ctx.stroke();
      }
      ctx.setLineDash([]); // 门符号用实线
      if (dtype === 'sliding') { // 推拉门：两片错位实线（一片偏通道内、一片偏外，各覆盖洞口一半）
        const off = Math.max(2, 40 * s);
        ctx.beginPath();
        ctx.moveTo(ex - sx * off, -owpx / 2); ctx.lineTo(ex - sx * off, 0);
        ctx.moveTo(ex + sx * off, 0); ctx.lineTo(ex + sx * off, owpx / 2);
        ctx.stroke();
      } else { // 平开门：门扇 90° 外开（开向通道外）+ 1/4 开启弧（符号同墙体门）；单开铰链在局部 -y 侧
        const open = sx > 0 ? 0 : Math.PI;
        const leaf = (hy, closed, r) => {
          ctx.beginPath(); ctx.moveTo(ex, hy);
          ctx.lineTo(ex + Math.cos(open) * r, hy + Math.sin(open) * r); ctx.stroke();
          const sweep = ((open - closed) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
          ctx.beginPath(); ctx.arc(ex, hy, r, closed, open, sweep > Math.PI); ctx.stroke();
        };
        if (dtype === 'double') { leaf(-owpx / 2, Math.PI / 2, owpx / 2); leaf(owpx / 2, -Math.PI / 2, owpx / 2); }
        else leaf(-owpx / 2, Math.PI / 2, owpx);
      }
      ctx.setLineDash([8, 5]);
    }
  }
  ctx.restore();
  // 标签沿通道长轴排布：随带旋转并归一化到 (-90°,90°]，南北向通道文字竖向显示（自上而下读），永不倒置；maxWidth 沿长轴，不溢出带宽
  if (wpx >= 46) {
    let a = ((o.rotation || 0) % 360 + 360) % 360;
    if (a > 90 && a <= 270) a -= 180; else if (a > 270) a -= 360;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(a * Math.PI / 180);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = cold ? P.blue.strong : P.aisle.hotText;
    ctx.font = 'bold 11px sans-serif';
    const txt = (cold ? t('aisle.cold') : t('aisle.hot')) + (enclosed ? t('aisle.enclosed') : '') + ' ' + Math.round(o.props.d || 0) + 'mm';
    ctx.fillText(txt, 0, 0, wpx - 10);
    ctx.restore();
  }
  if (sel) drawSelRect(ctx, o, wpx, dpx);
  if (sel && state.selectedIds.length === 1) { // 单选：四边中点拖拽手柄（拖两侧调通道宽、拖两端调通道长）
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((o.rotation || 0) * Math.PI / 180);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = P.fb.sel; ctx.lineWidth = 1.2;
    ctx.setLineDash([]);
    for (const [hx, hy] of [[wpx / 2, 0], [-wpx / 2, 0], [0, dpx / 2], [0, -dpx / 2]]) {
      ctx.beginPath(); ctx.rect(hx - 4, hy - 4, 8, 8); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
}

function drawColumn(ctx, o, opts) {
  const s = state.view.scale;
  const p = w2s(o.x, o.y);
  const wpx = o.props.w * s, dpx = o.props.d * s;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((o.rotation || 0) * Math.PI / 180);
  ctx.fillStyle = P.column.fill; ctx.strokeStyle = P.column.edge; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.rect(-wpx / 2, -dpx / 2, wpx, dpx); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = P.column.hatch; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-wpx / 2, -dpx / 2); ctx.lineTo(wpx / 2, dpx / 2);
  ctx.moveTo(wpx / 2, -dpx / 2); ctx.lineTo(-wpx / 2, dpx / 2);
  ctx.stroke();
  ctx.restore();
  drawLabel(ctx, o.props.name, p, Math.max(wpx, dpx));
  if (!opts.export && isSel(o.id)) drawSelRect(ctx, o, wpx, dpx);
}

function drawCabinet(ctx, o, opts) {
  const s = state.view.scale;
  const p = w2s(o.x, o.y);
  const wpx = o.props.w * s, dpx = o.props.d * s;
  const FRONT_H = 6; // 正面深灰色条高度（固定 px，不随缩放；柜体极小时减半防满铺）
  // 机柜自定义颜色：未设色时 cabPaint 回传主题默认柜色（P.cabinet），下面无需分支
  const pc = cabPaint(o.props.color, P.cabinet);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((o.rotation || 0) * Math.PI / 180);
  // 柜体底色 + 正面色条（标识朝向，替代原粗线）；轮廓 1.2px 细线
  ctx.fillStyle = pc.body;
  ctx.fillRect(-wpx / 2, -dpx / 2, wpx, dpx);
  ctx.fillStyle = pc.front;
  ctx.fillRect(-wpx / 2, -dpx / 2, wpx, Math.min(FRONT_H, dpx / 2));
  ctx.strokeStyle = pc.edge; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.rect(-wpx / 2, -dpx / 2, wpx, dpx); ctx.stroke();
  ctx.restore();
  // 文字不随旋转，保证可读（阈值 16/18：默认 600×1200 机柜缩小到 scale≈0.027 才消失，原 24/28≈0.04）
  if (wpx >= 16 && dpx >= 18) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = pc.text; ctx.font = 'bold 11px sans-serif'; // 深色柜体自动用白字（见 cabinetcolor.js）
    ctx.fillText(o.props.name || '', p.x, p.y, Math.max(wpx, dpx) - 8);
    ctx.restore();
  }
  if (!opts.export && isSel(o.id)) drawSelRect(ctx, o, wpx, dpx);
}

/** 列头柜（精密配电柜）：铜金柜体 + 正面色条 + 闪电符号（电气设备，与桥架同族色），标注名称与输入电压/电流 */
function drawPdu(ctx, o, opts) {
  const s = state.view.scale;
  const p = w2s(o.x, o.y);
  const wpx = o.props.w * s, dpx = o.props.d * s;
  const sel = !opts.export && isSel(o.id);
  const pc = cabPaint(o.props.color, { body: tint(P.tray.line, .12), front: P.tray.line, edge: P.tray.line });
  const col = sel ? P.fb.sel : pc.edge;
  const FRONT_H = 6; // 正面色条高度（固定 px，与机柜一致）
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((o.rotation || 0) * Math.PI / 180);
  ctx.fillStyle = pc.body;
  ctx.fillRect(-wpx / 2, -dpx / 2, wpx, dpx);
  ctx.fillStyle = sel ? P.fb.sel : pc.front; // 正面色条（局部 -y 边，标识朝向）
  ctx.fillRect(-wpx / 2, -dpx / 2, wpx, Math.min(FRONT_H, dpx / 2));
  ctx.strokeStyle = col; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.rect(-wpx / 2, -dpx / 2, wpx, dpx); ctx.stroke();
  // 闪电符号（配电标识）：居中偏正面侧，避免与中心文字重叠
  const k = Math.min(wpx, dpx) * 0.32;
  if (k >= 5) {
    const by = -dpx * 0.22;
    ctx.beginPath();
    ctx.moveTo(0.15 * k, by - k); ctx.lineTo(-0.5 * k, by + 0.2 * k); ctx.lineTo(0, by + 0.2 * k);
    ctx.lineTo(-0.15 * k, by + k); ctx.lineTo(0.5 * k, by - 0.2 * k); ctx.lineTo(0, by - 0.2 * k);
    ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
  }
  ctx.restore();
  // 文字不随旋转，保证可读：名称 + 输入电压/电流
  if (wpx >= 26 && dpx >= 26) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const mw = Math.max(wpx, dpx) - 6;
    ctx.fillStyle = pc.custom ? pc.text : P.tray.dim; ctx.font = 'bold 10px sans-serif';
    ctx.fillText(o.props.name || t('type.pdu'), p.x, p.y + dpx * 0.12, mw);
    ctx.font = '9px sans-serif';
    ctx.fillText(`${+o.props.voltage || 0}V / ${+o.props.current || 0}A`, p.x, p.y + dpx * 0.12 + 12, mw);
    ctx.restore();
  }
  if (sel) drawSelRect(ctx, o, wpx, dpx);
}

/** 空调（精密空调）：蓝色矩形 + 风扇圆 + 送风方向箭头（正面=局部 -y 边，与机柜一致） */
function drawAC(ctx, o, opts) {
  const s = state.view.scale;
  const p = w2s(o.x, o.y);
  const wpx = o.props.w * s, dpx = o.props.d * s;
  const sel = !opts.export && isSel(o.id);
  const pc = cabPaint(o.props.color, { body: P.ac.fill, front: P.blue.main, edge: P.blue.main });
  const col = sel ? P.fb.sel : pc.edge;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((o.rotation || 0) * Math.PI / 180);
  ctx.fillStyle = pc.body; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.rect(-wpx / 2, -dpx / 2, wpx, dpx); ctx.fill(); ctx.stroke();
  // 送风方向箭头：正面（-y 边）向外，标识气流方向
  ctx.beginPath();
  ctx.moveTo(0, -dpx / 2);
  ctx.lineTo(0, -dpx / 2 - Math.max(6, dpx * 0.18));
  ctx.moveTo(-4, -dpx / 2 - Math.max(2, dpx * 0.18 - 4));
  ctx.lineTo(0, -dpx / 2 - Math.max(6, dpx * 0.18));
  ctx.lineTo(4, -dpx / 2 - Math.max(2, dpx * 0.18 - 4));
  ctx.stroke();
  // 风扇圆 + 三叶片（尺寸随外形缩放）
  const r = Math.min(wpx, dpx) * 0.28;
  if (r >= 4) {
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 2 / 3;
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.stroke();
  }
  ctx.restore();
  // 只标注制冷量（不显示名称），文字不随旋转，保证可读
  if (wpx >= 26 && dpx >= 26) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = pc.custom ? pc.text : P.blue.sub; ctx.font = '10px sans-serif';
    ctx.fillText((+o.props.cool || 0) + ' kW', p.x, p.y, Math.max(wpx, dpx) - 8);
    ctx.restore();
  }
  if (sel) drawSelRect(ctx, o, wpx, dpx);
}

/** UPS（不间断电源）：铜金电气族矩形 + 正面色条 + 电池组符号，标注名称与额定容量（正面=局部 -y 边，与机柜一致） */
function drawUPS(ctx, o, opts) {
  const s = state.view.scale;
  const p = w2s(o.x, o.y);
  const wpx = o.props.w * s, dpx = o.props.d * s;
  const sel = !opts.export && isSel(o.id);
  const pc = cabPaint(o.props.color, { body: P.ups.fill, front: P.ups.edge, edge: P.ups.edge });
  const col = sel ? P.fb.sel : pc.edge;
  const FRONT_H = 6; // 正面色条高度（固定 px，与机柜/列头柜一致）
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((o.rotation || 0) * Math.PI / 180);
  ctx.fillStyle = pc.body;
  ctx.fillRect(-wpx / 2, -dpx / 2, wpx, dpx);
  ctx.fillStyle = sel ? P.fb.sel : pc.front; // 正面色条（局部 -y 边，标识朝向）
  ctx.fillRect(-wpx / 2, -dpx / 2, wpx, Math.min(FRONT_H, dpx / 2));
  ctx.strokeStyle = col; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.rect(-wpx / 2, -dpx / 2, wpx, dpx); ctx.stroke();
  // 电池组符号（居中偏正面侧）：壳体 + 两个正极柱 + 内部“+”标记
  const k = Math.min(wpx, dpx) * 0.32;
  if (k >= 5) {
    const by = -dpx * 0.2;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.rect(-k * 0.75, by - k * 0.4, k * 1.5, k * 0.8); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-k * 0.25, by - k * 0.4); ctx.lineTo(-k * 0.25, by - k * 0.62);
    ctx.moveTo(k * 0.25, by - k * 0.4); ctx.lineTo(k * 0.25, by - k * 0.62);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-k * 0.2, by); ctx.lineTo(k * 0.2, by);
    ctx.moveTo(0, by - k * 0.2); ctx.lineTo(0, by + k * 0.2);
    ctx.stroke();
  }
  ctx.restore();
  // 文字不随旋转，保证可读：名称 + 额定容量（kVA）
  if (wpx >= 26 && dpx >= 26) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const mw = Math.max(wpx, dpx) - 6;
    ctx.fillStyle = pc.custom ? pc.text : P.ups.text; ctx.font = 'bold 10px sans-serif';
    ctx.fillText(o.props.name || t('type.ups'), p.x, p.y + dpx * 0.14, mw);
    ctx.font = '9px sans-serif';
    ctx.fillText((+o.props.kva || 0) + ' kVA', p.x, p.y + dpx * 0.14 + 12, mw);
    ctx.restore();
  }
  if (sel) drawSelRect(ctx, o, wpx, dpx);
}

/** 蓄电池（UPS 电池柜）：铜金电气族矩形 + 正面色条 + 三个并排电池单元符号（与 UPS 的单电池组区分），标注名称与单只容量 */
function drawBattery(ctx, o, opts) {
  const s = state.view.scale;
  const p = w2s(o.x, o.y);
  const wpx = o.props.w * s, dpx = o.props.d * s;
  const sel = !opts.export && isSel(o.id);
  const pc = cabPaint(o.props.color, { body: P.battery.fill, front: P.battery.edge, edge: P.battery.edge });
  const col = sel ? P.fb.sel : pc.edge;
  const FRONT_H = 6; // 正面色条高度（固定 px，与机柜/列头柜/UPS 一致）
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((o.rotation || 0) * Math.PI / 180);
  ctx.fillStyle = pc.body;
  ctx.fillRect(-wpx / 2, -dpx / 2, wpx, dpx);
  ctx.fillStyle = sel ? P.fb.sel : pc.front; // 正面色条（局部 -y 边，标识朝向）
  ctx.fillRect(-wpx / 2, -dpx / 2, wpx, Math.min(FRONT_H, dpx / 2));
  ctx.strokeStyle = col; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.rect(-wpx / 2, -dpx / 2, wpx, dpx); ctx.stroke();
  // 三个并排电池单元符号（居中偏正面侧）：每个=小矩形壳体 + 顶部正极柱
  const k = Math.min(wpx, dpx) * 0.26;
  if (k >= 4) {
    const by = -dpx * 0.2;
    ctx.lineWidth = 1.2;
    for (let i = -1; i <= 1; i++) {
      const cx = i * k * 1.05;
      ctx.beginPath(); ctx.rect(cx - k * 0.42, by - k * 0.38, k * 0.84, k * 0.76); ctx.stroke();
      ctx.beginPath(); // 正极柱（壳顶中央小凸）
      ctx.moveTo(cx - k * 0.12, by - k * 0.38); ctx.lineTo(cx - k * 0.12, by - k * 0.58);
      ctx.lineTo(cx + k * 0.12, by - k * 0.58); ctx.lineTo(cx + k * 0.12, by - k * 0.38);
      ctx.stroke();
    }
  }
  ctx.restore();
  // 文字不随旋转，保证可读：名称 + 规格（只数×单只容量 Ah）
  if (wpx >= 26 && dpx >= 26) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const mw = Math.max(wpx, dpx) - 6;
    ctx.fillStyle = pc.custom ? pc.text : P.battery.text; ctx.font = 'bold 10px sans-serif';
    ctx.fillText(o.props.name || t('type.battery'), p.x, p.y + dpx * 0.14, mw);
    ctx.font = '9px sans-serif';
    const cells = +o.props.cells || 0, ah = +o.props.ah || 0;
    ctx.fillText((cells > 0 ? cells + '×' : '') + ah + ' Ah', p.x, p.y + dpx * 0.14 + 12, mw);
    ctx.restore();
  }
  if (sel) drawSelRect(ctx, o, wpx, dpx);
}

/** 灭火器：消防红矩形 + 居中灭火器符号（瓶体 + 顶部压把/喷管），标注名称与充装量（kg） */
function drawExtinguisher(ctx, o, opts) {
  const s = state.view.scale;
  const p = w2s(o.x, o.y);
  const wpx = o.props.w * s, dpx = o.props.d * s;
  const sel = !opts.export && isSel(o.id);
  const pc = cabPaint(o.props.color, { body: P.extinguisher.fill, front: P.extinguisher.edge, edge: P.extinguisher.edge });
  const col = sel ? P.fb.sel : pc.edge;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((o.rotation || 0) * Math.PI / 180);
  ctx.fillStyle = pc.body;
  ctx.fillRect(-wpx / 2, -dpx / 2, wpx, dpx);
  ctx.strokeStyle = col; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.rect(-wpx / 2, -dpx / 2, wpx, dpx); ctx.stroke();
  // 灭火器符号（居中偏上）：圆角瓶体 + 顶部压把横杆 + 左侧喷管弯出
  const k = Math.min(wpx, dpx) * 0.34;
  if (k >= 4) {
    const by = -dpx * 0.08;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); // 瓶体（圆角矩形）
    if (ctx.roundRect) ctx.roundRect(-k * 0.3, by - k * 0.42, k * 0.6, k * 0.84, k * 0.18);
    else ctx.rect(-k * 0.3, by - k * 0.42, k * 0.6, k * 0.84);
    ctx.stroke();
    ctx.beginPath(); // 压把（瓶顶横杆 + 中心立杆）
    ctx.moveTo(-k * 0.32, by - k * 0.56); ctx.lineTo(k * 0.32, by - k * 0.56);
    ctx.moveTo(0, by - k * 0.56); ctx.lineTo(0, by - k * 0.42);
    // 喷管（自压把左端向下弯出）
    ctx.moveTo(-k * 0.32, by - k * 0.56);
    ctx.quadraticCurveTo(-k * 0.6, by - k * 0.54, -k * 0.64, by - k * 0.26);
    ctx.stroke();
  }
  ctx.restore();
  // 文字不随旋转，保证可读：名称 + 充装量（kg）
  if (wpx >= 18 && dpx >= 18) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const mw = Math.max(wpx, dpx) - 4;
    ctx.fillStyle = pc.custom ? pc.text : P.extinguisher.text; ctx.font = 'bold 9px sans-serif';
    ctx.fillText(o.props.name || t('type.extinguisher'), p.x, p.y + dpx * 0.22, mw);
    ctx.font = '8px sans-serif';
    ctx.fillText((+o.props.kg || 0) + ' kg', p.x, p.y + dpx * 0.22 + 11, mw);
    ctx.restore();
  }
  if (sel) drawSelRect(ctx, o, wpx, dpx);
}

/** 地板出风口（静电地板风口，下送风）：蓝框矩形 + 网状点孔圆点阵（冲孔通风板，默认 600×600 地板模数） */
function drawVent(ctx, o, opts) {
  const s = state.view.scale;
  const p = w2s(o.x, o.y);
  const wpx = o.props.w * s, dpx = o.props.d * s;
  const sel = !opts.export && isSel(o.id);
  const pc = cabPaint(o.props.color, { body: P.vent.fill, front: P.blue.soft, edge: P.blue.soft });
  const col = sel ? P.fb.sel : pc.edge;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((o.rotation || 0) * Math.PI / 180);
  ctx.fillStyle = pc.body; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.rect(-wpx / 2, -dpx / 2, wpx, dpx); ctx.fill(); ctx.stroke();
  // 网状点孔（冲孔通风板）：居中圆点阵，孔距 75mm、孔半径 18mm（缩放过小时保底可见）
  const step = Math.max(75 * s, 4);
  const r = Math.max(1, 18 * s);
  const nx = Math.max(1, Math.floor((wpx - 6) / step));
  const ny = Math.max(1, Math.floor((dpx - 6) / step));
  ctx.fillStyle = col;
  ctx.beginPath(); // 全部圆点并入一条路径，一次填充（性能）
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const xx = (ix - (nx - 1) / 2) * step, yy = (iy - (ny - 1) / 2) * step;
      ctx.moveTo(xx + r, yy);
      ctx.arc(xx, yy, r, 0, Math.PI * 2);
    }
  }
  ctx.fill();
  ctx.restore();
  // 文字不随旋转，保证可读
  if (wpx >= 26 && dpx >= 26) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = pc.custom ? pc.text : P.vent.name; ctx.font = 'bold 10px sans-serif';
    ctx.fillText(o.props.name || t('typeShort.vent'), p.x, p.y - 4, Math.max(wpx, dpx) - 6);
    if (+o.props.air > 0) {
      ctx.fillStyle = pc.custom ? pc.text : P.blue.subSoft; ctx.font = '9px sans-serif';
      ctx.fillText(+o.props.air + ' m³/h', p.x, p.y + 7, Math.max(wpx, dpx) - 6);
    }
    ctx.restore();
  }
  if (sel) drawSelRect(ctx, o, wpx, dpx);
}

function drawLabel(ctx, text, p, maxW) {
  if (maxW < 34 || !text) return;
  ctx.save();
  ctx.fillStyle = P.label.main; ctx.font = '11px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, p.x, p.y, maxW - 6);
  ctx.restore();
}

function drawSelRect(ctx, o, wpx, dpx) {
  const p = w2s(o.x, o.y);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((o.rotation || 0) * Math.PI / 180);
  ctx.strokeStyle = P.fb.sel; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
  ctx.strokeRect(-wpx / 2 - 3, -dpx / 2 - 3, wpx + 6, dpx + 6);
  ctx.restore();
}

/* ---------- 操作预览 ---------- */
// 门窗放置 / 柱子 / 机柜 放置预览
function drawGhost(ctx) {
  const t = state.tool, m = runtime.mouse, s = state.view.scale;
  if (t === 'door' || t === 'window' || t === 'grille') {
    const h = runtime.hoverOpening;
    if (!h) return;
    const w = h.wall, L = wallLen(w);
    if (L < 1) return;
    const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
    const nx = -uy, ny = ux;
    const width = defaultProps(t).width || 900; // 与 openingDown 真实放置宽度一致（跟随上一次设置）
    const tc = Math.max(width / 2 / L, Math.min(1 - width / 2 / L, h.t));
    const c = tc * L, hw = width / 2, th = w.props.thickness || 240;
    const a = { x: w.x1 + ux * (c - hw), y: w.y1 + uy * (c - hw) };
    const b = { x: w.x1 + ux * (c + hw), y: w.y1 + uy * (c + hw) };
    const pts = [
      w2s(a.x + nx * th / 2, a.y + ny * th / 2), w2s(b.x + nx * th / 2, b.y + ny * th / 2),
      w2s(b.x - nx * th / 2, b.y - ny * th / 2), w2s(a.x - nx * th / 2, a.y - ny * th / 2)];
    ctx.save();
    ctx.fillStyle = tint(P.fb.sel, .35); ctx.strokeStyle = P.fb.sel; ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    return;
  }
  // 通道POD预览（起点=首排第一台中心，跟随鼠标）
  if (t === 'cabpod' && state.podCfg) {
    const cfg = state.podCfg;
    const geo = podGeometry(cfg, snapVal(m.wx), snapVal(m.wy));
    const cw = cfg.w * s, cd = cfg.d * s;
    ctx.save();
    // 通道带（冷/热交替，按各带自身类型着色；封闭带四边闭合，不封闭带两端开口）
    ctx.setLineDash([8, 5]);
    for (const b of geo.bands) {
      const bc = b.kind === 'cold';
      ctx.fillStyle = bc ? tint(P.blue.main, .16) : tint(P.aisle.hotEdge, .14);
      ctx.strokeStyle = bc ? P.blue.main : P.aisle.hotEdge;
      const p = w2s(b.x, b.y);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(b.rotation * Math.PI / 180);
      ctx.fillRect(-b.w * s / 2, -b.d * s / 2, b.w * s, b.d * s);
      if (b.enclosed !== false) {
        ctx.strokeRect(-b.w * s / 2, -b.d * s / 2, b.w * s, b.d * s);
      } else {
        ctx.beginPath();
        ctx.moveTo(-b.w * s / 2, -b.d * s / 2); ctx.lineTo(b.w * s / 2, -b.d * s / 2);
        ctx.moveTo(-b.w * s / 2, b.d * s / 2); ctx.lineTo(b.w * s / 2, b.d * s / 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    // 各排机柜
    ctx.fillStyle = tint(P.blue.main, .18); ctx.strokeStyle = P.blue.main;
    ctx.setLineDash([4, 3]);
    for (const row of geo.rows) {
      for (let i = 0; i < cfg.count; i++) {
        const p = w2s(geo.horiz ? row.x + i * geo.pitch : row.x,
          geo.horiz ? row.y : row.y + i * geo.pitch);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(row.rotation * Math.PI / 180);
        ctx.fillRect(-cw / 2, -cd / 2, cw, cd);
        ctx.strokeRect(-cw / 2, -cd / 2, cw, cd);
        ctx.restore();
      }
    }
    ctx.restore();
    return;
  }
  // 机柜排预览（起点=第一台中心，跟随鼠标）
  if (t === 'cabrow' && state.rowCfg) {
    const cfg = state.rowCfg;
    const x0 = snapVal(m.wx), y0 = snapVal(m.wy);
    const pitch = cfg.w + cfg.gap;
    const axisX = cfg.rotation % 180 === 0;
    const cd = (cfg.d || 1200) * s, cw = cfg.w * s;
    ctx.save();
    ctx.fillStyle = tint(P.blue.main, .18); ctx.strokeStyle = P.blue.main; ctx.setLineDash([4, 3]);
    for (let i = 0; i < cfg.count; i++) {
      const p = w2s(axisX ? x0 + i * pitch : x0, axisX ? y0 : y0 + i * pitch);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(cfg.rotation * Math.PI / 180);
      ctx.fillRect(-cw / 2, -cd / 2, cw, cd);
      ctx.strokeRect(-cw / 2, -cd / 2, cw, cd);
      ctx.restore();
    }
    ctx.restore();
    return;
  }
  if (t === 'vent') { // 地板出风口放置预览（600×600 地板模数）
    const dp = defaultProps('vent'), vw = dp.w || 600, vd = dp.d || 600;
    const pc = cabPaint(dp.color, { body: P.vent.fill, front: P.blue.soft, edge: P.blue.soft });
    const p = w2s(snapVal(m.wx), snapVal(m.wy));
    ctx.save();
    ctx.fillStyle = tint(pc.ghost, .18); ctx.strokeStyle = pc.edge; ctx.setLineDash([4, 3]);
    ctx.fillRect(p.x - vw * s / 2, p.y - vd * s / 2, vw * s, vd * s);
    ctx.strokeRect(p.x - vw * s / 2, p.y - vd * s / 2, vw * s, vd * s);
    ctx.restore();
    return;
  }
  if (t === 'ac') { // 空调放置预览（与 placeRect 真实尺寸一致，跟随上一次设置）
    const dp = defaultProps('ac');
    const aw = dp.w || 2500, ad = dp.d || 1300;
    let cx = snapVal(m.wx), cy = snapVal(m.wy);
    // 空调→格栅磁吸预览：靠近格栅时预览吸到格栅正前方贴合位（与 placeRect 一致），并画吸附连线
    const g = grilleSnapAC(state.project.objects, cx, cy, aw, ad, 0, 24 / s);
    if (g) { cx = g.x; cy = g.y; }
    const p = w2s(cx, cy);
    ctx.save();
    const pc = cabPaint(dp.color, { body: P.ac.fill, front: P.blue.main, edge: P.blue.main });
    ctx.fillStyle = tint(pc.ghost, .2); ctx.strokeStyle = pc.edge; ctx.setLineDash([4, 3]);
    ctx.fillRect(p.x - aw * s / 2, p.y - ad * s / 2, aw * s, ad * s);
    ctx.strokeRect(p.x - aw * s / 2, p.y - ad * s / 2, aw * s, ad * s);
    if (g) { // 吸附指示：格栅中心 → 机位中心连线
      const q = w2s(g.gx, g.gy);
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    ctx.restore();
    return;
  }
  if (t === 'column' || t === 'cabinet' || t === 'pdu' || t === 'dbox' || t === 'ups' || t === 'battery' || t === 'extinguisher') {
    const dp = defaultProps(t); // 与 placeRect 真实尺寸一致（跟随上一次设置）
    const gw = dp.w || 600, gd = dp.d || 1200;
    const p = w2s(snapVal(m.wx), snapVal(m.wy));
    const pc = t === 'cabinet' || dp.color ? cabPaint(dp.color, P.cabinet) : null; // 设备预览跟随该类型上次设置的颜色
    ctx.save();
    ctx.fillStyle = pc ? tint(pc.ghost, .35)
      : t === 'dbox' ? tint(DISTRIBUTION_BOX_PALETTE.edge, .22)
      : t === 'pdu' ? tint(P.tray.line, .22)
      : t === 'ups' ? tint(P.ups.edge, .2)
      : t === 'extinguisher' ? tint(P.extinguisher.edge, .2)
      : t === 'battery' ? tint(P.battery.edge, .2) : tint(P.blue.main, .2);
    ctx.strokeStyle = pc ? pc.edge
      : t === 'dbox' ? DISTRIBUTION_BOX_PALETTE.edge
      : t === 'pdu' ? P.tray.line
      : t === 'ups' ? P.ups.edge
      : t === 'extinguisher' ? P.extinguisher.edge
      : t === 'battery' ? P.battery.edge : P.blue.main;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(p.x - gw * s / 2, p.y - gd * s / 2, gw * s, gd * s);
    ctx.strokeRect(p.x - gw * s / 2, p.y - gd * s / 2, gw * s, gd * s);
    ctx.restore();
  }
}

// 墙体/桥架/框架梁链式绘制橡皮筋 + 长度提示
function drawPreview(ctx) {
  const dr = runtime.drawing;
  if (!dr) return;
  if (state.tool === 'beam') { // 框架梁预览：终点吸附柱心（命中柱高亮标记），线宽=梁宽
    const m = runtime.mouse;
    const last = dr.last;
    const tol = 8 / state.view.scale;
    let col = null;
    for (let i = state.project.objects.length - 1; i >= 0; i--) {
      const q = state.project.objects[i];
      if (q.type !== 'column') continue;
      const r = -(q.rotation || 0) * Math.PI / 180;
      const c = Math.cos(r), s2 = Math.sin(r);
      const lx = (m.wx - q.x) * c - (m.wy - q.y) * s2;
      const ly = (m.wx - q.x) * s2 + (m.wy - q.y) * c;
      if (Math.abs(lx) <= (q.props.w || 600) / 2 + tol && Math.abs(ly) <= (q.props.d || 600) / 2 + tol) { col = q; break; }
    }
    let cx = col ? col.x : snapVal(m.wx), cy = col ? col.y : snapVal(m.wy);
    if (runtime.shiftKey) { // Shift 正交
      if (Math.abs(cx - last.x) >= Math.abs(cy - last.y)) cy = last.y; else cx = last.x;
    }
    const pl = w2s(last.x, last.y), pc = w2s(cx, cy);
    const bw = defaultProps('beam').b || 300;
    ctx.save();
    ctx.strokeStyle = P.beam.edge;
    ctx.lineWidth = Math.max(2, bw * state.view.scale);
    ctx.globalAlpha = 0.5; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(pl.x, pl.y); ctx.lineTo(pc.x, pc.y); ctx.stroke();
    ctx.globalAlpha = 1;
    if (col) { // 吸附柱标记：柱心琥珀小方块（与放置结果一致）
      ctx.strokeStyle = P.fb.sel; ctx.lineWidth = 1.5;
      ctx.strokeRect(pc.x - 5, pc.y - 5, 10, 10);
    }
    const L = Math.hypot(cx - last.x, cy - last.y);
    if (L > 0) {
      ctx.fillStyle = P.beam.edge; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(Math.round(L) + ' mm', m.sx + 12, m.sy - 8);
    }
    ctx.restore();
    return;
  }
  if (state.tool !== 'wall' && state.tool !== 'tray') return;
  const isTray = state.tool === 'tray';
  const m = runtime.mouse;
  const last = dr.last;
  let cx = snapVal(m.wx), cy = snapVal(m.wy);
  if (runtime.shiftKey) { // Shift 正交
    if (Math.abs(cx - last.x) >= Math.abs(cy - last.y)) cy = last.y; else cx = last.x;
  }
  const pl = w2s(last.x, last.y), pc = w2s(cx, cy);
  ctx.save();
  ctx.strokeStyle = isTray ? P.tray.line : P.blue.main;
  ctx.lineWidth = Math.max(2, (isTray ? (defaultProps('tray').width || 300) : (defaultProps('wall').thickness || 240)) * state.view.scale); // 与真实绘制线宽一致（跟随上一次设置）
  ctx.globalAlpha = 0.55; ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(pl.x, pl.y); ctx.lineTo(pc.x, pc.y); ctx.stroke();
  ctx.globalAlpha = 1;
  const L = Math.hypot(cx - last.x, cy - last.y);
  if (dr.typed) { // 直接长度输入中
    ctx.fillStyle = P.fb.selDeep; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(t('canvas.typed', { len: dr.typed }), m.sx + 12, m.sy + 22);
  } else if (L > 0) {
    ctx.fillStyle = P.blue.main; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(Math.round(L) + ' mm', m.sx + 12, m.sy - 8);
  }
  ctx.restore();
}
