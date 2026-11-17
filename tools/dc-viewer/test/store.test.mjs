/**
 * 设计器 store 单测：多选/批量操作/对齐等距/开洞 t/草稿/撤销。
 * store 是纯 JS（不引 three），node --test 直接跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, TOOL_DEFS, openingWidth, centerOf } from '../src/design/store.js';

/** 内存版 localStorage，避免测试依赖浏览器。 */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    size: () => map.size,
  };
}

function project(objects, name = '测试机房') {
  return { name, meta: { roomHeight: 3000, floorHeight: 400 }, objects };
}

const wall = (id = 'w1', x2 = 6000) => ({
  id, type: 'wall', x1: 0, y1: 0, x2, y2: 0, props: { thickness: 240, height: 3000, name: '墙-1' },
});

const cab = (id, x, y) => ({
  id, type: 'cabinet', x, y, rotation: 0, props: { w: 600, d: 1200, h: 2000, name: id },
});

function seeded() {
  const store = createStore({ storage: memoryStorage() });
  store.load(project([
    wall('w1'),
    cab('c1', 1000, 1000),
    cab('c2', 2000, 1500),
    cab('c3', 3000, 2500),
  ]), { id: 7, name: '测试机房' });
  return store;
}

test('构件库覆盖全部 15 类并且放置模式正确', () => {
  const modes = Object.fromEntries(TOOL_DEFS.map(def => [def.type, def.mode]));
  for (const type of ['door', 'window', 'grille']) assert.equal(modes[type], 'opening');
  for (const type of ['wall', 'tray', 'beam']) assert.equal(modes[type], 'line');
  for (const type of ['cabinet', 'column', 'aisle', 'vent', 'ac', 'pdu', 'ups', 'battery', 'extinguisher']) {
    assert.equal(modes[type], 'point');
  }
  assert.equal(TOOL_DEFS.length, 15);
});

test('多选：additive 追加/取消，批量移动与删除', () => {
  const store = seeded();
  store.select('c1');
  store.select('c2', { additive: true });
  assert.deepEqual(store.selection(), ['c1', 'c2']);

  store.translateMany(['c1', 'c2'], 100, -50);
  const moved = store.project().objects.filter(o => o.id === 'c1' || o.id === 'c2');
  assert.deepEqual(moved.map(o => [o.x, o.y]), [[1100, 950], [2100, 1450]]);

  store.select('c2', { additive: true });
  assert.deepEqual(store.selection(), ['c1']);

  store.removeMany(['c1']);
  assert.deepEqual(store.project().objects.map(o => o.id), ['w1', 'c2', 'c3']);
});

test('批量移动只占一次撤销', () => {
  const store = seeded();
  store.translateMany(['c1', 'c2', 'c3'], 200, 0);
  assert.equal(store.project().objects.filter(o => o.type === 'cabinet').every(o => o.x >= 1200), true);
  store.undo();
  assert.deepEqual(
    store.project().objects.filter(o => o.type === 'cabinet').map(o => o.x),
    [1000, 2000, 3000],
  );
});

test('duplicateMany 整体偏移 400 并选中副本', () => {
  const store = seeded();
  const copies = store.duplicateMany(['c1', 'c2']);
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.map(o => o.x), [1400, 2400]);
  assert.deepEqual(store.selection(), copies.map(o => o.id));
  assert.equal(store.project().objects.length, 6);
});

test('align：左/右/前/后对齐按包围盒边缘', () => {
  const cases = [
    ['minX', 'x', [1000, 1000, 1000]],
    ['maxX', 'x', [3000, 3000, 3000]],
    ['minY', 'y', [1000, 1000, 1000]],
    ['maxY', 'y', [2500, 2500, 2500]],
  ];
  for (const [kind, axis, expected] of cases) {
    const store = seeded();
    store.selectMany(['c1', 'c2', 'c3']);
    store.align(kind);
    assert.deepEqual(store.selectedObjects().map(o => o[axis]), expected, kind);
  }
});

test('distribute：首尾不动，中间等距', () => {
  const store = createStore({ storage: memoryStorage() });
  store.load(project([
    wall('w1'),
    cab('a', 0, 0),
    cab('b', 100, 0),
    cab('c', 1000, 0),
  ]));
  store.selectMany(['a', 'b', 'c']);
  store.distribute('x');
  const xs = store.selectedObjects().map(o => centerOf(o).x).sort((p, q) => p - q);
  assert.deepEqual(xs, [0, 500, 1000]);
});

test('distribute 在少于 3 个对象时不动', () => {
  const store = seeded();
  store.selectMany(['c1', 'c2']);
  const before = JSON.stringify(store.project());
  store.distribute('x');
  assert.equal(JSON.stringify(store.project()), before);
});

