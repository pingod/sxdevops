import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SECTION, CLIP, SIDE, BOX,
  sectionHeights, presetCut, matchPreset, sectionItems, hiddenByCut, sectionPlan, sliderRange,
  isBounds, isSideAxis, sideCenter, sideCrosses, hiddenBySide, sidePlane, sideBounds,
  sideRange, sideDefaultPos, sideLabel, sideCutName, sideKeepName, sidePlan,
  isClipAxis, clipDefaultCut, clipRangeFor, clipDefaultPos, clipPlaneAt, clipScenePlane,
  clipKeepsPoint, clipCutName, clipKeepName, clipLabel,
  isBoxPreset, boxPreset, boxPresetLabel, isBoxBounds, boxRangeFor, boxRanges,
  defaultBox, normalizeBox, boxLabel, hiddenByBox, boxPlan, matchBoxPreset,
} from '../src/features/sectionplan.js';

const room = JSON.parse(readFileSync(new URL('../public/samples/room.json', import.meta.url), 'utf8'));

const BOX_BOUNDS = { x0: 0, x1: 12000, y0: 0, y1: 7000 };
const heights = sectionHeights(room);

test('sectionHeights: room.json 派生层高/桥架标高', () => {
  assert.equal(heights.roomH, 3000);
  assert.equal(heights.hasCeil, false);
  assert.equal(heights.ceilH, 3000);
  assert.equal(heights.floorH, 0);
  assert.equal(heights.trayBottom, 2900);
  assert.equal(heights.trayTop, 3100);
  assert.equal(heights.beamTop, null);
});

test('sectionHeights: 吊顶与地面高度派生', () => {
  const h = sectionHeights({
    meta: { roomHeight: 3600, ceilHeight: 2800, floorHeight: 400 },
    objects: [{ id: 'w', type: 'wall', props: { height: 3200 } }],
  });
  assert.equal(h.roomH, 3600);
  assert.equal(h.hasCeil, true);
  assert.equal(h.ceilH, 2800);
  assert.equal(h.floorH, 400);
  assert.equal(h.trayBottom, null);
  assert.equal(h.trayTop, null);
});

test('presetCut: 四档预设', () => {
  assert.equal(presetCut('above-ceiling', heights), 3000);
  assert.equal(presetCut('above-tray', heights), 3100);
  assert.equal(presetCut('below-tray', heights), 2900);
  assert.equal(presetCut('all', heights), null);
});

test('presetCut: 无桥架时退化不产生 NaN', () => {
  const h = sectionHeights({ meta: { roomHeight: 3000, ceilHeight: 2600 }, objects: [] });
  assert.equal(presetCut('above-tray', h), 2600);
  assert.equal(presetCut('below-tray', h), 2500);
});

test('matchPreset: ±2mm 容差与 custom/all', () => {
  assert.equal(matchPreset(0, heights), 'all');
  assert.equal(matchPreset(3000, heights), 'above-ceiling');
  assert.equal(matchPreset(3002, heights), 'above-ceiling');
  assert.equal(matchPreset(3100, heights), 'above-tray');
  assert.equal(matchPreset(3098, heights), 'above-tray');
  assert.equal(matchPreset(2902, heights), 'below-tray');
  assert.equal(matchPreset(3003, heights), 'custom');
  assert.equal(matchPreset(3103, heights), 'custom');
});

test('hiddenByCut: 顶面高于切面才隐藏，恰好等高保留', () => {
  const item = { maxY: 2900 };
  assert.equal(hiddenByCut(item, 2898), true);
  assert.equal(hiddenByCut(item, 2899), false); // 2900 > 2900 不成立
  assert.equal(hiddenByCut(item, 0), false);
  assert.equal(hiddenByCut(null, 2000), false);
});

test('sectionItems/sectionPlan: 只作用于 ceiling/tray/beam', () => {
  const project = {
    meta: { roomHeight: 3000, ceilHeight: 2800, floorHeight: 0 },
    objects: [
      { id: 't1', type: 'tray', props: { height: 2900, bodyH: 200 } },
      { id: 'b1', type: 'beam', props: { top: 3300, h: 600 } },
      { id: 'c1', type: 'cabinet', props: { h: 2000 } },
      { id: 'w1', type: 'wall', props: { height: 3000 } },
    ],
  };
  const items = sectionItems(project);
  assert.deepEqual(items.map(i => i.id), ['__ceiling', 't1', 'b1']);
  assert.deepEqual(items[0], { id: '__ceiling', type: 'ceiling', label: '吊顶', minY: 2800, maxY: 2800 });

  const plan = sectionPlan(project, { cut: 2900 });
  assert.deepEqual(plan.hidden.map(i => i.id), ['t1', 'b1']);
  assert.equal(plan.items.find(i => i.id === 't1').hidden, true);

  const planHigh = sectionPlan(project, { cut: 2850 });
  assert.deepEqual(planHigh.hidden.map(i => i.id), ['t1', 'b1']);
  assert.equal(planHigh.items.find(i => i.id === 'b1').minY, 2700);
  // 切面低于吊顶时吊顶也进入隐藏集合
  assert.deepEqual(sectionPlan(project, { cut: 2790 }).hidden.map(i => i.id), ['__ceiling', 't1', 'b1']);
});

