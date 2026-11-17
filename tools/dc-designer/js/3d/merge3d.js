/**
 * 静态几何合并（3D 性能）：把「同一个对象组内、同材质、同阴影标记」的 Mesh 合并成一个 Mesh。
 * 素模风格（theme3d）下建模时会额外产出构件棱线（LineSegments）：同样在本模块按对象组
 * 合并为一条线（同组内线材质相同），否则每个零件一条线会让 draw call 反弹。
 *
 * 为什么需要：机柜这类对象由很多小零件拼成（侧板/立柱/前后网孔门梁/拉手/支脚/灯板…），
 * 30 台机柜就是 600+ 个 Mesh，主 pass 与阴影 pass 各要提交一遍——three r185 的 WebGPU 后端
 * 每个 draw call 的 JS 侧开销不低，实测瓶颈就在这里（把 devicePixelRatio 从 1 提到 2，
 * 帧率完全不变 → 不是填充率问题）。合并后 draw call 降 2~3 倍，画面完全不变。
 *
 * 为什么只合并到「对象组」边界为止：右键隔离（isolate3d）靠对象组 visible 开关、
 * 悬停高亮（pick3d）也是按对象组整体换材质——合并必须止步于 userData.pick 组，
 * 这两个功能的语义才不受影响（组内嵌套的对象组，如墙体里的门窗格栅，逐层递归合并）。
 *
 * 实现要点：
 *   · 合并键 = 材质引用 + castShadow + receiveShadow（阴影标记不同的零件不能混：混了会让不投影的零件跟着投影）；
 *   · 变换烘焙进几何体（position 乘矩阵、normal 乘法线矩阵），对象组自身变换保持在场景里不变；
 *   · 多材质 Mesh（机柜立柱：侧面 4 面净面 + 前后 2 面安装孔条）按 geometry.groups 切成子几何，
 *     每片各归自己材质的桶（只保留用到的顶点，避免整块复制）；
 *   · 共享几何（后门是前门的 clone，共用同一个 geometry）只读一次、只销毁一次（Set 去重）；
 *   · 合并后原几何体与切片临时几何即时销毁，避免显存/内存泄漏（重建时 disposeGroup 只看得到合并后的几何）。
 */
import * as THREE from '../../lib/three/three.webgpu.min.js';

/** 合并 root 子树里的静态几何；返回 { before, after }（合并前后的 Mesh 数，供自检/基准打印） */
export function mergeStatics(root) {
  root.updateMatrixWorld(true);       // 换算「相对对象组」的局部矩阵需要世界矩阵
  let before = 0, after = 0;
  const disposed = new Set();         // 已销毁的原几何（共享几何只销毁一次）

  function walk(node) {
    const own = [], ownLines = [];
    (function collect(n) {
      for (const c of n.children) {
        if (c.userData && c.userData.pick) { walk(c); continue; }  // 嵌套对象组：交给自己处理
        if (c.isMesh) own.push(c);
        else if (c.isLineSegments) ownLines.push(c);               // 构件棱线（素模风）
        else if (c.children.length) collect(c);
      }
    })(node);

    before += own.length;
    mergeLines(node, ownLines, disposed);
    if (own.length < 2) { after += own.length; return; }           // 单件不值得合并

    const buckets = new Map();       // key → { mat, cast, recv, parts: [{ geo, matrix }] }
    const tmp = new Set();           // 本次拆分产生的临时切片几何（合并后销毁）
    const inv = node.matrixWorld.clone().invert();
    for (const m of own) {
      const matrix = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
      for (const part of partsOfMesh(m, tmp)) {
        const key = part.mat.uuid + '|' + (m.castShadow ? 1 : 0) + (m.receiveShadow ? 1 : 0);
        let b = buckets.get(key);
        if (!b) buckets.set(key, b = { mat: part.mat, cast: !!m.castShadow, recv: !!m.receiveShadow, parts: [] });
        b.parts.push({ geo: part.geo, matrix });
      }
    }

    for (const b of buckets.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(b.parts), b.mat);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.recv;
      node.add(mesh);
      after++;
    }
    for (const m of own) if (m.parent) m.parent.remove(m);
    for (const g of tmp) g.dispose();
    for (const m of own) if (!disposed.has(m.geometry)) { disposed.add(m.geometry); m.geometry.dispose(); }
  }

  walk(root);
  return { before, after };
}

/* ---------- 内部：多材质拆分 / 几何切片 / 合并 ---------- */

