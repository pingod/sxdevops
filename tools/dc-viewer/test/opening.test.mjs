/**
 * 开洞吸附的纯几何单测：最近墙投影、500mm 容差、墙太短拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { projectOnWall, nearestWall, clampTOnWall } from '../src/design/opening.js';

const wall = (id, x1, y1, x2, y2) => ({ id, type: 'wall', x1, y1, x2, y2, props: {} });

const north = wall('w-n', 0, 0, 6000, 0);
const east = wall('w-e', 6000, 0, 6000, 8000);
const door = wall('w-d', 0, 4000, 3000, 4000);

test('projectOnWall：投影到墙轴上并夹在 0–1', () => {
  assert.deepEqual(projectOnWall(north, 1500, 0), { t: 0.25, distance: 0 });
  assert.equal(projectOnWall(north, -3000, 0).t, 0);
  assert.equal(projectOnWall(north, 9000, 0).t, 1);
  assert.equal(projectOnWall(north, 3000, 200).distance, 200);
  assert.equal(projectOnWall({ ...north, x2: 0, y2: 0 }, 10, 10), null);
});

test('nearestWall：500mm 内取最近，超出返回 null', () => {
  const walls = [north, east, door];
  const hit = nearestWall(walls, 1500, 300, 500);
  assert.equal(hit.wall.id, 'w-n');
  assert.equal(hit.t, 0.25);

  assert.equal(nearestWall(walls, 1500, 900, 500), null);
  // 两条墙都在容差内时取更近的那条：到东墙 100mm、到北墙 200mm
  const corner = nearestWall(walls, 5900, 200, 500);
  assert.equal(corner.wall.id, 'w-e');
});

test('nearestWall：忽略非墙对象与无效墙', () => {
  const objects = [{ id: 'c1', type: 'cabinet', x: 0, y: 0 }, wall('bad', 0, 0, 0, 0), north];
  const hit = nearestWall(objects, 100, 50, 500);
  assert.equal(hit.wall.id, 'w-n');
});

test('clampTOnWall：门洞 900 在 6000 长墙上夹到 0.075–0.925', () => {
  assert.equal(clampTOnWall(north, 900, 0.01), 0.075);
  assert.equal(clampTOnWall(north, 900, 0.5), 0.5);
  assert.equal(clampTOnWall(north, 900, 0.99), 0.925);
  assert.equal(clampTOnWall(north, 900, Number.NaN), 0.5);
});

test('clampTOnWall：墙短于洞口宽度时拒绝', () => {
  const short = wall('w-s', 0, 0, 800, 0);
  assert.equal(clampTOnWall(short, 900, 0.5), null);
  assert.equal(clampTOnWall(short, 800, 0.5), 0.5);
  assert.equal(clampTOnWall(null, 900, 0.5), null);
});