test('sectionPlan: room.json 2600mm 切面隐藏全部桥架', () => {
  const plan = sectionPlan(room, { cut: 2600 });
  assert.equal(plan.items.length, 9);
  assert.equal(plan.hidden.length, 9);
  assert.ok(plan.hidden.every(i => i.type === 'tray'));
  // 设备与墙体从不进入高度过滤
  assert.ok(plan.items.every(i => i.type !== 'cabinet' && i.type !== 'wall'));
});

test('sliderRange: 覆盖层高与桥架顶，步长 100', () => {
  const r = sliderRange(heights);
  assert.deepEqual(r, { min: 600, max: 3600, step: 100 });
  const r2 = sliderRange({ roomH: 5000, ceilH: 5000, trayTop: 4200, beamTop: 4300 });
  assert.equal(r2.max, 5000);
  assert.equal(r2.min, 600);
  assert.equal(r2.step, 100);
});

test('isBounds/isSideAxis: 合法性', () => {
  assert.equal(isBounds({ x0: 0, x1: 10, y0: 0, y1: 10 }), true);
  assert.equal(isBounds({ x0: 10, x1: 0, y0: 0, y1: 10 }), false);
  assert.equal(isBounds({ x0: 0, x1: 10, y0: 0 }), false);
  assert.equal(isBounds(null), false);
  assert.equal(isSideAxis('x'), true);
  assert.equal(isSideAxis('Z'), true);
  assert.equal(isSideAxis('y'), false);
});

test('sideCenter/sideCrosses: 轴映射与跨越判定', () => {
  const b = { x0: 0, x1: 1000, y0: 2000, y1: 4000 };
  assert.equal(sideCenter(b, 'x'), 500);
  assert.equal(sideCenter(b, 'z'), 3000); // z 轴使用项目 y
  assert.equal(sideCenter(null, 'x'), null);
  assert.equal(sideCrosses(b, { axis: 'x', pos: 500 }), true);
  assert.equal(sideCrosses(b, { axis: 'x', pos: 1200 }), false);
  assert.equal(sideCrosses(b, { axis: 'z', pos: 2500 }), true);
  assert.equal(sideCrosses(b, { axis: 'z', pos: 4500 }), false);
});

test('hiddenBySide: 中心判边与 flip', () => {
  const b = { x0: 0, x1: 1000, y0: 0, y1: 2000 };
  assert.equal(hiddenBySide(b, { axis: 'x', pos: 600, flip: false }), true);
  assert.equal(hiddenBySide(b, { axis: 'x', pos: 600, flip: true }), false);
  assert.equal(hiddenBySide(b, { axis: 'x', pos: 400, flip: false }), false);
  assert.equal(hiddenBySide(b, { axis: 'x', pos: 400, flip: true }), true);
  assert.equal(hiddenBySide(b, { axis: 'z', pos: 1100, flip: false }), true);
  assert.equal(hiddenBySide(b, { axis: 'z', pos: 1100, flip: true }), false);
  assert.equal(hiddenBySide(null, { axis: 'x', pos: 0 }), false);
});

test('sidePlane: 归一化非法轴与超界位置', () => {
  assert.deepEqual(sidePlane({ axis: 'Q', pos: 'abc' }), { axis: 'x', pos: 0, flip: false });
  assert.deepEqual(sidePlane({ axis: 'z', pos: 999999, flip: 1 }), {
    axis: 'z', pos: SIDE.maxPosMm, flip: true,
  });
  assert.deepEqual(sidePlane(), { axis: 'x', pos: 0, flip: false });
});

test('sideBounds: 并集与空集', () => {
  assert.deepEqual(sideBounds([
    { x0: 0, x1: 10, y0: 0, y1: 10 },
    { x0: -5, x1: 4, y0: 2, y1: 30 },
    null,
  ]), { x0: -5, y0: 0, x1: 10, y1: 30 });
  assert.equal(sideBounds([]), null);
});

