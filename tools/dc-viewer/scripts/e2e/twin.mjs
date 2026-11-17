#!/usr/bin/env node
/**
 * 端到端回归：三维机房设计器 + 数字孪生查看器（真实浏览器、真实后端）。
 *
 *   cd backend && python manage.py runserver 127.0.0.1:8012
 *   node tools/dc-viewer/scripts/e2e/twin.mjs
 *
 * 环境变量：E2E_BASE（默认 http://127.0.0.1:8012）、E2E_USER、E2E_PASS。
 * 前置条件：库里有至少一台可绑定的网络设备（monitor-targets 非空）。
 *
 * 多选通过 store.selectMany 触发（三维拾取的屏幕坐标依赖相机，回归里不稳定），
 * 其余动作都走真实 UI：构件库按钮、画布点击、机柜排弹窗、保存/冲突/回滚弹窗。
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8012').replace(/\/$/, '');
const USER = process.env.E2E_USER || 'admin';
const PASS = process.env.E2E_PASS || '';
const ROOM = { width: 12000, depth: 8000, height: 3000, floorHeight: 400 };
const CABINETS = 8;

const log = (...args) => console.log('  ', ...args);

async function api(path, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Token ${token}`;
  const response = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

function requireCreds() {
  if (!PASS) {
    throw new Error('缺少 E2E_PASS 环境变量（E2E_USER 默认 admin）');
  }
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('请输入用户名').fill(USER);
  await page.getByPlaceholder('请输入密码').fill(PASS);
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), null, { timeout: 30000 });
  const result = await page.evaluate(async ([username, password]) => {
    const response = await fetch('/api/auth/login/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }, [USER, PASS]);
  assert.equal(result.status, 200, `API 登录失败：${JSON.stringify(result.data)}`);
  return result.data.token;
}

async function designerFrame(page) {
  for (const frame of page.frames()) {
    if (frame.url().includes('/dc-viewer-app/design.html')) return frame;
  }
  throw new Error('未找到设计器 iframe');
}

async function waitDesigner(page) {
  await page.waitForSelector('iframe.design-frame', { timeout: 30000 });
  const frame = await designerFrame(page);
  await frame.waitForFunction(() => !!window.__dz && !!window.__dz.viewport, null, { timeout: 40000 });
  return frame;
}

const dz = (frame, fn, arg) => frame.evaluate(fn, arg);

/** 工具栏「保存」：保存弹窗关闭后仍留在 DOM 里，必须按工具栏范围定位。 */
const toolbarSave = (page) => page.locator('.design-toolbar__right')
  .getByRole('button', { name: '保存', exact: true });

async function shot(page, name) {
  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
}

