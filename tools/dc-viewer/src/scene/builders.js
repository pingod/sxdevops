/**
 * 机房三维构建：由只读项目数据生成场景（不回写任何编辑数据）。
 *
 * 约定：每个数据对象一个 THREE.Group（group.userData.obj = o），组是合并/拾取/隔离/
 * 爆炸/线稿的边界；组内坐标 mm，放置对象局部正面 = +Z（对应 2D 局部 -Y）。
 */
import * as THREE from 'three/webgpu';
import { beamEnds } from '../data/sanitize.js';
import {
  M, S, rep,
  floorTex, ceilTex, ceilGridTex, wallTex, concreteTex, ventGrilleTex, ventPerfTex, meshTrayTex,
  rackPerfMat, rackColFaceMat, rackLedMat, rackBodyMat, rackFrameMat,
} from './materials.js';

const rad = d => ((d || 0) * Math.PI) / 180;

const TRAY_COLORS = { 强电: 0xc0392b, 弱电: 0x2980b9, 光纤: 0x27ae60 };

/* ---------- 基础件 ---------- */

/** 对象分组（合并/拾取边界） */
function objGroup(g, o) {
  const grp = new THREE.Group();
  grp.userData.obj = o;
  g.add(grp);
  return grp;
}

/** 世界盒体：w/h/d 单位 mm；(x,z) = 2D 世界中心（z 即项目 y），y0 = 底面距地 */
function box(g, mat, w, h, d, x, y0, z, ry = 0, cast = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w * S, h * S, d * S), mat);
  m.position.set(x * S, (y0 + h / 2) * S, -z * S);
  m.rotation.y = ry;
  m.castShadow = cast;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

/** 沿墙盒体：a..b 为沿墙距离，y0..y1 为高度区间，thk 为厚度 */
function wallBox(g, mat, w, ux, uy, a, b, y0, y1, thk, cast = true) {
  if (b - a <= 0 || y1 - y0 <= 0) return null;
  const cx = w.x1 + ux * (a + b) / 2;
  const cy = w.y1 + uy * (a + b) / 2;
  const m = new THREE.Mesh(new THREE.BoxGeometry((b - a) * S, (y1 - y0) * S, thk * S), mat);
  m.position.set(cx * S, ((y0 + y1) / 2) * S, -cy * S);
  m.rotation.y = Math.atan2(uy, ux);
  m.castShadow = cast;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

/** 被放置对象组：定位 (x,y) + rotation，组内局部 mm */
function placed(g, o) {
  const grp = new THREE.Group();
  grp.position.set(o.x * S, 0, -o.y * S);
  grp.rotation.y = rad(o.rotation);
  g.add(grp);
  return grp;
}

/** 组内局部盒体 */
function lbox(grp, mat, w, h, d, lx, ly0, lz, cast = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w * S, h * S, d * S), mat);
  m.position.set(lx * S, (ly0 + h / 2) * S, lz * S);
  m.castShadow = cast;
  m.receiveShadow = true;
  grp.add(m);
  return m;
}

/* ---------- 墙体（含门窗/格栅开洞） ---------- */
function buildWall(g, w, ops, roomH) {
  const L = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
  if (L < 1) return;
  const ux = (w.x2 - w.x1) / L;
  const uy = (w.y2 - w.y1) / L;
  const th = w.props.thickness || 240;
  const h = w.props.height || roomH;
  const kind = w.props.material || '砖墙';
  const isGlass = kind === '玻璃隔断';
  let wm;
  if (isGlass) wm = M.glass;
  else if (kind === '混凝土') {
    wm = new THREE.MeshStandardMaterial({ map: rep(concreteTex, L / 1200, h / 1200), roughness: 0.95, metalness: 0 });
  } else if (kind === '轻钢龙骨') {
    wm = new THREE.MeshStandardMaterial({ color: 0xf2efe9, roughness: 0.9, metalness: 0 });
  } else {
    wm = new THREE.MeshStandardMaterial({ map: rep(wallTex, L / 1200, h / 1200), roughness: 0.85, metalness: 0.05 });
  }
  const wcast = !isGlass;

  // 洞口区间（沿墙距离），重叠合并
  const ivs = ops
    .map(o => {
      const half = (o.props.width || 900) / 2;
      const c = o.t * L;
      return { a: Math.max(0, c - half), b: Math.min(L, c + half), o };
    })
    .sort((p, q) => p.a - q.a);
  const merged = [];
  for (const iv of ivs) {
    const last = merged[merged.length - 1];
    if (last && iv.a <= last.b) {
      last.b = Math.max(last.b, iv.b);
      last.list.push(iv.o);
    } else {
      merged.push({ a: iv.a, b: iv.b, list: [iv.o] });
    }
  }

  // 墙体实体段 = 洞口补集
  let cur = 0;
  for (const m of merged) {
    if (m.a > cur) wallBox(g, wm, w, ux, uy, cur, m.a, 0, h, th, wcast);
    cur = Math.max(cur, m.b);
  }
  if (cur < L) wallBox(g, wm, w, ux, uy, cur, L, 0, h, th, wcast);

  for (const m of merged) {
    for (const o of m.list) buildOpening(objGroup(g, o), wm, w, ux, uy, L, o, th, h, wcast);
  }
}

