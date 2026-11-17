/**
 * 3D 场景构建：由 2D 项目数据生成机房三维模型（只读，不回写任何编辑数据）。
 *
 * 坐标映射：2D 世界坐标毫米 mm、原点房间西南角、X 东 / Y 北；
 *          3D 场景单位米 m、Y 轴向上，映射为 x3=x·S, y3=高度·S, z3=-y·S（北 = -Z）。
 * 旋转映射：2D 逆时针角度 θ（度） → three 绕 Y 轴 rotation.y = θ（弧度），
 *          被放置对象（机柜/空调/风口/柱/通道）的 2D 局部 -y 边（正面）对应 three 局部 +Z。
 */
import * as THREE from '../../lib/three/three.webgpu.min.js';
import { beamEnds } from '../geo.js';
import { deviceZ, isDevice } from '../device.js';
import { buildDistributionBox } from './distribution-box3d.js';
import { pipeBuilder, sceneBounds } from './pipes3d.js';
import { M, S, rep, floorTex, ceilTex, ceilGridTex, wallTex, concreteTex, ventGrilleTex, ventPerfTex, meshTrayTex, rackPerfMat, rackColFaceMat, rackLedMat, rackBodyMat, rackFrameMat, deviceMat, color3D, bimFloorTex, bimCeilTex } from './materials3d.js';
import { bimPick, themeColor, flat, isBim3D } from './theme3d.js';
import { edgeBox, edgeRect } from './edges3d.js';
import { planJoints, jointPipeRisks } from './route-joints3d.js';
import { buildCurvedTray } from './tray-joints3d.js';
import { pipeDeviceDistance } from '../pipe-checks.js';

const rad = d => (d || 0) * Math.PI / 180;
const TRAY_COLORS = { '强电': 0xc0392b, '弱电': 0x2980b9, '光纤': 0x27ae60 };

/* ---------- 基础件 ---------- */
/** 对象分组：把对象的全部 Mesh 收进一个组并标注源对象（pick3d 悬停拾取沿父链找 userData.pick） */
function pickGroup(g, o) {
  const grp = new THREE.Group();
  grp.userData.pick = o;
  g.add(grp);
  return grp;
}

/** 世界盒体：w/h/d 单位 mm；(x,z) 为 2D 世界中心，y0 为底面距地 mm */
function box(g, mat, w, h, d, x, y0, z, ry = 0, cast = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w * S, h * S, d * S), mat);
  m.position.set(x * S, (y0 + h / 2) * S, -z * S);
  m.rotation.y = ry;
  m.castShadow = cast; m.receiveShadow = true;
  g.add(m);
  if (isBim3D()) edgeBox(g, m, w, h, d); // 素模风：补构件棱线（与本体同父同变换，由 merge3d 一起合并）
  return m;
}

/** 沿墙盒体：a..b 为沿墙距离（mm，自墙起点），y0..y1 为高度区间，thk 厚度 */
function wallBox(g, mat, w, ux, uy, a, b, y0, y1, thk, cast = true) {
  if (b - a <= 0 || y1 - y0 <= 0) return null;
  const cx = w.x1 + ux * (a + b) / 2, cy = w.y1 + uy * (a + b) / 2;
  const m = new THREE.Mesh(new THREE.BoxGeometry((b - a) * S, (y1 - y0) * S, thk * S), mat);
  m.position.set(cx * S, (y0 + y1) / 2 * S, -cy * S);
  m.rotation.y = Math.atan2(uy, ux);
  m.castShadow = cast; m.receiveShadow = true;
  g.add(m);
  if (isBim3D()) edgeBox(g, m, b - a, y1 - y0, thk);
  return m;
}

/** 被放置对象组：定位到 (x,y) 并按 rotation 旋转，组内局部坐标 mm（正面 = +Z） */
function placed(g, o) {
  const grp = new THREE.Group();
  grp.position.set(o.x * S, deviceZ(o) * S, -o.y * S);
  grp.rotation.y = rad(o.rotation);
  g.add(grp);
  return grp;
}

/** 组内局部盒体：lx/lz 局部中心 mm，ly0 底面 mm */
function lbox(grp, mat, w, h, d, lx, ly0, lz, cast = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w * S, h * S, d * S), mat);
  m.position.set(lx * S, (ly0 + h / 2) * S, lz * S);
  m.castShadow = cast; m.receiveShadow = true;
  grp.add(m);
  if (isBim3D()) edgeBox(grp, m, w, h, d);
  return m;
}

/* ---------- 墙体（含门窗/格栅开洞） ---------- */
function buildWall(g, w, ops, roomH) {
  const L = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
  if (L < 1) return;
  const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
  const th = w.props.thickness || 240;
  const h = w.props.height || roomH; // 默认到结构层高（楼板底，穿过吊顶面上方）
  // 按墙体属性选材质：砖墙=彩钢板贴面（默认）、混凝土=混凝土贴图、轻钢龙骨=石膏板净色、玻璃隔断=共享玻璃
  // 素模风下三种实墙材质都换成浅素色（保留材质差异的深浅层次），玻璃隔断两套共用共享玻璃材质
  const kind = w.props.material || '砖墙';
  const isGlass = kind === '玻璃隔断';
  const wm = isGlass ? M.glass : bimPick(() => {
    if (kind === '混凝土') return new THREE.MeshStandardMaterial({
      map: rep(concreteTex, L / 1200, h / 1200), roughness: .95, metalness: 0,
    });
    if (kind === '轻钢龙骨') return new THREE.MeshStandardMaterial({
      color: 0xf2efe9, roughness: .9, metalness: 0, // 石膏板净面
    });
    return new THREE.MeshStandardMaterial({
      map: rep(wallTex, L / 1200, h / 1200), roughness: .85, metalness: .05,
    });
  }, () => kind === '混凝土' ? flat(0xb4bbc2, .92)
    : kind === '轻钢龙骨' ? flat(0xd8dce0, .9) // 石膏板素色
    : flat(0xc9d0d7, .85));                    // 彩钢板素色
  const wcast = !isGlass; // 透明玻璃不投实心阴影

  // 洞口区间（沿墙距离），重叠合并（与 2D 逻辑一致）
  const ivs = ops.map(o => {
    const half = (o.props.width || 900) / 2, c = o.t * L;
    return { a: Math.max(0, c - half), b: Math.min(L, c + half), o };
  }).sort((p, q) => p.a - q.a);
  const merged = [];
  for (const iv of ivs) {
    const last = merged[merged.length - 1];
    if (last && iv.a <= last.b) { last.b = Math.max(last.b, iv.b); last.list.push(iv.o); }
    else merged.push({ a: iv.a, b: iv.b, list: [iv.o] });
  }

  // 墙体实体段（洞口的补集）
  let cur = 0;
  for (const m of merged) {
    if (m.a > cur) wallBox(g, wm, w, ux, uy, cur, m.a, 0, h, th, wcast);
    cur = Math.max(cur, m.b);
  }
  if (cur < L) wallBox(g, wm, w, ux, uy, cur, L, 0, h, th, wcast);

  for (const m of merged) for (const o of m.list) buildOpening(pickGroup(g, o), wm, w, ux, uy, L, o, th, h, wcast);
}

