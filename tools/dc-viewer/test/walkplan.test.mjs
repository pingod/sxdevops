import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WALK, wrapPi, canStand, nearestStand, moveWalk, clearanceRatio, speedFactor,
  joystickAxis, walkDirection, lookDelta, walkCameraPose, walkHint, speedText,
} from '../src/features/walkplan.js';

/** 构造一个与 route.WalkGrid 同接口的小网格（测试用；CELL=200mm） */
const CELL = 200;
function mkModel(rows) {
  const ny = rows.length;
  const nx = rows[0].length;
  const occ = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) occ[j * nx + i] = rows[j][i] ? 1 : 0;
  return {
    cell: CELL, minx: 0, miny: 0, nx, ny, occ,
    ci(x) { return Math.floor(x / CELL); },
    cj(y) { return Math.floor(y / CELL); },
    x(i) { return (i + .5) * CELL; },
    y(j) { return (j + .5) * CELL; },
    id(i, j) { return j * nx + i; },
    bi(id) { return id % nx; },
    bj(id) { return (id - (id % nx)) / nx; },
    inside(i, j) { return i >= 0 && j >= 0 && i < nx && j < ny; },
    freeId(id) { return this.occ[id] === 0; },
    point(id) { return { x: this.x(this.bi(id)), y: this.y(this.bj(id)) }; },
    freeAt(x, y) {
      const i = this.ci(x), j = this.cj(y);
      return this.inside(i, j) && this.occ[this.id(i, j)] === 0;
    },
  };
}

/** 5×5，仅 (i=2,j=2) 一个障碍（中心 500,500） */
const one = mkModel([
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
]);

test('WALK 常量', () => {
  assert.equal(WALK.eye, 1.62);
  assert.equal(WALK.base, 1.3);
  assert.equal(WALK.narrow, 0.62);
  assert.equal(WALK.accel, 9);
  assert.equal(WALK.body, 60);
  assert.equal(WALK.step, 100);
  assert.equal(WALK.bobAmp, 0.009);
  assert.equal(WALK.bobStride, 720);
  assert.equal(WALK.turnDrag, 0.0042);
  assert.equal(WALK.pitchMin, -1.15);
  assert.equal(WALK.pitchMax, 1.05);
  assert.equal(WALK.joyDead, 0.12);
});