async function run() {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  let token = '';
  let projectId = null;
  const steps = [];
  const step = async (name, fn) => {
    process.stdout.write(`▶ ${name}\n`);
    await fn();
    steps.push(name);
  };

  try {
    await step('登录平台', async () => {
      requireCreds();
      token = await login(page);
      assert.ok(token, '登录未返回 token');
    });

    await step('绑定目标设备可用', async () => {
      const { status, data } = await api('/api/datacenter/twin/monitor-targets/', { token });
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.items) && data.items.length > 0, 'monitor-targets 为空，请先创建网络设备');
      log(`可绑定设备 ${data.items.length} 台`);
    });

    await step('打开设计器并新建 12000×8000 机房', async () => {
      await page.goto(`${BASE}/datacenter/twin-design`, { waitUntil: 'domcontentloaded' });
      await waitDesigner(page);
      await page.getByRole('button', { name: '新建机房' }).click();
      const dialog = page.locator('.el-dialog').filter({ hasText: '新建机房' }).last();
      await dialog.locator('input').first().fill('E2E 机房');
      await dialog.getByRole('button', { name: '创建并编辑' }).click();
      const frame = await designerFrame(page);
      await frame.waitForFunction(
        ([w, d]) => {
          const walls = window.__dz.project.objects.filter(o => o.type === 'wall');
          const spanX = Math.max(0, ...walls.map(o => Math.abs(o.x2 - o.x1)));
          const spanY = Math.max(0, ...walls.map(o => Math.abs(o.y2 - o.y1)));
          return spanX === w && spanY === d;
        },
        [ROOM.width, ROOM.depth],
        { timeout: 20000 },
      );
      await shot(page, '01-room');
    });

    await step('在墙上放置门，写入 wallId 与 t', async () => {
      const frame = await designerFrame(page);
      await frame.locator('.dz-tool[data-type="door"]').click();
      const spot = await dz(frame, () => {
        const wall = window.__dz.project.objects.find(o => o.type === 'wall');
        const x = (wall.x1 + wall.x2) / 2;
        const y = (wall.y1 + wall.y2) / 2;
        return window.__dz.viewport.projectPoint(x, 1200, y);
      });
      await page.mouse.click(spot.x, spot.y);
      const door = await dz(frame, () => window.__dz.project.objects.find(o => o.type === 'door') || null);
      assert.ok(door, '门没有放上去');
      assert.ok(door.wallId, '门缺少 wallId');
      assert.ok(door.t > 0 && door.t < 1, `门的 t 越界：${door.t}`);
      log(`门已挂在 ${door.wallId}，t=${door.t}`);
      await frame.locator('.dz-tool[data-type="door"]').click();
      await shot(page, '02-door');
    });

    await step('机柜排 8 台并通过工具栏左对齐', async () => {
      const frame = await designerFrame(page);
      await frame.locator('#dz-row').click();
      await frame.locator('#dz-dialog input[data-key="count"]').fill(String(CABINETS));
      await frame.locator('#dz-dialog input[data-key="x"]').fill('1500');
      await frame.locator('#dz-dialog input[data-key="y"]').fill('2000');
      await frame.locator('#dz-dialog-ok').click();
      const cabinets = await dz(frame, () => window.__dz.project.objects.filter(o => o.type === 'cabinet').length);
      assert.equal(cabinets, CABINETS);
      await dz(frame, () => {
        const ids = window.__dz.project.objects.filter(o => o.type === 'cabinet').slice(0, 2).map(o => o.id);
        window.__dz.store.selectMany(ids);
        return ids;
      });
      await frame.waitForSelector('#dz-align:not([hidden])', { timeout: 5000 });
      await frame.locator('#dz-align button[data-align="minX"]').click();
      const xs = await dz(frame, () => window.__dz.store.selectedObjects().map(o => o.x));
      assert.equal(xs.length, 2);
      assert.equal(xs[0], xs[1], `左对齐后 x 不一致：${xs}`);
      log(`对齐后 x=${xs[0]}`);
      await shot(page, '03-align');
    });

    await step('保存为 v1', async () => {
      await toolbarSave(page).click();
      const dialog = page.locator('.el-dialog').filter({ hasText: '保存三维机房项目' });
      await dialog.waitFor({ state: 'visible', timeout: 15000 });
      await dialog.locator('input').first().fill(`E2E 机房 ${Date.now()}`);
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() => /project=\d+/.test(location.search), null, { timeout: 20000 });
      projectId = Number(new URL(page.url()).searchParams.get('project'));
      assert.ok(projectId > 0);
      const { data } = await api(`/api/datacenter/twin/projects/${projectId}/`, { token });
      assert.equal(data.version, 1);
      log(`项目 id=${projectId} v${data.version}`);
    });

    await step('再次修改并保存为 v2', async () => {
      const frame = await designerFrame(page);
      await dz(frame, () => {
        const cab = window.__dz.project.objects.find(o => o.type === 'cabinet');
        window.__dz.store.translateMany([cab.id], 300, 0);
      });
      await toolbarSave(page).click();
      let data = null;
      for (let i = 0; i < 80; i += 1) {
        const response = await api(`/api/datacenter/twin/projects/${projectId}/`, { token });
        data = response.data;
        if (data.version >= 2) break;
        await page.waitForTimeout(250);
      }
      assert.equal(data.version, 2);
      log(`保存后 v${data.version}`);
    });

    await step('版本冲突弹窗：另存为副本 vs 加载最新', async () => {
      const { data: current } = await api(`/api/datacenter/twin/projects/${projectId}/content/`, { token });
      const project = typeof current === 'string' ? JSON.parse(current) : current;
      project.objects.push({
        id: `e2e-vent-${Date.now()}`, type: 'vent', x: 500, y: 500, props: { w: 600, d: 600, name: '外部改动' },
      });
      const advanced = await api(`/api/datacenter/twin/projects/${projectId}/`, {
        token, method: 'PUT', body: { project, base_version: 2 },
      });
      assert.equal(advanced.status, 200, JSON.stringify(advanced.data));

      const frame = await designerFrame(page);
      await dz(frame, () => {
        const cab = window.__dz.project.objects.find(o => o.type === 'cabinet');
        window.__dz.store.translateMany([cab.id], -300, 0);
      });
      await toolbarSave(page).click();
      const conflict = page.locator('.el-message-box').filter({ hasText: '版本冲突' });
      await conflict.waitFor({ state: 'visible', timeout: 15000 });
      await shot(page, '04-conflict');
      await conflict.getByRole('button', { name: '加载最新' }).click();
      const externalId = project.objects[project.objects.length - 1].id;
      const after = await designerFrame(page);
      await after.waitForFunction(
        id => window.__dz.project.objects.some(o => o.id === id),
        externalId,
        { timeout: 30000 },
      );
      log('已加载服务端最新版本（含外部改动）');
    });

    await step('绑定网络设备并保存', async () => {
      const { data: targets } = await api('/api/datacenter/twin/monitor-targets/', { token });
      const deviceId = targets.items[0].id;
      const frame = await designerFrame(page);
      await dz(frame, () => {
        const cab = window.__dz.project.objects.find(o => o.type === 'cabinet');
        window.__dz.store.select(cab.id);
        return cab.id;
      });
      await frame.waitForSelector('select[data-key="monitor"]', { timeout: 10000 });
      await frame.locator('select[data-key="monitor"]').selectOption([String(deviceId)]);
      const bound = await dz(frame, () => {
        const cab = window.__dz.project.objects.find(o => o.type === 'cabinet');
        return cab.props.monitor?.deviceIds || [];
      });
      assert.deepEqual(bound, [deviceId], `绑定未写入：${JSON.stringify(bound)}`);
      await toolbarSave(page).click();
      await page.waitForTimeout(2500);
      const { data: content } = await api(`/api/datacenter/twin/projects/${projectId}/content/`, { token });
      const saved = typeof content === 'string' ? JSON.parse(content) : content;
      const savedCab = saved.objects.find(o => o.type === 'cabinet');
      assert.deepEqual(savedCab.props.monitor.deviceIds, [deviceId]);
      log(`机柜已绑定设备 ${deviceId}`);
      await shot(page, '05-binding');
    });

    await step('查看器：8 台机柜 + 实时状态环与图例', async () => {
      await page.goto(`${BASE}/datacenter/twin?project=${projectId}`, { waitUntil: 'domcontentloaded' });
      let viewerFrame = null;
      for (let i = 0; i < 120 && !viewerFrame; i += 1) {
        viewerFrame = page.frames().find(f => f.url().includes('/dc-viewer-app/') && !f.url().includes('design.html'));
        if (!viewerFrame) await page.waitForTimeout(250);
      }
      assert.ok(viewerFrame, '未找到查看器 iframe');
      await viewerFrame.waitForFunction(() => window.__dcxd && window.__dcxd.info().ready, null, { timeout: 60000 });
      const info = await viewerFrame.evaluate(() => window.__dcxd.info());
      assert.equal(info.visibility.cabinet.total, CABINETS, `机柜数 ${info.visibility.cabinet.total}`);
      // 父页面轮询 /live/ 后必须把状态推给查看器（ready 握手 + postMessage 通道）。
      await viewerFrame.waitForFunction(() => !!window.__dcxd.liveInfo(), null, { timeout: 30000 });
      const pushed = await viewerFrame.evaluate(() => window.__dcxd.liveInfo());
      const bound = Object.values(pushed.cabinets);
      assert.ok(bound.length > 0, '父页面没有把实时状态推给查看器');
      assert.ok(bound.every(item => item.status), `状态缺失：${JSON.stringify(bound)}`);
      log(`实时状态已被父页面推送：${bound.map(item => item.status).join(',')}`);

      const cabId = await viewerFrame.evaluate(() => window.__dcxd.state.project.objects
        .find(o => o.type === 'cabinet').id);
      await viewerFrame.evaluate((id) => {
        window.__dcxd.applyLive({
          generated_at: new Date().toISOString(),
          thresholds: { warning: 80, critical: 95 },
          devices: [],
          cabinets: { [id]: { status: 'warning', util: 83, device_ids: [] } },
        });
      }, cabId);
      const live = await viewerFrame.evaluate(() => window.__dcxd.liveInfo());
      assert.equal(live.cabinets[cabId].status, 'warning');
      const legend = await viewerFrame.locator('#live-legend').innerText();
      assert.match(legend, /高负载\s*1/, `图例文案：${legend}`);
      await shot(page, '06-viewer-live');
      log(`机柜 ${info.visibility.cabinet.total} 台，图例：${legend.replace(/\s+/g, ' ')}`);
    });

    await step('草稿：刷新后出现恢复横条并恢复内容', async () => {
      await page.goto(`${BASE}/datacenter/twin-design?project=${projectId}`, { waitUntil: 'domcontentloaded' });
      const frame = await waitDesigner(page);
      await frame.waitForFunction((count) => window.__dz.project.objects
        .filter(o => o.type === 'cabinet').length === count, CABINETS, { timeout: 30000 });
      await dz(frame, () => {
        const cab = window.__dz.project.objects.find(o => o.type === 'cabinet');
        window.__dz.store.translateMany([cab.id], 0, 400);
      });
      await page.waitForTimeout(2600);
      const key = await dz(frame, () => window.__dz.store.draftKey());
      const stored = await frame.evaluate(k => localStorage.getItem(k), key);
      assert.ok(stored, `草稿没有写入 ${key}`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const again = await waitDesigner(page);
      await again.waitForSelector('#dz-draft-banner:not([hidden])', { timeout: 30000 });
      await again.locator('#dz-draft-restore').click();
      const count = await again.evaluate(() => window.__dz.project.objects.filter(o => o.type === 'cabinet').length);
      assert.equal(count, CABINETS);
      const dirty = await again.evaluate(() => window.__dz.store.dirty());
      assert.equal(dirty, true, '恢复草稿后应标记为未保存');
      log('草稿已恢复并标记未保存');
      await shot(page, '07-draft');
    });

    await step('页面无 JS 异常', async () => {
      assert.deepEqual(pageErrors, []);
    });

    await writeFile(join(OUT, 'result.json'), JSON.stringify({
      base: BASE, projectId, steps, pageErrors, finishedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`\n✔ E2E 通过（${steps.length} 步），截图在 ${OUT}`);
  } catch (error) {
    await mkdir(OUT, { recursive: true });
    await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
    await writeFile(join(OUT, 'failure.json'), JSON.stringify({
      base: BASE, projectId, steps, error: String(error && error.stack || error), pageErrors,
    }, null, 2)).catch(() => {});
    console.error(`\n✖ E2E 失败：${error && error.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

run();
