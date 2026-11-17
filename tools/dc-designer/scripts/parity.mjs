#!/usr/bin/env node
/**
 * 参考站 vs 本地克隆截图对比（Playwright Chrome + pixelmatch）。
 *
 *   node scripts/parity.mjs                 # 对比（参考站在线）
 *   node scripts/parity.mjs --update-ref    # 重录 test/parity/ref/*.png
 *   node scripts/parity.mjs --only=plan,3d  # 只跑指定状态
 *
 * 约定：1600×1000、DPR 1、zh-CN、同一 fixture（public/fixtures/demo.json）。
 * 2D 状态阈值 3%，3D 状态 6%；3D 状态屏蔽右下角「检视」新增按钮区域。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refDir = path.join(root, 'test', 'parity', 'ref');
const outDir = path.join(root, 'test', 'parity', 'out');
fs.mkdirSync(refDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const REF = process.env.DCX_REF || 'https://www.nvisual.com/dcdesigner/';
const LOCAL = process.env.DCX_LOCAL || 'http://127.0.0.1:5200/';
const args = process.argv.slice(2);
const updateRef = args.includes('--update-ref');
const only = (args.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);

const fixture = JSON.parse(fs.readFileSync(path.join(root, 'public', 'fixtures', 'demo.json'), 'utf8'));

const STATES = [
  { id: 'empty', kind: '2d' },
  { id: 'plan', kind: '2d' },
  { id: 'select', kind: '2d' },
  { id: 'wizard', kind: '2d' },
  { id: 'checks', kind: '2d' },
  { id: 'export-menu', kind: '2d' },
  { id: '3d-real', kind: '3d' },
  { id: '3d-bim', kind: '3d' },
  { id: '3d-labels', kind: '3d' },
];

async function boot(page, url) {
  await page.addInitScript(() => { try { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('idc2d_no_welcome', '1'); } catch (e) {} });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#cv', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.waitForFunction(() => document.fonts && document.fonts.status === 'loaded').catch(() => {});
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-m]')].find(x => x.dataset.m === 'blank');
    if (b) b.click();
    const s = document.getElementById('lang-sel');
    if (s && s.value !== 'zh-CN') { s.value = 'zh-CN'; s.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(400);
}

async function loadFixture(page, project) {
  await page.evaluate(async (p) => {
    const m = window.__dcd || await import(new URL('js/state.js', document.baseURI).href);
    const copy = JSON.parse(JSON.stringify(p));
    m.sanitize(copy);
    m.state.project = copy;
    m.markDirty({ dirty: false });
    m.ui.fit();
  }, project);
  await settle(page);
}

async function settle(page) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(350);
}

async function selectFirstCabinet(page) {
  const ok = await page.evaluate(() => {
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    // 通过动态 import 读取实时 state（与参考站同路径）
    return Promise.resolve(window.__dcd || import(new URL('js/state.js', document.baseURI).href)).then(m => {
      const o = m.state.project.objects.find(x => x.type === 'cabinet');
      if (!o) return false;
      const v = m.state.view;
      const sx = r.left + o.x * v.scale + v.ox;
      const sy = r.top + v.oy - o.y * v.scale;
      window.__parityClick = { x: sx, y: sy };
      return true;
    });
  });
  if (!ok) return;
  const pt = await page.evaluate(() => window.__parityClick);
  await page.mouse.click(pt.x, pt.y);
  await settle(page);
}

async function applyState(page, state) {
  if (state.id === 'empty') {
    await page.evaluate(async () => {
      const m = window.__dcd || await import(new URL('js/state.js', document.baseURI).href);
      m.newProject('未命名机房');
      m.markDirty({ dirty: false });
      m.ui.fit();
    });
    await settle(page);
    return;
  }
  await loadFixture(page, fixture);
  if (state.kind === '3d') {
    await page.click('#btn-3d');
    await page.waitForTimeout(2400);
    if (state.id === '3d-bim') { await page.click('#btn-style'); await page.waitForTimeout(1800); }
    if (state.id === '3d-labels') { await page.click('#btn-label'); await page.waitForTimeout(900); }
    await settle(page);
    return;
  }
  if (state.id === 'select') { await selectFirstCabinet(page); return; }
  if (state.id === 'wizard') {
    await page.evaluate(() => { const b = document.getElementById('btn-wizard'); if (b && !b.classList.contains('active')) b.click(); });
    await settle(page); return;
  }
  if (state.id === 'checks') {
    await page.evaluate(() => document.getElementById('btn-check').click());
    await page.waitForTimeout(700); return;
  }
  if (state.id === 'export-menu') {
    await page.evaluate(() => document.getElementById('btn-export').click());
    await settle(page); return;
  }
  if (state.id === 'ai-panel') {
    await page.evaluate(() => document.getElementById('tab-ai').click());
    await page.waitForTimeout(900); return;
  }
}

function diffPng(aPath, bPath, kind) {
  const a = PNG.sync.read(fs.readFileSync(aPath));
  const b = PNG.sync.read(fs.readFileSync(bPath));
  if (a.width !== b.width || a.height !== b.height) return { ratio: 1, reason: 'size' };
  // 去标识化是有意差异：顶栏品牌/按钮（0–51px）不参与像素对比
  for (const img of [a, b]) for (let y = 0; y < Math.min(51, a.height); y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 233;
      img.data[i + 3] = 255;
    }
  }
  if (kind === '3d') {
    // 屏蔽本地新增的「检视」按钮（右下角）
    const x0 = a.width - 130, y0 = a.height - 60;
    for (const img of [a, b]) for (let y = y0; y < a.height; y++) for (let x = x0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 233;
      img.data[i + 3] = 255;
    }
  }
  const out = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: 0.1, includeAA: false });
  return { ratio: n / (a.width * a.height), out };
}

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
let failed = 0;

for (const state of STATES) {
  if (only.length && !only.includes(state.id)) continue;
  const refPath = path.join(refDir, `${state.id}.png`);
  const locPath = path.join(outDir, `${state.id}.png`);

  await boot(page, REF);
  await applyState(page, state);
  if (updateRef) await page.screenshot({ path: refPath });
  else if (!fs.existsSync(refPath)) { console.error(`missing ref ${refPath}（先 --update-ref）`); failed++; continue; }

  await boot(page, LOCAL);
  await applyState(page, state);
  await page.screenshot({ path: locPath });

  if (updateRef) { console.log(`saved ref ${state.id}`); continue; }
  const { ratio, out, reason } = diffPng(refPath, locPath, state.kind);
  const limit = state.kind === '3d' ? 0.06 : 0.03;
  const ok = !reason && ratio <= limit;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${state.id.padEnd(12)} diff=${(ratio * 100).toFixed(2)}% limit=${(limit * 100)}%${reason ? ' (' + reason + ')' : ''}`);
  if (!ok) {
    failed++;
    if (out) {
      const d = new PNG({ width: out.width, height: out.height });
      d.data = out.data;
      fs.writeFileSync(path.join(outDir, `${state.id}.diff.png`), PNG.sync.write(d));
    }
  }
}

await browser.close();
if (updateRef) console.log('reference screenshots updated');
else if (failed) { console.error(`${failed} state(s) failed`); process.exit(1); }
else console.log('all parity states within threshold');
