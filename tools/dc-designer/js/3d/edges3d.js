/**
 * 3D 构件轮廓线（盒体 12 条棱线、平面矩形边框）；通常用于素模 / BIM，架空层边界两种风格均显示。
 *
 * 为什么按「零件」补线而不是对合并后的几何体求 EdgesGeometry：
 *   · 本场景几何 100% 由 box/plane 原语拼成，棱线可以直接由尺寸算出（无需按顶点哈希找硬边），
 *     一台由 25 个盒体拼成的机柜省下上万次哈希比较；EdgesGeometry 在 90 台机柜的规模下会到秒级卡顿；
 *   · 棱线由 builders3d 在建模时与本体一起产出，随后交给 merge3d 与本体同样按「对象组 + 材质」合并，
 *     draw call 仍是每个对象组 1 条（而不是每个零件 1 条）。
 *
 * 拾取：棱线一律禁用射线（raycast 置空）——线段的射线检测带 1m 阈值（Raycaster.params.Line.threshold），
 *   否则悬停时会在物体外 1m 内「命中」到线，导致选中旁边那个构件（与吊顶俯视网格线同一处理）；
 * 悬停高亮：pick3d 会连同线材质一起做提亮克隆（素模材质浅、靠棱线变琥珀更醒目）。
 */
import * as THREE from '../../lib/three/three.webgpu.min.js';

/** 共享棱线材质：深蓝灰半透明（素模白底场景里的「图纸线」，浅色构件上都可读） */
export const EDGE_MAT = new THREE.LineBasicMaterial({
  color: 0x2f3740, transparent: true, opacity: .62, depthWrite: false,
});

const noRay = () => {}; // 禁用射线（同上：线有 1m 拾取阈值，会抢掉正确构件）

/** 立方向盒体的 12 条棱线（中心在原点，mm；与 BoxGeometry(w,h,d) 完全同形） */
function boxPositions(w, h, d) {
  const x = w / 2 * 0.001, y = h / 2 * 0.001, z = d / 2 * 0.001;
  const p = [];
  const seg = (ax, ay, az, bx, by, bz) => p.push(ax, ay, az, bx, by, bz);
  for (const s of [-1, 1]) { // 底/顶面各 4 条
    for (const t of [-1, 1]) {
      seg(-x, s * y, t * z, x, s * y, t * z);
      seg(t * x, s * y, -z, t * x, s * y, z);
    }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) seg(sx * x, -y, sz * z, sx * x, y, sz * z); // 4 条立柱
  return p;
}

/** 水平放置的矩形边框（XY 平面内 w×h，中心在原点；用于吊顶板等单面几何） */
function rectPositions(w, h) {
  const x = w / 2 * 0.001, y = h / 2 * 0.001;
  return [-x, -y, 0, x, -y, 0, x, -y, 0, x, y, 0, x, y, 0, -x, y, 0, -x, y, 0, -x, -y, 0];
}

/** 由顶点数组建一条线（禁用射线、不投影：线投不出有意义的影，只会增加阴影 pass 开销） */
function lineOf(parent, pos, src, material = EDGE_MAT) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const l = new THREE.LineSegments(g, material);
  l.castShadow = false; l.receiveShadow = false;
  l.raycast = noRay;
  if (src) { // 与本体同父同变换（由 merge3d 在对象组内与本体一起合并）
    l.position.copy(src.position);
    l.rotation.copy(src.rotation);
    l.scale.copy(src.scale);
  }
  parent.add(l);
  return l;
}

/** 给盒体零件补棱线：src 为同父同变换的 Mesh 或 Object3D（允许只画边界、不生成实体面） */
export function edgeBox(parent, src, w, h, d, material = EDGE_MAT) {
  return lineOf(parent, boxPositions(w, h, d), src, material);
}

/** 给水平面板补矩形边框（吊顶板等） */
export function edgeRect(parent, src, w, h) {
  return lineOf(parent, rectPositions(w, h), src);
}
