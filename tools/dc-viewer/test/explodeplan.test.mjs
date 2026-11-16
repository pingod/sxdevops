import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPLODE, EXPLODE_PROFILES, DEFAULT_EXPLODE_PROFILE,
  normalizeExplodeProfile, explodeProfile, explodePlan,
} from '../src/features/explodeplan.js';

const room = JSON.parse(fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/samples/room.json'),
  'utf8',
));

const NEAR = (a, b, e = 1e-6) => Math.abs(a - b) < e;

test('normalizeExplodeProfile: 别名与非法值', () => {
  assert.equal(normalizeExplodeProfile('presentation'), 'presentation');
  assert.equal(normalizeExplodeProfile('demo'), 'presentation');
  assert.equal(normalizeExplodeProfile('show'), 'presentation');
  assert.equal(normalizeExplodeProfile('default'), 'presentation');
  assert.equal(normalizeExplodeProfile('review'), 'review');
  assert.equal(normalizeExplodeProfile(' SMALL '), 'review');
  assert.equal(normalizeExplodeProfile('bogus'), null);
  assert.equal(normalizeExplodeProfile(''), null);
  assert.equal(normalizeExplodeProfile(null), null);
});

test('EXPLODE_PROFILES: 两档参数与默认档', () => {
  assert.deepEqual(Object.keys(EXPLODE_PROFILES).sort(), ['presentation', 'review']);
  assert.equal(DEFAULT_EXPLODE_PROFILE, 'presentation');
  assert.equal(explodeProfile('bogus').id, 'presentation');
  assert.equal(explodeProfile('review').id, 'review');
  assert.equal(EXPLODE_PROFILES.presentation.dolly, 3.2);
  assert.equal(EXPLODE_PROFILES.review.dolly, 1.65);
  assert.equal(EXPLODE_PROFILES.review.spread, 1.25);
  assert.equal(EXPLODE.spread, 3.0);
});

test('explodePlan(room.json): 条目数量、档位、爆心', () => {
  const plan = explodePlan(room);
  assert.equal(plan.profile, 'presentation');
  assert.equal(plan.dolly, 3.2);
  // 1 地板 + 217 个可移动对象（152 机柜 + 8 列头柜 + 20 空调 + 8 灭火器 + 7 通道 + 9 桥架 + 8 柱 + 5 墙）
  assert.equal(plan.items.length, 218);
  const movable = room.objects.filter(o => [
    'wall', 'column', 'beam', 'cabinet', 'pdu', 'ac', 'ups', 'battery',
    'extinguisher', 'vent', 'tray', 'aisle',
  ].includes(o.type)).length;
  assert.equal(plan.items.length, movable + 1);
  assert.equal(plan.roomH, 3000);
  assert.equal(plan.floorH, 0);
  assert.equal(plan.ceilH, 0);
  assert(plan.maxDist > 0);
});

test('explodePlan: 演示档分层（墙 dy=0 / 桥架抬升 / 地板下沉 / 设备抬升）', () => {
  const plan = explodePlan(room, { profile: 'presentation' });
  const floor = plan.items.find(i => i.id === '__floor');
  assert(NEAR(floor.dy, -EXPLODE.floorDrop));
  assert.equal(floor.dx, 0);
  assert.equal(floor.dz, 0);

  const wall = plan.items.find(i => i.type === 'wall');
  assert.equal(wall.dy, 0);
  assert(Math.hypot(wall.dx, wall.dz) > 0);

  const tray = plan.items.find(i => i.type === 'tray');
  // trayLift + roomH(3m) × trayLiftRatio(0.8) = 5.5 + 2.4
  assert(NEAR(tray.dy, 7.9));
  const cab = plan.items.find(i => i.type === 'cabinet');
  // equipLift + 3m × 0.3 = 2.8 + 0.9
  assert(NEAR(cab.dy, 3.7));
});

test('explodePlan: 评审档位移更克制', () => {
  const plan = explodePlan(room, { profile: 'review' });
  assert.equal(plan.profile, 'review');
  assert.equal(plan.dolly, 1.65);
  const floor = plan.items.find(i => i.id === '__floor');
  assert(NEAR(floor.dy, -0.6));
  const tray = plan.items.find(i => i.type === 'tray');
  assert(NEAR(tray.dy, 1.4));
  const cab = plan.items.find(i => i.type === 'cabinet');
  assert(NEAR(cab.dy, 0.9));
});

test('explodePlan: 平面外扩按离爆心方向与比例', () => {
  const plan = explodePlan(room, { profile: 'presentation' });
  const cx = plan.center.x;
  const cy = plan.center.y;
  const east = plan.items.find(i => {
    const o = room.objects.find(q => q.id === i.id);
    return o && o.type === 'cabinet' && +o.x > cx;
  });
  assert(east);
  const eo = room.objects.find(q => q.id === east.id);
  assert(NEAR(east.dx, (+eo.x - cx) * 0.001 * 3.0, 1e-9));
  const north = plan.items.find(i => {
    const o = room.objects.find(q => q.id === i.id);
    return o && o.type === 'cabinet' && +o.y > cy;
  });
  assert(north);
  const no = room.objects.find(q => q.id === north.id);
  assert(NEAR(north.dz, -(+no.y - cy) * 0.001 * 3.0, 1e-9));

  const custom = explodePlan(room, { profile: 'presentation', spread: 5 });
  const east5 = custom.items.find(i => i.id === east.id);
  assert(NEAR(east5.dx, east.dx / 3.0 * 5.0, 1e-6));
});

test('explodePlan: rank 按离爆心距离归一化', () => {
  const plan = explodePlan(room);
  let maxRank = 0;
  let minRank = Infinity;
  for (const it of plan.items) {
    assert(it.rank >= 0 && it.rank <= 1);
    maxRank = Math.max(maxRank, it.rank);
    minRank = Math.min(minRank, it.rank);
  }
  assert(NEAR(minRank, 0, 1e-9));
  assert(NEAR(maxRank, 1, 1e-9));
  // 最远对象的 rank 必然是 1（maxDist 归一化）
  assert(plan.items.some(it => it.rank === 1));
  // 地板在爆心，rank 0
  assert.equal(plan.items.find(i => i.id === '__floor').rank, 0);
});

test('explodePlan: 空项目不抛错', () => {
  const plan = explodePlan({ objects: [] });
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].id, '__floor');
  assert(plan.maxDist >= 1);
});
