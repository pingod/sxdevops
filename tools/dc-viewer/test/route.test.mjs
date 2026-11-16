import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TOUR_PLAN, yaw2d, posAt, planTour, INSPECTION_TYPES, normalizeRouteId,
  cabinetRowKey, detectRows, listRoutes, planRoute, buildWalkGrid, isWalkable,
  nearestFree, ROUTE_FALLBACK_TEXT, routeLabelOf, routeHintOf,
} from '../src/features/route.js';

const roomPath = fileURLToPath(new URL('../public/samples/room.json', import.meta.url));
const room = JSON.parse(readFileSync(roomPath, 'utf8'));

test('listRoutes(room.json) 返回 10 条：all + row-a..h + inspection', () => {
  const routes = listRoutes(room);
  assert.equal(routes.length, 10);
  assert.deepEqual(routes.map(r => r.id),
    ['all', 'row-a', 'row-b', 'row-c', 'row-d', 'row-e', 'row-f', 'row-g', 'row-h', 'inspection']);
  for (const r of routes.slice(1, 9)) {
    assert.equal(r.kind, 'row');
    assert.equal(r.count, 19);
    assert.equal(r.hint, '19 台机柜 · 单排通道');
    assert.equal(r.available, true);
  }
  const insp = routes[9];
  assert.equal(insp.kind, 'inspection');
  assert.equal(insp.available, true);
  assert.equal(insp.hint, '入口 → 空调');
  assert.deepEqual(insp.types, ['ac']);
});

test('detectRows(room.json) 产出 8 排 key a..h', () => {
  const rows = detectRows(room);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map(r => r.key.toLowerCase()), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  rows.forEach(r => {
    assert.equal(r.count, 19);
    assert.match(r.id, /^row-[a-h]$/);
    assert.equal(r.source, 'name');
  });
});

test('planRoute(room.json, all)：len≈144346、waypoints=38、入口并闭合成环', () => {
  const plan = planRoute(room, 'all');
  assert.ok(plan);
  assert.ok(Math.abs(plan.path.len - 144346) <= 5000, `len=${plan.path.len}`);
  assert.equal(plan.stats.waypoints, 38);
  assert.equal(plan.stats.kind, 'all');
  assert.equal(plan.stats.fallback, null);
  assert.equal(plan.stats.fromDoor, true);
  // 入口点与网格/门内侧一致（4088, 24200）
  assert.ok(Math.abs(plan.entry.x - 4088) < 1, `entry.x=${plan.entry.x}`);
  assert.equal(Math.round(plan.entry.y), 24200);
  // 首尾闭合
  const pts = plan.path.pts;
  const f = pts[0], l = pts[pts.length - 1];
  assert.ok(Math.hypot(f.x - l.x, f.y - l.y) < 1e-6);
});

test('planTour 与 planRoute(all) 等长', () => {
  const a = planTour(room);
  const b = planRoute(room, 'all');
  assert.ok(a && b);
  assert.ok(Math.abs(a.path.len - b.path.len) < 1e-6);
  assert.equal(a.stats.waypoints, 38);
});

test('单排 / 巡检 / 指定机柜路线', () => {
  const row = planRoute(room, 'row-a');
  assert.equal(row.stats.kind, 'row');
  assert.equal(row.stats.row.key, 'A');
  assert.equal(row.stats.row.label, 'A 排');
  assert.equal(row.stats.waypoints, 20);

  const insp = planRoute(room, 'inspection');
  assert.equal(insp.stats.kind, 'inspection');
  assert.deepEqual(insp.stats.skipped, [
    { type: 'ups', reason: 'missing' },
    { type: 'battery', reason: 'missing' },
  ]);
  assert.equal(insp.stats.targets[0].label, '空调');

  const cab = planRoute(room, 'cabinet-a01');
  assert.equal(cab.stats.kind, 'cabinet');
  assert.equal(cab.stats.target.name, 'A01');
  assert.equal(cab.stats.waypoints, 1);
});