/** 门 / 窗 / 格栅洞口及构件（wcast：墙本体材质是否投影，玻璃隔断传 false） */
function buildOpening(g, wm, w, ux, uy, L, o, th, wallH, wcast = true) {
  const wd = o.props.width || 900;
  const c = o.t * L, a = c - wd / 2, b = c + wd / 2;

  if (o.type === 'door') {
    const dh = o.props.height || 2100;
    wallBox(g, wm, w, ux, uy, a, b, dh, wallH, th, wcast);     // 门上过梁
    // 门框
    wallBox(g, M.doorSteel, w, ux, uy, a, a + 60, 0, dh, th + 24);
    wallBox(g, M.doorSteel, w, ux, uy, b - 60, b, 0, dh, th + 24);
    wallBox(g, M.doorSteel, w, ux, uy, a, b, dh - 60, dh, th + 24);
    // 门扇（关闭状态）：单开一整扇 / 双开对半两扇，中缝居墙厚
    const leafH = dh - 90, leafT = 46;
    if ((o.props.leaf || 'single') === 'double') {
      wallBox(g, M.doorSteel, w, ux, uy, a + 62, c - 3, 30, 30 + leafH, leafT);
      wallBox(g, M.doorSteel, w, ux, uy, c + 3, b - 62, 30, 30 + leafH, leafT);
      // 拉手
      for (const hc of [c - 130, c + 130]) {
        const hx = w.x1 + ux * hc, hy = w.y1 + uy * hc;
        box(g, M.dark, 26, 160, 26, hx, 980, hy, Math.atan2(uy, ux), false);
      }
    } else {
      wallBox(g, M.doorSteel, w, ux, uy, a + 62, b - 62, 30, 30 + leafH, leafT);
      const hc = (o.props.swing === 'right' ? a + 190 : b - 190);
      box(g, M.dark, 26, 160, 26, w.x1 + ux * hc, 980, w.y1 + uy * hc, Math.atan2(uy, ux), false);
    }
  } else if (o.type === 'window') {
    const sill = o.props.sill ?? 900, wh = o.props.height || 1500;
    wallBox(g, wm, w, ux, uy, a, b, 0, sill, th, wcast);       // 窗台下墙
    wallBox(g, wm, w, ux, uy, a, b, sill + wh, wallH, th, wcast); // 窗上过梁
    // 铝框 + 中梃
    wallBox(g, M.aluminum, w, ux, uy, a, a + 50, sill, sill + wh, th + 16);
    wallBox(g, M.aluminum, w, ux, uy, b - 50, b, sill, sill + wh, th + 16);
    wallBox(g, M.aluminum, w, ux, uy, a, b, sill, sill + 50, th + 16);
    wallBox(g, M.aluminum, w, ux, uy, a, b, sill + wh - 50, sill + wh, th + 16);
    wallBox(g, M.aluminum, w, ux, uy, c - 25, c + 25, sill, sill + wh, th * 0.5);
    // 玻璃
    wallBox(g, M.glass, w, ux, uy, a + 50, b - 50, sill + 50, sill + wh - 50, 10, false);
  } else { // grille 格栅（百叶风口：真实倾斜叶片 + 大间距 + 暗腔，通风观感）
    const sill = o.props.sill || 0, gh = o.props.height || 1200;
    if (sill > 0) wallBox(g, wm, w, ux, uy, a, b, 0, sill, th, wcast);
    wallBox(g, wm, w, ux, uy, a, b, sill + gh, wallH, th, wcast);
    // 边框（白色铝合金）
    wallBox(g, M.grilleFrame, w, ux, uy, a, a + 30, sill, sill + gh, th * 0.6);
    wallBox(g, M.grilleFrame, w, ux, uy, b - 30, b, sill, sill + gh, th * 0.6);
    wallBox(g, M.grilleFrame, w, ux, uy, a, b, sill, sill + 30, th * 0.6);
    wallBox(g, M.grilleFrame, w, ux, uy, a, b, sill + gh - 30, sill + gh, th * 0.6);
    // 暗腔背板（居中薄板：叶片缝隙所见即风管暗腔，封堵洞口不透隔壁房间）
    const bay0 = a + 30, bay1 = b - 30, y0 = sill + 30, y1 = sill + gh - 30;
    wallBox(g, M.plenum, w, ux, uy, bay0, bay1, y0, y1, 12, false);
    // 倾斜叶片：墙面两侧各一排（双层百叶），≈110mm 大间距，缝隙开阔
    const H = y1 - y0;
    if (H > 60 && bay1 - bay0 > 60) {
      const n = Math.max(2, Math.round(H / 110)), pitch = H / n;
      const off = Math.max(th / 4, 30), nx = -uy, ny = ux;
      const bg = new THREE.BoxGeometry((bay1 - bay0) * S, 5 * S, 56 * S); // 叶片截面 5×56mm
      const tMid = (bay0 + bay1) / 2, ry = Math.atan2(uy, ux);
      for (const side of [-off, off]) {
        for (let i = 0; i < n; i++) {
          const m = new THREE.Mesh(bg, M.grilleFrame);
          m.position.set(
            (w.x1 + ux * tMid + nx * side) * S,
            (y0 + pitch * (i + 0.5)) * S,
            -(w.y1 + uy * tMid + ny * side) * S);
          m.rotation.order = 'YXZ';
          m.rotation.y = ry; m.rotation.x = 0.66; // ≈38° 倾角
          m.receiveShadow = true;
          g.add(m);
        }
      }
    }
  }
}

