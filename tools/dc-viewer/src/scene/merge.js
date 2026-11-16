/**
 * 逐对象几何合并：同一对象组内按「材质 + 投影/受影标记 + noPick」分桶合并为单 Mesh。
 * 不跨对象组合并——保留透明件的排序层次、拾取/隔离/爆炸/线稿的对象粒度。
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** 拆出单材质几何片（多材质 mesh 按 geometry.groups 切片），统一为带 position/normal/uv 的非索引几何 */
function partsOfMesh(mesh) {
  const geo = mesh.geometry;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const groups = Array.isArray(mesh.material) && geo.groups && geo.groups.length
    ? geo.groups
    : [{ start: 0, count: geo.index ? geo.index.count : geo.attributes.position.count, materialIndex: 0 }];
  const out = [];
  for (const grp of groups) {
    const mat = mats[grp.materialIndex] || mats[0];
    if (!mat) continue;
    out.push({ geo: sliceGeometry(geo, grp.start, grp.count), mat });
  }
  return out;
}

/** 按索引区间切出一份独立（非索引）几何，保证后续矩阵烘焙不共享属性 */
function sliceGeometry(geo, start, count) {
  const idx = geo.index;
  const names = Object.keys(geo.attributes);
  const part = new THREE.BufferGeometry();
  for (const name of names) {
    const a = geo.attributes[name];
    const itemSize = a.itemSize;
    const arr = new a.array.constructor(count * itemSize);
    for (let i = 0; i < count; i++) {
      const vi = idx ? idx.getX(start + i) : start + i;
      for (let k = 0; k < itemSize; k++) arr[i * itemSize + k] = a.array[vi * itemSize + k];
    }
    part.setAttribute(name, new THREE.BufferAttribute(arr, itemSize, a.normalized));
  }
  return part;
}

/** 对象组自身拥有的 mesh（遇到嵌套对象组即停） */
export function ownMeshes(group) {
  const list = [];
  const walk = n => {
    for (const c of n.children) {
      if (c.userData && c.userData.obj) continue;
      if (c.isMesh) list.push(c);
      else if (c.children && c.children.length) walk(c);
    }
  };
  walk(group);
  return list;
}

const bucketKey = p => `${p.mat.uuid}|${p.cast ? 1 : 0}|${p.receive ? 1 : 0}${p.noPick ? '|np' : ''}`;

function mergeOwn(group) {
  const meshes = ownMeshes(group);
  const before = meshes.length;
  if (before < 2) return { before, after: before };
  group.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map();
  const geoms = new Set();
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    for (const part of partsOfMesh(mesh)) {
      part.geo.applyMatrix4(m);
      const key = bucketKey({
        mat: part.mat,
        cast: mesh.castShadow,
        receive: mesh.receiveShadow,
        noPick: !!(mesh.userData && mesh.userData.noPick),
      });
      let b = buckets.get(key);
      if (!b) {
        b = {
          mat: part.mat,
          cast: mesh.castShadow,
          receive: mesh.receiveShadow,
          noPick: !!(mesh.userData && mesh.userData.noPick),
          geos: [],
        };
        buckets.set(key, b);
      }
      b.geos.push(part.geo);
    }
    geoms.add(mesh.geometry);
    if (mesh.parent) mesh.parent.remove(mesh);
  }
  let after = 0;
  for (const b of buckets.values()) {
    const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    if (b.geos.length > 1) for (const g of b.geos) g.dispose();
    if (!merged) {
      console.warn('[merge] 合并失败：材质', b.mat && b.mat.type, '几何片', b.geos.length);
      continue;
    }
    const mesh = new THREE.Mesh(merged, b.mat);
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.receive;
    if (b.noPick) {
      mesh.userData.noPick = true;
      mesh.raycast = () => {};
    }
    group.add(mesh);
    after++;
  }
  for (const g of geoms) g.dispose();
  return { before, after };
}

/**
 * 合并整棵场景树（逐对象组）。
 * @returns {{before:number, after:number}}
 */
export function mergeStatics(root) {
  let before = 0;
  let after = 0;
  const process = group => {
    for (const c of group.children) {
      if (c.userData && c.userData.obj) {
        const r = mergeOwn(c);
        before += r.before;
        after += r.after;
        process(c); // 嵌套对象组（墙体里的门窗/格栅）各自合并
      } else if (c.children && c.children.length) {
        process(c);
      }
    }
  };
  process(root);
  return { before, after };
}