/** 门 / 窗 / 格栅 */
function buildOpening(g, wm, w, ux, uy, L, o, th, wallH, wcast = true) {
  const wd = o.props.width || 900;
  const c = o.t * L;
  const a = c - wd / 2;
  const b = c + wd / 2;

  if (o.type === 'door') {
    const dh = o.props.height || 2100;
    wallBox(g, wm, w, ux, uy, a, b, dh, wallH, th, wcast);
    wallBox(g, M.doorSteel, w, ux, uy, a, a + 60, 0, dh, th + 24);
    wallBox(g, M.doorSteel, w, ux, uy, b - 60, b, 0, dh, th + 24);
    wallBox(g, M.doorSteel, w, ux, uy, a, b, dh - 60, dh, th + 24);
    const leafH = dh - 90;
    const leafT = 46;
    if ((o.props.leaf || 'single') === 'double') {
      wallBox(g, M.doorSteel, w, ux, uy, a + 62, c - 3, 30, 30 + leafH, leafT);
      wallBox(g, M.doorSteel, w, ux, uy, c + 3, b - 62, 30, 30 + leafH, leafT);
      const ry = Math.atan2(uy, ux);
      for (const hc of [c - 130, c + 130]) {
        box(g, M.dark, 26, 160, 26, w.x1 + ux * hc, 980, w.y1 + uy * hc, ry, false);
      }
    } else {
      wallBox(g, M.doorSteel, w, ux, uy, a + 62, b - 62, 30, 30 + leafH, leafT);
      const hc = o.props.swing === 'right' ? a + 190 : b - 190;
      box(g, M.dark, 26, 160, 26, w.x1 + ux * hc, 980, w.y1 + uy * hc, Math.atan2(uy, ux), false);
    }
    return;
  }

  if (o.type === 'window') {
    const sill = o.props.sill ?? 900;
    const wh = o.props.height || 1500;
    wallBox(g, wm, w, ux, uy, a, b, 0, sill, th, wcast);
    wallBox(g, wm, w, ux, uy, a, b, sill + wh, wallH, th, wcast);
    wallBox(g, M.aluminum, w, ux, uy, a, a + 50, sill, sill + wh, th + 16);
    wallBox(g, M.aluminum, w, ux, uy, b - 50, b, sill, sill + wh, th + 16);
    wallBox(g, M.aluminum, w, ux, uy, a, b, sill, sill + 50, th + 16);
    wallBox(g, M.aluminum, w, ux, uy, a, b, sill + wh - 50, sill + wh, th + 16);
    wallBox(g, M.aluminum, w, ux, uy, c - 25, c + 25, sill, sill + wh, th * 0.5);
    wallBox(g, M.glass, w, ux, uy, a + 50, b - 50, sill + 50, sill + wh - 50, 10, false);
    return;
  }

  // grille：倾斜双排叶片 + 暗腔背板
  const sill = o.props.sill || 0;
  const gh = o.props.height || 1200;
  if (sill > 0) wallBox(g, wm, w, ux, uy, a, b, 0, sill, th, wcast);
  wallBox(g, wm, w, ux, uy, a, b, sill + gh, wallH, th, wcast);
  wallBox(g, M.grilleFrame, w, ux, uy, a, a + 30, sill, sill + gh, th * 0.6);
  wallBox(g, M.grilleFrame, w, ux, uy, b - 30, b, sill, sill + gh, th * 0.6);
  wallBox(g, M.grilleFrame, w, ux, uy, a, b, sill, sill + 30, th * 0.6);
  wallBox(g, M.grilleFrame, w, ux, uy, a, b, sill + gh - 30, sill + gh, th * 0.6);
  const bay0 = a + 30;
  const bay1 = b - 30;
  const y0 = sill + 30;
  const y1 = sill + gh - 30;
  wallBox(g, M.plenum, w, ux, uy, bay0, bay1, y0, y1, 12, false);
  const H = y1 - y0;
  if (H > 60 && bay1 - bay0 > 60) {
    const n = Math.max(2, Math.round(H / 110));
    const pitch = H / n;
    const off = Math.max(th / 4, 30);
    const nx = -uy;
    const ny = ux;
    const bg = new THREE.BoxGeometry((bay1 - bay0) * S, 5 * S, 56 * S);
    const tMid = (bay0 + bay1) / 2;
    const ry = Math.atan2(uy, ux);
    for (const side of [-off, off]) {
      for (let i = 0; i < n; i++) {
        const m = new THREE.Mesh(bg, M.grilleFrame);
        m.position.set(
          (w.x1 + ux * tMid + nx * side) * S,
          (y0 + pitch * (i + 0.5)) * S,
          -(w.y1 + uy * tMid + ny * side) * S,
        );
        m.rotation.order = 'YXZ';
        m.rotation.y = ry;
        m.rotation.x = 0.66;
        m.receiveShadow = true;
        g.add(m);
      }
    }
  }
}