/* ---------- 柱子（自结构地面通高） ---------- */
function buildColumn(g, o, floorH) {
  const p = o.props, w = p.w || 600, d = p.d || 600, h = p.h || 3000;
  box(g, M.concrete, w, h + floorH, d, o.x, -floorH, o.y, rad(o.rotation));
}

/* ---------- 框架梁（柱间混凝土梁：矩形截面 b×h，梁顶标高 top，端点随附着柱） ---------- */
function buildBeam(g, o, objs) {
  const p = o.props, b = +p.b > 0 ? +p.b : 300, h = +p.h > 0 ? +p.h : 600;
  const top = +p.top > 0 ? +p.top : 3000;
  const e = beamEnds(o, id => objs.find(q => q.id === id) || null);
  const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  if (L < 1) return;
  const ux = (e.x2 - e.x1) / L, uy = (e.y2 - e.y1) / L;
  // 梁体：顶面与梁顶标高齐平、向下悬出梁高 h（两端伸至柱心，与柱自然相交成型）
  wallBox(g, M.concrete, e, ux, uy, 0, L, top - h, top, b);
}

/* ---------- 机柜（网孔门服务器机柜：薄板柜体 + U 位立柱 + 网孔门，正面 = 局部 +Z） ---------- */
/** 单扇网孔门：局部 x 居中、y 自柜底起，门外表面 = 局部 z0，门体向 -z 内凹。
 *  hex=机柜柜色（'' = 默认柜色）→ 门框梁/网孔面按该色渲染；frameMat 可由调用侧传入复用解析结果 */
function rackDoor(w, footH, topY, hex, frameMat) {
  const g = new THREE.Group();
  const doorW = w - 100, doorH = topY - footH - 8, y0 = footH + 4; // 两侧让开 40 立柱 + 6mm 门缝
  const beam = 20, dep = 22;                                       // 门梁宽 / 门厚
  const fm = frameMat || rackFrameMat(hex);
  // 门框梁不投影：紧贴柜体前/后缘，影子落在柜体自身影子里（柜顶盖 + 侧板已构成完整轮廓），
  // 但每台机柜能省下 8 个（前后门各 4）阴影 pass 的 draw call
  lbox(g, fm, doorW, beam, dep, 0, y0 + doorH - beam, -dep / 2, false);                          // 上梁
  lbox(g, fm, doorW, beam, dep, 0, y0, -dep / 2, false);                                         // 下梁
  lbox(g, fm, beam, doorH - beam * 2, dep, -(doorW / 2 - beam / 2), y0 + beam, -dep / 2, false); // 左梁
  lbox(g, fm, beam, doorH - beam * 2, dep, doorW / 2 - beam / 2, y0 + beam, -dep / 2, false);    // 右梁
  // 网孔面（内凹 6mm，大孔径打孔透出柜内）
  const mw = doorW - beam * 2, mh = doorH - beam * 2;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(mw * S, mh * S), rackPerfMat(mw, mh, hex));
  mesh.position.set(0, (y0 + doorH / 2) * S, (-dep + 6) * S);
  mesh.castShadow = true;
  g.add(mesh);
  // 竖拉手（右梁外侧：两个金属悬臂座 + 握把）
  const hx = doorW / 2 - beam / 2, hy = y0 + doorH * .52;
  lbox(g, M.handleMetal, 9, 14, 8, hx, hy - 46, 1, false);
  lbox(g, M.handleMetal, 9, 14, 8, hx, hy + 32, 1, false);
  lbox(g, M.dark, 10, 104, 10, hx, hy - 42, 9, false);
  return { g, mw, mh, yc: y0 + doorH / 2, zBack: -dep - 16 }; // zBack = 门后衬板局部 z
}

function buildCabinet(g, o) {
  const p = o.props, w = p.w || 600, d = p.d || 1200, h = p.h || 2000;
  const grp = placed(g, o);
  const footH = 30, pt = 14, cs = 40, capH = 28;   // 支脚高 / 板厚 / 立柱截面 / 顶盖高
  const topY = h - capH, zF = d / 2 - 4;           // 顶盖底 / 立柱与门外表面
  // 机柜颜色（属性 color，'' = 默认柜色）：柜身/门框梁/立柱/网孔门均按该色渲染，未设色时用共享默认材质
  const hex = p.color || '';
  const bodyMat = rackBodyMat(hex), frameMat = rackFrameMat(hex), colSideMat = rackFrameMat(hex, 'col');

  // 薄板柜体：两侧板 + 底板 + 顶盖（无实心盒，板缝自然）
  lbox(grp, bodyMat, pt, topY - footH, d - 70, -(w / 2 - pt / 2 - 4), footH, 0); // 左侧板
  lbox(grp, bodyMat, pt, topY - footH, d - 70, w / 2 - pt / 2 - 4, footH, 0);    // 右侧板
  lbox(grp, bodyMat, w - 16, pt, d - 70, 0, footH, 0);                           // 底板
  lbox(grp, bodyMat, w - 2, capH, d - 10, 0, topY, 0);                           // 顶盖（略外挑）

  // 四角 U 位立柱（前/后面贴安装孔条，侧面净面）
  // 不投影：立柱被柜体包在里面，影子完全落在柜体自身的影子里，但会多出 4 个阴影 pass 的 draw call
  //（机柜是数量最多的对象，阴影 pass 的开销主要在这里——大机房旋转视角时的帧率瓶颈）
  const colH = topY - footH;
  const colGeo = new THREE.BoxGeometry(cs * S, colH * S, cs * S);
  const colFace = rackColFaceMat(colH, hex);
  const colMats = [colSideMat, colSideMat, colSideMat, colSideMat, colFace, colFace];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const c = new THREE.Mesh(colGeo, colMats);
    c.position.set(sx * (w / 2 - 4 - cs / 2) * S, (footH + colH / 2) * S, sz * (zF - cs / 2) * S);
    c.castShadow = false; c.receiveShadow = true;
    grp.add(c);
  }

  // 前网孔门 + 门后设备灯板（透孔可见，按 U 行规则排布）
  const fd = rackDoor(w, footH, topY, hex, frameMat);
  fd.g.position.z = zF * S;
  grp.add(fd.g);
  const led = new THREE.Mesh(new THREE.PlaneGeometry(fd.mw * S, fd.mh * S), rackLedMat(fd.mh));
  led.position.set(0, fd.yc * S, (zF + fd.zBack) * S);
  grp.add(led);
  // 后网孔门（克隆，拉手镜像到背面右侧）+ 柜内暗腔背板（封堵透视线）
  const bd = fd.g.clone();
  bd.rotation.y = Math.PI;
  bd.position.z = -zF * S;
  grp.add(bd);
  const inner = new THREE.Mesh(new THREE.PlaneGeometry(fd.mw * S, fd.mh * S), M.rackInner);
  inner.rotation.y = Math.PI;
  inner.position.set(0, fd.yc * S, -(zF + fd.zBack) * S);
  grp.add(inner);

  // 调节支脚
  for (const fx of [-1, 1]) for (const fz2 of [-1, 1]) {
    lbox(grp, M.dark, 56, footH, 56, fx * (w / 2 - 52), 0, fz2 * (d / 2 - 52), false);
  }
}

