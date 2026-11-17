/** 液冷风险自检：保守外包，不是规范符合性、水力或连通性结论。 */
import { normalizePipe, pipeGeometry, segmentDistance3D, segmentBoxDistance, PIPE_EPS } from './pipe-geometry.js';

import { beamEnds, roomInnerBox } from './geo.js';
import { deviceZ, isDevice } from './device.js';

export function pipeDeviceDistance(pipe, o, resolve, floorH, roomH) {
  const p = o.props || {};
  let x, y, angle, w, d, z0, z1;
  if ([ 'wall', 'tray', 'beam' ].includes(o.type)) {
    const e = o.type === 'beam' ? beamEnds(o, resolve) : o;
    x = (e.x1 + e.x2) / 2;
    y = (e.y1 + e.y2) / 2;
    angle = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
    w = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    d = o.type === 'wall' ? p.thickness || 240 : o.type === 'tray' ? p.width || 300 : p.b || 300;
    if (o.type === 'wall') {
      z0 = 0;
      z1 = p.height || roomH;
    }
    if (o.type === 'tray') {
      z0 = p.height ?? 2500;
      z1 = z0 + (p.bodyH ?? 100);
    }
    if (o.type === 'beam') {
      z1 = p.top ?? 3e3;
      z0 = z1 - (p.h ?? 600);
    }
  } else if (isDevice(o) || o.type === 'column' || o.type === 'aisle') {
    if (o.type === 'aisle' && p.enclosed === false) return Infinity;
    x = o.x;
    y = o.y;
    angle = (o.rotation || 0) * Math.PI / 180;
    w = p.w || 600;
    d = p.d || 600;
    z0 = o.type === 'column' ? -floorH : deviceZ(o);
    z1 = deviceZ(o) + (o.type === 'vent' ? 30 : p.h || 2e3);
  } else return Infinity;
  const c = Math.cos(angle), s = Math.sin(angle), local = i => {
    const dx = pipe['x' + i] - x, dy = pipe['y' + i] - y;
    return [ dx * c + dy * s, -dx * s + dy * c, pipe['z' + i] ];
  };
  return segmentBoxDistance(local(1), local(2), [ -w / 2, -d / 2, z0 ], [ w / 2, d / 2, z1 ]);
}

export function checkPipes(ctx) {
  const pipes = ctx.objs.filter(o => o.type === 'pipe'), valid = [], meta = ctx.meta || {}, roomH = +meta.roomHeight || Math.max(3000,...ctx.walls.map(o=>+o.props?.height||0)), floorH = +(meta.floorHeight ?? 400), room = roomInnerBox(ctx.walls);
  const issue = (level, o, msg, other = null, actual = '') => ctx.issues.push({
    level: level,
    rule: 'pipes',
    cat: 'cooling',
    objectIds: [ o.id, ...other ? [ other.id ] : [] ],
    actual: actual,
    expect: '有效几何 / 三维净空（保守风险）',
    msg: msg,
    x: (o.x1 + o.x2) / 2 || 0,
    y: (o.y1 + o.y2) / 2 || 0
  });
  for (const o of pipes) {
    try {
      normalizePipe(o);
      valid.push(o);
    } catch (e) {
      issue('error', o, '管道数据无效：' + e.message);
      continue;
    }
    const g = pipeGeometry(o), b = g.bounds;
    if (b.maxz > roomH || b.minz < -floorH) issue('warn', o, `管道外包超出结构空间：${b.minz.toFixed(1)}…${b.maxz.toFixed(1)} mm，参考范围 ${-floorH}…${roomH} mm（保守范围）`);
    if (b.minz < 0 && b.maxz > -30) issue('warn', o, '管道保守外包与地板面层 [-30,0] mm 相交；需核对穿板孔洞/实际净空');
    if (room && (b.minx < room.minX || b.maxx > room.maxX || b.miny < room.minY || b.maxy > room.maxY)) issue('warn', o, '管道保守外包越出机房内空，核对穿墙/外延段设计');
    for (const obj of ctx.objs) {
      if (obj.id === o.id || obj.type === 'pipe') continue;
      if (pipeDeviceDistance(o, obj, ctx.resolve, floorH, roomH) < g.outerRadius - PIPE_EPS) issue('warn', o, `三维干涉风险：${o.props.name || o.id} 与 ${obj.props?.name || obj.type} 的保守外包相交；非自动避让/规范结论`, obj);
    }
  }
  for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) {
    const a = valid[i], b = valid[j], ga = pipeGeometry(a), gb = pipeGeometry(b);
    // 同三维端点相接是直段走向，不自动统计弯头；连接邻域不作为穿管碰撞。
    let joined = false, sameXY = false, overlapFromJoin = false;
    for (const u of [ 1, 2 ]) for (const v of [ 1, 2 ]) {
      const xy = Math.hypot(a['x' + u] - b['x' + v], a['y' + u] - b['y' + v]);
      if (xy <= PIPE_EPS) {
        if (Math.abs(a['z' + u] - b['z' + v]) <= PIPE_EPS) {
          joined = true;
          const va = [ 'x', 'y', 'z' ].map(k => a[k + (3 - u)] - a[k + u]), vb = [ 'x', 'y', 'z' ].map(k => b[k + (3 - v)] - b[k + v]);
          const cos = va.reduce((s, n, i) => s + n * vb[i], 0) / (Math.hypot(...va) * Math.hypot(...vb));
          // 同一端向同向延伸不是普通接头，是重复/重叠直管。
          if (cos > 1 - 1e-8) overlapFromJoin = true;
        } else sameXY = true;
      }
    }
    const distance = segmentDistance3D(a, b), clear = distance - ga.outerRadius - gb.outerRadius;
    if ((!joined || overlapFromJoin) && clear < -PIPE_EPS) issue('warn', a, '管段三维保守外包干涉风险（中心线距离减两外包半径），请核对', b, clear.toFixed(2) + ' mm'); else if (sameXY && !joined) issue('info', a, '端点 XY 重合但标高不同，不视为已连接', b);
  }
  if (pipes.length) issue('info', pipes[0], '液冷边界：当前仅直管几何与保守干涉风险；原空调冷量自检不覆盖液冷负荷。无温度/露点/流量/内径/流体数据，不能判断保温合规性、水力性能或端口连通性。');
}