test('sideRange/sideDefaultPos: 取整到 100mm', () => {
  const b = { x0: -212, x1: 30238, y0: 5900, y1: 25120 };
  assert.deepEqual(sideRange(b, 'x'), { min: -300, max: 30300, step: 100 });
  assert.deepEqual(sideRange(b, 'z'), { min: 5900, max: 25200, step: 100 });
  assert.equal(sideDefaultPos(b, 'x'), 15000);
  assert.equal(sideDefaultPos(b, 'z'), 15500);
  assert.deepEqual(sideRange(null, 'x'), { min: 0, max: 0, step: 100 });
  assert.equal(sideDefaultPos(null, 'x'), 0);
});

test('sideLabel/sideCutName/sideKeepName: 文案', () => {
  assert.equal(sideLabel('x', false), '东西 X · 切掉西侧');
  assert.equal(sideLabel('x', true), '东西 X · 切掉东侧');
  assert.equal(sideLabel('z', false), '南北 Z · 切掉南侧');
  assert.equal(sideCutName('z', true), '北侧');
  assert.equal(sideKeepName('x', false), '东侧');
  assert.equal(sideKeepName('z', true), '南侧');
  assert.equal(sideLabel('bad', false), '东西 X · 切掉西侧');
});

test('sidePlan: hidden/crossed 分类', () => {
  const records = [
    { id: 'west', type: 'cabinet', bounds: { x0: 0, x1: 400, y0: 0, y1: 1000 } },
    { id: 'east', type: 'cabinet', bounds: { x0: 600, x1: 1000, y0: 0, y1: 1000 } },
    { id: 'cross', type: 'tray', bounds: { x0: 400, x1: 600, y0: 0, y1: 1000 } },
  ];
  const plan = sidePlan(records, { axis: 'x', pos: 500, flip: false });
  assert.deepEqual(plan.hidden.map(i => i.id), ['west']);
  assert.deepEqual(plan.crossed.map(i => i.id), ['cross']);
  assert.deepEqual(plan.bounds, { x0: 0, y0: 0, x1: 1000, y1: 1000 });
  assert.equal(plan.items.find(i => i.id === 'cross').hidden, false);

  const flipped = sidePlan(records, { axis: 'x', pos: 500, flip: true });
  assert.deepEqual(flipped.hidden.map(i => i.id), ['east']);
});

test('isClipAxis/clipDefaultCut/clipRangeFor/clipDefaultPos', () => {
  assert.equal(isClipAxis('y'), true);
  assert.equal(isClipAxis('X'), true);
  assert.equal(isClipAxis('h'), false);
  assert.equal(clipDefaultCut(heights), 1200);
  assert.deepEqual(clipRangeFor(heights, null, 'y'), { min: 0, max: 3000, step: 100 });
  assert.deepEqual(clipRangeFor(heights, BOX_BOUNDS, 'x'), { min: 0, max: 12000, step: 100 });
  assert.equal(clipDefaultPos(heights, BOX_BOUNDS, 'y'), 1200);
  assert.equal(clipDefaultPos(heights, BOX_BOUNDS, 'x'), 6000);
});

test('clipPlaneAt/clipKeepsPoint: 四轴保留侧', () => {
  const py = clipPlaneAt('y', 1200, false);
  assert.deepEqual(py.normal, { x: 0, y: 0, z: 1 });
  assert.equal(py.constant, -1200);
  assert.equal(clipKeepsPoint(py, { x: 0, y: 0, z: 1300 }), true);
  assert.equal(clipKeepsPoint(py, { x: 0, y: 0, z: 1100 }), false);
  assert.equal(clipKeepsPoint(py, { x: 0, y: 0, z: 1200 }), true); // 边界保留

  const px = clipPlaneAt('x', 3000, false);
  assert.deepEqual(px.normal, { x: 1, y: 0, z: 0 });
  assert.equal(clipKeepsPoint(px, { x: 3100, y: 0, z: 0 }), true);
  assert.equal(clipKeepsPoint(px, { x: 2900, y: 0, z: 0 }), false);

  const pz = clipPlaneAt('z', 2000, false);
  assert.deepEqual(pz.normal, { x: 0, y: 1, z: 0 });
  assert.equal(clipKeepsPoint(pz, { x: 0, y: 2100, z: 0 }), true);
  assert.equal(clipKeepsPoint(pz, { x: 0, y: 1900, z: 0 }), false);
});