/* ---------- 列头柜（精密配电柜：机柜同型柜体，正面监控显示屏 + 铜金配电标识条，正面 = 局部 +Z） ---------- */
function buildPdu(g, o) {
  const p = o.props, w = p.w || 600, d = p.d || 1200, h = p.h || 2000;
  const grp = placed(g, o);
  const body = deviceMat(p.color, M.pduBody), panel = deviceMat(p.color, M.dark, 'front');
  lbox(grp, body, w - 30, h - 60, d - 70, 0, 30, 0);       // 柜体
  lbox(grp, body, w - 8, 28, d - 16, 0, h - 28, 0);        // 顶盖
  const fz = d / 2 - 16;
  // 前面板（深色检修门观感）
  lbox(grp, panel, w - 70, h - 160, 18, 0, 70, fz);
  // 监控显示屏（上部，显示输入电压/电流的表位）
  lbox(grp, M.acScreen, Math.min(180, w - 160), 120, 6, 0, h - 340, fz + 12, false);
  // 铜金配电标识条（显示屏下方）
  lbox(grp, M.pduStripe, w - 8, 40, 6, 0, h - 120, fz + 10, false);
  // 前面板竖拉手
  lbox(grp, M.dark, 14, (h - 160) * .5, 14, (w - 70) / 2 - 18, 70 + (h - 160) * .2, fz + 16, false);
  // 调节支脚
  for (const fx of [-1, 1]) for (const fz2 of [-1, 1]) {
    lbox(grp, M.dark, 56, 30, 56, fx * (w / 2 - 52), 0, fz2 * (d / 2 - 52), false);
  }
}

/* ---------- 精密空调（正面 = 局部 +Z：上风机区 / 下检修门 / 显示屏） ---------- */
function buildAC(g, o) {
  const p = o.props, w = p.w || 1000, d = p.d || 800, h = p.h || 2000;
  const grp = placed(g, o);
  const body = deviceMat(p.color, M.acBody), panel = deviceMat(p.color, M.acPanel, 'front');
  lbox(grp, body, w, h, d, 0, 0, 0);
  const fz = d / 2 + 2;
  lbox(grp, panel, w - 70, h * .40, 18, 0, h * .55, fz);            // 风机面板
  const fr = Math.min(w, h * .4) * .19;                                  // 风机圆罩
  const n = w >= 900 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const fx = n === 1 ? 0 : (i === 0 ? -w * .22 : w * .22);
    const fan = new THREE.Mesh(new THREE.CylinderGeometry(fr * S, fr * S, 14 * S, 28), M.dark);
    fan.rotation.x = Math.PI / 2;
    fan.position.set(fx * S, h * .75 * S, (fz + 8) * S);
    grp.add(fan);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(fr * .22 * S, fr * .22 * S, 18 * S, 12), M.steel);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(fx * S, h * .75 * S, (fz + 10) * S);
    grp.add(hub);
  }
  lbox(grp, panel, w - 90, h * .46, 14, 0, 40, fz);                  // 下部检修门
  lbox(grp, M.acScreen, 130, 90, 6, -w / 2 + 120, h * .48, fz + 8, false); // 显示屏
  lbox(grp, M.dark, w - 40, 40, d - 40, 0, 0, 0, false);                 // 底座
}

/* ---------- UPS（不间断电源，正面 = 局部 +Z：上部监控屏 / 中部电池组标识 / 下部电池模块分层） ---------- */
function buildUPS(g, o) {
  const p = o.props, w = p.w || 800, d = p.d || 800, h = p.h || 2000;
  const grp = placed(g, o);
  const body = deviceMat(p.color, M.upsBody), panel = deviceMat(p.color, M.dark, 'front');
  lbox(grp, body, w - 20, h - 60, d - 20, 0, 30, 0);          // 柜体
  lbox(grp, body, w - 4, 28, d - 8, 0, h - 28, 0);           // 顶盖
  const fz = d / 2 - 12;
  lbox(grp, panel, w - 76, h - 140, 18, 0, 70, fz);              // 前面板（检修门）
  // 监控显示屏（上部，显示 UPS 运行状态）
  lbox(grp, M.acScreen, Math.min(240, w - 180), 130, 6, 0, h - 320, fz + 11, false);
  // 铜金电池标识条（显示屏下方，与列头柜同族但色更暖）
  lbox(grp, M.upsStripe, w - 12, 36, 6, 0, h - 130, fz + 9, false);
  // 下部电池模块分层（三道横向格栅缝 + 散热网）
  for (let i = 0; i < 3; i++) {
    lbox(grp, body, w - 130, 14, 8, 0, h * 0.42 - i * 120, fz + 10, false);
    lbox(grp, M.dark, w - 190, 6, 6, 0, h * 0.42 - i * 120 - 26, fz + 10, false);
  }
  // 前面板竖拉手
  lbox(grp, M.dark, 14, (h - 140) * .4, 14, (w - 76) / 2 - 16, 70 + (h - 140) * .25, fz + 15, false);
  // 调节支脚
  for (const fx of [-1, 1]) for (const fz2 of [-1, 1]) {
    lbox(grp, M.dark, 56, 30, 56, fx * (w / 2 - 52), 0, fz2 * (d / 2 - 52), false);
  }
}