/** 同组内棱线合并：按材质归桶，逐条烘焙矩阵后拼成一个位置数组（线无阴影标记、无多材质） */
function mergeLines(node, lines, disposed) {
  if (!lines.length) return;
  const buckets = new Map();
  const inv = node.matrixWorld.clone().invert();
  for (const l of lines) {
    let b = buckets.get(l.material.uuid);
    if (!b) buckets.set(l.material.uuid, b = { mat: l.material, parts: [] });
    b.parts.push({ geo: l.geometry, matrix: new THREE.Matrix4().multiplyMatrices(inv, l.matrixWorld) });
  }
  const v = new THREE.Vector3();
  for (const b of buckets.values()) {
    const arr = [];
    for (const { geo, matrix } of b.parts) {
      const a = geo.attributes.position;
      for (let i = 0; i < a.count; i++) { v.fromBufferAttribute(a, i).applyMatrix4(matrix); arr.push(v.x, v.y, v.z); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.computeBoundingSphere();
    const line = new THREE.LineSegments(geo, b.mat);
    line.raycast = () => {}; // 与建模端一致：棱线不参与拾取（线有 1m 拾取阈值，会抢掉正确构件）
    node.add(line);
  }
  for (const l of lines) {
    if (l.parent) l.parent.remove(l);
    if (!disposed.has(l.geometry)) { disposed.add(l.geometry); l.geometry.dispose(); }
  }
}

/** 把 Mesh 拆成「单材质几何」列表：[{ geo, mat }]；单材质直接给原几何，多材质按 geometry.groups 切片 */
function partsOfMesh(mesh, tmp) {
  const g = mesh.geometry;
  if (!Array.isArray(mesh.material)) return [{ geo: g, mat: mesh.material }];
  const mats = mesh.material;
  const total = g.index ? g.index.count : g.attributes.position.count;
  const groups = (g.groups && g.groups.length) ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
  const out = [];
  for (const grp of groups) {
    if (!grp.count) continue;
    const mi = Math.min(Math.max(grp.materialIndex | 0, 0), mats.length - 1);
    const slice = sliceGeometry(g, grp.start || 0, grp.count);
    tmp.add(slice);
    out.push({ geo: slice, mat: mats[mi] });
  }
  return out.length ? out : [{ geo: g, mat: mats[0] }];
}

/** 取几何体某段索引区间的子几何体副本（顶点去重，便于后续合并） */
function sliceGeometry(geo, start, count) {
  const out = new THREE.BufferGeometry();
  const src = geo.index ? geo.index.array : null;
  const map = new Map();             // 原顶点序号 → 新顶点序号
  const newIdx = [];
  const names = Object.keys(geo.attributes);
  const bufs = {};
  for (const n of names) bufs[n] = [];
  const v = new THREE.Vector3();
  for (let i = start; i < start + count; i++) {
    const vi = src ? src[i] : i;
    let ni = map.get(vi);
    if (ni === undefined) {
      ni = map.size;
      map.set(vi, ni);
      for (const n of names) bufs[n].push(...readVertex(geo.attributes[n], vi, v));
    }
    newIdx.push(ni);
  }
  for (const n of names) out.setAttribute(n, new THREE.Float32BufferAttribute(bufs[n], geo.attributes[n].itemSize));
  out.setIndex(newIdx);
  return out;
}

/** 读取顶点某分量的数值数组（itemSize 1~4，复用 Vector3 减少 GC） */
function readVertex(attr, i, v) {
  const s = attr.itemSize;
  if (s === 3) { v.fromBufferAttribute(attr, i); return [v.x, v.y, v.z]; }
  if (s === 4) { v.fromBufferAttribute(attr, i); return [v.x, v.y, v.z, attr.getW(i)]; }
  if (s === 2) return [attr.getX(i), attr.getY(i)];
  return [attr.getX(i)];
}

/**
 * 合并一批「同材质」几何（各自先烘焙矩阵）为单个索引化 BufferGeometry：
 * position 乘矩阵、normal 乘法线矩阵，其余属性（uv 等）原样拼接；缺属性按默认值补齐（保证属性集合一致）。
 */
function mergeGeometries(parts) {
  const names = new Map();          // 属性名 → itemSize（并集，缺失的补默认值）
  for (const { geo } of parts) for (const n of Object.keys(geo.attributes)) names.set(n, geo.attributes[n].itemSize);
  const acc = {};
  for (const [n, s] of names) acc[n] = { itemSize: s, arr: [] };

  const index = [];
  let base = 0;
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  for (const { geo, matrix } of parts) {
    nm.getNormalMatrix(matrix);
    const cnt = geo.attributes.position.count;
    for (const [n, itemSize] of names) {
      const a = geo.attributes[n];
      const dst = acc[n].arr;
      if (!a) { for (let i = 0; i < cnt; i++) dst.push(...defaultVertex(n, itemSize)); continue; }
      for (let i = 0; i < cnt; i++) {
        if (n === 'position') { v.fromBufferAttribute(a, i).applyMatrix4(matrix); dst.push(v.x, v.y, v.z); }
        else if (n === 'normal') { v.fromBufferAttribute(a, i).applyMatrix3(nm).normalize(); dst.push(v.x, v.y, v.z); }
        else dst.push(...readVertex(a, i, v));
      }
    }
    const src = geo.index ? geo.index.array : null;
    if (src) for (let i = 0; i < src.length; i++) index.push(src[i] + base);
    else for (let i = 0; i < cnt; i++) index.push(base + i);
    base += cnt;
  }

  const out = new THREE.BufferGeometry();
  for (const [n, o] of Object.entries(acc)) out.setAttribute(n, new THREE.Float32BufferAttribute(o.arr, o.itemSize));
  out.setIndex(index);
  out.computeBoundingSphere();
  return out;
}

/** 缺失属性的默认值（法线朝上、uv 归零，够用且不产生 NaN 顶点） */
function defaultVertex(name, itemSize) {
  if (name === 'normal') return [0, 1, 0];
  return new Array(itemSize).fill(0);
}
