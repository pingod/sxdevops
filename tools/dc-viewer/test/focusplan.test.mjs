import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOCUS, normalizeBox, viewBasis, projectedHalfExtents, fitDistance,
  boxExitDistance, roomClearance, focusPose, focusBoxOf, focusLabel,
} from '../src/features/focusplan.js';

const NEAR = (a, b, e = 1e-6) => Math.abs(a - b) < e;

test('normalizeBox: min/max 与 minimum/maximum 归一', () => {
  const b = normalizeBox({ min: { x: -1, y: 0, z: -2 }, max: { x: 1, y: 4, z: 2 } });
  assert.deepEqual(b.center, { x: 0, y: 2, z: 0 });
  assert.deepEqual(b.size, { x: 2, y: 4, z: 4 });
  assert(NEAR(b.radius, Math.hypot(2, 4, 4) / 2));
  const b2 = normalizeBox({ minimum: { x: 0, y: 0, z: 0 }, maximum: { x: 2, y: 2, z: 2 } });
  assert.deepEqual(b2.center, { x: 1, y: 1, z: 1 });
  assert.equal(normalizeBox(null), null);
  assert.equal(normalizeBox({ min: { x: 'a' } }), null);
});

test('viewBasis: 方向基正交', () => {
  const { dir, right, up } = viewBasis(Math.PI / 4, 0.9);
  assert(NEAR(dot(dir, right), 0, 1e-9));
  assert(NEAR(dot(dir, up), 0, 1e-9));
  assert(NEAR(dot(right, up), 0, 1e-9));
  for (const v of [dir, right, up]) assert(NEAR(Math.hypot(v.x, v.y, v.z), 1, 1e-9));
});

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

test('fitDistance 透视：水平视角公式 D = h·(1 + 1/tanV)', () => {
  const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
  const tanHalf = Math.tan((45 * Math.PI) / 360); // tan(22.5°)
  // theta=0, phi=π/2 → dir=(0,0,1), right=(1,0,0), up=(0,1,0)
  const r = fitDistance(box, { x: 0, y: 0, z: 0 }, 0, Math.PI / 2, 45, 1, 'perspective');
  assert(NEAR(r.tanV, tanHalf, 1e-9));
  assert(NEAR(r.tanH, tanHalf, 1e-9));
  assert(NEAR(r.halfX, 1, 1e-9));
  assert(NEAR(r.halfY, 1, 1e-9));
  // D = toward + ey/tanV = 1 + 1/tan(22.5°)；fitR = D * padding(1.16)
  assert(NEAR(r.fitR, (1 + 1 / tanHalf) * FOCUS.padding, 1e-9));
});

test('fitDistance 正交：half/tanV × padding', () => {
  const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
  const tanHalf = Math.tan((45 * Math.PI) / 360);
  const r = fitDistance(box, { x: 0, y: 0, z: 0 }, 0, Math.PI / 2, 45, 1, 'ortho');
  assert(NEAR(r.fitR, (1 / tanHalf) * FOCUS.padding, 1e-9));
  // 透视比正交退得更远（同一语义下的透视需要更多深度）
  const persp = fitDistance(box, { x: 0, y: 0, z: 0 }, 0, Math.PI / 2, 45, 1, 'perspective');
  assert(persp.fitR > r.fitR);
});

test('projectedHalfExtents: 立方体屏幕半宽/半高', () => {
  const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
  const h = projectedHalfExtents(box, { x: 0, y: 0, z: 0 }, 0, Math.PI / 2);
  assert(NEAR(h.halfX, 1, 1e-9));
  assert(NEAR(h.halfY, 1, 1e-9));
});

test('boxExitDistance: 目标中心到包围盒面距离', () => {
  const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
  assert(NEAR(boxExitDistance(box, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), 1, 1e-9));
  assert(NEAR(boxExitDistance(box, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), 1, 1e-9));
  // 目标偏移时按对应面
  assert(NEAR(boxExitDistance(box, { x: 2, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }), 3, 1e-9));
});

