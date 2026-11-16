#!/usr/bin/env node
/**
 * 截图对比：参考站 vs 本地克隆，同一视口/参数下逐像素比较。
 *
 *   node scripts/parity.mjs                # 对比 10 个固定状态
 *   node scripts/parity.mjs --update-ref   # 重新录制参考基准（需网络）
 *   node scripts/parity.mjs --only=top     # 只跑一个状态
 *
 * 判定：差异像素占比 ≤ 3%。参考站不可达时跳过并记 SKIP（不视为失败）。
 */
import { chromium } from 'playwright-core';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REF = 'https://www.nvisual.com/DCExporer/';
const LOCAL = 'http://127.0.0.1:5199/';
const W = 1600;
const H = 1000;
const DPR = 1;
const THRESHOLD = 0.03;

const STATES = [
  { id: 'default', q: '' },
  { id: 'top', q: '&view=top' },
  { id: 'iso', q: '&view=iso' },
  { id: 'front', q: '&view=front' },
  { id: 'height', q: '&section=height&cut=2600' },
  { id: 'clip', q: '&section=clip&clip=y&clipPos=1600' },
  { id: 'box', q: '&section=box&box=top' },
  { id: 'xray', q: '&xray=1' },
  { id: 'hide', q: '&hide=tray' },
  { id: 'ui0', q: '&ui=0' },
];

const argv = process.argv.slice(2);
const update = argv.includes('--update-ref');
const only = (argv.find(a => a.startsWith('--only=')) || '').split('=')[1];

const OUT = 'test/parity/out';
const REFDIR = 'test/parity/ref';

async function launch() {
  return chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
}

async function shot(browser, base, state, src) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '?src=' + src + '&renderer=webgl' + state.q, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const api = window.__dcxd || window.__dc3d;
    const ready = api && (api.isReady || api.is3DReady);
    return !!ready && !!ready();
  }, null, { timeout: 60000 });
  await page.waitForTimeout(1400);
  const info = await page.evaluate(() => {
    const api = window.__dcxd || window.__dc3d;
    return api.info ? api.info() : null;
  });
  const buf = await page.screenshot();
  await page.close();
  return { buf, info, errors };
}

function compare(refBuf, curBuf) {
  const a = PNG.sync.read(refBuf);
  const b = PNG.sync.read(curBuf);
  if (a.width !== b.width || a.height !== b.height) {
    return { error: `尺寸不一致 ${a.width}×${a.height} vs ${b.width}×${b.height}` };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  return { ratio: n / (a.width * a.height), diff: PNG.sync.write(diff) };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(REFDIR, { recursive: true });
  const browser = await launch();
  let failed = 0;
  let skipped = 0;
  for (const state of STATES) {
    if (only && state.id !== only) continue;
    const refPath = join(REFDIR, state.id + '.png');
    let ref;
    if (!update && existsSync(refPath)) {
      ref = await readFile(refPath);
    } else {
      try {
        const r = await shot(browser, REF, state, 'room.json');
        if (r.errors.length) console.warn(`[${state.id}] 参考站错误：`, r.errors.slice(0, 3));
        ref = r.buf;
        await writeFile(refPath, ref);
        if (update) {
          console.log(`REF ${state.id} 已录制`);
          continue;
        }
      } catch (err) {
        console.warn(`SKIP ${state.id}: 参考站不可达（${err.message.split('\n')[0]}）`);
        skipped++;
        continue;
      }
    }
    let cur;
    try {
      cur = await shot(browser, LOCAL, state, 'samples/room.json');
    } catch (err) {
      console.error(`FAIL ${state.id}: 本地页面异常 ${err.message.split('\n')[0]}`);
      failed++;
      continue;
    }
    if (cur.errors.length) console.warn(`[${state.id}] 本地页面错误：`, cur.errors.slice(0, 3));
    const res = compare(ref, cur.buf);
    if (res.error) {
      console.error(`FAIL ${state.id}: ${res.error}`);
      failed++;
      continue;
    }
    await writeFile(join(OUT, state.id + '.diff.png'), res.diff);
    await writeFile(join(OUT, state.id + '.cur.png'), cur.buf);
    const pct = (res.ratio * 100).toFixed(2);
    const ok = res.ratio <= THRESHOLD;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${state.id.padEnd(8)} diff ${pct}%`);
    if (!ok) failed++;
  }
  await browser.close();
  console.log(`\n${failed ? `${failed} 个状态超限` : '全部通过'}${skipped ? `（${skipped} 跳过）` : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