/* ---------- 柱子 / 框架梁 ---------- */
function buildColumn(g, o, floorH) {
  const p = o.props;
  const w = p.w || 600;
  const d = p.d || 600;
  const h = p.h || 3000;
  box(g, M.concrete, w, h + floorH, d, o.x, -floorH, o.y, rad(o.rotation));
}

function buildBeam(g, o, objs) {
  const p = o.props;
  const b = +p.b > 0 ? +p.b : 300;
  const h = +p.h > 0 ? +p.h : 600;
  const top = +p.top > 0 ? +p.top : 3000;
  const e = beamEnds(o, id => objs.find(q => q.id === id) || null);
  const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  if (L < 1) return;
  const ux = (e.x2 - e.x1) / L;
  const uy = (e.y2 - e.y1) / L;
  wallBox(g, M.concrete, e, ux, uy, 0, L, top - h, top, b);
}

/* ---------- 机柜 ---------- */
function rackDoor(w, footH, topY, hex, frameMat) {
  const g = new THREE.Group();
  const doorW = w - 100;
  const doorH = topY - footH - 8;
  const y0 = footH + 4;
  const beam = 20;
  const dep = 22;
  const fm = frameMat || rackFrameMat(hex);
  lbox(g, fm, doorW, beam, dep, 0, y0 + doorH - beam, -dep / 2, false);
  lbox(g, fm, doorW, beam, dep, 0, y0, -dep / 2, false);
  lbox(g, fm, beam, doorH - beam * 2, dep, -(doorW / 2 - beam / 2), y0 + beam, -dep / 2, false);
  lbox(g, fm, beam, doorH - beam * 2, dep, doorW / 2 - beam / 2, y0 + beam, -dep / 2, false);
  const mw = doorW - beam * 2;
  const mh = doorH - beam * 2;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(mw * S, mh * S), rackPerfMat(mw, mh, hex));
  mesh.position.set(0, (y0 + doorH / 2) * S, (-dep + 6) * S);
  mesh.castShadow = true;
  g.add(mesh);
  const hx = doorW / 2 - beam / 2;
  const hy = y0 + doorH * 0.52;
  lbox(g, M.handleMetal, 9, 14, 8, hx, hy - 46, 1, false);
  lbox(g, M.handleMetal, 9, 14, 8, hx, hy + 32, 1, false);
  lbox(g, M.dark, 10, 104, 10, hx, hy - 42, 9, false);
  return { g, mw, mh, yc: y0 + doorH / 2, zBack: -dep - 16 };
}

function buildCabinet(g, o) {
  const p = o.props;
  const w = p.w || 600;
  const d = p.d || 1200;
  const h = p.h || 2000;
  const grp = placed(g, o);
  const footH = 30;
  const pt = 14;
  const cs = 40;
  const capH = 28;
  const topY = h - capH;
  const zF = d / 2 - 4;
  const hex = p.color || '';
  const bodyMat = rackBodyMat(hex);
  const frameMat = rackFrameMat(hex);
  const colSideMat = rackFrameMat(hex, 'col');

  lbox(grp, bodyMat, pt, topY - footH, d - 70, -(w / 2 - pt / 2 - 4), footH, 0);
  lbox(grp, bodyMat, pt, topY - footH, d - 70, w / 2 - pt / 2 - 4, footH, 0);
  lbox(grp, bodyMat, w - 16, pt, d - 70, 0, footH, 0);
  lbox(grp, bodyMat, w - 2, capH, d - 10, 0, topY, 0);

  const colH = topY - footH;
  const colGeo = new THREE.BoxGeometry(cs * S, colH * S, cs * S);
  const colFace = rackColFaceMat(colH, hex);
  const colMats = [colSideMat, colSideMat, colSideMat, colSideMat, colFace, colFace];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const c = new THREE.Mesh(colGeo, colMats);
      c.position.set(sx * (w / 2 - 4 - cs / 2) * S, (footH + colH / 2) * S, sz * (zF - cs / 2) * S);
      c.castShadow = false;
      c.receiveShadow = true;
      grp.add(c);
    }
  }

  const fd = rackDoor(w, footH, topY, hex, frameMat);
  fd.g.position.z = zF * S;
  grp.add(fd.g);
  const led = new THREE.Mesh(new THREE.PlaneGeometry(fd.mw * S, fd.mh * S), rackLedMat(fd.mh));
  led.position.set(0, fd.yc * S, (zF + fd.zBack) * S);
  grp.add(led);
  const bd = fd.g.clone();
  bd.rotation.y = Math.PI;
  bd.position.z = -zF * S;
  grp.add(bd);
  const inner = new THREE.Mesh(new THREE.PlaneGeometry(fd.mw * S, fd.mh * S), M.rackInner);
  inner.rotation.y = Math.PI;
  inner.position.set(0, fd.yc * S, -(zF + fd.zBack) * S);
  grp.add(inner);

  for (const fx of [-1, 1]) {
    for (const fz2 of [-1, 1]) {
      lbox(grp, M.dark, 56, footH, 56, fx * (w / 2 - 52), 0, fz2 * (d / 2 - 52), false);
    }
  }
}

