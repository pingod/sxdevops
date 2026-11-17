/** 设备共用字段：业务坐标均为 mm，Z 为设备底部相对完成地坪的标高（向上为正）。
 * 建筑构件沿用原有高度/窗台/梁顶标高，管道沿用 z1/z2，不额外叠加设备 Z。 */
export const DEVICE_TYPES = Object.freeze(['cabinet', 'pdu', 'dbox', 'ups', 'battery', 'ac', 'extinguisher', 'vent']);
export const isDevice = o => !!o && DEVICE_TYPES.includes(o.type);

/** 未设置/非法 Z 回到地坪；保留负标高与小数，不能用尺寸字段的非负清洗规则。 */
export function deviceZ(o) {
  if (!isDevice(o)) return 0;
  const z = +o.z;
  return Number.isFinite(z) ? z : 0;
}