test('roomClearance: 目标在室内时到边界的距离', () => {
  const room = { minx: -5, maxx: 5, miny: 0, maxy: 3, minz: -5, maxz: 5 };
  assert(NEAR(roomClearance({ x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 1 }, room), 5, 1e-9));
  assert(NEAR(roomClearance({ x: 0, y: 0.5, z: 0 }, { x: 0, y: 1, z: 0 }, room), 2.5, 1e-9));
  // 目标在室外 → Infinity
  assert.equal(roomClearance({ x: 99, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, room), Infinity);
});

test('focusPose: 无房间时 phi 保持、r ≥ 包围盒退出距离', () => {
  const box = { min: { x: -0.3, y: -0.3, z: -0.3 }, max: { x: 0.3, y: 0.3, z: 0.3 } };
  const p = focusPose({ box, theta: Math.PI / 4, phi: 0.9, fov: 45, aspect: 1 });
  assert(NEAR(p.phi, 0.9, 1e-9));
  assert.equal(p.phiAdjusted, false);
  assert.equal(p.clamped, false);
  assert.equal(p.insideRoom, null);
  const { dir } = viewBasis(p.theta, p.phi);
  const exit = boxExitDistance(box, p.target, dir);
  assert(p.r >= exit + FOCUS.nearPad - 1e-9);
  assert(p.r >= p.fitR);
});

test('focusPose: 正交模式直接取基础极角', () => {
  const box = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
  const p = focusPose({ box, theta: 0, phi: 0.5, fov: 45, aspect: 1, mode: 'ortho' });
  assert.equal(p.mode, 'ortho');
  assert(NEAR(p.phi, 0.5, 1e-9));
  assert.equal(p.phiAdjusted, false);
  assert.equal(p.clamped, false);
  const fit = fitDistance(box, p.target, p.theta, p.phi, 45, 1, 'ortho');
  assert(NEAR(p.r, fit.fitR, 1e-9));
});

test('focusPose: 矮房顶强制极角递增（0.06 步进、上限 1.28）', () => {
  const box = { min: { x: -2, y: 0.4, z: -2 }, max: { x: 2, y: 0.6, z: 2 } };
  const room = { minx: -10, maxx: 10, miny: 0, maxy: 1.2, minz: -10, maxz: 10 };
  const p = focusPose({ box, theta: Math.PI / 4, phi: 0.12, fov: 45, aspect: 1, room });
  assert(p.phiAdjusted === true);
  assert(p.phi > 0.12);
  // 步进在 0.06 网格上，且不超过上限
  const step = (p.phi - 0.12) / FOCUS.phiStep;
  assert(NEAR(step, Math.round(step), 1e-6));
  assert(p.phi <= FOCUS.maxPhi + 1e-9);
  // 相机不高于房顶
  assert(p.camera.y <= room.maxy + 1e-6);
  assert.equal(p.insideRoom, true);
  // 各候选极角都 ≥ 下限
  assert(p.phi >= FOCUS.minPhi);
});

test('focusBoxOf: 机柜 / 墙 / 通道 / 吊顶', () => {
  const cab = { type: 'cabinet', x: 1000, y: 2000, rotation: 90, props: { name: 'A01', w: 600, d: 1200, h: 2000 } };
  const b = focusBoxOf(cab);
  assert(NEAR(b.min.x, 0.7, 1e-9));
  assert(NEAR(b.min.y, 0, 1e-9));
  assert(NEAR(b.min.z, -2.6, 1e-9));
  assert(NEAR(b.max.x, 1.3, 1e-9));
  assert(NEAR(b.max.y, 2, 1e-9));
  assert(NEAR(b.max.z, -1.4, 1e-9));

  const wall = { type: 'wall', x1: 0, y1: 0, x2: 10000, y2: 0, props: { thickness: 240, height: 3000 } };
  const wb = focusBoxOf(wall, { roomH: 3000 });
  assert(NEAR(wb.min.x, -0.12, 1e-9));
  assert(NEAR(wb.max.y, 3, 1e-9));
  assert(NEAR(wb.min.y, 0, 1e-9));

  const aisle = { type: 'aisle', x: 1000, y: 1000, rotation: 90, props: { w: 14400, d: 1200 } };
  const ab = focusBoxOf(aisle, { roomH: 3000 });
  assert(NEAR(ab.max.y, 3, 1e-9)); // 默认通道高取 roomH

  assert.equal(focusBoxOf({ type: 'ceiling', props: {} }), null);
  assert.equal(focusBoxOf(null), null);
});

test('focusLabel: 名称优先，其次 id/类型', () => {
  assert.equal(focusLabel({ type: 'cabinet', props: { name: 'A01' } }), 'A01');
  assert.equal(focusLabel({ id: 'abc', type: 'ac' }), 'abc');
  assert.equal(focusLabel({ type: 'ac' }), 'ac');
  assert.equal(focusLabel(null), '');
});
