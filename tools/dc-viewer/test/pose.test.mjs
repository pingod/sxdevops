import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VIEW, TOP_VIEW, ISO_VIEW, VIEWPOINT,
  normalizeViewId, deriveRows, topViewPose, isoViewPose, elevationViewPose,
  elevationId, projectFrame, listViewpoints, summarizeViewpoints,
} from '../src/camera/pose.js';

const room = JSON.parse(fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/samples/room.json'),
  'utf8',
));

const NEAR = (a, b, e = 1e-9) => Math.abs(a - b) < e;

test('normalizeViewId: 俯视/轨道/立面别名', () => {
  assert.equal(normalizeViewId('top'), VIEW.TOP);
  assert.equal(normalizeViewId('plan'), VIEW.TOP);
  assert.equal(normalizeViewId('bird'), VIEW.TOP);
  assert.equal(normalizeViewId('俯视'), VIEW.TOP);
  assert.equal(normalizeViewId('orbit'), VIEW.ORBIT);
  assert.equal(normalizeViewId('3d'), VIEW.ORBIT);
  assert.equal(normalizeViewId('全景'), VIEW.ORBIT);
  assert.equal(normalizeViewId('front'), 'front');
  assert.equal(normalizeViewId('south'), 'front');
  assert.equal(normalizeViewId('南立面'), 'front');
  assert.equal(normalizeViewId('前'), 'front');
  assert.equal(normalizeViewId('north'), 'back');
  assert.equal(normalizeViewId('北立面'), 'back');
  assert.equal(normalizeViewId('left'), 'left');
  assert.equal(normalizeViewId('west'), 'left');
  assert.equal(normalizeViewId('right'), 'right');
  assert.equal(normalizeViewId('east'), 'right');
  assert.equal(normalizeViewId('东立面'), 'right');
  assert.equal(normalizeViewId(''), null);
  assert.equal(normalizeViewId(null), null);
  assert.equal(normalizeViewId('bogus'), null);
});

test('normalizeViewId: iso 四角中英文', () => {
  assert.equal(normalizeViewId('iso'), VIEW.ISO);
  assert.equal(normalizeViewId('iso-se'), VIEW.ISO + '-se');
  assert.equal(normalizeViewId('iso-sw'), VIEW.ISO + '-sw');
  assert.equal(normalizeViewId('iso-nw'), VIEW.ISO + '-nw');
  assert.equal(normalizeViewId('iso-ne'), VIEW.ISO + '-ne');
  assert.equal(normalizeViewId('axo 东南'), VIEW.ISO + '-se');
  assert.equal(normalizeViewId('等轴测-东北'), VIEW.ISO + '-ne');
  assert.equal(normalizeViewId('isometric 西南'), VIEW.ISO + '-sw');
  assert.equal(normalizeViewId('轴测西北'), VIEW.ISO + '-nw');
});

test('elevationId: 别名归一', () => {
  assert.equal(elevationId('front'), 'front');
  assert.equal(elevationId('南立面'), 'front');
  assert.equal(elevationId('北'), 'back');
  assert.equal(elevationId('right-elevation'), 'right');
  assert.equal(elevationId('bogus'), null);
});

test('topViewPose: theta=0 phi=0.01 可见范围 max(D,W/aspect)*1.08', () => {
  const bounds = { minx: 0, miny: 0, maxx: 20000, maxy: 10000 };
  const p = topViewPose(bounds, { aspect: 1 });
  assert.equal(p.theta, 0);
  assert.equal(p.phi, 0.01);
  assert.deepEqual(p.target, { x: 10, y: 0, z: -5 });
  // W=20m, D=10m, aspect=1 → visible = max(10, 20/1) * 1.08 = 21.6
  assert(NEAR(p.visible, 21.6, 1e-9));
  // r = visible / (2·tan(fov/2))，fov=45 → tan(22.5°)
  const tanHalf = Math.tan((45 * Math.PI) / 360);
  assert(NEAR(p.r, 21.6 / (2 * tanHalf), 1e-9));

  const p2 = topViewPose(bounds, { aspect: 2 });
  // W/aspect = 10 → visible = max(10, 10)*1.08 = 10.8
  assert(NEAR(p2.visible, 10.8, 1e-9));
  assert(NEAR(p2.r, 10.8 / (2 * tanHalf), 1e-9));
});

