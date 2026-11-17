/**
 * 机柜实时状态：口径与后端 `datacenter/live.py` 一致，纯函数以便单测。
 *
 * 优先级：任一绑定设备离线 → offline；否则最高利用率 ≥95 critical、≥80 warning；
 * 设备全部未采集 → unknown；其余 online。未绑定机柜没有状态。
 */

export const STATUS_COLORS = {
  online: '#16a34a',
  warning: '#d97706',
  critical: '#dc2626',
  offline: '#7f1d1d',
  unknown: '#94a3b8',
};

export const STATUS_LABELS = {
  online: '在线',
  warning: '高负载',
  critical: '严重',
  offline: '离线',
  unknown: '未采集',
};

export const DEFAULT_THRESHOLDS = { warning: 80, critical: 95 };

const utilOf = (device) => {
  const raw = device?.util;
  if (raw === null || raw === undefined || raw === '') return NaN;
  return Number(raw);
};

const statusOfDevice = (device, thresholds) => {
  if (!device) return 'unknown';
  if (device.status === 'offline') return 'offline';
  const util = utilOf(device);
  if (Number.isFinite(util)) {
    if (util >= thresholds.critical) return 'critical';
    if (util >= thresholds.warning) return 'warning';
  }
  if (device.status !== 'online') return 'unknown';
  return 'online';
};

/**
 * 机柜状态：`devices` 可以是数组（后端 `devices`）或 Map/对象（按 id 索引）。
 * @returns {{status:string, util:number|null, deviceIds:number[]}}
 */
export function deriveCabinetStatus(deviceIds, devices, thresholds = DEFAULT_THRESHOLDS) {
  const ids = Array.isArray(deviceIds) ? deviceIds : [];
  const limits = {
    warning: Number(thresholds?.warning) || DEFAULT_THRESHOLDS.warning,
    critical: Number(thresholds?.critical) || DEFAULT_THRESHOLDS.critical,
  };
  const lookup = Array.isArray(devices)
    ? new Map(devices.map(device => [device.id, device]))
    : new Map(Object.entries(devices || {}).map(([key, device]) => [Number(key), device]));

  const states = [];
  const utils = [];
  for (const id of ids) {
    const device = lookup.get(id);
    states.push(statusOfDevice(device, limits));
    const util = utilOf(device);
    if (Number.isFinite(util)) utils.push(util);
  }

  let status = 'online';
  if (states.includes('offline')) status = 'offline';
  else if (states.includes('critical')) status = 'critical';
  else if (states.includes('warning')) status = 'warning';
  else if (states.length && states.every(state => state === 'unknown')) status = 'unknown';

  return {
    status,
    util: utils.length ? Math.max(...utils) : null,
    deviceIds: [...ids],
  };
}

/** 图例计数：只统计绑定了设备的机柜。 */
export function summarizeLive(payload) {
  const counts = { online: 0, warning: 0, critical: 0, offline: 0, unknown: 0 };
  const cabinets = payload?.cabinets || {};
  for (const entry of Object.values(cabinets)) {
    const status = entry?.status;
    if (status && counts[status] !== undefined) counts[status] += 1;
  }
  return { counts, bound: Object.keys(cabinets).length };
}

/** 把后端 payload 折算成「机柜 → 状态」，供渲染环与调试 API 共用。 */
export function resolveCabinets(payload) {
  const thresholds = payload?.thresholds || DEFAULT_THRESHOLDS;
  const devices = payload?.devices || [];
  const out = {};
  for (const [objectId, entry] of Object.entries(payload?.cabinets || {})) {
    const derived = deriveCabinetStatus(entry?.device_ids ?? entry?.deviceIds ?? [], devices, thresholds);
    out[objectId] = {
      status: entry?.status || derived.status,
      util: entry?.util ?? derived.util,
      deviceIds: derived.deviceIds,
    };
  }
  return out;
}
