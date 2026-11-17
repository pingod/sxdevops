import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('zh/en dictionaries share keys and include inspect strings', async () => {
  const zh = (await import(new URL('../js/i18n/zh.js', import.meta.url).href)).zhCN;
  const en = (await import(new URL('../js/i18n/en.js', import.meta.url).href)).en;
  const missingEn = Object.keys(zh).filter(k => !(k in en));
  const missingZh = Object.keys(en).filter(k => !(k in zh));
  // 允许少量参考站遗留的单语键，但不得超过 2%（否则说明合并不完整）
  assert.ok(missingEn.length <= Object.keys(zh).length * 0.02, `en missing ${missingEn.slice(0, 8)}`);
  assert.ok(missingZh.length <= Object.keys(en).length * 0.02, `zh missing ${missingZh.slice(0, 8)}`);
  for (const k of ['inspect.open', 'inspect.title', 'inspect.hint', 'inspect.back', 'inspect.offline']) {
    assert.ok(zh[k] && en[k], `missing ${k}`);
  }
});

test('only zh/en locale packs are shipped', () => {
  const dir = path.resolve('js/i18n');
  const files = fs.readdirSync(dir);
  assert.ok(files.includes('zh.js') && files.includes('en.js'));
  assert.ok(!files.includes('ar.js') && !files.includes('es.js'));
  const html = fs.readFileSync('index.html', 'utf8');
  assert.ok(!/value="(ar|es)"/.test(html), 'index.html language options');
});
