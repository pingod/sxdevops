import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPE_GROUPS, TYPE_ORDER, TYPE_GROUP_BY_ID, ALWAYS_VISIBLE_TYPES,
  DEVICE_GROUPS, ENVELOPE_GROUPS, TOP_GROUPS,
  TYPE_PRESETS, PRESET_IDS, ALL_PRESET, CUSTOM_PRESET,
  categoryOf, categoryLabel, buildTypeCatalog, availableGroups,
  normalizeHidden, parseHiddenParam, serializeHidden,
  isHiddenGroup, isTypeHidden, hiddenTypes,
  presetHidden, matchPreset, presetLabel, typeVisPlan, summarizeTypeVis,
} from '../src/data/typeplan.js';

test('TYPE_ORDER 稳定且前后端 id 顺序一致', () => {
  assert.deepEqual(TYPE_ORDER, [
    'cabinet', 'power', 'cooling', 'safety', 'aisle',
    'tray', 'structure', 'wall', 'ceiling', 'other',
  ]);
  assert.deepEqual(TYPE_GROUPS.map(g => g.id), [...TYPE_ORDER]);
  assert.deepEqual(PRESET_IDS, ['all', 'devices', 'envelope', 'no-top']);
  assert.equal(TYPE_GROUP_BY_ID.power.label, '配电');
  // 冻结结构不可变
  assert.ok(Object.isFrozen(TYPE_GROUPS));
  assert.ok(Object.isFrozen(TYPE_ORDER));
});

test('categoryOf：floor/__floor 永远不参与，类型映射正确', () => {
  assert.equal(categoryOf('floor'), null);
  assert.equal(categoryOf('__floor'), null);
  assert.equal(categoryOf(''), null);
  assert.equal(categoryOf(null), null);
  assert.equal(categoryOf('cabinet'), 'cabinet');
  assert.equal(categoryOf('pdu'), 'power');
  assert.equal(categoryOf('ups'), 'power');
  assert.equal(categoryOf('battery'), 'power');
  assert.equal(categoryOf('ac'), 'cooling');
  assert.equal(categoryOf('vent'), 'cooling');
  assert.equal(categoryOf('extinguisher'), 'safety');
  assert.equal(categoryOf('aisle'), 'aisle');
  assert.equal(categoryOf('tray'), 'tray');
  assert.equal(categoryOf('column'), 'structure');
  assert.equal(categoryOf('beam'), 'structure');
  for (const t of ['wall', 'door', 'window', 'grille']) assert.equal(categoryOf(t), 'wall');
  assert.equal(categoryOf('ceiling'), 'ceiling');
  // 场景里派生吊顶分组的 type 是 'ceiling'；'__ceiling' 只是分组 id
  assert.equal(categoryOf('__ceiling'), 'other');
  assert.equal(categoryOf('hologram'), 'other');
  // 大小写/空格容错
  assert.equal(categoryOf('  UPS '), 'power');
  // 只读
  assert.deepEqual(ALWAYS_VISIBLE_TYPES, ['floor', '__floor']);
});

test('buildTypeCatalog：按对象统计、忽略 floor、顺序固定', () => {
  const objects = [
    { type: 'cabinet' }, { type: 'cabinet' }, { type: 'pdu' },
    { type: 'ac' }, { type: 'wall' }, { type: 'door' },
    { type: 'floor' }, null, {}, { type: 'mystery' },
  ];
  const cat = buildTypeCatalog(objects);
  assert.equal(cat.total, 7); // floor/null/无类型不计
  assert.deepEqual(cat.available, ['cabinet', 'power', 'cooling', 'wall', 'other']);
  assert.equal(cat.counts.cabinet, 2);
  assert.equal(cat.counts.wall, 2); // wall + door
  assert.equal(cat.counts.power, 1);
  assert.equal(cat.items.find(i => i.id === 'wall').types.length, 4);
  assert.deepEqual(cat.items.find(i => i.id === 'wall').typeCounts, { wall: 1, door: 1 });
  assert.deepEqual(availableGroups(cat), ['cabinet', 'power', 'cooling', 'wall', 'other']);
  // 无 catalog 时返回全部顺序
  assert.deepEqual(availableGroups(null), [...TYPE_ORDER]);
});

test('buildTypeCatalog：sceneTypes 支持派生吊顶且门窗不重复计数', () => {
  const cat = buildTypeCatalog([], { sceneTypes: ['cabinet', 'wall', 'ceiling', '__floor'] });
  assert.equal(cat.total, 3);
  assert.deepEqual(cat.available, ['cabinet', 'wall', 'ceiling']);
  assert.equal(cat.counts.ceiling, 1);
});

test('normalizeHidden：字符串/数组/Set 均可，去重并按 TYPE_ORDER 排序', () => {
  assert.deepEqual(normalizeHidden('tray, ceiling cabinet,tray,floor,junk'), ['cabinet', 'tray', 'ceiling']);
  assert.deepEqual(normalizeHidden(['tray', 'cabinet', 'tray']), ['cabinet', 'tray']);
  assert.deepEqual(normalizeHidden(new Set(['ceiling', 'power'])), ['power', 'ceiling']);
  assert.deepEqual(normalizeHidden(''), []);
  assert.deepEqual(normalizeHidden(null), []);
  // 未知 / floor 永远丢弃
  assert.deepEqual(normalizeHidden('floor __floor nope'), []);
});

