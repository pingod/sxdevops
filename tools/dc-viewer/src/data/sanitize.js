/**
 * 项目数据清洗（3D 场景的唯一数据来源）。
 *
 * 规则与原 DCDesigner 导出一致：
 *   - 丢弃缺 id/type 的对象；
 *   - 门窗/格栅随墙剔除（墙体不存在时一并移除）；
 *   - 坐标/尺寸/电气参数强制转型，非负物理量夹到 ≥0；
 *   - 门 side:left/right → out/in；
 *   - 机柜颜色仅接受 #rgb / #rrggbb，非法值删除（回默认柜色）；
 *   - 空调 acType 旧值「风墙末端」→「远端风墙空调」。
 */
import { normalizeCabColor } from './color.js';

const numOr = v => {
  const n = +v;
  return Number.isFinite(n) ? n : 0;
};

const NUM_TOP = ['x', 'y', 'z', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2', 'rotation', 't'];
const NUM_PROPS = [
  'thickness', 'height', 'width', 'sill', 'bodyH', 'w', 'd', 'h',
  'u', 'power', 'rpdu', 'voltage', 'current', 'cool', 'air', 'temp', 'supplyRh', 'returnTemp',
  'kva', 'backup',
  'doorW',
  'ah', 'cells',
  'b', 'top',
  'outsideDiameter', 'wallThickness', 'insulationThickness',
  'kg',
];
const NONNEG_PROPS = new Set(NUM_PROPS.filter(k => k !== 'temp' && k !== 'returnTemp'));

/**
 * 原地清洗并返回项目数据。
 * @param {{name?:string, meta?:object, objects:Array}} p
 */
export function sanitize(p) {
  if (!p || !Array.isArray(p.objects)) {
    throw new Error('不是有效的 DCDesigner 项目数据（缺少 objects 数组）');
  }
  p.objects = p.objects.filter(o => o && o.id && o.type);
  const ids = new Set(p.objects.map(o => o.id));
  p.objects = p.objects.filter(o =>
    !((o.type === 'door' || o.type === 'window' || o.type === 'grille') && !ids.has(o.wallId)));
  for (const o of p.objects) {
    o.props = o.props || {};
    for (const k of NUM_TOP) if (o[k] !== undefined) o[k] = numOr(o[k]);
    for (const k of NUM_PROPS) {
      if (o.props[k] === undefined) continue;
      o.props[k] = numOr(o.props[k]);
      if (NONNEG_PROPS.has(k) && o.props[k] < 0) o.props[k] = 0;
    }
    if (o.type === 'door' && o.props.side === 'left') o.props.side = 'out';
    else if (o.type === 'door' && o.props.side === 'right') o.props.side = 'in';
    if (o.props.color !== undefined) {
      const c = normalizeCabColor(o.props.color);
      if (c) o.props.color = c;
      else delete o.props.color;
    }
    if (o.type === 'ac' && o.props.acType === '风墙末端') o.props.acType = '远端风墙空调';
  }
  if (!p.meta || typeof p.meta !== 'object') p.meta = { surveyor: '', date: '' };
  if (typeof p.name !== 'string') p.name = '';
  return p;
}

/** 按 id 取对象（框架梁端点动态求解用） */
export function getObj(project, id) {
  return project.objects.find(o => o.id === id) || null;
}

/** 框架梁端点：附着柱心优先，否则回退存储坐标；返回 {x1,y1,x2,y2,c1,c2} */
export function beamEnds(o, resolve) {
  let x1 = o.x1;
  let y1 = o.y1;
  let x2 = o.x2;
  let y2 = o.y2;
  let c1 = null;
  let c2 = null;
  if (o.col1 && resolve) {
    c1 = resolve(o.col1);
    if (c1) {
      x1 = c1.x;
      y1 = c1.y;
    }
  }
  if (o.col2 && resolve) {
    c2 = resolve(o.col2);
    if (c2) {
      x2 = c2.x;
      y2 = c2.y;
    }
  }
  return { x1, y1, x2, y2, c1, c2 };
}
