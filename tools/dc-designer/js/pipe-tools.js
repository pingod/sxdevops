/** 液冷管交互服务：创建事务、项目工作标高、三维端点吸附及管道筛选。 */
import { state, runtime, ui, snapVal, defaultProps, autoName, pushUndo, markDirty } from './state.js';

import { uid, dist2seg } from './geo.js';

import { normalizePipe, normalizePipeWork, pipeGeometry, PIPE_EPS } from './pipe-geometry.js';

import { t } from './i18n.js';

export function pipeSettings() {
  try {
    return normalizePipeWork(state.project.meta?.pipeWork || {});
  } catch {
    return normalizePipeWork();
  }
}

export function setPipeSettings(patch) {
  const c = normalizePipeWork({
    ...pipeSettings(),
    ...patch
  });
  state.project.meta ||= {};
  state.project.meta.pipeWork = c;
  // 工作标高是新绘制的基准，不隐式改写正在续画的端点 Z。
  markDirty();
}

export function pipeVisible(o) {
  const c = pipeSettings(), g = pipeGeometry(o);
  if (c.filter === 'elevation') return Math.max(o.z1, o.z2) >= +c.elevation - +c.band && Math.min(o.z1, o.z2) <= +c.elevation + +c.band;
  if (c.filter === 'system') return o.systemId === c.systemId;
  return Number.isFinite(g.length);
}

export function pipeCandidates(x, y) {
  const tol = 6 / state.view.scale;
  return state.project.objects.filter(o => o.type === 'pipe' && pipeVisible(o) && dist2seg(x, y, o.x1, o.y1, o.x2, o.y2).d <= Math.max(tol, pipeGeometry(o).outerRadius)).sort((a, b) => b.z1 + b.z2 - (a.z1 + a.z2) || b.id.localeCompare(a.id));
}

/** 吸附只接受同一 Z 的端点，平面交叉不产生连接或隐藏拓扑。 */ export function snapPipePoint(x, y, z) {
  let best = null, distance = 8 / state.view.scale;
  if (!runtime.altKey) for (const o of state.project.objects) if (o.type === 'pipe') for (const i of [ 1, 2 ]) {
    const d = Math.hypot(x - o['x' + i], y - o['y' + i]);
    if (Math.abs(z - o['z' + i]) <= PIPE_EPS && d <= distance) {
      distance = d;
      best = {
        x: o['x' + i],
        y: o['y' + i],
        z: o['z' + i]
      };
    }
  }
  return best || {
    x: snapVal(x),
    y: snapVal(y),
    z: z
  };
}

export function planPipeSegments(a, b, options = {}, makeId = uid) {
  const c = normalizePipeWork({
    ...pipeSettings(),
    ...options
  }), props = {
    ...defaultProps('pipe'),
    ...options.props
  };
  const first = normalizePipe({
    id: makeId(),
    type: 'pipe',
    x1: a.x,
    y1: a.y,
    z1: a.z,
    x2: b.x,
    y2: b.y,
    z2: b.z,
    systemId: c.systemId,
    circuitId: c.circuitId,
    props: {
      ...props,
      name: options.name || autoName(t('auto.pipe'))
    }
  });
  const list = [ first ];
  if (c.pair) {
    const secondProps = {
      ...props,
      side: 'return',
      color: '',
      flowDirection: 'reverse',
      ...c.returnProps
    };
    // 双管相距含两根外包半径；不同高度时只承诺平面横向净距，不伪称三维净距。
    const g = pipeGeometry(first), r2 = +secondProps.outsideDiameter / 2 + +secondProps.insulationThickness;
    const spacing = c.spacingMode === 'center' ? +c.gap : g.outerRadius + r2 + +c.gap;
    if (!Number.isFinite(spacing) || spacing <= 0) throw new Error(t('pipe.invalid'));
    const nx = g.projectionLength > PIPE_EPS ? -g.dy / g.projectionLength : 1, ny = g.projectionLength > PIPE_EPS ? g.dx / g.projectionLength : 0;
    const dz = c.returnElevation === undefined ? 0 : +c.returnElevation - a.z;
    const pairId = makeId();
    first.pairId = pairId;
    first.props.side = 'supply';
    const taken = new Set(state.project.objects.map(o => o.props?.name));
    let name = first.props.name + '-R', suffix = 1;
    while (taken.has(name) || name === first.props.name) name = first.props.name + '-R-' + suffix++;
    list.push(normalizePipe({
      ...first,
      id: makeId(),
      pairId: pairId,
      x1: first.x1 + nx * spacing,
      y1: first.y1 + ny * spacing,
      z1: first.z1 + dz,
      x2: first.x2 + nx * spacing,
      y2: first.y2 + ny * spacing,
      z2: first.z2 + dz,
      props: {
        ...secondProps,
        name: name
      }
    }));
  }
  return list;
}

