/** 多选对象对齐：以选区整体外沿（联合包围盒）为基准的 6 向对齐。
 * 参与类型：矩形对象（机柜/柱子/空调/风口/列头柜/通道带）与线段对象（墙/桥架，两端点整体平移）；
 * 挂墙门/窗/格栅无独立坐标（wallId+t 参数化定位），不参与——所属墙被对齐平移时随墙自动跟随（t 不变）。
 * 对齐组作为互斥锚点（自身不动），推开重叠的未选中实体邻居；组内互叠仅提示残留（同旋转规则）。
 * 整批一步撤销；对齐后选中集保持，可继续拖动/旋转/再次对齐。 */
import { state, runtime, ui, pushUndo, markDirty, getObj } from './state.js';
import { objOutline, beamEnds, isSolid } from './geo.js';
import { resolveOverlaps } from './collision.js';
import { translatePipe } from './pipe-geometry.js';
import { t } from './i18n.js';

/** 对齐模式：left/hcenter/right（X 向）、bottom/vcenter/top（Y 向；世界坐标 Y 向北=屏幕上方） */
export const ALIGN_MODES = ['left', 'hcenter', 'right', 'bottom', 'vcenter', 'top'];

/** 不参与对齐的类型：挂墙门/窗/格栅（沿墙参数 t 定位，无独立坐标） */
const EXCLUDE_TYPES = new Set(['door', 'window', 'grille']);

/** 对象包围盒（世界坐标）：复用 objOutline 轮廓（墙含半厚、桥架含半宽、矩形对象含旋转），无轮廓返回 null */
function bboxOf(o) {
  const poly = objOutline(o, getObj);
  if (!poly) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** 从对象数组中筛出可参与对齐的对象（排除挂墙门窗与无轮廓对象）；≥2 个时对齐才有意义 */
export function alignableObjects(objs) {
  return (objs || []).filter(o => o && !EXCLUDE_TYPES.has(o.type) && bboxOf(o));
}

/** 对象按 (dx,dy) 平移：矩形对象移中心；墙/桥架两端点整体平移（其上挂墙门窗随 t 参数自动跟随）；
 * 框架梁端点固化为当前位置后平移并脱离柱附着（对齐移动梁，不带动柱子） */
function translate(o, dx, dy) {
  if(o.type==='pipe'){Object.assign(o,translatePipe(o,dx,dy));return;}
  if (o.type === 'wall' || o.type === 'tray') {
    o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
  } else if (o.type === 'beam') {
    const e = beamEnds(o, getObj);
    o.col1 = o.col2 = null;
    o.x1 = e.x1 + dx; o.y1 = e.y1 + dy; o.x2 = e.x2 + dx; o.y2 = e.y2 + dy;
  } else {
    o.x += dx; o.y += dy;
  }
}

/** 对齐计划（不落数据，供预览/单测）：每个需要移动的对象 → 位移 {dx,dy}。
 * 基准 = 选区联合包围盒的对应边/中线；已在基准线上的对象不出现（delta=0）。 */
export function alignPlan(objs, mode) {
  const items = (objs || []).map(o => ({ o, b: bboxOf(o) })).filter(it => it.b);
  const plan = new Map();
  if (items.length < 2) return plan;
  const horiz = mode === 'left' || mode === 'hcenter' || mode === 'right';
  const minX = Math.min(...items.map(it => it.b.minX));
  const maxX = Math.max(...items.map(it => it.b.maxX));
  const minY = Math.min(...items.map(it => it.b.minY));
  const maxY = Math.max(...items.map(it => it.b.maxY));
  const target = {
    left: minX, hcenter: (minX + maxX) / 2, right: maxX,
    bottom: minY, vcenter: (minY + maxY) / 2, top: maxY,
  }[mode];
  if (target === undefined) return plan; // 非法模式
  const own = { left: 'minX', hcenter: 'cx', right: 'maxX', bottom: 'minY', vcenter: 'cy', top: 'maxY' }[mode];
  for (const it of items) {
    const delta = target - it.b[own];
    if (Math.abs(delta) < 1e-9) continue; // 已在基准线上
    plan.set(it.o, horiz ? { dx: delta, dy: 0 } : { dx: 0, dy: delta });
  }
  return plan;
}

/** 多选对象对齐（整批一步撤销）：以选区整体外沿为基准，6 向对齐。
 * 返回实际移动的对象数；可参与对象 <2 个或已全部在基准线上时不动作（仅提示）。 */
export function alignSelection(mode, objs = state.selectedIds.map(getObj).filter(Boolean)) {
  const list = alignableObjects(objs);
  if (list.length < 2) { ui.hint(t('hint.alignNeed2')); return 0; }
  const plan = alignPlan(list, mode);
  if (!plan.size) { ui.hint(t('hint.alreadyAligned')); return 0; }
  try{for(const [o,v]of plan)if(o.type==='pipe')translatePipe(o,v.dx,v.dy);}catch(e){ui.hint(e.message);return 0;}
  pushUndo();
  for (const [o, v] of plan) translate(o, v.dx, v.dy);
  runtime.nudgeSig = null; // 对齐后立即方向键微调须重新记撤销（避免被并进对齐的撤销步）
  const r = resolveOverlaps(list.filter(isSolid)); // 对齐组为锚：推开未选中的实体邻居，组内保持对齐线
  markDirty();
  ui.hint(t('hint.aligned', { n: plan.size, mode: t('align.' + mode) }) +
    (r.moved ? t('hint.pushedN', { n: r.moved }) : '') +
    (r.left ? t('hint.leftN', { n: r.left }) : ''));
  return plan.size;
}