test('开洞：t 被夹到洞口不越界，墙太短返回 null', () => {
  const store = seeded();
  const door = store.addOpening('door', 'w1', 0.01);
  assert.ok(door);
  assert.equal(door.wallId, 'w1');
  assert.equal(door.t, 0.075); // 900 / 2 / 6000

  const high = store.addOpening('door', 'w1', 0.99);
  assert.equal(high.t, 0.925);

  const narrow = store.addOpening('window', 'nope', 0.5);
  assert.equal(narrow, null);

  store.load(project([wall('short', 500), cab('c1', 0, 0)]));
  assert.equal(store.addOpening('door', 'short', 0.5), null);
});

test('开洞宽度默认值：门 900、窗 1200', () => {
  assert.equal(openingWidth({ type: 'door', props: {} }), 900);
  assert.equal(openingWidth({ type: 'window', props: {} }), 1200);
  assert.equal(openingWidth({ type: 'grille', props: { width: 800 } }), 800);
});

test('删墙连带删掉挂在墙上的门窗，避免悬空引用', () => {
  const store = seeded();
  const door = store.addOpening('door', 'w1', 0.5);
  store.removeMany(['w1']);
  assert.equal(store.project().objects.some(o => o.id === door.id), false);
});

test('手势：拖动开洞合成一次撤销', () => {
  const store = seeded();
  const door = store.addOpening('door', 'w1', 0.5);
  const undoDepth = store.project().objects.length;
  store.beginGesture();
  store.setOpeningT(door.id, 0.3);
  store.setOpeningT(door.id, 0.4);
  store.endGesture('model', { ids: [door.id], structural: false, wallIds: ['w1'] });
  assert.equal(store.project().objects.find(o => o.id === door.id).t, 0.4);
  store.undo();
  assert.equal(store.project().objects.find(o => o.id === door.id).t, 0.5);
  assert.equal(store.project().objects.length, undoDepth);
});

test('草稿：写入/读取/保存后清空', () => {
  const storage = memoryStorage();
  const store = createStore({ storage });
  store.load(project([wall('w1'), cab('c1', 0, 0)]), { id: 42, name: '草稿房' });
  assert.equal(store.draftKey(), 'dc-designer:draft:v1:42');
  store.translateMany(['c1'], 300, 0);
  assert.equal(store.writeDraft(), true);
  const draft = store.readDraft();
  assert.equal(draft.project.objects.find(o => o.id === 'c1').x, 300);
  assert.ok(draft.savedAt);
  store.markSaved({ id: 42, name: '草稿房' });
  assert.equal(store.readDraft(), null);
});

test('草稿：新建项目在保存后键从 new 切到 id 并清空', () => {
  const storage = memoryStorage();
  const store = createStore({ storage });
  store.newProject({ name: '新机房', width: 12000, depth: 8000, height: 3000, floorHeight: 400 });
  store.writeDraft();
  assert.ok(storage.getItem('dc-designer:draft:v1:new'));
  store.markSaved({ id: 9, name: '新机房' });
  assert.equal(storage.getItem('dc-designer:draft:v1:new'), null);
  assert.equal(storage.getItem('dc-designer:draft:v1:9'), null);
});

test('800 对象草稿 JSON round-trip 后对象数不变', () => {
  const objects = [wall('w1')];
  for (let i = 0; i < 800; i += 1) objects.push(cab(`c${i}`, i * 700, 1000));
  const store = createStore({ storage: memoryStorage() });
  store.load(project(objects));
  store.writeDraft();
  const draft = store.readDraft();
  assert.equal(draft.project.objects.length, 801);
  assert.equal(store.stats().counts.cabinet, 800);
  assert.deepEqual(store.toJSON().objects.length, 801);
});

test('撤销/重做保留选择有效性', () => {
  const store = seeded();
  store.select('c3');
  store.removeMany(['c3']);
  assert.deepEqual(store.selection(), []);
  assert.equal(store.canUndo(), true);
  store.undo();
  assert.equal(store.project().objects.some(o => o.id === 'c3'), true);
  store.redo();
  assert.equal(store.project().objects.some(o => o.id === 'c3'), false);
});

test('commit 携带增量重建信息：点对象非结构、开洞带 wallIds', () => {
  const store = seeded();
  const events = [];
  store.subscribe((reason, detail) => events.push({ reason, detail }));
  store.select('c1');
  store.updateObject('c1', { x: 1200 }, {});
  assert.equal(events.at(-1).detail.structural, false);
  assert.deepEqual(events.at(-1).detail.ids, ['c1']);

  const door = store.addOpening('door', 'w1', 0.5);
  const lastModel = () => [...events].reverse().find(event => event.reason === 'model').detail;
  assert.deepEqual(lastModel().wallIds, ['w1']);
  store.updateObject('w1', { x2: 7000 }, {});
  assert.equal(lastModel().structural, true);
  assert.ok(door);
});

test('横梁端点可写 col1/col2，并可只留坐标', () => {
  const store = seeded();
  const column = store.addPoint('column', 500, 500);
  const beam = store.addLine('beam', 500, 500, 2500, 500, column ? { col1: column.id } : {});
  assert.equal(beam.type, 'beam');
  assert.equal(beam.col1, column.id);
  assert.equal(beam.x2, 2500);
  const free = store.addLine('beam', 0, 0, 2000, 0);
  assert.equal(free.col1, undefined);
});
