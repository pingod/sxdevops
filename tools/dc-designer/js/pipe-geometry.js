/** 液冷直管唯一数据契约与几何（mm，Z=完成地面中心标高）。无 DOM/全局状态依赖。 */
import { normalizeCabColor } from './cabinetcolor.js';

export const PIPE_EPS = .01;

 // 建模容差，不代表工程规范
export const PIPE_DEFAULTS = Object.freeze({
  nominalSize: 'DN50',
  outsideDiameter: 60.3,
  wallThickness: 2,
  insulationThickness: 0,
  material: 'stainless-steel-304',
  color: '',
  loopSide: 'secondary',
  side: 'supply',
  flowDirection: 'forward',
  remark: ''
});

// 示例系列明确来源/范围，不从 DN 推断任意管材外径。用户须核对采购规格。
export const PIPE_PRESETS = [ {
  label: 'ASME B36.19M / Sch 10S · DN25',
  nominalSize: 'DN25',
  outsideDiameter: 33.4,
  wallThickness: 2.77
}, {
  label: 'ASME B36.19M / Sch 10S · DN50',
  nominalSize: 'DN50',
  outsideDiameter: 60.3,
  wallThickness: 2.77
}, {
  label: 'ASME B36.19M / Sch 10S · DN100',
  nominalSize: 'DN100',
  outsideDiameter: 114.3,
  wallThickness: 3.05
} ];

export const PIPE_FORMAT_KEYS = [ 'nominalSize', 'outsideDiameter', 'wallThickness', 'insulationThickness', 'material', 'color' ];

const finite = (v, key) => {
  if ((typeof v!=='number' && typeof v!=='string') || (typeof v==='string' && v.trim()==='') || !Number.isFinite(+v)) throw new Error(`pipe.${key}: 必须为有限数字 / finite number required`);
  return +v;
};

const text = v => typeof v === 'string' ? v.slice(0, 200) : '';

