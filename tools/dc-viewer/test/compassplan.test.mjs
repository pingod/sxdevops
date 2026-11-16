import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPASS, normalizeAngle, northAngleFromBasis, northAngleFromCamera,
  scaleLabel, scalePlan, viewCaption, isElevationView, compassPlan,
  directionText, summarizeCompass,
} from '../src/features/compassplan.js';

/* 俯视（北朝上）的相机基：屏幕右 = 世界 +X，屏幕上 = 世界 -Z */
const RIGHT_NORTH_UP = { x: 1, y: 0, z: 0 };
const UP_NORTH_UP = { x: 0, y: 1, z: -1 };

test('normalizeAngle: 归一到 [0,360)', () => {
  assert.equal(normalizeAngle(0), 0);
  assert.equal(normalizeAngle(360), 0);
  assert.equal(normalizeAngle(-90), 270);
  assert.equal(normalizeAngle(450), 90);
  assert.equal(normalizeAngle(NaN), 0);
  assert.equal(normalizeAngle('abc'), 0);
});

test('northAngleFromBasis: 北朝上基线为 0°', () => {
  assert.equal(northAngleFromBasis(RIGHT_NORTH_UP, UP_NORTH_UP), 0);
  // 相机顺时针转 90°：屏幕右 = 南，北在屏幕左侧 → 270°
  assert.equal(northAngleFromBasis({ x: 0, z: 1 }, { x: 1, z: 0 }), 270);
  // 相机逆时针转 90°：屏幕右 = 北？此时北在右侧 → 90°
  assert.equal(northAngleFromBasis({ x: 0, z: -1 }, { x: -1, z: 0 }), 90);
});

test('northAngleFromBasis: 退化与非法输入返回 null', () => {
  assert.equal(northAngleFromBasis(null, UP_NORTH_UP), null);
  assert.equal(northAngleFromBasis(RIGHT_NORTH_UP, null), null);
  // 北向投影长度 < 0.12（立面视轴平行北向）
  assert.equal(northAngleFromBasis({ z: 0 }, { z: 0 }), null);
  assert.equal(northAngleFromBasis({ z: -0.1 }, { z: 0 }), null);
});

test('northAngleFromCamera: 读取矩阵列 0/1 的 z 分量', () => {
  const basis = new Array(16).fill(0);
  basis[0] = 1; basis[2] = 0; // right
  basis[5] = 1; basis[6] = -1; // up
  assert.equal(northAngleFromCamera(basis), 0);
  assert.equal(northAngleFromCamera(null), null);
  assert.equal(northAngleFromCamera([1, 0, 0]), null);
});

test('scaleLabel: km / m / cm / mm 单位格式', () => {
  assert.equal(scaleLabel(2000), '2 km');
  assert.equal(scaleLabel(1500), '1.5 km');
  assert.equal(scaleLabel(1000), '1 km');
  assert.equal(scaleLabel(2), '2 m');
  assert.equal(scaleLabel(1.25), '1.25 m');
  assert.equal(scaleLabel(0.5), '50 cm');
  assert.equal(scaleLabel(0.01), '1 cm');
  assert.equal(scaleLabel(0.005), '5 mm');
  assert.equal(scaleLabel(0), '');
  assert.equal(scaleLabel(-1), '');
  assert.equal(scaleLabel(NaN), '');
});