test('parseHiddenParam：有效分类 + 未知 token', () => {
  const p = parseHiddenParam('tray,ceiling,cabinet,floor,junk,tray');
  assert.deepEqual(p.hidden, ['cabinet', 'tray', 'ceiling']);
  assert.deepEqual(p.unknown, ['floor', 'junk']);
  assert.deepEqual(parseHiddenParam(null), { hidden: [], unknown: [] });
});

test('serializeHidden / isHiddenGroup / isTypeHidden / hiddenTypes', () => {
  assert.equal(serializeHidden(['ceiling', 'tray']), 'tray,ceiling');
  assert.equal(serializeHidden([]), '');
  assert.equal(isHiddenGroup(['tray'], 'TRAY'), true);
  assert.equal(isHiddenGroup(['tray'], 'cabinet'), false);

  assert.equal(isTypeHidden('cabinet', ['cabinet']), true);
  assert.equal(isTypeHidden('pdu', ['power']), true);
  assert.equal(isTypeHidden('door', ['wall']), true);
  // 地板永远可见
  assert.equal(isTypeHidden('floor', ['cabinet', 'wall']), false);
  assert.equal(isTypeHidden('__floor', ['cabinet']), false);

  assert.deepEqual(hiddenTypes(['power', 'wall']), ['pdu', 'ups', 'battery', 'wall', 'door', 'window', 'grille']);
  assert.deepEqual(hiddenTypes(['other']), []); // other 不展开
});

test('presetHidden / matchPreset / presetLabel（按项目实际分类）', () => {
  const cat = buildTypeCatalog([
    { type: 'cabinet' }, { type: 'pdu' }, { type: 'ac' },
    { type: 'wall' }, { type: 'column' }, { type: 'ceiling' }, { type: 'tray' },
  ]);
  assert.deepEqual(presetHidden('all', cat), []);
  assert.deepEqual(presetHidden('devices', cat), ['tray', 'structure', 'wall', 'ceiling']);
  assert.deepEqual(presetHidden('envelope', cat), ['cabinet', 'power', 'cooling', 'tray']);
  assert.deepEqual(presetHidden('no-top', cat), ['tray', 'ceiling']);

  assert.equal(matchPreset(presetHidden('no-top', cat), cat), 'no-top');
  assert.equal(matchPreset([], cat), 'all');
  assert.equal(matchPreset(['tray'], cat), CUSTOM_PRESET);
  assert.equal(matchPreset(['cabinet'], cat), CUSTOM_PRESET);

  assert.equal(presetLabel('devices'), '只看设备');
  assert.equal(presetLabel(CUSTOM_PRESET), '自定义');
  assert.equal(presetLabel('nope'), '全部显示');
  assert.deepEqual(DEVICE_GROUPS, ['cabinet', 'power', 'cooling', 'safety']);
  assert.deepEqual(ENVELOPE_GROUPS, ['wall', 'structure', 'ceiling']);
  assert.deepEqual(TOP_GROUPS, ['ceiling', 'tray']);
  assert.equal(ALL_PRESET, 'all');
});

test('typeVisPlan / summarizeTypeVis：摘要与计数', () => {
  const cat = buildTypeCatalog([
    { type: 'cabinet' }, { type: 'pdu' }, { type: 'aisle' }, { type: 'wall' },
    { type: 'column' }, { type: 'tray' }, { type: 'ceiling' }, { type: 'ceiling' },
  ]);
  const empty = typeVisPlan(cat, []);
  assert.equal(empty.active, false);
  assert.equal(empty.label, '全部显示');
  assert.equal(empty.preset, 'all');
  assert.equal(empty.counts.totalCategories, 7);
  assert.equal(empty.counts.totalObjects, 8);
  assert.equal(summarizeTypeVis(empty), '全部分类显示');

  const plan = typeVisPlan(cat, 'ceiling,tray');
  assert.equal(plan.active, true);
  assert.deepEqual(plan.hidden, ['tray', 'ceiling']);
  assert.deepEqual(plan.hiddenTypes, ['tray', 'ceiling']);
  assert.equal(plan.preset, 'no-top');
  assert.equal(plan.presetLabel, '隐藏顶架');
  assert.equal(plan.label, '已隐藏 桥架、吊顶 · 3 个对象');
  assert.equal(plan.counts.hiddenCategories, 2);
  assert.equal(plan.counts.hiddenObjects, 3);
  assert.deepEqual(plan.items.filter(i => i.hidden).map(i => i.id), ['tray', 'ceiling']);
  assert.equal(summarizeTypeVis(plan), '已隐藏：桥架、吊顶');
});

test('typeVisPlan：无 catalog 时回退全部分类，不崩溃', () => {
  const plan = typeVisPlan(null, ['wall']);
  assert.equal(plan.items.length, TYPE_ORDER.length);
  assert.deepEqual(plan.items.map(i => i.id), [...TYPE_ORDER]);
  assert.equal(plan.items.find(i => i.id === 'wall').label, '围护');
  assert.equal(plan.hidden.join(','), 'wall');
});