test('topViewPose: 也接受带 bounds/roomH 的场景构建对象', () => {
  const built = { bounds: { minx: 0, miny: 0, maxx: 20000, maxy: 10000 }, roomH: 3000 };
  const p = topViewPose(built, { aspect: 1 });
  assert(NEAR(p.visible, 21.6, 1e-9));
  assert.deepEqual(p.target, { x: 10, y: 0, z: -5 });
});

test('isoViewPose: 四角 theta 与等轴测极角', () => {
  const bounds = { minx: 0, miny: 0, maxx: 30000, maxy: 19000 };
  const expect = Math.PI / 2 - Math.atan(Math.SQRT1_2);
  for (const corner of ISO_VIEW.order) {
    const p = isoViewPose(bounds, { roomH: 3000, corner });
    assert(NEAR(p.phi, expect, 1e-9));
    assert.equal(p.corner, corner);
  }
  assert(NEAR(isoViewPose(bounds, { roomH: 3000, corner: 'se' }).theta, Math.PI / 4, 1e-9));
  assert(NEAR(isoViewPose(bounds, { roomH: 3000, corner: 'sw' }).theta, -Math.PI / 4, 1e-9));
  assert(NEAR(isoViewPose(bounds, { roomH: 3000, corner: 'nw' }).theta, (-3 * Math.PI) / 4, 1e-9));
  assert(NEAR(isoViewPose(bounds, { roomH: 3000, corner: 'ne' }).theta, (3 * Math.PI) / 4, 1e-9));
  // 默认东南角
  assert.equal(isoViewPose(bounds, { roomH: 3000 }).corner, 'se');
});

test('elevationViewPose: 四个立面 theta', () => {
  const bounds = { minx: 0, miny: 0, maxx: 30000, maxy: 19000 };
  assert(NEAR(elevationViewPose(bounds, { side: 'front', roomH: 3000 }).theta, 0, 1e-9));
  assert(NEAR(elevationViewPose(bounds, { side: 'back', roomH: 3000 }).theta, Math.PI, 1e-9));
  assert(NEAR(elevationViewPose(bounds, { side: 'left', roomH: 3000 }).theta, -Math.PI / 2, 1e-9));
  assert(NEAR(elevationViewPose(bounds, { side: 'right', roomH: 3000 }).theta, Math.PI / 2, 1e-9));
  assert(NEAR(elevationViewPose(bounds, { roomH: 3000 }).phi, Math.PI / 2 - 1e-4, 1e-9));
  // 目标在房间中心、层高中点
  const p = elevationViewPose(bounds, { side: 'front', roomH: 3000 });
  assert.deepEqual(p.target, { x: 15, y: 1.5, z: -9.5 });
});

test('projectFrame: 墙体优先，层高取墙高', () => {
  const f = projectFrame(room);
  assert.equal(f.source, 'walls');
  assert.equal(f.roomH, 3000);
  // 墙体端点包围盒
  assert(NEAR(f.minx, -212.07477675821357, 1e-6));
  assert(NEAR(f.maxx, 30238.873910822203, 1e-6));
  assert(NEAR(f.miny, 5900, 1e-9));
  assert(NEAR(f.maxy, 25120, 1e-9));
  assert(NEAR(f.cx, (f.minx + f.maxx) / 2, 1e-9));
  assert(NEAR(f.cy, (f.miny + f.maxy) / 2, 1e-9));
});

test('deriveRows: room.json 8 排 a..h 每排 19 台', () => {
  const rows = deriveRows(room);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map(r => r.key), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  for (const r of rows) assert.equal(r.count, 19);
  for (const r of rows) assert.equal(r.axis, 'y');
  // 南北向排：锚点在北端外 900mm，x 在排中心
  const a = rows[0];
  assert.equal(a.anchor.x, 3200);
  // 排最大 y = 21900 + 600 = 22500；+900 = 23400（墙内缩 400 未触发）
  assert.equal(a.anchor.y, 23400);
  assert.deepEqual(a.bbox, { minx: 2900, miny: 8100, maxx: 3500, maxy: 22500 });
});

