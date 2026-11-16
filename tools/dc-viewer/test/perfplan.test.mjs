import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERF, isNum, percentile, mean, round1, summarizeSamples, resourceDelta,
  fpsAcceptable, buildAcceptable, normalizeBench,
} from '../src/features/perfplan.js';

test('perf: 常量与数值工具', () => {
  assert.equal(PERF.window, 120);
  assert.equal(PERF.bench.maxFrames, 600);
  assert.equal(PERF.budgets.desktopMinFps, 24);
  assert.equal(PERF.budgets.mobileMinFps, 15);
  assert.equal(PERF.budgets.relativeFps, 0.55);
  assert.equal(isNum(1), true);
  assert.equal(isNum(NaN), false);
  assert.equal(isNum(Infinity), false);
  assert.equal(isNum('1'), false);
  assert.equal(round1(1.24), 1.2);
  assert.equal(round1(1.25), 1.3);
  assert.equal(round1('x'), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([1, NaN, 3]), 2);
  assert.equal(mean([]), 0);
});

test('perf: percentile 线性插值', () => {
  assert.equal(percentile([], .5), 0);
  assert.equal(percentile([4, 1, 3, 2], 0), 1);
  assert.equal(percentile([4, 1, 3, 2], .5), 2.5);
  assert.ok(Math.abs(percentile([4, 1, 3, 2], .95) - 3.85) < 1e-9);
  assert.equal(percentile([4, 1, 3, 2], 1), 4);
  assert.equal(percentile([1, 2, 3], -1), 1);
  assert.equal(percentile([1, 2, 3], 2), 3);
  assert.equal(percentile([1, 2, 3], NaN), 1);
});

test('perf: summarizeSamples 帧时/渲染耗时汇总', () => {
  const s = summarizeSamples([16, 16, 16, 16], [4, 6, 8, 10]);
  assert.equal(s.samples, 4);
  assert.equal(s.seconds, 0.1);
  assert.equal(s.fps, 62.5);
  assert.equal(s.fpsLow, 62.5);
  assert.deepEqual(s.frameMs, { avg: 16, p50: 16, p95: 16, max: 16 });
  assert.deepEqual(s.renderMs, { avg: 7, p50: 7, p95: 9.7, max: 10 });

  const mixed = summarizeSamples([10, 20, 0, -5, 6000, NaN], [1, 2, 3]);
  assert.equal(mixed.samples, 2);
  assert.equal(mixed.seconds, 0);
  assert.equal(mixed.fps, 66.7);
  assert.equal(mixed.fpsLow, 51.3);
  assert.deepEqual(mixed.frameMs, { avg: 15, p50: 15, p95: 19.5, max: 20 });
  assert.equal(mixed.renderMs.avg, 2);

  assert.equal(summarizeSamples([], []).samples, 0);
  assert.equal(summarizeSamples([], []).fps, 0);
});

test('perf: summarizeSamples 只保留最近窗口', () => {
  const dts = Array.from({ length: 130 }, () => 10);
  dts[0] = 100;
  dts[129] = 20;
  const s = summarizeSamples(dts, [], { window: 120 });
  assert.equal(s.samples, 120);
  assert.equal(s.frameMs.max, 20);
  assert.equal(s.frameMs.avg, 10.1);
});

test('perf: resourceDelta 判定泄漏', () => {
  const clean = resourceDelta({ meshes: 10, textures: 3 }, { meshes: 10, textures: 3 });
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.delta, { meshes: 0, textures: 0 });
  assert.deepEqual(clean.grew, []);
  assert.deepEqual(clean.missing, []);

  const leak = resourceDelta({ meshes: 10, geometries: 5 }, { meshes: 12, geometries: 5, textures: 1 });
  assert.equal(leak.clean, false);
  assert.deepEqual(leak.delta, { geometries: 0, meshes: 2 });
  assert.deepEqual(leak.grew, ['meshes+2']);
  assert.deepEqual(leak.missing, ['textures']);
});

test('perf: fpsAcceptable / buildAcceptable', () => {
  const ok = { samples: 60, fps: 60, renderMs: { avg: 10 } };
  assert.equal(fpsAcceptable(ok), true);
  assert.equal(fpsAcceptable({ ...ok, samples: 5 }), false);
  assert.equal(fpsAcceptable({ ...ok, fps: 20 }), false);
  assert.equal(fpsAcceptable({ ...ok, fps: 20 }, { mobile: true }), true);
  assert.equal(fpsAcceptable({ ...ok, renderMs: { avg: 50 } }), false);
  assert.equal(fpsAcceptable({ ...ok, fps: 30 }, { baselineFps: 60 }), false);
  assert.equal(fpsAcceptable(null), false);

  assert.equal(buildAcceptable(1200), true);
  assert.equal(buildAcceptable(0), false);
  assert.equal(buildAcceptable(-1), false);
  assert.equal(buildAcceptable(Infinity), false);
  assert.equal(buildAcceptable(20000), false);
  assert.equal(buildAcceptable(2000, 1500), false);
});

test('perf: normalizeBench 夹取 10..600 / 0..30', () => {
  assert.deepEqual(normalizeBench(), { frames: 60, warmup: 10, label: 'bench' });
  assert.deepEqual(normalizeBench({ frames: 5, warmup: -3 }), { frames: 10, warmup: 0, label: 'bench' });
  assert.deepEqual(normalizeBench({ frames: 900, warmup: 99 }), { frames: 600, warmup: 30, label: 'bench' });
  assert.deepEqual(normalizeBench({ frames: 120.6, warmup: 4.4, label: 'x'.repeat(50) }), {
    frames: 121, warmup: 4, label: 'x'.repeat(40),
  });
  assert.deepEqual(normalizeBench({ frames: NaN, warmup: 'x', label: 3 }), {
    frames: 60, warmup: 10, label: 'bench',
  });
});
