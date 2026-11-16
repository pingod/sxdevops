import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, beamEnds } from '../src/data/sanitize.js';
import { cabPaint, normalizeCabColor, hexLuminance } from '../src/data/color.js';

test('sanitize: 缺 objects 抛错', () => {
  assert.throws(() => sanitize({}), /缺少 objects 数组/);
  assert.throws(() => sanitize(null), /缺少 objects 数组/);
});

test('sanitize: 丢弃缺 id/type 的对象', () => {
  const p = sanitize({ objects: [{ id: 'a', type: 'cabinet' }, { id: 'b' }, { type: 'ac' }, null] });
  assert.deepEqual(p.objects.map(o => o.id), ['a']);
  assert.deepEqual(p.objects[0].props, {});
  assert.equal(p.name, '');
  assert.deepEqual(p.meta, { surveyor: '', date: '' });
});

test('sanitize: 数值字段转型并夹非负（温度可为负）', () => {
  const p = sanitize({
    objects: [{
      id: 'c', type: 'cabinet', x: '1200', y: 'abc', rotation: '90',
      props: { w: '600', h: '-200', temp: '-5', returnTemp: '-3', kg: '-1' },
    }],
  });
  const o = p.objects[0];
  assert.equal(o.x, 1200);
  assert.equal(o.y, 0);
  assert.equal(o.rotation, 90);
  assert.equal(o.props.w, 600);
  assert.equal(o.props.h, 0);
  assert.equal(o.props.temp, -5);
  assert.equal(o.props.returnTemp, -3);
  assert.equal(o.props.kg, 0);
});

test('sanitize: 门窗格栅随墙剔除', () => {
  const p = sanitize({
    objects: [
      { id: 'w1', type: 'wall', x1: 0, y1: 0, x2: 1000, y2: 0 },
      { id: 'd1', type: 'door', wallId: 'w1', t: 0.5, props: {} },
      { id: 'd2', type: 'door', wallId: 'gone', t: 0.5, props: {} },
      { id: 'g1', type: 'grille', wallId: 'gone' },
      { id: 'n1', type: 'window', wallId: 'w1' },
    ],
  });
  assert.deepEqual(p.objects.map(o => o.id), ['w1', 'd1', 'n1']);
});

test('sanitize: 门 side 旧值迁移与 acType 迁移', () => {
  const p = sanitize({
    objects: [
      { id: 'd1', type: 'door', wallId: 'w', props: { side: 'left' } },
      { id: 'd2', type: 'door', wallId: 'w', props: { side: 'right' } },
      { id: 'a1', type: 'ac', props: { acType: '风墙末端' } },
      { id: 'w', type: 'wall' },
    ],
  });
  const by = Object.fromEntries(p.objects.map(o => [o.id, o]));
  assert.equal(by.d1.props.side, 'out');
  assert.equal(by.d2.props.side, 'in');
  assert.equal(by.a1.props.acType, '远端风墙空调');
});

test('sanitize: 非法机柜颜色删除，合法值规范化', () => {
  const p = sanitize({
    objects: [
      { id: 'a', type: 'cabinet', props: { color: '#ABC' } },
      { id: 'b', type: 'cabinet', props: { color: 'red' } },
      { id: 'c', type: 'cabinet', props: { color: 'aabbcc' } },
    ],
  });
  const by = Object.fromEntries(p.objects.map(o => [o.id, o]));
  assert.equal(by.a.props.color, '#aabbcc');
  assert.equal('color' in by.b.props, false);
  assert.equal(by.c.props.color, '#aabbcc');
});

test('color: 规范化与亮度边界', () => {
  assert.equal(normalizeCabColor(' #FFF '), '#ffffff');
  assert.equal(normalizeCabColor('#12345'), '');
  assert.equal(normalizeCabColor(123), '');
  assert.ok(hexLuminance('#ffffff') > 0.99);
  assert.ok(hexLuminance('#000000') < 0.01);
});

test('color: cabPaint 明暗派生与对比文字', () => {
  const dark = cabPaint('#0931fb');
  assert.equal(dark.custom, true);
  assert.equal(dark.body, '#0931fb');
  assert.notEqual(dark.front, dark.body);
  assert.equal(hexLuminance(dark.front) > hexLuminance(dark.body), true);
  const light = cabPaint('#e8edf4');
  assert.equal(hexLuminance(light.front) < hexLuminance(light.body), true);
  const plain = cabPaint('');
  assert.equal(plain.custom, false);
  assert.equal(plain.body, '#e8edf4');
});

test('beamEnds: 附着柱心优先，失效回退存储坐标', () => {
  const cols = { c1: { x: 100, y: 200 }, c2: { x: 900, y: 200 } };
  const e = beamEnds({ x1: 0, y1: 0, x2: 1, y2: 1, col1: 'c1', col2: 'c2' }, id => cols[id] || null);
  assert.deepEqual([e.x1, e.y1, e.x2, e.y2], [100, 200, 900, 200]);
  const f = beamEnds({ x1: 5, y1: 6, x2: 7, y2: 8, col1: 'x', col2: 'c2' }, id => cols[id] || null);
  assert.deepEqual([f.x1, f.y1, f.x2, f.y2], [5, 6, 900, 200]);
});