/* ---------- 列头柜 ---------- */
function buildPdu(g, o) {
  const p = o.props;
  const w = p.w || 600;
  const d = p.d || 1200;
  const h = p.h || 2000;
  const grp = placed(g, o);
  lbox(grp, M.pduBody, w - 30, h - 60, d - 70, 0, 30, 0);
  lbox(grp, M.pduBody, w - 8, 28, d - 16, 0, h - 28, 0);
  const fz = d / 2 - 16;
  lbox(grp, M.dark, w - 70, h - 160, 18, 0, 70, fz);
  lbox(grp, M.acScreen, Math.min(180, w - 160), 120, 6, 0, h - 340, fz + 12, false);
  lbox(grp, M.pduStripe, w - 8, 40, 6, 0, h - 120, fz + 10, false);
  lbox(grp, M.dark, 14, (h - 160) * 0.5, 14, (w - 70) / 2 - 18, 70 + (h - 160) * 0.2, fz + 16, false);
  for (const fx of [-1, 1]) {
    for (const fz2 of [-1, 1]) {
      lbox(grp, M.dark, 56, 30, 56, fx * (w / 2 - 52), 0, fz2 * (d / 2 - 52), false);
    }
  }
}

/* ---------- 精密空调 ---------- */
function buildAC(g, o) {
  const p = o.props;
  const w = p.w || 1000;
  const d = p.d || 800;
  const h = p.h || 2000;
  const grp = placed(g, o);
  lbox(grp, M.acBody, w, h, d, 0, 0, 0);
  const fz = d / 2 + 2;
  lbox(grp, M.acPanel, w - 70, h * 0.4, 18, 0, h * 0.55, fz);
  const fr = Math.min(w, h * 0.4) * 0.19;
  const n = w >= 900 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const fx = n === 1 ? 0 : i === 0 ? -w * 0.22 : w * 0.22;
    const fan = new THREE.Mesh(new THREE.CylinderGeometry(fr * S, fr * S, 14 * S, 28), M.dark);
    fan.rotation.x = Math.PI / 2;
    fan.position.set(fx * S, h * 0.75 * S, (fz + 8) * S);
    grp.add(fan);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(fr * 0.22 * S, fr * 0.22 * S, 18 * S, 12), M.steel);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(fx * S, h * 0.75 * S, (fz + 10) * S);
    grp.add(hub);
  }
  lbox(grp, M.acPanel, w - 90, h * 0.46, 14, 0, 40, fz);
  lbox(grp, M.acScreen, 130, 90, 6, -w / 2 + 120, h * 0.48, fz + 8, false);
  lbox(grp, M.dark, w - 40, 40, d - 40, 0, 0, 0, false);
}

/* ---------- UPS ---------- */
function buildUPS(g, o) {
  const p = o.props;
  const w = p.w || 800;
  const d = p.d || 800;
  const h = p.h || 2000;
  const grp = placed(g, o);
  lbox(grp, M.upsBody, w - 20, h - 60, d - 20, 0, 30, 0);
  lbox(grp, M.upsBody, w - 4, 28, d - 8, 0, h - 28, 0);
  const fz = d / 2 - 12;
  lbox(grp, M.dark, w - 76, h - 140, 18, 0, 70, fz);
  lbox(grp, M.acScreen, Math.min(240, w - 180), 130, 6, 0, h - 320, fz + 11, false);
  lbox(grp, M.upsStripe, w - 12, 36, 6, 0, h - 130, fz + 9, false);
  for (let i = 0; i < 3; i++) {
    lbox(grp, M.upsBody, w - 130, 14, 8, 0, h * 0.42 - i * 120, fz + 10, false);
    lbox(grp, M.dark, w - 190, 6, 6, 0, h * 0.42 - i * 120 - 26, fz + 10, false);
  }
  lbox(grp, M.dark, 14, (h - 140) * 0.4, 14, (w - 76) / 2 - 16, 70 + (h - 140) * 0.25, fz + 15, false);
  for (const fx of [-1, 1]) {
    for (const fz2 of [-1, 1]) {
      lbox(grp, M.dark, 56, 30, 56, fx * (w / 2 - 52), 0, fz2 * (d / 2 - 52), false);
    }
  }
}