/* ---------- 蓄电池（UPS 电池柜，正面 = 局部 +Z：开放式电池架，多排电池单元 + 铜金极柱） ---------- */
function buildBattery(g, o) {
  const p = o.props, w = p.w || 800, d = p.d || 800, h = p.h || 2000;
  const grp = placed(g, o);
  const body = deviceMat(p.color, M.batBody);
  lbox(grp, body, w - 20, h - 60, d - 20, 0, 30, 0);          // 柜体
  lbox(grp, body, w - 4, 28, d - 8, 0, h - 28, 0);           // 顶盖
  const fz = d / 2 - 12;
  // 正面开放式电池架：3 层托板，每层一排电池单元（深绿壳体 + 铜金极柱）
  const tiers = 3, perRow = Math.max(2, Math.floor((w - 120) / 180));
  for (let i = 0; i < tiers; i++) {
    const ty = h * 0.30 + i * (h * 0.24);
    lbox(grp, M.dark, w - 60, 16, d - 90, 0, ty - 46, 0, false);   // 托板
    for (let j = 0; j < perRow; j++) {
      const cx = (j - (perRow - 1) / 2) * 180;
      lbox(grp, M.batCell, 150, 120, d - 160, cx, ty, 0, false);   // 电池单元
      lbox(grp, M.batPole, 24, 16, 24, cx - 40, ty + 120, fz - 60, false); // 极柱（前部两颗）
      lbox(grp, M.batPole, 24, 16, 24, cx + 40, ty + 120, fz - 60, false);
    }
  }
  lbox(grp, M.upsStripe, w - 12, 36, 6, 0, h - 130, fz + 9, false); // 铜金标识条（电气族）
  // 调节支脚
  for (const fx of [-1, 1]) for (const fz2 of [-1, 1]) {
    lbox(grp, M.dark, 56, 30, 56, fx * (w / 2 - 52), 0, fz2 * (d / 2 - 52), false);
  }
}

/* ---------- 灭火器（红色圆柱瓶体 + 顶部压把/喷管，落地放置） ---------- */
function buildExtinguisher(g, o) {
  const p = o.props, w = p.w || 400, d = p.d || 400, h = p.h || 1200;
  const grp = placed(g, o);
  const body = deviceMat(p.color, M.extBody);
  const r = Math.min(w, d) * 0.28;              // 瓶体半径（占对象占位内）
  const bodyH = h * 0.68;                        // 瓶体高（压把/喷管占上部）
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r * S, r * S, bodyH * S, 20), body);
  cyl.position.set(0, (bodyH / 2 + 30) * S, 0);
  cyl.castShadow = true; cyl.receiveShadow = true;
  grp.add(cyl);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(r * 0.7 * S, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), body);
  cap.position.set(0, (bodyH + 30) * S, 0);      // 瓶顶半球封头
  cap.castShadow = true;
  grp.add(cap);
  lbox(grp, M.dark, r * 1.7, 30, r * 1.7, 0, 0, 0, false);                 // 底座
  lbox(grp, M.extHose, r * 0.5, 60, r * 0.5, 0, bodyH + 30, 0, false);     // 瓶口阀座
  lbox(grp, M.extHose, r * 2.2, 22, r * 0.5, -r * 0.4, bodyH + 90, 0, false); // 压把（横杆）
  lbox(grp, M.extHose, r * 0.36, h * 0.34, r * 0.36, -r * 1.35, bodyH - h * 0.3, 0, false); // 喷管（垂下一侧）
}

/* ---------- 地板出风口（静电地板面层，600 模数） ---------- */
function buildVent(g, o) {
  const p = o.props, w = p.w || 600, d = p.d || 600;
  const tex = (p.kind || '格栅') === '孔板' ? ventPerfTex : ventGrilleTex;
  const grp = placed(g, o);
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w * S, 16 * S, d * S),
    bimPick(
      () => new THREE.MeshStandardMaterial({ map: rep(tex, w / 600, d / 600), color: color3D(p.color) || 0xffffff, roughness: .85, metalness: 0 }),
      () => flat(color3D(p.color) || 0xaeb8c2, .8)));
  m.position.y = 8 * S + 2 * S;
  m.receiveShadow = true;
  grp.add(m);
  if (isBim3D()) edgeBox(grp, m, w, 16, d);
}

