#!/usr/bin/env node
/**
 * 端到端回归（本地克隆）：向导建房 → 生成 POD → 属性/撤销 → 合规检查 → 导出 →
 * 3D real/bim/编号 → union 检视 → AI 面板 → 语言切换/刷新恢复。
 * 前置：npm run dev（5200）；检视相关需 npm run dev:inspect（5199）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const URL_LOCAL = process.env.DCX_LOCAL || 'http://127.0.0.1:5200/';
const out = path.join(root, 'test', 'e2e-out');
fs.mkdirSync(out, { recursive: true });

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
const steps = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  await fn();
  steps.push(name);
  console.log(`ok ${name} (${Date.now() - t0}ms)`);
};

let projectState = null;
const readState = () => page.evaluate(async () => {
  const m = await import(new URL('js/state.js', document.baseURI).href);
  return {
    n: m.state.project.objects.length,
    types: [...new Set(m.state.project.objects.map(o => o.type))],
    cabs: m.state.project.objects.filter(o => o.type === 'cabinet').length,
    aisles: m.state.project.objects.filter(o => o.type === 'aisle').length,
    walls: m.state.project.objects.filter(o => o.type === 'wall').length,
    undo: m.undoDepth(),
  };
});

try {
  await step('boot + dismiss welcome + zh', async () => {
    await page.goto(URL_LOCAL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('idc2d_no_welcome', '1'); } catch (e) {}
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv');
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('[data-m]')].find(x => x.dataset.m === 'blank');
      if (b) b.click();
      const s = document.getElementById('lang-sel');
      s.value = 'zh-CN'; s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    assert((await page.title()) === 'DCDesigner', 'title');
  });

  await step('wizard room (12000x9000)', async () => {
    await page.evaluate(() => document.getElementById('btn-wizard').click());
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#wizard button')].find(x => x.dataset.act === 'room');
      b.click();
    });
    await page.waitForTimeout(600);
    const s = await readState();
    assert(s.walls === 4, `walls=4 got ${s.walls}`);
  });

  await step('wizard POD 4x12', async () => {
    await page.evaluate(() => {
      const set = (k, v) => {
        const e = document.querySelector(`#wizard [data-wz="${k}"]`);
        if (!e) return;
        e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('rows', '4'); set('count', '12'); set('gap', '0'); set('sx', '2200'); set('sy', '2200');
      const b = [...document.querySelectorAll('#wizard button')].find(x => x.dataset.act === 'cabs-xy');
      b.click();
    });
    await page.waitForTimeout(900);
    const s = await readState();
    assert(s.cabs === 48, `cabs=48 got ${s.cabs}`);
    assert(s.aisles === 3, `aisles=3 got ${s.aisles}`);
    await page.evaluate(() => document.getElementById('btn-fit').click());
    await page.waitForTimeout(300);
  });

  await step('select + props + undo', async () => {
    const pt = await page.evaluate(async () => {
      const m = await import(new URL('js/state.js', document.baseURI).href);
      const o = m.state.project.objects.find(x => x.type === 'cabinet');
      const r = document.getElementById('cv').getBoundingClientRect();
      const v = m.state.view;
      return { x: r.left + o.x * v.scale + v.ox, y: r.top + v.oy - o.y * v.scale, id: o.id };
    });
    await page.evaluate(() => document.querySelector('[data-tool="select"]').click());
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(350);
    const sel = await page.evaluate(async () => {
      const m = await import(new URL('js/state.js', document.baseURI).href);
      return m.state.selectedIds;
    });
    assert(sel.length === 1, 'one object selected');
    const before = (await readState()).undo;
    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    assert((await readState()).undo <= before + 1, 'undo depth sane');
  });

  await step('compliance checks', async () => {
    await page.evaluate(() => document.getElementById('btn-check').click());
    await page.waitForTimeout(900);
    const text = await page.textContent('#checks');
    assert(/越出房间|out of room|合规|Compliance/i.test(text), 'checks rendered');
  });

  await step('export CSV/DXF/PNG', async () => {
    await page.evaluate(() => document.getElementById('btn-export').click());
    for (const [id, ext] of [['btn-csv', '.csv'], ['btn-dxf', '.dxf'], ['btn-png', '.png']]) {
      const dl = page.waitForEvent('download', { timeout: 20000 });
      await page.evaluate((x) => document.getElementById(x).click(), id);
      await page.evaluate(() => document.getElementById('btn-export').click());
      const d = await dl;
      const p = path.join(out, `export${ext}`);
      await d.saveAs(p);
      assert(fs.statSync(p).size > (ext === '.png' ? 10000 : 500), `${ext} non-empty`);
    }
  });

  await step('3D real/bim/labels', async () => {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('[data-m]')].find(x => x.dataset.m === 'blank');
      if (b) b.click();
    });
    await page.waitForTimeout(300);
    await page.click('#btn-3d');
    await page.waitForTimeout(2600);
    assert(await page.evaluate(() => document.body.classList.contains('mode3d')), 'mode3d');
    await page.click('#btn-style');
    await page.waitForTimeout(1400);
    await page.click('#btn-label');
    await page.waitForTimeout(700);
    const labels = await page.evaluate(() => document.querySelectorAll('.labels3d .lb3d.on').length);
    assert(labels > 0, '3D labels visible');
  });

  await step('union inspect', async () => {
    await page.click('#btn-inspect');
    await page.waitForSelector('#dc-inspect iframe');
    const frame = page.frameLocator('#dc-inspect iframe');
    await frame.locator('#action-dock').waitFor({ timeout: 15000 });
    const railText = await frame.locator('#action-dock').innerText();
    assert(/视角|显示|剖切|定位|漫游|拆解/.test(railText), 'viewer rail in inspect');
    await page.click('#dc-inspect .dci-back');
    await page.waitForTimeout(400);
    assert(await page.evaluate(() => !document.getElementById('dc-inspect')), 'inspect closed');
  });

  await step('AI panel + settings', async () => {
    await page.evaluate(() => document.getElementById('tab-ai').click());
    await page.waitForTimeout(900);
    const txt = await page.textContent('#ai-design');
    assert(/API Key|API 密钥/.test(txt), 'AI settings present');
  });

  await step('locale switch + reload draft', async () => {
    await page.evaluate(() => { const s = document.getElementById('lang-sel'); s.value = 'en'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForTimeout(500);
    assert((await page.evaluate(() => document.documentElement.lang)) === 'en', 'lang=en');
    await page.evaluate(async () => {
      const m = await import(new URL('js/state.js', document.baseURI).href);
      m.flushDraft();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#cv', { state: 'attached' });
    await page.waitForTimeout(1500);
    const s = await readState();
    assert(s.cabs === 48, `draft restored cabinets=${s.cabs}`);
  });

  console.log(`\n${steps.length} steps passed`);
} finally {
  await browser.close();
}