test('clipPlaneAt: flip 保留坐标较小侧', () => {
  const py = clipPlaneAt('y', 1200, true);
  assert.deepEqual(py.normal, { x: 0, y: 0, z: -1 });
  assert.equal(py.constant, 1200);
  assert.equal(clipKeepsPoint(py, { x: 0, y: 0, z: 1100 }), true);
  assert.equal(clipKeepsPoint(py, { x: 0, y: 0, z: 1300 }), false);

  const px = clipPlaneAt('x', 3000, true);
  assert.equal(clipKeepsPoint(px, { x: 2900, y: 0, z: 0 }), true);
  assert.equal(clipKeepsPoint(px, { x: 3100, y: 0, z: 0 }), false);
});

test('clipScenePlane: 项目毫米 → 场景米（z 北 → -z）', () => {
  assert.deepEqual(clipScenePlane('y', 1200), {
    normal: { x: 0, y: 1, z: 0 }, constant: -1.2,
  });
  assert.deepEqual(clipScenePlane('x', 3000, false), {
    normal: { x: 1, y: 0, z: 0 }, constant: -3,
  });
  // 项目 +Y（北）映射到场景 -Z
  assert.deepEqual(clipScenePlane('z', 2000, false), {
    normal: { x: 0, y: 0, z: -1 }, constant: -2,
  });
  const plane = clipPlaneAt('y', 1200, false);
  assert.deepEqual(clipScenePlane(plane), { normal: { x: 0, y: 1, z: 0 }, constant: -1.2 });
});

test('clipCutName/clipKeepName/clipLabel: 文案', () => {
  assert.equal(clipCutName('y', false), '以下');
  assert.equal(clipCutName('x', true), '东侧');
  assert.equal(clipKeepName('y', true), '以下');
  assert.equal(clipKeepName('z', false), '北侧');
  assert.equal(clipLabel('y', 1200, false), '水平 1.20m · 保留以上');
  assert.equal(clipLabel('y', 1200, true), '水平 1.20m · 保留以下');
  assert.equal(clipLabel('x', 3000, false), '东西 X 3.00m · 切掉西侧');
  assert.equal(clipLabel('z', 2000, true), '南北 Z 2.00m · 切掉北侧');
});

test('BOX: 预设元数据与合法性', () => {
  assert.equal(isBoxPreset('CORNER'), true);
  assert.equal(isBoxPreset('nope'), false);
  assert.equal(boxPreset('top').label, '顶剖');
  assert.equal(boxPreset('nope'), null);
  assert.equal(boxPresetLabel('half'), '半剖');
  assert.equal(boxPresetLabel('nope'), '自定义');
  assert.deepEqual(BOX.ids, ['corner', 'top', 'half']);
  assert.equal(SECTION.box, BOX);
});

test('isBoxBounds: 合法性', () => {
  assert.equal(isBoxBounds({ x0: 0, x1: 10, y0: 0, y1: 10 }), true);
  assert.equal(isBoxBounds({ x0: 10, x1: 0, y0: 0, y1: 10 }), false);
  assert.equal(isBoxBounds({ x0: 0, x1: 10, y0: 'x', y1: 10 }), false);
  assert.equal(isBoxBounds(null), false);
});

test('boxRangeFor/boxRanges: 三轴范围', () => {
  assert.deepEqual(boxRangeFor(BOX_BOUNDS, heights, 'x'), { min: 0, max: 12000, step: 100 });
  assert.deepEqual(boxRangeFor(BOX_BOUNDS, heights, 'z'), { min: 0, max: 7000, step: 100 });
  assert.deepEqual(boxRangeFor(BOX_BOUNDS, heights, 'h'), { min: 0, max: 3000, step: 100 });
  const ranges = boxRanges(BOX_BOUNDS, heights);
  assert.deepEqual(Object.keys(ranges), ['x', 'z', 'h']);
  // 非法 bounds 走安全回退
  assert.deepEqual(boxRangeFor(null, heights, 'x'), { min: 0, max: 12000, step: 100 });
});

test('defaultBox: corner/top/half 默认值与一致性', () => {
  assert.deepEqual(defaultBox(BOX_BOUNDS, heights, 'corner'), {
    x: 6000, z: 3500, h: 3000, preset: 'corner',
  });
  assert.deepEqual(defaultBox(BOX_BOUNDS, heights, 'top'), {
    x: 12000, z: 0, h: 2900, preset: 'top',
  });
  assert.deepEqual(defaultBox(BOX_BOUNDS, heights, 'half'), {
    x: 6000, z: 0, h: 3000, preset: 'half',
  });
  // 未知预设退回 corner
  assert.equal(defaultBox(BOX_BOUNDS, heights, 'oops').preset, 'corner');
  // 无吊顶时 top 使用层高
  const noCeil = defaultBox(BOX_BOUNDS, sectionHeights(room), 'top');
  assert.equal(noCeil.h, 2900);
});