test('wrapPi 归一到 (-π, π]', () => {
  assert.ok(Math.abs(wrapPi(0)) < 1e-12);
  assert.ok(Math.abs(wrapPi(Math.PI / 2) - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(wrapPi(-Math.PI / 2) + Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(wrapPi(3 * Math.PI) - Math.PI) < 1e-12);
  assert.ok(Math.abs(wrapPi(2 * Math.PI)) < 1e-12);
  assert.ok(Math.abs(wrapPi(-2.5 * Math.PI) + 0.5 * Math.PI) < 1e-12);
});

test('canStand：格心可走 + 身体半径四向探测', () => {
  assert.equal(canStand(one, 300, 300), true);
  assert.equal(canStand(one, 500, 500), false);           // 障碍格
  assert.equal(canStand(one, 500, 500, 0), false);
  // 贴障碍：中心可走但右侧 60mm 探入障碍格（障碍格 x 400..600）
  assert.equal(canStand(one, 390, 500, 0), true);
  assert.equal(canStand(one, 390, 500, 60), false);
  assert.equal(canStand(one, NaN, 300), false);
  assert.equal(canStand(null, 300, 300), false);
});

test('nearestStand：从障碍格向外找到最近可站立点', () => {
  const hit = nearestStand(one, 500, 500);
  assert.ok(hit);
  assert.equal(hit.cell, one.id(1, 1));
  assert.equal(hit.x, 300);
  assert.equal(hit.y, 300);
  // 已在可站点：原样返回中心
  const same = nearestStand(one, 300, 300);
  assert.equal(same.cell, one.id(1, 1));
  assert.equal(nearestStand(one, NaN, 0), null);
});

test('moveWalk：对角受阻时沿轴滑动（不穿角）', () => {
  const r = moveWalk(one, 300, 300, 200, 200, { body: 0, step: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.slide, true);
  assert.equal(r.blocked, 0);
  assert.ok(Math.abs(r.x - 500) < 1e-6, `x=${r.x}`);
  assert.ok(Math.abs(r.y - 366.6666667) < 1e-4, `y=${r.y}`);
  // 首步对角 94.28 + 两次轴向滑动 66.67×2
  assert.ok(Math.abs(r.moved - 227.61423749153962) < 1e-6, `moved=${r.moved}`);
});

test('moveWalk：完全顶住时停止并计数', () => {
  const r = moveWalk(one, 300, 500, 200, 0, { body: 0, step: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.blocked, 1);
  assert.equal(r.moved, 0);
  assert.equal(r.x, 300);
  assert.equal(r.y, 500);

  // 起点不可站立 → ok:false 且不动
  const bad = moveWalk(one, 500, 500, 100, 0);
  assert.equal(bad.ok, false);
  assert.equal(bad.x, 500);
  assert.equal(bad.moved, 0);

  // 零位移
  const zero = moveWalk(one, 300, 300, 0, 0);
  assert.equal(zero.ok, true);
  assert.equal(zero.moved, 0);
});

test('clearanceRatio：5×5 窗口可走比例', () => {
  // 中心格 (1,1)：窗口贴边只统计网格内的 4×4=16 格，其中 1 格障碍
  assert.equal(clearanceRatio(one, 300, 300, 2), 15 / 16);
  assert.equal(clearanceRatio(one, 300, 300, 0), 1);
  // 网格外 → 0
  assert.equal(clearanceRatio(one, -100, 300, 2), 0);
});

test('speedFactor：0.78 以上全速、0.42 以下窄通道、中间线性', () => {
  // 开阔（24/25 ≥ 0.78）
  assert.equal(speedFactor(one, 300, 300), 1);

  // 密集：仅中心格可走 → 1/25 = 0.04 ≤ 0.42
  const dense = mkModel([
    [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1],
    [1, 1, 0, 1, 1],
    [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1],
  ]);
  assert.equal(clearanceRatio(dense, 500, 500, 2), 1 / 25);
  assert.equal(speedFactor(dense, 500, 500), WALK.narrow);

  // 中间：14/25 = 0.56 → 0.62 + 0.38*((0.56-0.42)/0.36)
  const mid = mkModel([
    [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 1],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ]);
  assert.equal(clearanceRatio(mid, 500, 500, 2), 14 / 25);
  const expected = WALK.narrow + (1 - WALK.narrow) * ((14 / 25 - 0.42) / (0.78 - 0.42));
  assert.ok(Math.abs(speedFactor(mid, 500, 500) - expected) < 1e-9);
});

test('joystickAxis：死区 0.12、边界夹取、死区外重映射', () => {
  assert.deepEqual(joystickAxis(0, 0, 44), { x: 0, y: 0, mag: 0, active: false });
  // 死区内
  assert.equal(joystickAxis(5, 0, 44).active, false);
  assert.equal(joystickAxis(0, -5, 44).mag, 0);
  // 满推 → (1,0)，屏幕 y 向上为正
  const full = joystickAxis(44, 0, 44);
  assert.equal(full.active, true);
  assert.ok(Math.abs(full.x - 1) < 1e-9);
  assert.ok(Math.abs(full.y) < 1e-9);
  assert.equal(full.mag, 1);
  const up = joystickAxis(0, -44, 44);
  assert.ok(Math.abs(up.y - 1) < 1e-9);
  // 半推 → 重映射 0.431818
  const half = joystickAxis(22, 0, 44);
  assert.ok(Math.abs(half.mag - (0.5 - 0.12) / 0.88) < 1e-9);
  assert.ok(Math.abs(half.x - (0.5 - 0.12) / 0.88) < 1e-9);
  // 超半径按圆边界夹取
  const over = joystickAxis(100, -100, 44);
  assert.ok(Math.abs(over.x - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(over.y - Math.SQRT1_2) < 1e-9);
  assert.equal(over.mag, 1);
});

test('walkDirection：yaw=0 面向北，输入归一', () => {
  const f = walkDirection(0, 1, 0);
  assert.ok(Math.abs(f.x) < 1e-12 && Math.abs(f.y - 1) < 1e-12);
  assert.equal(f.mag, 1);

  const right = walkDirection(0, 0, 1);
  assert.ok(Math.abs(right.x - 1) < 1e-12 && Math.abs(right.y) < 1e-12);

  const diag = walkDirection(0, 1, 1);
  assert.ok(Math.abs(diag.x - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(diag.y - Math.SQRT1_2) < 1e-12);
  assert.equal(diag.mag, 1);

  // yaw=-π/2 面向东（+x）
  const east = walkDirection(-Math.PI / 2, 1, 0);
  assert.ok(Math.abs(east.x - 1) < 1e-12);
  assert.ok(Math.abs(east.y) < 1e-12);

  // 非数值输入按 0 处理，半强度 mag=0.5
  const half = walkDirection(0, 0.5, 0);
  assert.equal(half.mag, 0.5);
  assert.deepEqual(walkDirection(0, NaN, undefined), { x: 0, y: 0, mag: 0 });
});

test('lookDelta：拖拽灵敏度与俯仰夹取', () => {
  const a = lookDelta(0, 0, 100, 0);
  assert.ok(Math.abs(a.yaw + 0.42) < 1e-9);
  assert.equal(a.pitch, 0);
  const b = lookDelta(0, 0, 0, 100);
  assert.ok(Math.abs(b.pitch + 0.42) < 1e-9);
  assert.ok(Math.abs(lookDelta(0, 1.0, 0, -100).pitch - WALK.pitchMax) < 1e-12);
  assert.ok(Math.abs(lookDelta(0, -1.0, 0, 100).pitch - WALK.pitchMin) < 1e-12);
  // 大角度回绕到 (-π, π]
  const wrapped = lookDelta(Math.PI - 0.01, 0, -100, 0);
  assert.ok(Math.abs(wrapped.yaw) <= Math.PI);
  assert.ok(wrapped.yaw < 0);
});

test('walkCameraPose / walkHint / speedText', () => {
  const p = walkCameraPose(4088, 24200);
  assert.equal(p.x, 4.088);
  assert.equal(p.y, 1.62);
  assert.equal(p.z, -24.2);
  assert.equal(walkCameraPose(1000, 0, 1.5, 0.01).y, 1.51);

  assert.match(walkHint(false), /^WASD \/ 方向键移动/);
  assert.match(walkHint(true), /^左侧摇杆移动/);
  assert.match(walkHint(true), /「切自动」回巡检/);

  assert.equal(speedText(1300), '1.3 m/s');
  assert.equal(speedText(0), '0.0 m/s');
  assert.equal(speedText(-5), '0.0 m/s');
  assert.equal(speedText(62 * 13), '0.8 m/s');
});