/* ---------- 蓄电池 ---------- */
function buildBattery(g, o) {
  const p = o.props;
  const w = p.w || 800;
  const d = p.d || 800;
  const h = p.h || 2000;
  const grp = placed(g, o);
  lbox(grp, M.batBody, w - 20, h - 60, d - 20, 0, 30, 0);
  lbox(grp, M.batBody, w - 4, 28, d - 8, 0, h - 28, 0);
  const fz = d / 2 - 12;
  const tiers = 3;
  const perRow = Math.max(2, Math.floor((w - 120) / 180));
  for (let i = 0; i < tiers; i++) {
    const ty = h * 0.3 + i * (h * 0.24);
    lbox(grp, M.dark, w - 60, 16, d - 90, 0, ty - 46, 0, false);
    for (let j = 0; j < perRow; j++) {
      const cx = (j - (perRow - 1) / 2) * 180;
      lbox(grp, M.batCell, 150, 120, d - 160, cx, ty, 0, false);
      lbox(grp, M.batPole, 24, 16, 24, cx - 40, ty + 120, fz - 60, false);
      lbox(grp, M.batPole, 24, 16, 24, cx + 40, ty + 120, fz - 60, false);
    }
  }
  lbox(grp, M.upsStripe, w - 12, 36, 6, 0, h - 130, fz + 9, false);
  for (const fx of [-1, 1]) {
    for (const fz2 of [-1, 1]) {
      lbox(grp, M.dark, 56, 30, 56, fx * (w / 2 - 52), 0, fz2 * (d / 2 - 52), false);
    }
  }
}

/* ---------- 液冷管（设计器 union：真实管径圆柱，保温层计入外半径） ---------- */
function buildPipe(g, o) {
  const p = o.props || {};
  const od = Math.abs(+p.outsideDiameter) || 60.3;
  const ins = Math.max(0, +p.insulationThickness || 0);
  const r = (od / 2 + ins) * S;
  const a = new THREE.Vector3(o.x1 * S, (+o.z1 || 0) * S, -o.y1 * S);
  const b = new THREE.Vector3(o.x2 * S, (+o.z2 || 0) * S, -o.y2 * S);
  const len = a.distanceTo(b);
  if (!(len > 1e-6)) return;
  const color = p.color ? p.color : (p.side === 'return' ? 0xc64634 : 0x2f6fb2);
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: ins > 0 ? 0.86 : 0.34, metalness: ins > 0 ? 0.03 : 0.48,
  });
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 20, 1), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  m.castShadow = od + 2 * ins >= 80;
  m.receiveShadow = true;
  g.add(m);
}

/* ---------- 配电箱（dbox）：柜体 + 深色检修面 + 铜金标识条 ---------- */
function buildDbox(g, o) {
  const p = o.props || {};
  const w = Math.abs(+p.w) || 600;
  const d = Math.abs(+p.d) || 400;
  const h = Math.abs(+p.h) || 1600;
  const grp = placed(g, o);
  lbox(grp, M.pduBody, w - 20, h - 40, d - 30, 0, 20, 0);
  lbox(grp, M.pduBody, w - 6, 24, d - 10, 0, h - 24, 0);
  const fz = d / 2 - 10;
  lbox(grp, M.dark, w - 70, h - 140, 16, 0, 60, fz);
  lbox(grp, M.pduStripe, w - 10, 34, 6, 0, h - 110, fz + 10, false);
  lbox(grp, M.acScreen, Math.min(140, w - 160), 90, 5, 0, h - 300, fz + 11, false);
  for (const fx of [-1, 1]) for (const fz2 of [-1, 1]) {
    lbox(grp, M.dark, 50, 20, 50, fx * (w / 2 - 45), 0, fz2 * (d / 2 - 45), false);
  }
}

/* ---------- 灭火器 ---------- */
function buildExtinguisher(g, o) {
  const p = o.props;
  const w = p.w || 400;
  const d = p.d || 400;
  const h = p.h || 1200;
  const grp = placed(g, o);
  const r = Math.min(w, d) * 0.28;
  const bodyH = h * 0.68;
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r * S, r * S, bodyH * S, 20), M.extBody);
  cyl.position.set(0, (bodyH / 2 + 30) * S, 0);
  cyl.castShadow = true;
  cyl.receiveShadow = true;
  grp.add(cyl);
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(r * 0.7 * S, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    M.extBody,
  );
  cap.position.set(0, (bodyH + 30) * S, 0);
  cap.castShadow = true;
  grp.add(cap);
  lbox(grp, M.dark, r * 1.7, 30, r * 1.7, 0, 0, 0, false);
  lbox(grp, M.extHose, r * 0.5, 60, r * 0.5, 0, bodyH + 30, 0, false);
  lbox(grp, M.extHose, r * 2.2, 22, r * 0.5, -r * 0.4, bodyH + 90, 0, false);
  lbox(grp, M.extHose, r * 0.36, h * 0.34, r * 0.36, -r * 1.35, bodyH - h * 0.3, 0, false);
}

/* ---------- 地板出风口 ---------- */
function buildVent(g, o) {
  const p = o.props;
  const w = p.w || 600;
  const d = p.d || 600;
  const tex = (p.kind || '格栅') === '孔板' ? ventPerfTex : ventGrilleTex;
  const grp = placed(g, o);
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w * S, 16 * S, d * S),
    new THREE.MeshStandardMaterial({ map: rep(tex, w / 600, d / 600), color: 0xffffff, roughness: 0.85, metalness: 0 }),
  );
  m.position.y = 8 * S + 2 * S;
  m.receiveShadow = true;
  grp.add(m);
}