/* ---------- 桥架（网格桥架：钢丝网侧壁/底板 + 上下边丝 + 吊杆，顶沿类型色带） ---------- */
function buildTray(g, o, ceilH) {
  const L = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
  if (L < 1) return;
  const ux = (o.x2 - o.x1) / L, uy = (o.y2 - o.y1) / L;
  const nx = -uy, ny = ux;
  const w = o.props.width || 300, hh = o.props.height || 2500;
  const bh = o.props.bodyH || 100; // 槽体高度（默认100）
  const ry = Math.atan2(uy, ux);
  const off = (t, side) => ({ // 沿墙参数 t + 法向偏移 side
    x: o.x1 + ux * t + nx * side, y: o.y1 + uy * t + ny * side,
  });
  // 整段一个组：定位到桥架中心并转向，组内局部坐标 mm（x 沿桥架，z 横跨）
  const grp = new THREE.Group();
  const c = off(L / 2, 0);
  grp.position.set(c.x * S, 0, -c.y * S);
  grp.rotation.y = ry;
  g.add(grp);
  // 上下边丝（纵向加粗钢丝，勾勒侧壁轮廓；细丝不投阴影，阴影贴图分辨不出）
  for (const side of [-w / 2 + 3, w / 2 - 3]) {
    lbox(grp, M.steel, L, 6, 6, 0, hh, side, false);           // 底边丝
    lbox(grp, M.steel, L, 6, 6, 0, hh + bh - 6, side, false);  // 顶边丝
  }
  // 钢丝网（两侧壁 + 底板）：网格纹理 alphaTest 真实镂空，纵丝 100mm / 横丝 50mm
  // 素模风：改整片素色面板（不镂空、不双面纹理采样），BIM 观感更干净、也更快
  const meshMat = (rx, ry2) => bimPick(() => new THREE.MeshStandardMaterial({
    map: rep(meshTrayTex, rx, ry2), alphaTest: .2, roughness: .4, metalness: .85, side: THREE.DoubleSide,
  }), () => new THREE.MeshStandardMaterial({
    color: 0x94a0ab, roughness: .45, metalness: .25, side: THREE.DoubleSide,
  }));
  for (const side of [-w / 2 + 3, w / 2 - 3]) { // 侧壁网（两端嵌进边丝 3mm，呈焊接感）
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
  // 类型色带（强电红/弱电蓝/光纤绿，贴顶边丝外侧上沿，如卡扣式标识条）
  const col = themeColor(TRAY_COLORS[o.props.kind] || 0x8e44ad);
  const stripe = new THREE.MeshStandardMaterial({ color: col, roughness: .6, metalness: .3 });
  const stH = Math.min(Math.max(bh * .2, 10), 30); // 色带高 = 20% 槽体高，限 10~30
  for (const side of [-w / 2 - 1, w / 2 + 1]) {
    const p = off(L / 2, side);
    box(g, stripe, L, stH, 3, p.x, hh + bh - stH, p.y, ry, false);
  }
  // 吊杆（2400 一档，吊至吊顶/顶板）；桥架高于层高时无吊挂空间，不生成（防负高度几何体）
  for (let t = 600; t < L && ceilH > hh + 60; t += 2400) {
    const p = off(t, 0);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(5 * S, 5 * S, (ceilH - hh) * S, 8), M.steel);
    rod.position.set(p.x * S, (hh + (ceilH - hh) / 2) * S, -p.y * S);
    g.add(rod);
  }
}

/* ---------- 通道带（冷/热通道：地面半透明色带 + 彩色边线；封闭通道含铝框玻璃围护结构） ---------- */
function buildAisle(g, o, cabH = 2000) {
  const cold = (o.props.kind || 'cold') === 'cold';
  const col = themeColor(cold ? 0x2f6fb2 : 0xc0392b);
  const enclosed = o.props.enclosed !== false;
  const w = o.props.w || 1000, d = o.props.d || 1200;
  const mat = new THREE.MeshStandardMaterial({
    color: col, transparent: true, opacity: isBim3D() ? .12 : .14, roughness: .9, metalness: 0, // 素模底：色带再淡一点，不扰白模
  });
  const m = box(g, mat, w, 26, d, o.x, 2, o.y, rad(o.rotation), false);
  m.material.depthWrite = false;
  const grp = placed(g, o);
  // 地面边线（通道结构线：冷蓝/热红标线，贴于色带上表面；封闭=四边闭合，非封闭=仅两侧长边，与 2D 一致）
  const edge = new THREE.MeshStandardMaterial({ color: col, roughness: .6, metalness: .1 });
  const ew = 90; // 标线宽
  for (const sz of [-1, 1]) lbox(grp, edge, w, 4, ew, 0, 30, sz * (d / 2 - ew / 2), false);
  if (enclosed) {
    for (const sx of [-1, 1]) lbox(grp, edge, ew, 4, d - ew * 2, sx * (w / 2 - ew / 2), 30, 0, false);
  }
  // 封闭通道（旧数据无 enclosed/endDoors/doorType 字段按 封闭+两端推拉门 处理，保持旧外观近似）：
  // 柜顶封板 + 两端端门/封板 + 铝型材框架。端门参数：endDoors=两端/单端(局部-x端)/无，
  // doorType=推拉/双开/单开，doorW>0 时门洞居中、两侧为固定封窗；封板端为整面玻璃无门五金。
  if (enclosed) {
    const hh = +o.props.h > 0 ? +o.props.h : cabH; // 通道高（封顶高度）：未设/≤0 时取最高机柜高（兼容旧数据）
    const doorH = Math.min(hh, cabH);              // 端门扇高：与机柜高度齐平
    const transom = hh - doorH > 60;               // 机柜以上剩余 > 60：门上为固定封窗（非门扇）；
    const dH = transom ? doorH : hh;               //   差值 ≤60 时不单列封窗，门扇直接到顶（默认 h=机柜高即此情形）
    const ed = o.props.endDoors || 'both';         // both=两端门 / one=仅局部起点端(-x) / none=两端封板
    const dtype = o.props.doorType || 'sliding';   // sliding=推拉 / double=双开 / single=单开（铰链在局部 -z 侧）
    const ow = +o.props.doorW > 0 ? Math.min(+o.props.doorW, d) : d; // 门洞净宽（0=全宽=通道宽）
    const sw = (d - ow) / 2;                       // 门洞两侧固定封窗宽
    const roof = lbox(grp, M.glass, w, 24, d, 0, hh, 0, false); // 顶部封板（通道高度）
    roof.receiveShadow = false;
    const glass = (th, gh, gx, gy0, gz, gw) => { const m = lbox(grp, M.glass, th, gh, gw, gx, gy0, gz, false); m.receiveShadow = false; return m; }; // th=厚度(x向) gw=扇宽(z向)
    for (const sx of [-1, 1]) { // 两端端部围护（玻璃高与机柜齐平；门上有封窗时另加）
      const hasDoor = ed === 'both' || (ed === 'one' && sx === -1);
      const ex = sx * (w / 2 - 20); // 端部玻璃平面（局部 x）
      if (!hasDoor) glass(40, dH, ex, 0, 0, d); // 封板端：整面玻璃
      else {
        if (sw > 1) for (const sz of [-1, 1]) glass(40, dH, ex, 0, sz * (ow / 2 + sw / 2), sw); // 门洞两侧固定封窗
        if (dtype === 'sliding') { // 推拉门：两片错位玻璃（一片偏内、一片偏外），中部搭接 120
          const lw = ow / 2 + 60;
          glass(24, dH, ex - sx * 25, 0, -(ow / 4 - 30), lw);
          glass(24, dH, ex + sx * 25, 0, ow / 4 - 30, lw);
        } else if (dtype === 'double') { // 双开门：两扇对开
          for (const sz of [-1, 1]) glass(40, dH, ex, 0, sz * ow / 4, ow / 2);
        } else glass(40, dH, ex, 0, 0, ow); // 单开门：一扇
      }
      if (transom) glass(40, hh - doorH, ex, doorH, 0, d); // 门上固定封窗（整端宽，机柜高度以上部分封闭）
    }
    // 铝型材框架（封闭通道结构线：勾勒透明围护轮廓，如真实通道封闭框架）
    const fs = 50; // 型材截面 50×50
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) // 四角立柱（兼端门侧框）
      lbox(grp, M.aluminum, fs, hh, fs, sx * (w / 2 - fs / 2), 0, sz * (d / 2 - fs / 2), false);
    for (const sz of [-1, 1]) // 顶部两侧长边梁（顶板檐口，略压住封板边）
      lbox(grp, M.aluminum, w, 36, fs, 0, hh - 6, sz * (d / 2 - fs / 2), false);
    for (const sx of [-1, 1]) { // 每端：顶梁 + 门楣（有封窗时）；门端按门型加中梃/地轨/竖拉手，封板端加地轨
      const hasDoor = ed === 'both' || (ed === 'one' && sx === -1);
      lbox(grp, M.aluminum, fs, 36, d, sx * (w / 2 - fs / 2), hh - 6, 0, false);
      if (transom) lbox(grp, M.aluminum, fs, 36, d, sx * (w / 2 - fs / 2), doorH - 6, 0, false); // 门楣：门扇与封窗分界
      if (!hasDoor) { lbox(grp, M.aluminum, fs, 24, d, sx * (w / 2 - fs / 2), 0, 0, false); continue; } // 封板端地轨
      if (dtype === 'double') lbox(grp, M.aluminum, fs, hh, fs, sx * (w / 2 - fs / 2), 0, 0, false); // 中梃（双开门中缝）
      if (dtype === 'sliding') lbox(grp, M.aluminum, fs, 24, ow, sx * (w / 2 - fs / 2), 0, 0, false); // 地轨（推拉门下导轨，仅门洞范围）
      const hx = dtype === 'sliding' ? sx * (w / 2 + 24) : sx * (w / 2 + 6); // 拉手：推拉门贴外侧门板面
      const hz = dtype === 'single' ? [Math.max(60, ow / 2 - 100)]      // 单开：拉手在铰链对侧
        : dtype === 'sliding' ? [-40, 40]                               // 推拉：两片搭接处各一
        : [-Math.min(90, ow / 4), Math.min(90, ow / 4)];                // 双开：中缝两侧
      for (const z of hz) lbox(grp, M.dark, 14, 220, 14, hx, 950, z, false);
    }
  }
}

