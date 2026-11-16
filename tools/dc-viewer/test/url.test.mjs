import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseViewState, serializeViewState, applyViewState,
  normalizeViewParam, normalizeRouteParam, isKnownRoute,
} from '../src/url/state.js';

test('parse: 空查询串全部回默认值', () => {
  const st = parseViewState('');
  assert.equal(st.src, null);
  assert.equal(st.src2, null);
  assert.equal(st.ab, 'a');
  assert.equal(st.view, 'orbit');
  assert.equal(st.focus, null);
  assert.equal(st.cut, 'off');
  assert.equal(st.section, 'off');
  assert.equal(st.side, 'x');
  assert.equal(st.sidePos, null);
  assert.equal(st.sideFlip, false);
  assert.equal(st.clip, 'y');
  assert.equal(st.clipPos, null);
  assert.equal(st.clipFlip, false);
  assert.equal(st.box, 'corner');
  assert.equal(st.boxX, null);
  assert.equal(st.boxZ, null);
  assert.equal(st.boxH, null);
  assert.equal(st.route, null);
  assert.equal(st.xray, false);
  assert.deepEqual(st.hide, []);
  assert.equal(st.ui, true);
  assert.equal(st.debug, null);
  assert.equal(st.explode, 'presentation');
  assert.equal(st.style, 'real');
  assert.equal(st.renderer, null);
  assert.equal(st.bright, null);
  assert.deepEqual(st.issues, []);
});

test('serialize: 默认值省略（view=orbit / cut=off / section=off / xray=0 / ui=1）', () => {
  const st = parseViewState('src=room.json');
  assert.equal(serializeViewState(st), 'src=room.json');
  // 显式默认值同样不写
  assert.equal(
    serializeViewState({ src: 'room.json', view: 'orbit', cut: 'off', section: 'off', xray: false, ui: true }),
    'src=room.json',
  );
});

test('往返：parse → serialize → parse 结果一致（含非默认值）', () => {
  const q = 'src=room.json&view=iso-sw&focus=A01&cut=2600&section=height&hide=tray,ceiling&xray=1&ui=0&debug=wire&style=lineart&explode=review&route=all&renderer=webgl&bright=1.4';
  const st = parseViewState(q);
  assert.equal(st.view, 'iso-sw');
  assert.equal(st.focus, 'A01');
  assert.equal(st.cut, 2600);
  assert.equal(st.section, 'height');
  assert.deepEqual(st.hide, ['tray', 'ceiling']);
  assert.equal(st.xray, true);
  assert.equal(st.ui, false);
  assert.equal(st.debug, 'wire');
  assert.equal(st.style, 'lineart');
  assert.equal(st.explode, 'review');
  assert.equal(st.route, 'all');
  assert.equal(st.renderer, 'webgl');
  assert.equal(st.bright, '1.4');

  // 一眼可读的规范顺序：route 在 section 参数之后、xray/hide 之前
  const ser = serializeViewState(st, { base: q });
  assert.equal(ser, 'src=room.json&view=iso-sw&focus=A01&cut=2600&section=height&route=all&xray=1&hide=tray,ceiling&ui=0&debug=wire&style=lineart&explode=review&renderer=webgl&bright=1.4');

  const st2 = parseViewState(ser);
  for (const k of ['src', 'view', 'focus', 'cut', 'section', 'route', 'xray', 'hide', 'ui', 'debug', 'style', 'explode', 'renderer', 'bright']) {
    assert.deepEqual(st2[k], st[k], `往返字段 ${k} 应一致`);
  }
  assert.deepEqual(st2.issues, []);
  // 规范化后再序列化是幂等的
  assert.equal(serializeViewState(st2, { base: ser }), ser);
});

test('renderer/bright/业务参数透传：按原始相对顺序追加在末尾，不被管理', () => {
  const st = parseViewState('src=a.json&renderer=webgl&foo=1&bright=1.2');
  assert.equal(st.renderer, 'webgl');
  assert.equal(st.bright, '1.2');
  assert.deepEqual(st.present.sort(), ['bright', 'foo', 'renderer', 'src'].sort());
  assert.equal(
    serializeViewState(st, { base: 'src=a.json&renderer=webgl&foo=1&bright=1.2' }),
    'src=a.json&renderer=webgl&foo=1&bright=1.2',
  );
  // 即使有管理参数，未知参数仍跟在管理参数之后且保持相对顺序
  assert.equal(
    serializeViewState({ src: 'a.json', view: 'top', bright: '2' }, { base: 'bright=2&src=a.json' }),
    'src=a.json&view=top&bright=2',
  );
});