/* ---------- 桥架 ---------- */
function buildTray(g, o, ceilH) {
  const L = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
  if (L < 1) return;
  const ux = (o.x2 - o.x1) / L;
  const uy = (o.y2 - o.y1) / L;
  const nx = -uy;
  const ny = ux;
  const w = o.props.width || 300;
  const hh = o.props.height || 2500;
  const bh = o.props.bodyH || 100;
  const ry = Math.atan2(uy, ux);
  const off = (t, side) => ({ x: o.x1 + ux * t + nx * side, y: o.y1 + uy * t + ny * side });
  const grp = new THREE.Group();
  const c = off(L / 2, 0);
  grp.position.set(c.x * S, 0, -c.y * S);
  grp.rotation.y = ry;
  g.add(grp);

  for (const side of [-w / 2 + 3, w / 2 - 3]) {
    lbox(grp, M.steel, L, 6, 6, 0, hh, side, false);
    lbox(grp, M.steel, L, 6, 6, 0, hh + bh - 6, side, false);
  }
  const meshMat = (rx, ry2) => new THREE.MeshStandardMaterial({
    map: rep(meshTrayTex, rx, ry2), alphaTest: 0.2, roughness: 0.4, metalness: 0.85, side: THREE.DoubleSide,
  });
  for (const side of [-w / 2 + 3, w / 2 - 3]) {
    const wm = new THREE.Mesh(new THREE.PlaneGeometry(L * S, (bh - 6) * S), meshMat(L / 100, (bh - 6) / 100));
    wm.position.set(0, (hh + bh / 2) * S, side * S);
    wm.receiveShadow = true;
    grp.add(wm);
  }
  const bm = new THREE.Mesh(new THREE.PlaneGeometry(L * S, (w - 6) * S), meshMat(L / 100, (w - 6) / 100));
  bm.rotation.x = -Math.PI / 2;
  bm.position.set(0, (hh + 3) * S, 0);
  bm.receiveShadow = true;
  grp.add(bm);

  const col = TRAY_COLORS[o.props.kind] || 0x8e44ad;
  const stripe = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.3 });
  const stH = Math.min(Math.max(bh * 0.2, 10), 30);
  for (const side of [-w / 2 - 1, w / 2 + 1]) {
    const p = off(L / 2, side);
    box(g, stripe, L, stH, 3, p.x, hh + bh - stH, p.y, ry, false);
  }
  for (let t = 600; t < L && ceilH > hh + 60; t += 2400) {
    const p = off(t, 0);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(5 * S, 5 * S, (ceilH - hh) * S, 8), M.steel);
    rod.position.set(p.x * S, (hh + (ceilH - hh) / 2) * S, -p.y * S);
    g.add(rod);
  }
}