test('scalePlan: 1/2/5×10ⁿ 选择与像素区间', () => {
  // 每像素 1cm：候选 1/2/5cm…1/2/5m；96px 目标命中 1m=100px
  const p = scalePlan(0.01);
  assert.equal(p.meters, 1);
  assert.equal(p.px, 100);
  assert.equal(p.label, '1 m');
  assert.equal(p.targetPx, COMPASS.targetPx);
  assert.ok(p.px >= COMPASS.minPx && p.px <= COMPASS.maxPx);

  // 每像素 2cm：桌面 2m=100px 最接近 96
  const desktop = scalePlan(0.02);
  assert.equal(desktop.meters, 2);
  assert.equal(desktop.px, 100);

  // 移动端目标 64px、上限 96px：2m=100px 超出区间，退回 1m=50px
  const mobile = scalePlan(0.02, { mobile: true });
  assert.equal(mobile.targetPx, COMPASS.mobileTargetPx);
  assert.equal(mobile.maxPx, COMPASS.mobileMaxPx);
  assert.equal(mobile.meters, 1);
  assert.equal(mobile.px, 50);
  assert.equal(mobile.label, '1 m');

  // 视口宽度 < 600 自动按移动端
  const auto = scalePlan(0.02, { viewportWidth: 400 });
  assert.equal(auto.targetPx, COMPASS.mobileTargetPx);
  assert.equal(scalePlan(0.02, { viewportWidth: 1600 }).targetPx, COMPASS.targetPx);
});

test('scalePlan: 候选始终来自 1/2/5 × 10ⁿ', () => {
  for (const wpp of [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.5]) {
    const p = scalePlan(wpp);
    assert.ok(p, `wpp=${wpp}`);
    const mant = p.meters / Math.pow(10, Math.floor(Math.log10(p.meters) + 1e-9));
    assert.ok([1, 2, 5].some(k => Math.abs(mant - k) < 1e-6), `meters=${p.meters}`);
  }
});

test('scalePlan: 非法输入与极端缩放', () => {
  assert.equal(scalePlan(0), null);
  assert.equal(scalePlan(-1), null);
  assert.equal(scalePlan(NaN), null);
  // 极端大比例：候选都短于 minPx，退回最接近目标像素的一个
  const tiny = scalePlan(1e-6);
  assert.ok(tiny && tiny.meters > 0 && tiny.px > 0);
  const huge = scalePlan(1e6);
  assert.ok(huge && huge.meters > 0 && huge.px > 0);
});

test('viewCaption: 各视图标题', () => {
  assert.deepEqual(viewCaption('top'), { title: '俯视平面', sub: '正交 · 北朝上' });
  assert.deepEqual(viewCaption('iso', { corner: 'se' }), {
    title: '轴测总览', sub: '正交 · 东南角',
  });
  assert.deepEqual(viewCaption('iso'), { title: '轴测总览', sub: '正交 · 平行投影' });
  assert.deepEqual(viewCaption('front'), { title: '南立面', sub: '正交 · 近墙隐藏' });
  assert.deepEqual(viewCaption('back'), { title: '北立面', sub: '正交 · 近墙隐藏' });
  assert.deepEqual(viewCaption('left'), { title: '西立面', sub: '正交 · 近墙隐藏' });
  assert.deepEqual(viewCaption('right'), { title: '东立面', sub: '正交 · 近墙隐藏' });
  assert.deepEqual(viewCaption('orbit'), { title: '全景轨道', sub: '透视' });
  assert.deepEqual(viewCaption('orbit', { cameraMode: 'ortho' }), {
    title: '正交轨道', sub: '平行投影',
  });
  assert.deepEqual(viewCaption('focus', { cameraMode: 'ortho' }), {
    title: '对象聚焦', sub: '正交',
  });
  assert.deepEqual(viewCaption('viewpoint', { viewpointLabel: '东南角' }), {
    title: '东南角', sub: '定点视点',
  });
  assert.deepEqual(viewCaption('weird'), { title: '机房视图', sub: '透视' });
});

test('isElevationView: 仅四立面', () => {
  for (const id of ['front', 'back', 'left', 'right']) assert.equal(isElevationView(id), true);
  for (const id of ['top', 'iso', 'orbit', 'focus', '']) assert.equal(isElevationView(id), false);
});