test('非法值回落默认并记 issue（view/cut/section/xray/ui/route）', () => {
  const st = parseViewState('view=iso-bad&cut=-5&section=nope&xray=maybe&ui=weird&route=bad%20token');
  assert.equal(st.view, 'orbit');
  assert.equal(st.cut, 'off');
  assert.equal(st.section, 'off');
  assert.equal(st.xray, false);
  assert.equal(st.ui, true);
  assert.equal(st.route, null);
  assert.equal(st.issues.length, 6);
  for (const it of st.issues) assert.equal(it.reason, 'invalid');
  assert.deepEqual(st.issues.map(i => i.key).sort(),
    ['cut', 'route', 'section', 'ui', 'view', 'xray'].sort());
});

test('非法盒体高度（负值）回落并记 issue', () => {
  const st = parseViewState('section=box&boxH=-1');
  assert.equal(st.boxH, null);
  assert.deepEqual(st.issues, [{ key: 'boxH', value: '-1', reason: 'invalid' }]);
});

test('hide 归一化顺序：去重、去 floor、按 TYPE_ORDER 排序；未知 token 进 issues', () => {
  const st = parseViewState('hide=tray,ceiling,cabinet,tray,floor,junk');
  assert.deepEqual(st.hide, ['cabinet', 'tray', 'ceiling']);
  assert.deepEqual(st.issues.map(i => i.value).sort(), ['floor', 'junk']);
  // serialize 用归一化顺序
  assert.equal(
    serializeViewState({ src: 'a.json', hide: ['tray', 'ceiling', 'cabinet'] }),
    'src=a.json&hide=cabinet,tray,ceiling',
  );
  // 空 hide（?hide=）作为 present，仍触发 apply 清理，但序列化省略
  assert.equal(serializeViewState({ src: 'a.json', hide: [] }), 'src=a.json');
});

test('section=side/clip/box 抑制 cut（解析与序列化都不产出两套切面）', () => {
  for (const mode of ['side', 'clip', 'box']) {
    const q = `src=a.json&section=${mode}&cut=2600`;
    const st = parseViewState(q);
    assert.equal(st.cut, 2600); // 解析保留，但应用/序列化被抑制
    assert.equal(st.section, mode);
    const ser = serializeViewState(st, { base: q });
    assert.ok(!ser.includes('cut'), `cut 不应出现在 section=${mode} 的序列化里：${ser}`);
  }
  // 单独 side/clip/box 的具体参数
  assert.equal(
    serializeViewState({ src: 'a.json', section: 'side', side: 'z', sidePos: 6000.4, sideFlip: true }),
    'src=a.json&section=side&side=z&sidePos=6000&sideFlip=1',
  );
  assert.equal(
    serializeViewState({ src: 'a.json', section: 'clip', clip: 'x', clipPos: 1500, clipFlip: true }),
    'src=a.json&section=clip&clip=x&clipPos=1500&clipFlip=1',
  );
  assert.equal(
    serializeViewState({ src: 'a.json', section: 'box', box: 'top', boxX: 8000, boxZ: 4000, boxH: 2800 }),
    'src=a.json&section=box&box=top&boxX=8000&boxZ=4000&boxH=2800',
  );
  // 默认 side=x / clip=y / box=corner 省略
  assert.equal(
    serializeViewState({ src: 'a.json', section: 'side', side: 'x', sidePos: 6000 }),
    'src=a.json&section=side&sidePos=6000',
  );
});

test('视图 id 别名归一化', () => {
  assert.equal(normalizeViewParam('俯视'), 'top');
  assert.equal(normalizeViewParam('plan'), 'top');
  assert.equal(normalizeViewParam('iso'), 'iso');
  assert.equal(normalizeViewParam('iso-东南'), 'iso-se');
  assert.equal(normalizeViewParam('axo-sw'), 'iso-sw');
  assert.equal(normalizeViewParam('南立面'), 'front');
  assert.equal(normalizeViewParam('北立面'), 'back');
  assert.equal(normalizeViewParam('east'), 'right');
  assert.equal(normalizeViewParam('west'), 'left');
  assert.equal(normalizeViewParam('全景'), 'orbit');
  // 业务视点 token 保留
  assert.equal(normalizeViewParam('entry'), 'entry');
  assert.equal(normalizeViewParam('corner-se'), 'corner-se');
  // 非法 iso 角不退化成语义视点
  assert.equal(normalizeViewParam('iso-bad'), null);
  assert.equal(normalizeViewParam(''), null);
});

test('route 参数与已知路线判定', () => {
  assert.equal(normalizeRouteParam('ALL'), 'all');
  assert.equal(normalizeRouteParam('row-a'), 'row-a');
  assert.equal(normalizeRouteParam('cabinet-A01'), 'cabinet-a01');
  assert.equal(normalizeRouteParam('bad token'), null);
  assert.ok(isKnownRoute('all'));
  assert.ok(isKnownRoute('inspection'));
  assert.ok(isKnownRoute('row-a'));
  assert.ok(isKnownRoute('row-z')); // 前缀合法但目标可能不存在，仍算已知
  assert.ok(isKnownRoute('cabinet-X99'));
  assert.ok(!isKnownRoute('foo'));
  assert.ok(!isKnownRoute(''));
});

