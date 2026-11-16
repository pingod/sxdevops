/**
 * 单位与坐标约定（全项目唯一出处）。
 *
 * - 项目数据单位 mm，原点西南角，+X 东、+Y 北；
 * - three 场景单位 m：x3 = x*S，y3 = 高度*S，z3 = -y*S（北 = -Z）；
 * - 2D 局部 -Y 为正面，映射到 3D 局部 +Z。
 */
export const S = 0.001;

/** 角度（度）→ 弧度 */
export const rad = d => ((d || 0) * Math.PI) / 180;

/** 项目 mm → 场景 m（标量） */
export const mm = v => (v || 0) * S;

/** 项目 2D 坐标 → 场景 [x, z]（z = -y） */
export const plan2scene = (x, y) => [x * S, -(y || 0) * S];

/** 场景 z → 项目 y */
export const zToY = z => -z / S;

/** 场景 x → 项目 x */
export const xToX = x => x / S;

/** 场景坐标 → 项目平面坐标（mm） */
export const sceneToPlan = (x, z) => ({ x: x / S, y: -z / S });

/** 世界北（场景空间） */
export const NORTH = Object.freeze({ x: 0, y: 0, z: -1 });