/** 返回已验证的新对象，不改变输入；所有写入口在落数据/记撤销前调用。 */
export function normalizePipe(input) {
  if (!input || !input.props || typeof input.props !== 'object' || Array.isArray(input.props)) throw new Error('pipe.props: 必须为对象 / object required');
  if (input.props.outsideDiameter == null) throw new Error('pipe.outsideDiameter: 缺少实际外径 / actual OD required');
  const o = {
    ...input,
    type: 'pipe',
    props: {
      ...PIPE_DEFAULTS,
      wallThickness: null,
      ...input.props
    }
  };
  for (const k of [ 'x1', 'y1', 'z1', 'x2', 'y2', 'z2' ]) o[k] = finite(input[k], k);
  const p = o.props;
  if ([ 'x', 'y', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2', 'systemId', 'circuitId', 'pairId' ].some(k => k in p)) throw new Error('pipe: 几何/关联字段必须放顶层 / geometry and IDs must be top-level');
  p.outsideDiameter = finite(p.outsideDiameter, 'outsideDiameter');
  p.insulationThickness = finite(p.insulationThickness, 'insulationThickness');
  if (p.outsideDiameter <= 0) throw new Error('pipe.outsideDiameter: 必须 > 0 / must be positive');
  if (p.insulationThickness < 0) throw new Error('pipe.insulationThickness: 必须 ≥ 0 / must be nonnegative');
  p.wallThickness = p.wallThickness == null || p.wallThickness === '' ? null : finite(p.wallThickness, 'wallThickness');
  if (p.wallThickness !== null && (p.wallThickness <= 0 || p.wallThickness * 2 >= p.outsideDiameter)) throw new Error('pipe.wallThickness: 要求 0 < 2t < OD');
  for (const [k, vals] of Object.entries({
    side: [ 'supply', 'return' ],
    loopSide: [ 'primary', 'secondary' ],
    flowDirection: [ 'forward', 'reverse', 'none' ]
  })) if (!vals.includes(p[k])) throw new Error(`pipe.${k}: ${vals.join(' / ')}`);
  if (![ p.outsideDiameter + 2 * p.insulationThickness, ...[ 'x1', 'y1', 'z1', 'x2', 'y2', 'z2' ].map(k => o[k]) ].every(v => Number.isFinite(v) && Math.abs(v) <= 1e9)) throw new Error('pipe: 超出建模数值范围 / modelling range exceeded (1e9 mm)');
  const c = normalizeCabColor(p.color);
  if (p.color !== '' && !c) throw new Error('pipe.color: HEX #rrggbb / #rgb');
  p.color = c;
  for (const k of [ 'name', 'remark', 'nominalSize', 'material' ]) p[k] = text(p[k]);
  for (const k of [ 'systemId', 'circuitId', 'pairId' ]) o[k] = text(o[k]);
  delete o.x;
  delete o.y;
  delete o.rotation; // 不允许第二份坐标真值
  if (Math.hypot(o.x2 - o.x1, o.y2 - o.y1, o.z2 - o.z1) <= PIPE_EPS) throw new Error('pipe: 零长度 / zero length');
  if (o.type === 'pipe') {
    const size = pipeGeometry(o).bounds;
    if (Math.min(size.minx, size.miny, size.minz) < -1e9 || Math.max(size.maxx, size.maxy, size.maxz) > 1e9) throw new Error('pipe: 外包范围超出建模边界 / envelope out of range');
  }
  return o;
}

export const PIPE_WORK_DEFAULTS = Object.freeze({
  elevation: 2600,
  pair: false,
  gap: 100,
  spacingMode: 'gap',
  filter: 'all',
  band: 200,
  systemId: '',
  circuitId: ''
});

/** 工作标高只存当前项目；几何标高不进入跨项目默认值表。 */ export function normalizePipeWork(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('pipeWork: object required');
  const c = {
    ...PIPE_WORK_DEFAULTS,
    ...input
  };
  for (const k of [ 'elevation', 'gap', 'band' ]) {
    c[k] = finite(c[k], k);
    if (Math.abs(c[k]) > 1e9 || k !== 'elevation' && c[k] < 0) throw new Error('pipeWork.' + k);
  }
  if (c.returnElevation !== undefined) {
    c.returnElevation = finite(c.returnElevation, 'returnElevation');
    if(Math.abs(c.returnElevation)>1e9)throw new Error('pipeWork.returnElevation');
  }
  if (![ 'gap', 'center' ].includes(c.spacingMode) || ![ 'all', 'elevation', 'system' ].includes(c.filter) || typeof c.pair !== 'boolean') throw new Error('pipeWork: invalid mode');
  c.systemId = text(c.systemId);
  c.circuitId = text(c.circuitId);
  if (c.returnProps) c.returnProps = pipeFormat(normalizePipe({
    x1: 0,
    y1: 0,
    z1: 0,
    x2: 1,
    y2: 0,
    z2: 0,
    props: {
      ...PIPE_DEFAULTS,
      ...c.returnProps
    }
  }));
  return c;
}

export function pipeGeometry(o) {
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1, dz = o.z2 - o.z1;
  const projectionLength = Math.hypot(dx, dy), length = Math.hypot(dx, dy, dz);
  const radius = +o.props.outsideDiameter / 2, outerRadius = radius + +o.props.insulationThickness;
  const kind = length <= PIPE_EPS ? 'invalid' : projectionLength <= PIPE_EPS ? 'vertical' : Math.abs(dz) <= PIPE_EPS ? 'horizontal' : 'sloped';
  const bounds = {
    minx: Math.min(o.x1, o.x2) - outerRadius,
    maxx: Math.max(o.x1, o.x2) + outerRadius,
    miny: Math.min(o.y1, o.y2) - outerRadius,
    maxy: Math.max(o.y1, o.y2) + outerRadius,
    minz: Math.min(o.z1, o.z2) - outerRadius,
    maxz: Math.max(o.z1, o.z2) + outerRadius
  };
  return {
    dx: dx,
    dy: dy,
    dz: dz,
    radius: radius,
    outerRadius: outerRadius,
    outerDiameter: outerRadius * 2,
    length: length,
    projectionLength: projectionLength,
    kind: kind,
    slope: projectionLength > PIPE_EPS ? 1e3 * dz / projectionLength : null,
    bounds: bounds
  };
}

/** 保守胶囊投影：立管为圆，非立管为两端半圆凸包。外包用于净距，非点击线宽。 */ export function pipeOutline(o, radius = pipeGeometry(o).outerRadius, conservative = false) {
  const {projectionLength: projectionLength, dx: dx, dy: dy} = pipeGeometry(o);
  const pts = [], N = 16;
  if(conservative)radius/=Math.cos(Math.PI/N); // 凸多边形外包，不以内接圆低估立管投影。
  if (projectionLength <= PIPE_EPS) {
    for (let i = 0; i < N; i++) {
      const a = i * Math.PI * 2 / N;
      pts.push({
        x: o.x1 + Math.cos(a) * radius,
        y: o.y1 + Math.sin(a) * radius
      });
    }
  } else {
    const angle = Math.atan2(dy, dx);
    for (const [x, y, start] of [ [ o.x2, o.y2, angle - Math.PI / 2 ], [ o.x1, o.y1, angle + Math.PI / 2 ] ]) for (let i = 0; i <= N / 2; i++) {
      const a = start + i * Math.PI * 2 / N;
      pts.push({
        x: x + Math.cos(a) * radius,
        y: y + Math.sin(a) * radius
      });
    }
  }
  return pts;
}

export function pipeColor(o, meta = {}) {
  return normalizeCabColor(o.props.color) || normalizeCabColor(meta.pipeColors?.[o.props.side]) || (o.props.side === 'return' ? '#c64634' : '#2f6fb2');
}

export function translatePipe(o, dx, dy) {
  return normalizePipe({
    ...o,
    x1: o.x1 + dx,
    y1: o.y1 + dy,
    x2: o.x2 + dx,
    y2: o.y2 + dy
  });
}

export function rotatePipe(o) {
  const cx = (o.x1 + o.x2) / 2, cy = (o.y1 + o.y2) / 2;
  return normalizePipe({
    ...o,
    x1: cx - (o.y1 - cy),
    y1: cy + (o.x1 - cx),
    x2: cx - (o.y2 - cy),
    y2: cy + (o.x2 - cx)
  });
}

export function pipeFormat(o) {
  return Object.fromEntries(PIPE_FORMAT_KEYS.map(k => [ k, o.props[k] ]));
}

export function reversePipe(o) {
  const n = {
    ...o,
    props: {
      ...o.props,
      flowDirection: {
        forward: 'reverse',
        reverse: 'forward',
        none: 'none'
      }[o.props.flowDirection]
    }
  };
  for (const a of [ 'x', 'y', 'z' ]) [n[a + '1'], n[a + '2']] = [ o[a + '2'], o[a + '1'] ];
  return normalizePipe(n);
 // 交换端点并保持物理流向
}

/** 复制一对/整组重建配对标识，单段副本脱离旧配对。删除后剩单根也解除配对。 */ export function remapPipePairs(copies, makeId) {
  const groups = new Map;
  for (const o of copies) if (o.type === 'pipe' && o.pairId) {
    if (!groups.has(o.pairId)) groups.set(o.pairId, []);
    groups.get(o.pairId).push(o);
  }
  for (const g of groups.values()) {
    const id = g.length > 1 ? makeId() : '';
    for (const o of g) o.pairId = id;
  }
}

export function cleanPipePairs(objects) {
  const counts = new Map;
  for (const o of objects) if (o.type === 'pipe' && o.pairId) counts.set(o.pairId, (counts.get(o.pairId) || 0) + 1);
  for (const o of objects) if (o.type === 'pipe' && o.pairId && counts.get(o.pairId) < 2) o.pairId = '';
}

/** 有限线段最短三维距离（含平行/退化情形），供管间保守胶囊干涉。 */ export function segmentDistance3D(a, b) {
  const A = [ a.x1, a.y1, a.z1 ], B = [ b.x1, b.y1, b.z1 ];
  const u = [ a.x2 - a.x1, a.y2 - a.y1, a.z2 - a.z1 ], v = [ b.x2 - b.x1, b.y2 - b.y1, b.z2 - b.z1 ], w = A.map((x, i) => x - B[i]);
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0), clamp = x => Math.max(0, Math.min(1, x));
  const aa = dot(u, u), bb = dot(u, v), cc = dot(v, v), dd = dot(u, w), ee = dot(v, w), det = aa * cc - bb * bb;
  let s = det > 1e-12 ? clamp((bb * ee - cc * dd) / det) : 0, t = cc ? clamp((bb * s + ee) / cc) : 0;
  s = aa ? clamp((bb * t - dd) / aa) : 0;
  t = cc ? clamp((bb * s + ee) / cc) : 0;
  return Math.hypot(...w.map((x, i) => x + s * u[i] - t * v[i]));
}

/** 线段到轴对齐盒的精确距离：分段二次凸函数各区间取极值。 */ export function segmentBoxDistance(a, b, lo, hi) {
  const d = a.map((x, i) => b[i] - x), cuts = [ 0, 1 ];
  for (let i = 0; i < 3; i++) if (d[i]) for (const v of [ lo[i], hi[i] ]) {
    const t = (v - a[i]) / d[i];
    if (t > 0 && t < 1) cuts.push(t);
  }
  cuts.sort((a, b) => a - b);
  const sq = t => a.reduce((s, x, i) => {
    const v = x + d[i] * t;
    return s + Math.max(lo[i] - v, 0, v - hi[i]) ** 2;
  }, 0);
  let best = Infinity;
  for (let j = 1; j < cuts.length; j++) {
    const l = cuts[j - 1], h = cuts[j], m = (l + h) / 2;
    let q = 0, r = 0;
    for (let i = 0; i < 3; i++) {
      const v = a[i] + d[i] * m, edge = v < lo[i] ? lo[i] : v > hi[i] ? hi[i] : null;
      if (edge !== null) {
        q += d[i] ** 2;
        r += d[i] * (a[i] - edge);
      }
    }
    const t = q ? Math.max(l, Math.min(h, -r / q)) : m;
    best = Math.min(best, sq(l), sq(h), sq(t));
  }
  return Math.sqrt(best);
}