test('未知/不可达路线回退全场并记 fallback', () => {
  const unknown = planRoute(room, 'bogus-id');
  assert.equal(unknown.stats.kind, 'all');
  assert.equal(unknown.stats.fallback, 'unknown-route');
  assert.equal(unknown.stats.requested, 'bogus-id');

  const nomatch = planRoute(room, 'cabinet-zzz999');
  assert.equal(nomatch.stats.fallback, 'target-missing');

  // 空项目：无引路点 → 兜底环线
  const empty = planRoute({ objects: [] }, 'all');
  assert.ok(empty && empty.path.len > 2000);
});

test('normalizeRouteId / cabinetRowKey', () => {
  assert.equal(normalizeRouteId('ROW-A'), 'row-a');
  assert.equal(normalizeRouteId(' row-a '), 'row-a');
  assert.equal(normalizeRouteId('巡检线'), '巡检线');
  assert.equal(normalizeRouteId(''), null);
  assert.equal(normalizeRouteId('..'), null);
  assert.equal(normalizeRouteId(null), null);

  assert.equal(cabinetRowKey({ props: { name: 'A01' } }), 'A');
  assert.equal(cabinetRowKey({ props: { name: 'AB-12' } }), 'AB');
  assert.equal(cabinetRowKey({ props: { name: 'ac unit' } }), '');
  assert.equal(cabinetRowKey({}), '');
});

test('buildWalkGrid / isWalkable / nearestFree', () => {
  const grid = buildWalkGrid(room);
  assert.equal(grid.nx, 151);
  assert.equal(grid.ny, 95);
  assert.equal(grid.cell, 200);
  assert.equal(grid.free, 6401);
  assert.equal(grid.fromDoor, true);
  assert.equal(grid.entryCell, 13610);
  assert.equal(Math.round(grid.entry.x), 4088);
  assert.equal(Math.round(grid.entry.y), 24200);

  assert.equal(isWalkable(grid, grid.entry.x, grid.entry.y), true);
  // 机柜中心被占位（外轮廓 + 人身余量）
  const cab = room.objects.find(o => o.type === 'cabinet');
  assert.equal(isWalkable(grid, cab.x, cab.y), false);
  assert.equal(isWalkable(grid, 0, 0), false);      // 房间外/墙内

  const near = nearestFree(grid, 99999, 99999);
  assert.equal(near, null);
  const snap = nearestFree(grid, grid.entry.x + 90, grid.entry.y + 90);
  assert.ok(snap && Number.isFinite(snap.x) && Number.isFinite(snap.y) && Number.isFinite(snap.cell));
});

test('posAt 沿环线取点（取模闭合）', () => {
  const plan = planRoute(room, 'all');
  const p0 = posAt(plan.path, 0);
  const p1 = posAt(plan.path, plan.path.len * 2);
  assert.ok(Math.abs(p0.x - p1.x) < 1e-6);
  assert.ok(Math.abs(p0.y - p1.y) < 1e-6);
  const mid = posAt(plan.path, plan.path.len / 2);
  assert.ok(Number.isFinite(mid.x) && Number.isFinite(mid.y));
});

test('yaw2d / TOUR_PLAN / INSPECTION_TYPES / 文案', () => {
  assert.ok(Math.abs(yaw2d(0, 1) - 0) < 1e-9);          // 北 = -z → yaw 0
  assert.ok(Math.abs(yaw2d(1, 0) + Math.PI / 2) < 1e-9); // 东 → yaw=-π/2
  assert.equal(TOUR_PLAN.cell, 200);
  assert.equal(TOUR_PLAN.merge, 1400);
  assert.equal(TOUR_PLAN.rowBand, 1000);
  assert.deepEqual(INSPECTION_TYPES.map(t => t.type), ['ups', 'battery', 'ac']);

  assert.equal(ROUTE_FALLBACK_TEXT['unknown-route'], '未知路线');
  assert.equal(ROUTE_FALLBACK_TEXT['row-missing'], '该排不存在或不可达');

  const plan = planRoute(room, 'all');
  assert.equal(routeLabelOf(plan), '全场环线');
  assert.equal(routeHintOf(plan), '38 个落脚点 · 144 m');
  const row = planRoute(room, 'row-a');
  assert.equal(routeLabelOf(row), 'A 排');
  const fallback = planRoute(room, 'bogus-id');
  assert.match(routeHintOf(fallback), /已回退全场（未知路线）/);
});
