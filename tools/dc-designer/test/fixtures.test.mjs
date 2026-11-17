import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('public/fixtures');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

test('demo fixture matches the reference wizard output shape', () => {
  const p = read('demo.json');
  assert.equal(p.name, '未命名机房');
  assert.equal(p.objects.length, 55);
  const by = (t) => p.objects.filter(o => o.type === t);
  assert.equal(by('wall').length, 4);
  assert.equal(by('cabinet').length, 48);
  assert.equal(by('aisle').length, 3);
  // 机柜：4 排 × 12，A 排 y=2200，D 排 y=9100（越出内墙 → 检查应报错）
  const ys = [...new Set(by('cabinet').map(o => o.y))].sort((a, b) => a - b);
  assert.deepEqual(ys, [2200, 4600, 6700, 9100]);
  const a = by('cabinet').filter(o => o.props.name.startsWith('A'));
  assert.equal(a.length, 12);
  assert.equal(Math.min(...a.map(o => o.x)), 2200);
  assert.equal(Math.max(...a.map(o => o.x)), 8800);
  // 封闭冷通道 1200、开放热通道 900
  assert.deepEqual(by('aisle').map(o => `${o.props.kind}:${o.props.d}:${o.props.enclosed}`),
    ['cold:1200:true', 'hot:900:false', 'cold:1200:true']);
});

test('all fixtures: unique ids, sane coordinates, 16 supported types in all-types', () => {
  for (const f of ['demo.json', 'pipes.json', 'all-types.json']) {
    const p = read(f);
    const ids = new Set(p.objects.map(o => o.id));
    assert.equal(ids.size, p.objects.length, `${f}: duplicate ids`);
    for (const o of p.objects) {
      assert.ok(o.id && o.type && o.props, `${f}: ${o.id}`);
      const nums = ['x', 'y', 'x1', 'y1', 'x2', 'y2'].filter(k => o[k] !== undefined);
      for (const k of nums) assert.ok(Number.isFinite(+o[k]), `${f}: ${o.id}.${k}`);
    }
  }
  const all = read('all-types.json');
  const types = new Set(all.objects.map(o => o.type));
  for (const t of ['wall', 'door', 'window', 'grille', 'column', 'beam', 'tray', 'pipe', 'vent',
    'cabinet', 'pdu', 'dbox', 'ups', 'battery', 'ac', 'extinguisher', 'aisle']) {
    assert.ok(types.has(t), `all-types missing ${t}`);
  }
  const pipes = read('pipes.json');
  assert.ok(pipes.objects.some(o => o.type === 'pipe'));
  assert.ok(pipes.objects.some(o => o.type === 'tray'));
});

test('project JSON round-trips through sanitize without losing supported objects', async () => {
  const m = await import(new URL('../js/state.js', import.meta.url).href);
  const p = read('all-types.json');
  const copy = JSON.parse(JSON.stringify(p));
  m.sanitize(copy);
  assert.equal(copy.objects.length, p.objects.length);
  for (const o of copy.objects) {
    if (o.type === 'door' || o.type === 'window' || o.type === 'grille') {
      assert.ok(copy.objects.some(w => w.id === o.wallId && w.type === 'wall'), `${o.id} wall ref`);
      assert.ok(o.t >= 0 && o.t <= 1, `${o.id} t`);
    }
    if (['cabinet', 'pdu', 'dbox', 'ups', 'battery', 'ac', 'extinguisher', 'vent'].includes(o.type)) {
      assert.equal(typeof o.z, 'number');
    }
  }
});