test('compassPlan: ortho 俯视显示指北针与比例尺', () => {
  const plan = compassPlan({
    activeId: 'top',
    cameraMode: 'ortho',
    right: RIGHT_NORTH_UP,
    up: UP_NORTH_UP,
    worldPerPixel: 0.01,
    viewportWidth: 1600,
  });
  assert.equal(plan.show, true);
  assert.equal(plan.title, '俯视平面');
  assert.equal(plan.sub, '正交 · 北朝上');
  assert.equal(plan.northAngle, 0);
  assert.equal(plan.showNorth, true);
  assert.equal(plan.scale.label, '1 m');
  assert.equal(plan.mobile, false);
  assert.match(plan.aria, /俯视平面/);
  assert.match(plan.aria, /指北针北偏北/);
  assert.match(plan.aria, /比例尺 1 m/);
});

test('compassPlan: 立面隐藏指北针但保留比例尺', () => {
  const plan = compassPlan({
    activeId: 'front',
    cameraMode: 'ortho',
    right: { x: 1, z: 0 },
    up: { x: 0, z: 0 }, // 北向退化为垂直屏幕
    worldPerPixel: 0.01,
    viewportWidth: 1600,
  });
  assert.equal(plan.show, true);
  assert.equal(plan.northAngle, null);
  assert.equal(plan.showNorth, false);
  assert.ok(plan.scale);
  assert.doesNotMatch(plan.aria, /指北针/);
  assert.match(plan.aria, /比例尺/);
});

test('compassPlan: 透视 / 巡视步行不显示', () => {
  const persp = compassPlan({ activeId: 'top', cameraMode: 'perspective' });
  assert.equal(persp.show, false);
  assert.equal(persp.aria, '');
  assert.equal(persp.scale, null);
  assert.equal(persp.northAngle, null);

  const suppressed = compassPlan({
    activeId: 'top', cameraMode: 'ortho', right: RIGHT_NORTH_UP, up: UP_NORTH_UP,
    worldPerPixel: 0.01, suppressed: true,
  });
  assert.equal(suppressed.show, false);
  assert.equal(suppressed.aria, '');
});

test('compassPlan: 窄视口按移动端目标长度', () => {
  const plan = compassPlan({
    activeId: 'top',
    cameraMode: 'ortho',
    right: RIGHT_NORTH_UP,
    up: UP_NORTH_UP,
    worldPerPixel: 0.02,
    viewportWidth: 400,
  });
  assert.equal(plan.mobile, true);
  assert.equal(plan.scale.targetPx, COMPASS.mobileTargetPx);
});

test('directionText: 八个方位', () => {
  assert.equal(directionText(0), '北');
  assert.equal(directionText(45), '东北');
  assert.equal(directionText(90), '东');
  assert.equal(directionText(135), '东南');
  assert.equal(directionText(180), '南');
  assert.equal(directionText(225), '西南');
  assert.equal(directionText(270), '西');
  assert.equal(directionText(315), '西北');
  assert.equal(directionText(350), '北');
  assert.equal(directionText(-45), '西北');
});

test('summarizeCompass: 自检摘要', () => {
  const plan = compassPlan({
    activeId: 'iso',
    corner: 'se',
    cameraMode: 'ortho',
    right: RIGHT_NORTH_UP,
    up: UP_NORTH_UP,
    worldPerPixel: 0.01,
    viewportWidth: 1600,
  });
  const sum = summarizeCompass(plan);
  assert.equal(sum.show, true);
  assert.equal(sum.title, '轴测总览');
  assert.equal(sum.sub, '正交 · 东南角');
  assert.equal(sum.showNorth, true);
  assert.equal(sum.northAngle, 0);
  assert.equal(sum.direction, '北');
  assert.equal(sum.scale.label, '1 m');
  assert.equal(sum.scale.px, 100);
  assert.equal(sum.scale.targetPx, COMPASS.targetPx);

  assert.deepEqual(summarizeCompass(null), { show: false, aria: '' });
  assert.deepEqual(summarizeCompass({ show: false }), { show: false, aria: '' });
});
