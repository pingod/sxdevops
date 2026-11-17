/** 液冷管平面渲染；仅显示增强不修改物理几何，导出排除选中效果。 */
import { state, runtime, w2s } from './state.js';

import { pipeGeometry, pipeOutline, pipeColor } from './pipe-geometry.js';

import { pipeVisible, pipePreviews } from './pipe-tools.js';

export function drawPipe(ctx, o, opts = {}) {
  const g = pipeGeometry(o);
  if (!Number.isFinite(g.length) || g.kind==='invalid' || !Number.isFinite(g.outerRadius)) return;
  const selected = !opts.export && state.selectedIds.includes(o.id), s = state.view.scale;
  const a = w2s(o.x1, o.y1), b = w2s(o.x2, o.y2), color = pipeColor(o, state.project.meta);
  const poly = r => {
    const ps = pipeOutline(o, r).map(p => w2s(p.x, p.y));
    ctx.beginPath();
    ps.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
  };
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  if (selected) {
    ctx.strokeStyle = '#f39c12';
    ctx.lineWidth = 3;
    poly(g.outerRadius + 4 / s);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
  }
  if (g.outerRadius * s >= .8) {
    poly(g.outerRadius);
    ctx.globalAlpha = .14;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (o.props.insulationThickness > 0) {
      ctx.setLineDash([ 4, 3 ]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    poly(g.radius);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = Math.max(.65, 2 * g.radius * s);
    ctx.stroke();
  }
  if (g.kind === 'vertical') {
    // 圆圈带方向符号属于立管注记（最小 5px），不是外包物理轮廓。
    ctx.beginPath();
    ctx.arc(a.x, a.y, Math.max(5, g.outerRadius * s), 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(g.dz > 0 ? '↑' : '↓', a.x, a.y + 4);
  } else if (o.props.flowDirection !== 'none') {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dir = o.props.flowDirection === 'reverse' ? -1 : 1;
    const L = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / L * dir, uy = (b.y - a.y) / L * dir;
    ctx.beginPath();
    ctx.moveTo(mx + ux * 7, my + uy * 7);
    ctx.lineTo(mx - ux * 5 - uy * 4, my - uy * 5 + ux * 4);
    ctx.lineTo(mx - ux * 5 + uy * 4, my - uy * 5 - ux * 4);
    ctx.closePath();
    ctx.fill();
  }
  if (g.kind === 'vertical' || Math.hypot(b.x - a.x, b.y - a.y) > 45) {
    const label = `${o.props.name || ''} ${o.props.nominalSize} · OD${o.props.outsideDiameter} · Z ${o.z1}→${o.z2}`;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2 - Math.max(12, g.outerRadius * s + 7);
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(label, x, y);
    ctx.fillStyle = color;
    ctx.fillText(label, x, y);
  }
  if (selected && state.selectedIds.length === 1 && g.kind !== 'vertical') for (const p of [ a, b ]) {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#f39c12';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export function drawPipes(ctx, opts = {}) {
  const list = state.project.objects.filter(o => o.type === 'pipe' && pipeVisible(o)).sort((a, b) => a.z1 + a.z2 - (b.z1 + b.z2) || a.id.localeCompare(b.id));
  for (const o of list) drawPipe(ctx, o, opts);
}

export function drawPipePreview(ctx) {
  const list = pipePreviews();
  if (!list.length) return;
  const o=list[0];
  ctx.save();
  ctx.globalAlpha = .55;
  for(const item of list)drawPipe(ctx,item,{export:true});
  ctx.restore();
  if (runtime.drawing?.typed) {
    const p = w2s(o.x2, o.y2);
    ctx.save();
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#33404f';
    ctx.fillText(runtime.drawing.typed + ' mm', p.x + 12, p.y - 16);
    ctx.restore();
  }
}
