/**
 * 房间级数值派生（纯计算，无 three 依赖）。
 * 单位：项目 mm。
 */

const num = v => {
  const n = +v;
  return Number.isFinite(n) ? n : 0;
};
const pos = (v, d) => {
  const n = +v;
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** 房间主体高度：项目设置 > 最高墙 > 3000 */
export function roomHeightOf(project) {
  const meta = (project && project.meta) || {};
  const objects = (project && Array.isArray(project.objects)) ? project.objects : [];
  const walls = objects.filter(o => o.type === 'wall');
  return pos(meta.roomHeight, Math.max(3000, ...walls.map(o => pos(o.props && o.props.height, 0))));
}

/** 吊顶面高：仅当 0 < ceilHeight < roomH 时有效 */
export function ceilingOf(project, roomH = roomHeightOf(project)) {
  const raw = num((project.meta || {}).ceilHeight);
  const hasCeil = raw > 0 && raw < roomH;
  return { hasCeil, ceilH: hasCeil ? raw : roomH, rawCeil: raw };
}

/** 地板下空间高度 */
export function floorHeightOf(project) {
  const v = (project.meta || {}).floorHeight;
  return Math.max(0, num(v === undefined || v === null ? 400 : v));
}
