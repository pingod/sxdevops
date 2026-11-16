import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DIFF_ORDER, DIFF_META, PLACEMENT_KEYS, objectName, objectSummary, placementOf,
  placementChanges, deepEqual, propertyChanges, indexObjects, isVisibleKind,
  visibleKinds, compareProjects, summarizeDiff,
} from '../src/features/compareplan.js';

const read = name => JSON.parse(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url), 'utf8'));
const a = read('room.json');
const b = read('room-b.json');

test('compare: 常量与摘要', () => {
  assert.deepEqual(DIFF_ORDER, ['added', 'removed', 'moved', 'changed']);
  assert.equal(DIFF_META.added.label, '新增');
  assert.equal(DIFF_META.moved.color, '#f59e0b');
  assert.equal(DIFF_META.same.hint, '未变化');
  assert.deepEqual(PLACEMENT_KEYS, ['x', 'y', 'rotation', 'x1', 'y1', 'x2', 'y2', 't', 'wallId']);
  assert.equal(objectName({ id: 'x', props: { name: ' A01 ' } }), ' A01 ');
  assert.equal(objectName({ id: 'x' }), 'x');
  assert.deepEqual(objectSummary({ id: 1, type: 'cabinet', props: { name: 'A01' } }), {
    id: '1', type: 'cabinet', name: 'A01',
  });
  assert.deepEqual(placementOf({}), { x: 0, y: 0, rotation: 0, x1: 0, y1: 0, x2: 0, y2: 0, t: 0, wallId: null });
});

test('compare: 位置/属性容差 0.5mm', () => {
  assert.deepEqual(placementChanges({ x: 0 }, { x: 0.5 }), []);
  assert.deepEqual(placementChanges({ x: 0 }, { x: 0.6 }), ['x']);
  assert.deepEqual(placementChanges({ wallId: 'w1' }, { wallId: 'w2' }), ['wallId']);
  assert.equal(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1.4 }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1.6 }), false);
  assert.deepEqual(propertyChanges({ props: { name: 'A' } }, { props: { name: 'B' } }), [
    { field: 'props.name', from: 'A', to: 'B' },
  ]);
});

test('compare: 索引重复 id 保留第一个', () => {
  const idx = indexObjects({ objects: [{ id: 'a', v: 1 }, { id: 'a', v: 2 }, { id: 'b' }] });
  assert.equal(idx.count, 2);
  assert.equal(idx.rawCount, 3);
  assert.deepEqual(idx.duplicateIds, ['a']);
  assert.equal(idx.map.get('a').v, 1);
});

test('compare: room.json vs room-b.json 计数为 新增1/删除1/移动1/属性1', () => {
  const diff = compareProjects(a, b);
  assert.deepEqual(diff.counts, {
    added: 1, removed: 1, moved: 1, changed: 1, same: 220, total: 224,
  });
  assert.equal(diff.items.length, 224);
  assert.equal(diff.changes.length, 4);
  assert.equal(diff.a.count, 223);
  assert.equal(diff.b.count, 223);
  assert.equal(diff.eps, 0.5);

  const removed = diff.items.find(i => i.id === a.objects.find(o => o.props && o.props.name === 'A03').id);
  assert.equal(removed.kind, 'removed');
  assert.equal(removed.b, null);

  const added = diff.items.find(i => i.id === 'omtfd30oi9zz');
  assert.equal(added.kind, 'added');
  assert.equal(added.a, null);
  assert.equal(added.name, 'H20');

  const a01 = diff.items.find(i => i.name === 'A01');
  assert.equal(a01.kind, 'changed');
  assert.deepEqual(a01.changes, [{ field: 'props.color', from: '#2e9e6e', to: '#2e6e9e' }]);

  const a02 = diff.items.find(i => i.name === 'A02');
  assert.equal(a02.kind, 'moved');
  assert.deepEqual(a02.changes, [{ field: 'x', from: 3200, to: 3260 }]);

  assert.equal(diff.get(a01.id), a01);
  assert.equal(diff.get('missing'), null);
  assert.deepEqual(diff.duplicateIds, []);
});

test('compare: 侧别可见类型与摘要文案', () => {
  assert.equal(isVisibleKind('a', 'removed'), true);
  assert.equal(isVisibleKind('a', 'added'), false);
  assert.equal(isVisibleKind('b', 'added'), true);
  assert.equal(isVisibleKind('b', 'removed'), false);
  assert.equal(isVisibleKind('a', 'same'), false);
  assert.deepEqual(visibleKinds('a'), ['removed', 'moved', 'changed']);
  assert.deepEqual(visibleKinds('b'), ['added', 'moved', 'changed']);

  const diff = compareProjects(a, b);
  assert.equal(summarizeDiff(diff), '新增 1 · 删除 1 · 移动 1 · 属性 1 · 相同 220');
  assert.equal(summarizeDiff(null), '新增 0 · 删除 0 · 移动 0 · 属性 0 · 相同 0');
});

test('compare: 完全相同项目全部 same', () => {
  const diff = compareProjects(a, a);
  assert.deepEqual(diff.counts, {
    added: 0, removed: 0, moved: 0, changed: 0, same: 223, total: 223,
  });
  assert.deepEqual(diff.changes, []);
  assert.equal(summarizeDiff(diff), '新增 0 · 删除 0 · 移动 0 · 属性 0 · 相同 223');
});
