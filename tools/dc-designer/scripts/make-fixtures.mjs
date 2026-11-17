#!/usr/bin/env node
/**
 * 确定性生成演示 fixtures（提交产物，可重跑）：
 *   demo.json       — 参考站工勘向导同参数生成的 4 排×12 机柜 + 围墙 + 3 通道（55 对象）
 *   pipes.json      — demo + 桥架/液冷管（管路视图、圆弯、3D 校验）
 *   all-types.json  — demo + 16 类构件各至少 1 个（属性/检查/导出/3D 全覆盖）
 *
 * demo 的几何与参考站“12000×9000、墙厚 240、4 排、每排 12、首台 (2200,2200)、间距 0”
 * 的输出一致；其余 fixture 只追加对象，不改 demo 数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public', 'fixtures');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const uid = (() => { let n = 0; return (p) => `${p}${(++n).toString(36)}${Date.now().toString(36)}`; })();

const cabDefaults = (name, color = '') => ({
  w: 600, d: 1200, h: 2000, u: 42, power: 4, remark: '', rpdu: 2, voltage: 220, current: 32,
  sockets: [{ type: 'IEC C13', count: 16 }, { type: 'IEC C19', count: 6 }], name, color,
});
const placed = (type, x, y, rotation, props) => ({ id: uid('o'), type, x, y, rotation, props });

function extraObjects() {
  const o = [];
  o.push({ id: uid('o'), type: 'door', wallId: 'omwk8ldti0j8', t: 0.5,
    props: { width: 1500, height: 2700, swing: 'left', side: 'out', leaf: 'double', name: '机房门-1' } });
  o.push({ id: uid('o'), type: 'window', wallId: 'omwk8ldti0j8', t: 0.22,
    props: { width: 1500, height: 1500, sill: 900, name: '窗-1' } });
  o.push({ id: uid('o'), type: 'grille', wallId: 'omwk8ldti0j8', t: 0.78,
    props: { width: 2500, height: 2750, sill: 10, kind: '送风', name: '格栅-1' } });
  o.push(placed('column', 1400, 6000, 0, { w: 800, d: 800, h: 3000, name: '柱-1' }));
  o.push(placed('column', 11200, 6000, 0, { w: 800, d: 800, h: 3000, name: '柱-2' }));
  o.push({ id: uid('o'), type: 'beam', x1: 1400, y1: 6000, x2: 11200, y2: 6000, col1: null, col2: null,
    props: { b: 300, h: 600, top: 3000, concrete: 'C30', kind: '框架梁', remark: '', name: '梁-1' } });
  o.push(placed('ups', 10600, 2200, 0, { upsType: '工频机', w: 800, d: 800, h: 2000, kva: 200, power: 160,
    voltage: 380, current: 400, backup: 15, redundancy: '', remark: '', name: 'UPS-1' }));
  o.push(placed('battery', 10600, 3200, 0, { batType: '阀控铅酸', w: 800, d: 800, h: 2000, ah: 100, cells: 32,
    voltage: 384, remark: '', name: '电池-1' }));
  o.push(placed('dbox', 11400, 4200, 90, { w: 600, d: 400, h: 1600, purpose: '机柜配电', mount: '落地',
    voltage: 380, current: 63, circuits: 12, remark: '', name: '配电箱-1' }));
  o.push(placed('pdu', 10600, 8000, 90, { w: 600, d: 1200, h: 2000, voltage: 380, current: 250, remark: '', name: 'PDU-1' }));
  o.push(placed('ac', 11200, 7600, 270, { acType: '房间级精密空调', w: 2500, d: 1300, h: 2800, cool: 25,
    air: 2800, temp: 18, supply: '水平送风', remark: '', name: '空调-1' }));
  o.push(placed('extinguisher', 1500, 8400, 0, { extType: '手提式干粉', w: 400, d: 400, h: 1200, kg: 5, remark: '', name: '灭火器-1' }));
  o.push(placed('vent', 1500, 4000, 0, { w: 600, d: 600, kind: '格栅', air: 1000, remark: '', name: '风口-1' }));
  o.push({ id: uid('o'), type: 'tray', x1: 2200, y1: 5650, x2: 8800, y2: 5650,
    props: { width: 300, height: 2500, bodyH: 100, kind: '弱电', name: '桥架-弱电-1' } });
  o.push({ id: uid('o'), type: 'tray', x1: 2200, y1: 5650, x2: 2200, y2: 8600,
    props: { width: 300, height: 2350, bodyH: 100, kind: '强电', name: '桥架-强电-1' } });
  o.push({ id: uid('o'), type: 'pipe', x1: 2400, y1: 3400, z1: 2600, x2: 2400, y2: 8000, z2: 2600,
    props: { nominalSize: 'DN50', outsideDiameter: 60.3, wallThickness: 2, insulationThickness: 20,
      material: 'stainless-steel-304', color: '', loopSide: 'secondary', side: 'supply',
      flowDirection: 'forward', remark: '', name: '液冷管-1' } });
  o.push({ id: uid('o'), type: 'pipe', x1: 2800, y1: 3400, z1: 2600, x2: 2800, y2: 3400, z2: 3200,
    props: { nominalSize: 'DN25', outsideDiameter: 33.4, wallThickness: 2.77, insulationThickness: 0,
      material: 'stainless-steel-304', color: '', loopSide: 'secondary', side: 'return',
      flowDirection: 'forward', remark: '', name: '液冷管-2' } });
  o.push(placed('aisle', 5500, 6100, 0, { kind: 'hot', w: 6600, d: 900, h: 2000, enclosed: false,
    endDoors: 'both', doorType: 'sliding', doorW: 0, name: '热通道-2' }));
  return o;
}

export function makeFixtures() {
  const demo = read('demo.json');
  const pipes = { name: '机房-管路示例', meta: { ...demo.meta }, objects: JSON.parse(JSON.stringify(demo.objects)) };
  pipes.objects.push(...extraObjects().filter(o => ['tray', 'pipe', 'column', 'beam', 'vent'].includes(o.type)));
  const allTypes = { name: '机房-全构件示例', meta: { ...demo.meta }, objects: JSON.parse(JSON.stringify(demo.objects)).concat(extraObjects()) };
  fs.writeFileSync(path.join(dir, 'pipes.json'), JSON.stringify(pipes, null, 2));
  fs.writeFileSync(path.join(dir, 'all-types.json'), JSON.stringify(allTypes, null, 2));
  return { demo: demo.objects.length, pipes: pipes.objects.length, allTypes: allTypes.objects.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(makeFixtures()));
}
