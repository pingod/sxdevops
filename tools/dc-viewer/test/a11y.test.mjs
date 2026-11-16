import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A11Y, parseHex, srgbLuminance, contrastRatio, meetsContrast,
  prefersReducedMotion, motionDuration,
} from '../src/data/a11y.js';

test('parseHex: #rgb / #rrggbb 与非法输入', () => {
  assert.deepEqual(parseHex('#abc'), { r: 170, g: 187, b: 204 });
  assert.deepEqual(parseHex('#aabbcc'), { r: 170, g: 187, b: 204 });
  assert.deepEqual(parseHex('  #0f8f77 '), { r: 15, g: 143, b: 119 });
  assert.deepEqual(parseHex('#FFF'), { r: 255, g: 255, b: 255 });
  assert.equal(parseHex('#abcd'), null);
  assert.equal(parseHex('abc'), null);
  assert.equal(parseHex(''), null);
  assert.equal(parseHex(null), null);
  assert.equal(parseHex(123), null);
});

test('srgbLuminance: 黑白两端与中间值单调', () => {
  assert.equal(srgbLuminance('#000000'), 0);
  assert.equal(srgbLuminance('#ffffff'), 1);
  assert.equal(srgbLuminance('nonsense'), 0);
  const red = srgbLuminance('#ff0000');
  const green = srgbLuminance('#00ff00');
  const blue = srgbLuminance('#0000ff');
  assert.ok(red > 0 && red < 1);
  assert.ok(green > red && red > blue); // 权重 0.7152 > 0.2126 > 0.0722
});

test('contrastRatio: 已知比值（对白）', () => {
  // 焦点环 #0f8f77 对白：4.03:1
  assert.ok(Math.abs(contrastRatio('#0f8f77', '#ffffff') - 4.03) < 0.01);
  // 选中柜号标签 #007c92 + 白字：4.89:1
  assert.ok(Math.abs(contrastRatio('#007c92', '#ffffff') - 4.89) < 0.01);
  // 浅色弱化文字 #5d6d7e 对白：5.31:1
  assert.ok(Math.abs(contrastRatio('#5d6d7e', '#ffffff') - 5.31) < 0.01);
  // 深色 HUD 焦点环 #1abc9c 对 #16222e：6.69:1
  assert.ok(Math.abs(contrastRatio('#1abc9c', '#16222e') - 6.69) < 0.01);
  // 状态文字 #64748b 对白：4.76:1
  assert.ok(Math.abs(contrastRatio('#64748b', '#ffffff') - 4.76) < 0.01);
  // 对称性与黑白极值
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  assert.equal(contrastRatio('#000000', '#000000'), 1);
});

test('contrastRatio: 非法颜色按黑色处理，返回有限值', () => {
  const r = contrastRatio('bad', '#ffffff');
  assert.equal(Number.isFinite(r), true);
  assert.equal(r, 21);
});

test('meetsContrast: 阈值与容差', () => {
  assert.equal(meetsContrast('#0f8f77', '#ffffff', 3), true); // 非文本 3:1
  assert.equal(meetsContrast('#0f8f77', '#ffffff', 4.5), false);
  assert.equal(meetsContrast('#007c92', '#ffffff'), true); // 默认 4.5
  assert.equal(meetsContrast('#5d6d7e', '#ffffff'), true);
  assert.equal(meetsContrast('#64748b', '#ffffff'), true);
  assert.equal(meetsContrast('#aaaaaa', '#ffffff', 4.5), false);
});

test('A11Y: 常量与文档值一致', () => {
  assert.equal(A11Y.focusOnLight, '#0f8f77');
  assert.equal(A11Y.focusOnDark, '#1abc9c');
  assert.equal(A11Y.selectedLabelBg, '#007c92');
  assert.equal(A11Y.selectedLabelFg, '#ffffff');
  assert.equal(A11Y.mutedOnLight, '#5d6d7e');
  assert.equal(A11Y.subtleOnLight, '#64748b');
  assert.equal(A11Y.touchTarget, 44);
  assert.deepEqual({ ...A11Y }, {
    focusOnLight: '#0f8f77',
    focusOnDark: '#1abc9c',
    selectedLabelBg: '#007c92',
    selectedLabelFg: '#ffffff',
    mutedOnLight: '#5d6d7e',
    subtleOnLight: '#64748b',
    labelFg: '#2c3e50',
    labelBg: '#ffffff',
    rowFg: '#14544a',
    rowBg: '#ffffff',
    touchTarget: 44,
  });
});

test('prefersReducedMotion: 读取 matchMedia，无 window 视为 false', () => {
  const reduced = { matchMedia: q => ({ matches: q === '(prefers-reduced-motion: reduce)' }) };
  assert.equal(prefersReducedMotion(reduced), true);
  const normal = { matchMedia: () => ({ matches: false }) };
  assert.equal(prefersReducedMotion(normal), false);
  assert.equal(prefersReducedMotion(null), false);
  assert.equal(prefersReducedMotion({}), false);
  assert.equal(prefersReducedMotion({ matchMedia: 'nope' }), false);
});

test('motionDuration: 减少动效时压到 0', () => {
  assert.equal(motionDuration(0.75, true), 0);
  assert.equal(motionDuration(0.75, false), 0.75);
  assert.equal(motionDuration(0, false), 0);
  assert.equal(motionDuration(-1, false), 0);
  assert.equal(motionDuration('abc', false), 0);
  assert.equal(motionDuration('1.5', false), 1.5);
  assert.equal(motionDuration(Infinity, false), 0);
});