export function createPipeSegments(a, b, options = {}) {
  const list=planPipeSegments(a,b,options);
  pushUndo();
  state.project.objects.push(...list);
  state.selectedIds = list.map(o => o.id);
  markDirty();
  return list;
}

export function pipeDown(wx, wy, e = {}) {
  const c = pipeSettings(), dr = runtime.drawing;
  const z = dr ? dr.last.z : +c.elevation;
  let pt = snapPipePoint(wx, wy, z);
  if (!dr) {
    runtime.drawing = {
      last: pt,
      typed: ''
    };
    ui.props();
    ui.render();
    return;
  }
  if (e.shiftKey) {
    if (Math.abs(pt.x - dr.last.x) >= Math.abs(pt.y - dr.last.y)) pt.y = dr.last.y; else pt.x = dr.last.x;
  }
  if (Math.hypot(pt.x - dr.last.x, pt.y - dr.last.y) <= PIPE_EPS) return;
  try {
    const source = state.project.objects.find(o => o.id === dr.lastPipeId);
    const context = source ? {
      props: source.props,
      systemId: source.systemId,
      circuitId: source.circuitId
    } : {};
    const list = createPipeSegments(dr.last, pt, context);
    dr.last = pt;
    dr.lastPipeId = list[0].id;
    dr.typed = '';
    ui.render();
    ui.props();
  } catch (err) {
    ui.hint(err.message);
  }
}

export function pipeRiser(target, from = null, source = null) {
  const a = from || runtime.drawing?.last;
  if (!a) throw new Error(t('pipe.startFirst'));
  const b = {
    ...a,
    z: target
  };
  const list = createPipeSegments(a, b, {
    pair: false,
    ...source ? {
      props: source.props,
      systemId: source.systemId,
      circuitId: source.circuitId
    } : {}
  });
  runtime.drawing = {
    last: b,
    lastPipeId: list[0].id,
    typed: ''
  };
  state.tool = 'pipe';
  ui.syncTool('pipe');
  ui.render();
  ui.props();
  return list;
}

export function pipePreview() {
  if (state.tool !== 'pipe' || !runtime.drawing) return null;
  const a = runtime.drawing.last;
  let b = snapPipePoint(runtime.mouse.wx, runtime.mouse.wy, a.z);
  if (runtime.shiftKey) {
    if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) b.y = a.y; else b.x = a.x;
  }
  return {
    type: 'pipe',
    x1: a.x,
    y1: a.y,
    z1: a.z,
    x2: b.x,
    y2: b.y,
    z2: b.z,
    props: state.project.objects.find(o=>o.id===runtime.drawing.lastPipeId)?.props || defaultProps('pipe')
  };
}

export function pipePreviews() {
  const o=pipePreview();if(!o)return [];
  try {
    let id=0;
    return planPipeSegments({x:o.x1,y:o.y1,z:o.z1},{x:o.x2,y:o.y2,z:o.z2},{props:o.props},()=> '__pipe-preview-'+(++id));
  } catch { return []; }
}

export function commitTypedPipe() {
  const dr = runtime.drawing, len = Number(dr?.typed);
  if (!dr || !Number.isFinite(len) || len <= 0) return;
  const preview = pipePreview(), g = pipeGeometry(preview);
  if (g.projectionLength <= PIPE_EPS) {
    ui.hint(t('hint.moveFirst'));
    return;
  }
  const b = {
    x: dr.last.x + g.dx / g.projectionLength * len,
    y: dr.last.y + g.dy / g.projectionLength * len,
    z: dr.last.z
  };
  try {
    const source = state.project.objects.find(o => o.id === dr.lastPipeId);
    const list = createPipeSegments(dr.last, b, source ? {
      props: source.props,
      systemId: source.systemId,
      circuitId: source.circuitId
    } : {});
    dr.last = b;
    dr.lastPipeId = list[0].id;
    dr.typed = '';
    ui.render();
    ui.props();
  } catch (e) {
    ui.hint(e.message);
  }
}

export function editPipe(o, patch) {
  const n = normalizePipe({
    ...o,
    ...patch,
    props: {
      ...o.props,
      ...patch.props
    }
  });
  pushUndo();
  Object.assign(o, n);
  if (state.tool === 'pipe' && runtime.drawing?.lastPipeId === o.id) runtime.drawing.last = {
    x: o.x2,
    y: o.y2,
    z: o.z2
  };
  markDirty();
  return o;
}