/* ---------- 通道带 ---------- */
function buildAisle(g, o, cabH = 2000) {
  const cold = (o.props.kind || 'cold') === 'cold';
  const col = cold ? 0x2f6fb2 : 0xc0392b;
  const enclosed = o.props.enclosed !== false;
  const w = o.props.w || 1000;
  const d = o.props.d || 1200;
  const mat = new THREE.MeshStandardMaterial({
    color: col, transparent: true, opacity: 0.14, roughness: 0.9, metalness: 0,
  });
  const band = box(g, mat, w, 26, d, o.x, 2, o.y, rad(o.rotation), false);
  band.material.depthWrite = false;

  const grp = placed(g, o);
  const edge = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.1 });
  const ew = 90;
  for (const sz of [-1, 1]) lbox(grp, edge, w, 4, ew, 0, 30, sz * (d / 2 - ew / 2), false);
  if (enclosed) {
    for (const sx of [-1, 1]) lbox(grp, edge, ew, 4, d - ew * 2, sx * (w / 2 - ew / 2), 30, 0, false);
  }

  if (!enclosed) return;
  const hh = +o.props.h > 0 ? +o.props.h : cabH;
  const doorH = Math.min(hh, cabH);
  const transom = hh - doorH > 60;
  const dH = transom ? doorH : hh;
  const ed = o.props.endDoors || 'both';
  const dtype = o.props.doorType || 'sliding';
  const ow = +o.props.doorW > 0 ? Math.min(+o.props.doorW, d) : d;
  const sw = (d - ow) / 2;

  const roof = lbox(grp, M.glass, w, 24, d, 0, hh, 0, false);
  roof.receiveShadow = false;
  const glass = (th, gh, gx, gy0, gz, gw) => {
    const m = lbox(grp, M.glass, th, gh, gw, gx, gy0, gz, false);
    m.receiveShadow = false;
    return m;
  };
  for (const sx of [-1, 1]) {
    const hasDoor = ed === 'both' || (ed === 'one' && sx === -1);
    const ex = sx * (w / 2 - 20);
    if (!hasDoor) glass(40, dH, ex, 0, 0, d);
    else {
      if (sw > 1) {
        for (const sz of [-1, 1]) glass(40, dH, ex, 0, sz * (ow / 2 + sw / 2), sw);
      }
      if (dtype === 'sliding') {
        const lw = ow / 2 + 60;
        glass(24, dH, ex - sx * 25, 0, -(ow / 4 - 30), lw);
        glass(24, dH, ex + sx * 25, 0, ow / 4 - 30, lw);
      } else if (dtype === 'double') {
        for (const sz of [-1, 1]) glass(40, dH, ex, 0, (sz * ow) / 4, ow / 2);
      } else glass(40, dH, ex, 0, 0, ow);
    }
    if (transom) glass(40, hh - doorH, ex, doorH, 0, d);
  }

  const fs = 50;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      lbox(grp, M.aluminum, fs, hh, fs, sx * (w / 2 - fs / 2), 0, sz * (d / 2 - fs / 2), false);
    }
  }
  for (const sz of [-1, 1]) lbox(grp, M.aluminum, w, 36, fs, 0, hh - 6, sz * (d / 2 - fs / 2), false);
  for (const sx of [-1, 1]) {
    const hasDoor = ed === 'both' || (ed === 'one' && sx === -1);
    lbox(grp, M.aluminum, fs, 36, d, sx * (w / 2 - fs / 2), hh - 6, 0, false);
    if (transom) lbox(grp, M.aluminum, fs, 36, d, sx * (w / 2 - fs / 2), doorH - 6, 0, false);
    if (!hasDoor) {
      lbox(grp, M.aluminum, fs, 24, d, sx * (w / 2 - fs / 2), 0, 0, false);
      continue;
    }
    if (dtype === 'double') lbox(grp, M.aluminum, fs, hh, fs, sx * (w / 2 - fs / 2), 0, 0, false);
    if (dtype === 'sliding') lbox(grp, M.aluminum, fs, 24, ow, sx * (w / 2 - fs / 2), 0, 0, false);
    const hx = dtype === 'sliding' ? sx * (w / 2 + 24) : sx * (w / 2 + 6);
    const hz = dtype === 'single'
      ? [Math.max(60, ow / 2 - 100)]
      : dtype === 'sliding'
        ? [-40, 40]
        : [-Math.min(90, ow / 4), Math.min(90, ow / 4)];
    for (const z of hz) lbox(grp, M.dark, 14, 220, 14, hx, 950, z, false);
  }
}

/* ---------- 吊顶 ---------- */
function buildCeiling(g, b, ceilH) {
  const W = b.maxx - b.minx;
  const D = b.maxy - b.miny;
  const cx = (b.minx + b.maxx) / 2;
  const cy = (b.miny + b.maxy) / 2;
  const geo = new THREE.PlaneGeometry(W * S, D * S);
  const grp = objGroup(g, { id: '__ceiling', type: 'ceiling', props: { h: ceilH } });
  const down = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: rep(ceilTex, W / 600, D / 600) }));
  down.rotation.x = Math.PI / 2;
  down.position.set(cx * S, ceilH * S, -cy * S);
  grp.add(down);
  const up = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ map: rep(ceilGridTex, W / 600, D / 600), transparent: true, depthWrite: false }),
  );
  up.rotation.x = -Math.PI / 2;
  up.position.set(cx * S, ceilH * S, -cy * S);
  up.raycast = () => {};
  up.userData.noPick = true;
  grp.add(up);
  return grp;
}

/* ---------- 地板 ---------- */
function buildFloor(g, b, floorH) {
  const W = b.maxx - b.minx;
  const D = b.maxy - b.miny;
  const cx = (b.minx + b.maxx) / 2;
  const cy = (b.miny + b.maxy) / 2;
  const grp = objGroup(g, { id: '__floor', type: 'floor', props: {} });
  grp.userData.noPick = true;
  const fm = new THREE.MeshStandardMaterial({
    map: rep(floorTex, W / 600, D / 600), roughness: 0.88, metalness: 0.06,
  });
  const fl = new THREE.Mesh(new THREE.BoxGeometry(W * S, 30 * S, D * S), fm);
  fl.position.set(cx * S, -15 * S, -cy * S);
  fl.receiveShadow = true;
  grp.add(fl);
  if (floorH > 0) {
    box(grp, M.plenum, W, floorH, 60, cx, -floorH, b.maxy + 30, 0, false);
    box(grp, M.plenum, W, floorH, 60, cx, -floorH, b.miny - 30, 0, false);
    box(grp, M.plenum, 60, floorH, D, b.minx - 30, -floorH, cy, 0, false);
    box(grp, M.plenum, 60, floorH, D, b.maxx + 30, -floorH, cy, 0, false);
    box(grp, M.plenum, W + 120, 40, D + 120, cx, -floorH - 40, cy, 0, false);
  }
  return grp;
}