test('applyViewState：注入钩子全部生效并按顺序调用', () => {
  const calls = [];
  const st = parseViewState('src=a.json&view=top&focus=A01&cut=2400&section=height&hide=tray&xray=1&debug=wire&style=lineart&explode=review');
  const deps = {
    setChromeVisible: v => calls.push(['chrome', v]),
    views: { goTo: id => { calls.push(['goTo', id]); return true; } },
    applyFocus: f => { calls.push(['focus', f]); return true; },
    applyCut: c => { calls.push(['cut', c]); return true; },
    applySection: m => { calls.push(['section', m]); return true; },
    applyHide: h => { calls.push(['hide', h]); return true; },
    applyXray: on => { calls.push(['xray', on]); return true; },
    applyDebug: d => { calls.push(['debug', d]); return true; },
    applyStyle: m => { calls.push(['style', m]); return true; },
    applyExplode: p => { calls.push(['explode', p]); return true; },
  };
  const r = applyViewState(st, deps);
  assert.equal(r.pending.length, 0);
  assert.equal(r.ignored.length, 0);
  assert.deepEqual(calls, [
    ['chrome', true],
    ['goTo', 'top'],
    ['focus', 'A01'],
    ['cut', 2400],
    ['section', 'height'],
    ['hide', ['tray']],
    ['xray', true],
    ['debug', 'wire'],
    ['style', 'lineart'],
    ['explode', 'review'],
  ]);
  assert.deepEqual(r.applied, {
    ui: true,
    view: 'top',
    focus: 'A01',
    cut: 2400,
    section: 'height',
    hide: ['tray'],
    xray: true,
    debug: 'wire',
    style: 'lineart',
    explode: 'review',
  });
});

test('applyViewState：缺钩子进 pending，被拒进 ignored', () => {
  const st = parseViewState('src=a.json&view=top&focus=A01&xray=1&section=clip');
  const r = applyViewState(st, {});
  assert.deepEqual(r.applied, { ui: true }); // view 无 views → 仅记 pending，不改写
  assert.equal(r.pending.length, 4);
  assert.deepEqual(r.pending.map(p => p.key), ['view', 'focus', 'section', 'xray']);
  assert.equal(r.pending.find(p => p.key === 'view').reason, 'viewer-not-ready');
  // section=clip 缺 applyClip/applySection → pending T11
  assert.deepEqual(r.pending.find(p => p.key === 'section').task, 'T11');

  const rejected = applyViewState(st, {
    views: { goTo: () => false },
    applyFocus: () => false,
    applyClip: () => false,
    applyXray: () => false,
  });
  assert.deepEqual(rejected.ignored.map(i => i.key), ['view', 'focus', 'section', 'xray']);
  assert.ok(rejected.ignored.find(i => i.key === 'view').reason === 'not-found');
  assert.ok(rejected.ignored.find(i => i.key === 'xray').reason === 'rejected');
});

test('applyViewState：section=side 调 applySide，不触发 cut', () => {
  let cutCalled = false;
  let sideCalled = false;
  const st = parseViewState('src=a.json&section=side&side=z&sidePos=6000&cut=2600');
  const r = applyViewState(st, {
    applySide: s => { sideCalled = true; assert.deepEqual(s, { axis: 'z', pos: 6000, flip: false }); return true; },
    applyCut: () => { cutCalled = true; return true; },
  });
  assert.equal(sideCalled, true);
  assert.equal(cutCalled, false);
  assert.deepEqual(r.applied.section, 'side');
});

test('applyViewState：route 未知进 ignored，tour 缺失进 pending，失败进 ignored', () => {
  const unknown = applyViewState(parseViewState('route=foo'), {});
  assert.deepEqual(unknown.ignored, [{ key: 'route', value: 'foo', reason: 'unknown-route' }]);

  const missing = applyViewState(parseViewState('route=all'), {});
  assert.deepEqual(missing.pending, [{ key: 'route', value: 'all', reason: 'tour-not-ready', task: 'T20' }]);

  const failed = applyViewState(parseViewState('route=all'), { tour: { start: () => false } });
  assert.deepEqual(failed.ignored, [{ key: 'route', value: 'all', reason: 'cannot-start' }]);

  const started = applyViewState(parseViewState('route=all'), { tour: { start: () => true, info: () => ({ route: 'all' }) } });
  assert.deepEqual(started.applied.route, 'all');
});