test('deriveRows: 锚点被墙内缩 400mm 限制', () => {
  const project = {
    objects: [
      { id: 'w', type: 'wall', x1: 0, y1: 0, x2: 10000, y2: 0 },
      { id: 'w2', type: 'wall', x1: 10000, y1: 0, x2: 10000, y2: 4000 },
      { id: 'w3', type: 'wall', x1: 10000, y1: 4000, x2: 0, y2: 4000 },
      { id: 'w4', type: 'wall', x1: 0, y1: 4000, x2: 0, y2: 0 },
      { id: 'c1', type: 'cabinet', x: 1000, y: 1000, rotation: 90, props: { name: 'A01', w: 600, d: 1200 } },
      { id: 'c2', type: 'cabinet', x: 1000, y: 1600, rotation: 90, props: { name: 'A02', w: 600, d: 1200 } },
    ],
  };
  const rows = deriveRows(project);
  assert.equal(rows.length, 1);
  const a = rows[0];
  // 排 bbox maxy = 2200，+900 = 3100，但墙 maxy = 4000 → 夹到 4000-400=3600（未触发）
  // 构造更紧：把墙 maxy 设为 2500 时锚点会被夹到 2100
  const tight = { ...project, objects: [...project.objects] };
  tight.objects[2] = { ...tight.objects[2], y1: 2500, y2: 2500 };
  tight.objects[3] = { ...tight.objects[3], y1: 2500, y2: 0 };
  tight.objects[0] = { ...tight.objects[0], y2: 2500 };
  tight.objects[1] = { ...tight.objects[1], y2: 2500 };
  const t = deriveRows(tight)[0];
  assert.equal(t.anchor.y, 2100); // 2500 - 400
});

test('listViewpoints: room.json 10 条 kinds 计数', () => {
  const list = listViewpoints(room);
  const s = summarizeViewpoints(list);
  assert.equal(s.count, 10);
  assert.deepEqual(s.kinds, { entry: 1, corner: 4, aisle: 3, area: 2 });
});

test('listViewpoints: 入口在门内侧、视线朝房间中心、人眼高度', () => {
  const list = listViewpoints(room);
  const entry = list.find(v => v.kind === 'entry');
  assert.equal(entry.id, 'entry');
  assert.equal(entry.mode, 'perspective');
  assert(NEAR(entry.target.y, 0.7, 1e-9));
  const f = projectFrame(room);
  assert(NEAR(entry.target.x, f.cx * 0.001, 1e-9));
  assert(NEAR(entry.target.z, -f.cy * 0.001, 1e-9));

  // 由位姿反解相机点
  const sp = Math.sin(entry.phi);
  const cam = {
    x: entry.target.x + entry.r * sp * Math.sin(entry.theta),
    y: entry.target.y + entry.r * Math.cos(entry.phi),
    z: entry.target.z + entry.r * sp * Math.cos(entry.theta),
  };
  assert(NEAR(cam.y, VIEWPOINT.entryEye, 1e-6));
  // 视线（目标 → 相机）应指向房间中心侧：机房门在北墙内侧
  const camPy = -cam.z / 0.001;
  const toward = { x: f.cx - cam.x / 0.001, y: f.cy - camPy };
  const door = room.objects.find(o => o.type === 'door');
  const wall = room.objects.find(o => o.id === door.wallId);
  const t = door.t;
  const dpx = +wall.x1 + (+wall.x2 - +wall.x1) * t;
  const dpy = +wall.y1 + (+wall.y2 - +wall.y1) * t;
  // 相机到门点的距离 < 相机到房间中心的距离 → 相机在门内侧
  const dCamToDoor = Math.hypot(cam.x / 0.001 - dpx, camPy - dpy);
  const dCamToCenter = Math.hypot(cam.x / 0.001 - f.cx, camPy - f.cy);
  assert(dCamToDoor < dCamToCenter);
  // 视线朝房间中心（角度正对中心）
  const dot = toward.x * (f.cx - dpx) + toward.y * (f.cy - dpy);
  assert(dot > 0);
});

test('listViewpoints: 角/通道/设备区 id 与标签', () => {
  const list = listViewpoints(room);
  const ids = list.map(v => v.id);
  for (const k of ['corner-se', 'corner-sw', 'corner-nw', 'corner-ne']) {
    assert(ids.includes(k), `missing ${k}`);
  }
  assert.equal(list.filter(v => v.kind === 'aisle').length, 3);
  assert(list.some(v => v.kind === 'area' && v.label === '空调区'));
  assert(list.some(v => v.kind === 'area' && v.label === '列头柜区'));
  const corners = list.filter(v => v.kind === 'corner');
  assert(corners.every(v => v.label.endsWith('角')));
});

test('listViewpoints: 空机房退化补俯视/轴测', () => {
  const list = listViewpoints({ objects: [], meta: {} });
  assert(list.length >= VIEWPOINT.min);
  const kinds = summarizeViewpoints(list).kinds;
  assert(kinds.preset >= 1);
});