/**
 * 构建单个对象到 `g` 下（含自己的对象组）。
 *
 * 墙体与开洞（door/window/grille）不在这里处理：它们的几何属于所属墙的
 * 洞口切分，走 `buildWallInto`。返回 null 表示调用方应交给墙体重建。
 *
 * @param {THREE.Group} g 目标组（通常是机房根组）
 * @param {object} o 项目对象
 * @param {{objs?:object[],roomH?:number,ceilH?:number,floorH?:number,cabH?:number}} ctx
 * @returns {THREE.Group|null} 新建的对象组，未处理时返回 null
 */
export function buildObjectInto(g, o, ctx = {}) {
  const { objs = [], ceilH = 3000, floorH = 400, cabH = 2000 } = ctx;
  const grp = objGroup(g, o);
  switch (o.type) {
    case 'column': buildColumn(grp, o, floorH); break;
    case 'beam': buildBeam(grp, o, objs); break;
    case 'cabinet': buildCabinet(grp, o); break;
    case 'pdu': buildPdu(grp, o); break;
    case 'ac': buildAC(grp, o); break;
    case 'ups': buildUPS(grp, o); break;
    case 'battery': buildBattery(grp, o); break;
    case 'extinguisher': buildExtinguisher(grp, o); break;
    case 'vent': buildVent(grp, o); break;
    case 'pipe': buildPipe(grp, o); break;
    case 'dbox': buildDbox(grp, o); break;
    case 'tray': buildTray(grp, o, ceilH); break;
    case 'aisle': buildAisle(grp, o, cabH); break;
    default:
      g.remove(grp);
      return null;
  }
  return grp;
}

/**
 * 构建一面墙及其开洞，返回墙的对象组（开洞组挂在墙组下面）。
 * @returns {THREE.Group}
 */
export function buildWallInto(g, wall, objs = [], roomH = 3000) {
  const ops = objs.filter(o =>
    (o.type === 'door' || o.type === 'window' || o.type === 'grille') && o.wallId === wall.id);
  const grp = objGroup(g, wall);
  buildWall(grp, wall, ops, roomH);
  return grp;
}

/**
 * 构建整机房。
 * @returns {{group:THREE.Group,bounds:object,roomH:number,ceilH:number,floorH:number,
 *   walls:THREE.Group[],floor:THREE.Group,ceiling:THREE.Group|null}}
 */
export function buildRoom(project) {
  const g = new THREE.Group();
  const objs = project.objects || [];
  const meta = project.meta || {};
  const wallHs = objs.filter(o => o.type === 'wall').map(o => o.props.height || 0);
  const roomH = meta.roomHeight || Math.max(3000, ...wallHs);
  const chH = +meta.ceilHeight || 0;
  const hasCeil = chH > 0 && chH < roomH;
  const ceilH = hasCeil ? chH : roomH;
  const floorH = meta.floorHeight ?? 400;
  const cabH = Math.max(2000, ...objs.filter(o => o.type === 'cabinet').map(o => o.props.h || 2000));

  const b = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  const ext = (x, y) => {
    b.minx = Math.min(b.minx, x);
    b.miny = Math.min(b.miny, y);
    b.maxx = Math.max(b.maxx, x);
    b.maxy = Math.max(b.maxy, y);
  };
  for (const o of objs) {
    if (o.type === 'wall' || o.type === 'tray' || o.type === 'pipe') {
      const pr = o.type === 'pipe'
        ? (Math.abs(+(o.props && o.props.outsideDiameter)) || 60.3) / 2
          + Math.max(0, +(o.props && o.props.insulationThickness) || 0)
        : 0;
      ext(o.x1 - pr, o.y1 - pr);
      ext(o.x2 + pr, o.y2 + pr);
    } else if (o.type === 'beam') {
      const e = beamEnds(o, id => objs.find(q => q.id === id) || null);
      ext(e.x1, e.y1);
      ext(e.x2, e.y2);
    } else if (o.x !== undefined) {
      const r = Math.hypot(o.props.w || 600, o.props.d || 600) / 2;
      ext(o.x - r, o.y - r);
      ext(o.x + r, o.y + r);
    }
  }
  if (!objs.length) {
    b.minx = -3000;
    b.miny = -2000;
    b.maxx = 3000;
    b.maxy = 2000;
  }
  const pad = 900;
  b.minx -= pad;
  b.miny -= pad;
  b.maxx += pad;
  b.maxy += pad;

  const wallGroups = [];
  for (const w of objs.filter(o => o.type === 'wall')) {
    wallGroups.push(buildWallInto(g, w, objs, roomH));
  }

  const ctx = { objs, roomH, ceilH, floorH, cabH };
  for (const o of objs) buildObjectInto(g, o, ctx);

  const floorGroup = buildFloor(g, b, floorH);
  const bc = { minx: b.minx + 840, miny: b.miny + 840, maxx: b.maxx - 840, maxy: b.maxy - 840 };
  const ceilingGroup = hasCeil ? buildCeiling(g, bc, ceilH) : null;
  return { group: g, bounds: b, roomH, ceilH, floorH, walls: wallGroups, floor: floorGroup, ceiling: ceilingGroup };
}
