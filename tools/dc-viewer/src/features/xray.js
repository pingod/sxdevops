/**
 * 围护透视（纯规则）：墙/门/窗/格栅/吊顶半透明，设备保持不透明。
 */
import { sectionHeights } from './sectionplan.js';

export const XRAY = Object.freeze({
  opacity: 0.18,
  minOpacity: 0.15,
  maxOpacity: 0.25,
  types: Object.freeze(['wall', 'door', 'window', 'grille', 'ceiling']),
  typeLabels: Object.freeze({ wall: '墙体', door: '机房门', window: '窗', grille: '格栅', ceiling: '吊顶' }),
});

const clamp01 = v => Math.max(0, Math.min(1, v));

export function isEnclosure(type) {
  if (typeof type !== 'string') return false;
  return XRAY.types.includes(type.trim().toLowerCase());
}

/** 目标透明度：只降不升 */
export function xrayOpacity(base = 1) {
  const b = Number.isFinite(+base) ? clamp01(+base) : 1;
  return Math.min(b, XRAY.opacity);
}

/** 材质目标状态（on=false 时恢复原始三元组） */
export function xrayMaterialState(base, on) {
  const b = base || {};
  const transparent = !!b.transparent;
  const depthWrite = b.depthWrite !== false;
  const opacity = Number.isFinite(+b.opacity) ? clamp01(+b.opacity) : 1;
  if (!on) return { transparent, depthWrite, opacity };
  return { transparent: true, depthWrite: false, opacity: xrayOpacity(opacity) };
}

/** 围护目标清单（纯数据） */
export function xrayPlan(project, opts = {}) {
  const objs = project && Array.isArray(project.objects) ? project.objects : [];
  const items = [];
  const byType = {};
  let equipment = 0;
  for (const o of objs) {
    if (!o) continue;
    const type = typeof o.type === 'string' ? o.type.trim().toLowerCase() : '';
    if (!type) continue;
    if (type === 'floor' || o.id === '__floor') continue;
    if (!isEnclosure(type)) {
      equipment++;
      continue;
    }
    const id = o.id || type + '-' + items.length;
    const label = (o.props && o.props.name) || XRAY.typeLabels[type] || type;
    items.push({ id, type, label });
    byType[type] = (byType[type] || 0) + 1;
  }
  const heights = sectionHeights(project);
  const ceiling = opts.ceiling == null ? !!heights.hasCeil : !!opts.ceiling;
  if (ceiling && !items.some(it => it.type === 'ceiling')) {
    items.push({ id: '__ceiling', type: 'ceiling', label: XRAY.typeLabels.ceiling });
    byType.ceiling = (byType.ceiling || 0) + 1;
  }
  return {
    total: items.length,
    byType,
    types: Object.keys(byType),
    items,
    ids: items.map(it => it.id),
    wallGroups: (byType.wall || 0) + (ceiling ? 1 : 0),
    equipment,
    ceiling,
    opacity: XRAY.opacity,
  };
}

export function xraySummary(on = true, opacity = XRAY.opacity) {
  if (!on) return '围护透视关闭';
  const pct = Math.round(clamp01(+opacity || 0) * 100);
  return `围护半透明 · 墙/门/窗/格栅/吊顶 ${pct}% · 设备不透明`;
}
