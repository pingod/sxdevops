/**
 * 实时状态口径单测：与后端 `datacenter/live.py` 一致。
 * 离线压过利用率、阈值 80/95、未绑定机柜不出现状态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveCabinetStatus, resolveCabinets, summarizeLive, STATUS_COLORS, DEFAULT_THRESHOLDS,
} from '../src/live/status.js';

const online = (id, util) => ({ id, name: `sw-${id}`, status: 'online', util });
const offline = (id, util = 0) => ({ id, name: `sw-${id}`, status: 'offline', util });
const unknown = (id, util = null) => ({ id, name: `sw-${id}`, status: 'unknown', util });

test('每个状态都有配色', () => {
  for (const status of ['online', 'warning', 'critical', 'offline', 'unknown']) {
    assert.match(STATUS_COLORS[status], /^#[0-9a-f]{6}$/i);
  }
  assert.deepEqual(DEFAULT_THRESHOLDS, { warning: 80, critical: 95 });
});

test('阈值边界：79/80 与 94/95', () => {
  const devices = [online(1, 79), online(2, 80), online(3, 94), online(4, 95)];
  assert.equal(deriveCabinetStatus([1], devices).status, 'online');
  assert.equal(deriveCabinetStatus([2], devices).status, 'warning');
  assert.equal(deriveCabinetStatus([3], devices).status, 'warning');
  assert.equal(deriveCabinetStatus([4], devices).status, 'critical');
});

test('离线压过利用率', () => {
  const devices = [offline(1, 99), online(2, 99)];
  assert.equal(deriveCabinetStatus([1, 2], devices).status, 'offline');
  assert.equal(deriveCabinetStatus([1], devices).status, 'offline');
});

test('多设备取最高严重度并回报最大利用率', () => {
  const devices = [online(1, 20), online(2, 85), online(3, 10)];
  const result = deriveCabinetStatus([1, 2, 3], devices);
  assert.equal(result.status, 'warning');
  assert.equal(result.util, 85);
  assert.deepEqual(result.deviceIds, [1, 2, 3]);
});

test('全部未采集 → unknown，不伪造在线', () => {
  const devices = [unknown(1), unknown(2)];
  const result = deriveCabinetStatus([1, 2], devices);
  assert.equal(result.status, 'unknown');
  assert.equal(result.util, null);
});

test('未采集但有利用率时按利用率判定', () => {
  const devices = [{ id: 1, name: 'sw-1', status: 'unknown', util: 96 }];
  assert.equal(deriveCabinetStatus([1], devices).status, 'critical');
});

test('绑定里含已不存在的设备时该设备视为 unknown', () => {
  const devices = [online(1, 10)];
  assert.equal(deriveCabinetStatus([1, 99], devices).status, 'online');
  const only = deriveCabinetStatus([99], devices);
  assert.equal(only.status, 'unknown');
});

test('空绑定不产生状态', () => {
  const result = deriveCabinetStatus([], [online(1, 10)]);
  assert.deepEqual(result.deviceIds, []);
  assert.equal(result.util, null);
});

test('resolveCabinets 尊重后端已给出的状态', () => {
  const payload = {
    thresholds: { warning: 80, critical: 95 },
    devices: [online(1, 10)],
    cabinets: {
      'cab-1': { status: 'offline', util: null, device_ids: [1] },
      'cab-2': { device_ids: [1] },
    },
  };
  const resolved = resolveCabinets(payload);
  assert.equal(resolved['cab-1'].status, 'offline');
  assert.equal(resolved['cab-2'].status, 'online');
  assert.equal(Object.keys(resolved).length, 2);
});

test('summarizeLive 计数只统计绑定机柜', () => {
  const { counts, bound } = summarizeLive({
    cabinets: {
      a: { status: 'online' },
      b: { status: 'warning' },
      c: { status: 'warning' },
      d: { status: 'critical' },
      e: { status: 'offline' },
      f: { status: 'unknown' },
    },
  });
  assert.equal(bound, 6);
  assert.deepEqual(counts, { online: 1, warning: 2, critical: 1, offline: 1, unknown: 1 });
});

test('summarizeLive 对空 payload 安全', () => {
  assert.deepEqual(summarizeLive(null), { counts: { online: 0, warning: 0, critical: 0, offline: 0, unknown: 0 }, bound: 0 });
});