/* ---------- 吊顶（明架矿棉板：600×600mm 龙骨网格，仅设置有效吊顶面高时生成） ---------- */
function buildCeiling(g, b, ceilH) {
  const W = b.maxx - b.minx, D = b.maxy - b.miny;
  const cx = (b.minx + b.maxx) / 2, cy = (b.miny + b.maxy) / 2;
  const geo = new THREE.PlaneGeometry(W * S, D * S);
  // 伪对象：吊顶由机房信息「吊顶面高」派生、无 2D 数据对象；id 固定，隔离后场景重建按 id 重套
  const grp = pickGroup(g, { id: '__ceiling', type: 'ceiling', props: { h: ceilH } });
  grp.userData.surface = 'ceiling';
  // MeshBasicMaterial：主光/补光均向下，受光材质在朝下/背面场景会发黑，无光照材质保持吊顶亮白
  // 下面（rotation.x=+π/2，室内仰视）：不透明矿棉板 + T 型龙骨网格（素模风改浅素色 600 模数板）——
  // 这一面参与悬停拾取/右键隔离；仍用无光照材质：主光从上向下照不到仰视面，受光材质会发黑
  const down = new THREE.Mesh(geo, bimPick(
    () => new THREE.MeshBasicMaterial({ map: rep(ceilTex, W / 600, D / 600) }),
    () => new THREE.MeshBasicMaterial({ map: rep(bimCeilTex, W / 600, D / 600) })));
  down.rotation.x = Math.PI / 2;
  down.position.set(cx * S, ceilH * S, -cy * S);
  grp.add(down);
  if (isBim3D()) edgeRect(grp, down, W, D); // 素模风：吊顶板四周棱线
  // 上面（rotation.x=-π/2，室外 3/4 俯视）：透明底网格线标示吊顶面位置与高度——
  // 600×600 网格清晰可读而室内陈设几乎不遮挡（不遮挡取景/导出）；透明度由 ceilGridTex 的
  // 各层 alpha 控制（刻意取小：线性混合→sRGB 输出会显著提亮低 alpha，见 materials3d 注释）；
  // 深度不写入避免与玻璃墙面排序打架；
  // 禁用射线：否则俯视时它拦截全部悬停，下方机柜等无法选中——拾取只由下面矿棉板承担
  const up = new THREE.Mesh(geo,
    new THREE.MeshBasicMaterial({ map: rep(ceilGridTex, W / 600, D / 600), transparent: true, depthWrite: false }));
  up.rotation.x = -Math.PI / 2;
  up.position.set(cx * S, ceilH * S, -cy * S);
  up.raycast = () => {};
  grp.add(up);
}

