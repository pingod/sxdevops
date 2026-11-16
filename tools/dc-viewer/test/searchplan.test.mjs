import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SEARCH, SEARCH_SCORE, normalizeSearchQuery, typeLabelOf, buildSearchIndex,
  normalizeLimit, searchIndex, searchObjects, matchSegments, searchStatus, resultHint,
} from '../src/features/searchplan.js';

const room = JSON.parse(fs.readFileSync(new URL('../public/samples/room.json', import.meta.url), 'utf8'));

test('search: 常量与查询归一化', () => {
  assert.equal(SEARCH.limit, 10);
  assert.deepEqual(SEARCH_SCORE, { nameExact: 1000, idExact: 950, namePrefix: 800, idPrefix: 750 });
  assert.equal(normalizeSearchQuery('  A01  '), 'A01');
  assert.equal(normalizeSearchQuery(''), '');
  assert.equal(normalizeSearchQuery(null), '');
  assert.equal(normalizeSearchQuery('A01\u0001'), '');
  assert.equal(normalizeSearchQuery('A01\u007f'), '');
  assert.equal(normalizeSearchQuery('x'.repeat(161)), '');
  assert.equal(normalizeSearchQuery('x'.repeat(160)).length, 160);
});

test('search: 类型显示名回退', () => {
  assert.equal(typeLabelOf('cabinet'), '机柜');
  assert.equal(typeLabelOf('pdu'), '列头柜');
  assert.equal(typeLabelOf('unknown-type'), 'unknown-type');
  assert.equal(typeLabelOf(null), '对象');
});

test('search: A0 前缀命中 A01..A09（字面前缀）', () => {
  const r = searchObjects(room.objects, 'A0');
  assert.equal(r.query, 'A0');
  assert.equal(r.total, 9);
  assert.equal(r.results.length, 9);
  assert.equal(r.truncated, false);
  assert.equal(r.empty, false);
  assert.deepEqual(r.results.map(x => x.label), [
    'A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09',
  ]);
  for (const hit of r.results) {
    assert.equal(hit.via, 'name');
    assert.equal(hit.mode, 'prefix');
    assert.equal(hit.score, SEARCH_SCORE.namePrefix - (hit.matched.length - 2));
    assert.equal(hit.typeLabel, '机柜');
  }
});

test('search: A 前缀命中 A01..A19 并截断为 10 条', () => {
  const r = searchObjects(room.objects, 'A');
  assert.equal(r.total, 19);
  assert.equal(r.results.length, 10);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.results.map(x => x.label), [
    'A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10',
  ]);
});

test('search: 大小写不敏感，精确命中优先', () => {
  const exact = searchObjects(room.objects, 'a01');
  assert.equal(exact.query, 'a01');
  assert.equal(exact.total, 1);
  assert.equal(exact.results[0].label, 'A01');
  assert.equal(exact.results[0].score, SEARCH_SCORE.nameExact);

  const upper = searchObjects(room.objects, 'A01');
  assert.deepEqual(upper.results.map(x => x.label), exact.results.map(x => x.label));
  assert.equal(upper.results[0].score, SEARCH_SCORE.nameExact);
});

test('search: ID 命中（前缀）低于名称命中', () => {
  const id = room.objects.find(o => o.type === 'wall');
  const prefix = String(id.id).slice(0, 6);
  const r = searchObjects(room.objects, prefix);
  assert.ok(r.total >= 1);
  const hit = r.results.find(x => x.id === id.id);
  assert.ok(hit);
  assert.equal(hit.via, 'id');
  assert.equal(hit.mode, 'prefix');
  assert.ok(hit.score <= SEARCH_SCORE.idPrefix);
  assert.match(resultHint(hit), /· ID /);
});

test('search: 控制字符查询被拒绝', () => {
  const r = searchObjects(room.objects, 'A0\u0001');
  assert.equal(r.query, '');
  assert.equal(r.empty, true);
  assert.equal(r.total, 0);
  assert.deepEqual(r.results, []);
  assert.equal(searchStatus(r).kind, 'idle');
});

test('search: 结果上限与非法 limit', () => {
  assert.equal(normalizeLimit(3), 3);
  assert.equal(normalizeLimit(99), 10);
  assert.equal(normalizeLimit(0), 10);
  assert.equal(normalizeLimit('x'), 10);
  assert.equal(normalizeLimit(-2), 10);
  const idx = buildSearchIndex(room.objects);
  assert.equal(searchIndex(idx, 'A', { limit: 3 }).results.length, 3);
  assert.equal(searchIndex(idx, 'A', { limit: 1000 }).results.length, 10);
});

test('search: 状态文案 idle / ok / more / empty', () => {
  const idle = searchStatus(searchObjects(room.objects, ''));
  assert.equal(idle.kind, 'idle');
  assert.equal(idle.text, '输入柜号 / 名称 / ID 定位对象');

  const ok = searchStatus(searchObjects(room.objects, 'A01'));
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.text, '找到 1 个结果');

  const more = searchStatus(searchObjects(room.objects, 'A'));
  assert.equal(more.kind, 'more');
  assert.equal(more.text, '找到 19 个 · 显示前 10 个');

  const empty = searchStatus(searchObjects(room.objects, '不存在的设备'));
  assert.equal(empty.kind, 'empty');
  assert.equal(empty.text, '未找到 · 不存在的设备');

  const long = 'x'.repeat(50);
  const longEmpty = searchStatus(searchObjects(room.objects, long));
  assert.equal(longEmpty.kind, 'empty');
  assert.equal(longEmpty.text, '未找到 · ' + 'x'.repeat(39) + '…');
});

test('search: 高亮片段与类型文案', () => {
  assert.deepEqual(matchSegments('A01', 'a0'), [
    { text: 'A0', hit: true },
    { text: '1', hit: false },
  ]);
  assert.deepEqual(matchSegments('A01', 'B'), [{ text: 'A01', hit: false }]);
  assert.deepEqual(matchSegments('', 'A0'), []);
  const r = searchObjects(room.objects, 'A01').results[0];
  assert.equal(resultHint(r), '机柜 · 名称精确');
  assert.equal(resultHint({ type: 'cabinet', via: 'id', id: 'abc', mode: 'exact' }), '机柜 · ID abc');
});
