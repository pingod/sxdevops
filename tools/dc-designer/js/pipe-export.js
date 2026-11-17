/** 液冷清单与 R12 平面 CAD。长度为建模中心线，不含管件裁短或施工余量。 */
import { pipeGeometry, pipeOutline, pipeColor } from './pipe-geometry.js';

const side = p => p.side === 'return' ? '回液' : '供液';

export function pipeSchedule(objects, {byColor: byColor = false, meta: meta = {}} = {}) {
  const groups = new Map;
  for (const o of objects.filter(o => o.type === 'pipe')) {
    const p = o.props, fields = [ o.systemId || '', p.loopSide, p.side, p.nominalSize, p.outsideDiameter, p.wallThickness, p.material, p.insulationThickness ];
    if (byColor) fields.push(pipeColor(o, meta));
    const key = JSON.stringify(fields);
    if (!groups.has(key)) groups.set(key, {
      fields: fields,
      items: [],
      length: 0
    });
    const g = groups.get(key);
    g.items.push(o);
    g.length += pipeGeometry(o).length;
  }
  return [ ...groups.values() ];
}

export function pipeSummaryRows(objects) {
  return pipeSchedule(objects).map(g => {
    const o = g.items[0], p = o.props;
    return [ '液冷管路', side(p), `${p.nominalSize} · OD${p.outsideDiameter}×${p.wallThickness ?? '未知'}mm · ${p.material} · 保温${p.insulationThickness}mm`, 'm', +(g.length / 1e3).toFixed(3), `系统 ${o.systemId || '—'} · ${p.loopSide === 'primary' ? '一次侧' : '二次侧'} · ${g.items.length}段；建模中心线长度` ];
  });
}

export function pipeDetailRows(objects, meta = {}) {
  const pipes = objects.filter(o => o.type === 'pipe');
  if (!pipes.length) return [];
  return [ [], [ '三、液冷管段明细（mm；长度单位 m；Z=完成地面中心标高）' ], [ '编号', '系统', '回路', '配对', '回路侧', '供回', '公称规格', '实际外径(mm)', '壁厚(mm)', '保温(mm)', '外包直径(mm)', '管材', 'X1', 'Y1', 'Z1', 'X2', 'Y2', 'Z2', '三维长度(m)', '投影长度(m)', '坡度(‰)', '颜色', '流向', '备注' ], ...pipes.map(o => {
    const p = o.props, g = pipeGeometry(o);
    return [ p.name || o.id, o.systemId, o.circuitId, o.pairId, p.loopSide, side(p), p.nominalSize, p.outsideDiameter, p.wallThickness ?? '', p.insulationThickness, g.outerDiameter, p.material, o.x1, o.y1, o.z1, o.x2, o.y2, o.z2, +(g.length / 1e3).toFixed(6), +(g.projectionLength / 1e3).toFixed(6), g.slope === null ? '—' : +g.slope.toFixed(3), pipeColor(o, meta), p.flowDirection, p.remark ];
  }), [ '说明：仅直管建模中心线长度，无自动弯头/三通/变径/设备端口连通；不含施工余量。原冷量自检不覆盖液冷负荷及水力设计。' ] ];
}

/** 标准 ACI 色表最近 RGB 距离。R12 不支持真彩，明确为有损近似。 */ export function nearestACI(hex) {
  const rgb = [ 1, 3, 5 ].map(i => parseInt(hex.slice(i, i + 2), 16)), colors = [ [ 1, 255, 0, 0 ], [ 2, 255, 255, 0 ], [ 3, 0, 255, 0 ], [ 4, 0, 255, 255 ], [ 5, 0, 0, 255 ], [ 6, 255, 0, 255 ], [ 7, 255, 255, 255 ], [ 8, 128, 128, 128 ], [ 9, 192, 192, 192 ] ];
  const hsv = (h, s, v) => {
    const c = v * s, x = c * (1 - Math.abs(h / 60 % 2 - 1)), m = v - c;
    const a = h < 60 ? [ c, x, 0 ] : h < 120 ? [ x, c, 0 ] : h < 180 ? [ 0, c, x ] : h < 240 ? [ 0, x, c ] : h < 300 ? [ x, 0, c ] : [ c, 0, x ];
    return a.map(v => Math.round(v + m));
  };
  for (let h = 0; h < 24; h++) for (let j = 0; j < 10; j++) colors.push([ 10 + h * 10 + j, ...hsv(h * 15, j % 2 ? .5 : 1, [ 255, 165, 127, 76, 38 ][Math.floor(j / 2)]) ]);
  for (let i = 0; i < 6; i++) {
    const v = [ 51, 80, 105, 130, 190, 255 ][i];
    colors.push([ 250 + i, v, v, v ]);
  }
  let best = 7, dist = Infinity;
  for (const [i, ...c] of colors) {
    const d = c.reduce((s, v, j) => s + (v - rgb[j]) ** 2, 0);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

export function pipeToDXF(E, o, meta, api) {
  const {line: line, circle: circle, text: text} = api, g = pipeGeometry(o), layer = o.props.side === 'return' ? 'IDC-PIPE-RETURN' : 'IDC-PIPE-SUPPLY', color = nearestACI(pipeColor(o, meta));
  const contour = (r, dashed) => {
    if (g.kind === 'vertical') circle(E, o.x1, o.y1, r, layer, color, dashed ? 'DASHED' : undefined); else {
      const pts = pipeOutline(o, r);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        line(E, a.x, a.y, b.x, b.y, layer, color, dashed ? 'DASHED' : undefined);
      }
    }
  };
  contour(g.radius, false);
  if (o.props.insulationThickness > 0) contour(g.outerRadius, true);
  line(E, o.x1, o.y1, o.x2, o.y2, layer, color);
  const label = `${o.props.name || o.id} ${o.props.nominalSize} OD${o.props.outsideDiameter} Z=${o.z1} -> ${o.z2} mm L3D=${(g.length / 1e3).toFixed(3)}m`;
  text(E, label, (o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2 + g.outerRadius + 160, 140, 0, layer);
}