test('normalizeBox: 夹取范围、取整与预设保留', () => {
  const cur = defaultBox(BOX_BOUNDS, heights, 'corner');
  const n = normalizeBox({ x: 1e9, z: -1e9, h: 5000 }, cur, BOX_BOUNDS, heights);
  assert.deepEqual(n, { x: 12000, z: 0, h: 3000, preset: 'corner' });
  const partial = normalizeBox({ x: 6000.4 }, cur, BOX_BOUNDS, heights);
  assert.equal(partial.x, 6000);
  assert.equal(partial.z, 3500);
  assert.equal(normalizeBox({ h: 1200, preset: 'custom' }, cur, BOX_BOUNDS, heights).preset, 'custom');
});

test('boxLabel: 两位小数米制文案', () => {
  assert.equal(boxLabel({ x: 6000, z: 3500, h: 2800 }), 'X 6.00m · Z 3.50m · 高 2.80m');
  assert.equal(boxLabel(null), 'X 0.00m · Z 0.00m · 高 0.00m');
});

test('hiddenByBox: 边界 eps=1mm', () => {
  const box = { x: 6000, z: 3500, h: 3000 };
  // 东西：完全在东侧才隐藏
  assert.equal(hiddenByBox({ x0: 6100, x1: 7000, y0: 0, y1: 7000 }, box), true);
  assert.equal(hiddenByBox({ x0: 6001, x1: 7000, y0: 0, y1: 7000 }, box), false);
  assert.equal(hiddenByBox({ x0: 6001.5, x1: 7000, y0: 0, y1: 7000 }, box), true);
  // 南北：完全在南侧才隐藏
  assert.equal(hiddenByBox({ x0: 0, x1: 6000, y0: 0, y1: 3498 }, box), true);
  assert.equal(hiddenByBox({ x0: 0, x1: 6000, y0: 0, y1: 3499 }, box), false);
  // 竖向：底面不低于顶切面才隐藏（等高视为盒外）
  assert.equal(hiddenByBox({ x0: 0, x1: 6000, y0: 3500, y1: 7000 }, box, { minY: 2999, maxY: 3100 }), true);
  assert.equal(hiddenByBox({ x0: 0, x1: 6000, y0: 3500, y1: 7000 }, box, { minY: 2998, maxY: 3100 }), false);
  // 无包围盒 / 非法包围盒永不隐藏
  assert.equal(hiddenByBox(null, box), false);
  assert.equal(hiddenByBox({ x0: 0, x1: 1 }, box), false);
});

test('boxPlan: 统计与分类', () => {
  const records = [
    { id: 'a', type: 'cabinet', bounds: { x0: 0, x1: 500, y0: 6000, y1: 7000 } },
    { id: 'b', type: 'cabinet', bounds: { x0: 7000, x1: 8000, y0: 6000, y1: 7000 } },
    { id: 'c', type: 'ceiling', bounds: { x0: 0, x1: 12000, y0: 0, y1: 7000 }, minY: 3000, maxY: 3000 },
  ];
  const plan = boxPlan(records, { x: 6000, z: 3500, h: 3000 });
  assert.deepEqual(plan.hidden.map(i => i.id), ['b', 'c']);
  assert.deepEqual(plan.byType, { cabinet: 2, ceiling: 1 });
  assert.deepEqual(plan.hiddenTypes, { cabinet: 1, ceiling: 1 });
  assert.equal(plan.items[0].label, 'a');
});

test('matchBoxPreset: ±2mm 命中与 custom', () => {
  const corner = defaultBox(BOX_BOUNDS, heights, 'corner');
  assert.equal(matchBoxPreset(corner, BOX_BOUNDS, heights), 'corner');
  assert.equal(matchBoxPreset({ ...corner, x: corner.x + 2 }, BOX_BOUNDS, heights), 'corner');
  assert.equal(matchBoxPreset({ ...corner, x: corner.x + 3 }, BOX_BOUNDS, heights), 'custom');
  assert.equal(matchBoxPreset(defaultBox(BOX_BOUNDS, heights, 'top'), BOX_BOUNDS, heights), 'top');
  assert.equal(matchBoxPreset(null, BOX_BOUNDS, heights), 'custom');
});

test('CLIP/SIDE/SECTION 模式表', () => {
  assert.deepEqual(SECTION.modes, ['off', 'height', 'side', 'clip', 'box']);
  assert.deepEqual(CLIP.axes, ['y', 'x', 'z']);
  assert.deepEqual(SIDE.axes, ['x', 'z']);
  assert.deepEqual(SECTION.types, ['ceiling', 'tray', 'beam']);
});