/* ---------- 地板系统（静电地板面层 + 开放架空层轮廓 + 结构底板） ---------- */
function buildFloor(g, b, floorH) {
  const W = b.maxx - b.minx, D = b.maxy - b.miny;
  const cx = (b.minx + b.maxx) / 2, cy = (b.miny + b.maxy) / 2;
  const fm = bimPick(
    () => new THREE.MeshStandardMaterial({
      map: rep(floorTex, W / 600, D / 600), roughness: .88, metalness: .06,
    }),
    () => new THREE.MeshStandardMaterial({ // 素模：浅素色 600 模数板（无 HPL 斑纹/支架点）
      map: rep(bimFloorTex, W / 600, D / 600), roughness: .9, metalness: .02,
    }));
  const fl = new THREE.Mesh(new THREE.BoxGeometry(W * S, 30 * S, D * S), fm);
  fl.position.set(cx * S, -15 * S, -cy * S);
  fl.receiveShadow = true;
  g.add(fl);
  if (isBim3D()) edgeBox(g, fl, W, 30, D);
  // 架空层四周开放：只勾勒边界，不生成裙边实体，侧面可直接看见/拾取地板下管路。
  // 轮廓线在地板对象组内，隔离/管路视图随组隐藏；edgeBox 禁用射线，不抢管道拾取。
  if (floorH > 0) {
    const frame = new THREE.Object3D();
    frame.position.set(cx * S, -floorH / 2 * S, -cy * S);
    const frameMat = new THREE.LineBasicMaterial({
      color: isBim3D() ? 0x2f3740 : 0x6f7f8e,
      transparent: true, opacity: .62, depthWrite: false,
    });
    edgeBox(g, frame, W, floorH, D, frameMat);
    // 结构楼板保留为不透明实体，标示架空空间底界。
    box(g, M.plenum, W + 120, 40, D + 120, cx, -floorH - 40, cy, 0, false);
  }
}

/* ---------- 入口：构建整机房 ---------- */
export function buildRoom(project, jointOptions = {}) {
  const g = new THREE.Group();
  const objs = project.objects || [];
  const meta = project.meta || {};
  const wallHs = objs.filter(o => o.type === 'wall').map(o => o.props.height || 0);
  const roomH = meta.roomHeight || Math.max(3000, ...wallHs); // 结构层高（楼板底）
  const chH = +meta.ceilHeight || 0;                          // 吊顶面高：未设 / ≤0 / ≥结构层高 = 无吊顶（裸顶）
  const hasCeil = chH > 0 && chH < roomH;                     // 有吊顶：吊顶面高严格低于结构层高
  const ceilH = hasCeil ? chH : roomH;                        // 吊顶面（无吊顶时 = 结构层高）
  const floorH = meta.floorHeight ?? 400;                     // 架空地板高度
  const cabH = Math.max(2000, ...objs.filter(o => o.type === 'cabinet').map(o => o.props.h || 2000)); // 封闭通道封顶/端门高度 = 最高机柜

  // 场景包围盒（世界 mm），用于地板范围与相机取景
  const b = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  const ext = (x, y) => {
    b.minx = Math.min(b.minx, x); b.miny = Math.min(b.miny, y);
    b.maxx = Math.max(b.maxx, x); b.maxy = Math.max(b.maxy, y);
  };
  for (const o of objs) {
    if (o.type === 'wall' || o.type === 'tray') { ext(o.x1, o.y1); ext(o.x2, o.y2); }
    else if (o.type === 'beam') { // 端点随附着柱求解
      const e = beamEnds(o, id => objs.find(q => q.id === id) || null);
      ext(e.x1, e.y1); ext(e.x2, e.y2);
    }
    else if (o.x !== undefined) {
      const r = Math.hypot(o.props.w || 600, o.props.d || 600) / 2;
      ext(o.x - r, o.y - r); ext(o.x + r, o.y + r);
    }
  }
  if (!Number.isFinite(b.minx)) { b.minx = -3000; b.miny = -2000; b.maxx = 3000; b.maxy = 2000; }
  const pad = 900;
  b.minx -= pad; b.miny -= pad; b.maxx += pad; b.maxy += pad;

  // 墙体 + 其上门窗格栅（每个对象一个 pick 组：悬停尺寸提示按组回溯源对象）
  const walls = objs.filter(o => o.type === 'wall');
  for (const w of walls) {
    const ops = objs.filter(o =>
      (o.type === 'door' || o.type === 'window' || o.type === 'grille') && o.wallId === w.id);
    buildWall(pickGroup(g, w), w, ops, roomH);
  }
  const buildPipe = pipeBuilder(meta);
  const joints = planJoints(objs, jointOptions, meta);
  joints.risks = jointPipeRisks(joints, objs, pipeDeviceDistance, roomH, floorH);
  for (const o of objs) {
    const route = joints.entries.get(o);
    if (o.type === 'pipe') buildPipe(pickGroup(g, o), o, route);
    else if (o.type === 'column') buildColumn(pickGroup(g, o), o, floorH);
    else if (o.type === 'beam') buildBeam(pickGroup(g, o), o, objs);
    else if (o.type === 'cabinet') buildCabinet(pickGroup(g, o), o);
    else if (o.type === 'pdu') buildPdu(pickGroup(g, o), o);
    else if (o.type === 'dbox') buildDistributionBox(pickGroup(g, o), o, { placed, lbox });
    else if (o.type === 'ac') buildAC(pickGroup(g, o), o);
    else if (o.type === 'ups') buildUPS(pickGroup(g, o), o);
    else if (o.type === 'battery') buildBattery(pickGroup(g, o), o);
    else if (o.type === 'extinguisher') buildExtinguisher(pickGroup(g, o), o);
    else if (o.type === 'vent') buildVent(pickGroup(g, o), o);
    else if (o.type === 'tray') {
      const grp = pickGroup(g, o);
      if (route?.ends.some(Boolean)) buildCurvedTray(grp, o, route, ceilH);
      else buildTray(grp, o, ceilH);
    }
    else if (o.type === 'aisle') buildAisle(pickGroup(g, o), o, cabH);
  }
  // 与吊顶一样使用固定伪对象 id；面层、开放架空层轮廓、结构楼板作为一组隔离，不改 2D 数据。
  const floorGroup = pickGroup(g, { id: '__floor', type: 'floor', props: { h: floorH } });
  floorGroup.userData.surface = 'floor';
  buildFloor(floorGroup, b, floorH);
  // 吊顶 600×600 网格：仅外挑 60mm（=包围盒外挑 900 回退 840），边缘收进墙体内——
  // 不外飘出墙（半透明上面外飘会像错误），也不留顶边漏缝
  const bc = { minx: b.minx + 840, miny: b.miny + 840, maxx: b.maxx - 840, maxy: b.maxy - 840 };
  if (hasCeil) buildCeiling(g, bc, ceilH);
  return { group: g, bounds: b, roomH, ceilH, joints, sceneBounds3d: objs.some(o => o.type === 'pipe' || (isDevice(o) && deviceZ(o) !== 0)) ? sceneBounds(g, objs.filter(o=>o.type==='pipe')) : undefined };
}
