/** 任意方向管段及只读展示圆弯：物理外包半径，不按 DN 或屏幕线宽建模。材质为本次 build 私有。 */
import * as THREE from '../../lib/three/three.webgpu.min.js';

import { normalizePipe, pipeGeometry, pipeColor } from '../pipe-geometry.js';

import { isBim3D } from './theme3d.js';
import { routeSamples } from './route-joints3d.js';
import { sweepTube } from './sweep3d.js';

const S = .001, UP = new THREE.Vector3(0, 1, 0);

/** 每次重建新工厂：有限缓存 256 颜色，超出后私有材质，不保留跨场景全局引用。 */ export function pipeBuilder(meta = {}) {
  const cache = new Map;
  return function buildPipe(group, input, route = null) {
    let o;
    try {
      o = normalizePipe(input);
    } catch {
      return;
    }
    const g = pipeGeometry(o), c = pipeColor(o, meta), bim = isBim3D(), key = `${bim}|${o.props.material}|${c}|${o.props.insulationThickness > 0}`;
    let mat = cache.get(key);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: c,
        roughness: bim ? .8 : o.props.insulationThickness > 0 ? .86 : .34,
        metalness: bim ? .05 : o.props.insulationThickness > 0 ? .03 : .48
      });
      if (cache.size < 256) cache.set(key, mat);
    }
    const a = new THREE.Vector3(o.x1 * S, o.z1 * S, -o.y1 * S), b = new THREE.Vector3(o.x2 * S, o.z2 * S, -o.y2 * S);
    const direction = b.clone().sub(a);
    const curved = route?.ends.some(Boolean);
    const geometry = curved ? sweepTube(routeSamples(route), g.outerRadius, 24, route.ends.map(e => !e)) :
      new THREE.CylinderGeometry(g.outerRadius * S, g.outerRadius * S, g.length * S, 20, 1);
    const mesh = new THREE.Mesh(geometry, mat);
    if (!curved) {
      mesh.position.copy(a).add(b).multiplyScalar(.5);
      mesh.quaternion.setFromUnitVectors(UP, direction.normalize());
    }
    // 细管不参与昂贵细碎阴影，真实几何仍保持原外径。
    mesh.castShadow = g.outerDiameter >= 80;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
}

/** 视图设置不是项目实体；用对象组边界阻止 mergeStatics 把楼板合并进别的对象。 */ export function applyPipeView(built, on) {
  built.group.traverse(n => {
    if (n.userData.surface) n.visible = !on && !n.userData.isolationHidden;
  });
}

/** 场景范围是 mm 业务坐标（含所有实体及管道外包），与地板建筑范围独立。 */ export function sceneBounds(group, pipes = []) {
  group.updateMatrixWorld(true);
  const box = (new THREE.Box3).setFromObject(group);
  if (box.isEmpty()) return {
    minx: -3e3,
    maxx: 3e3,
    miny: -2e3,
    maxy: 2e3,
    minz: -440,
    maxz: 3e3
  };
  const b = {
    minx: box.min.x / S,
    maxx: box.max.x / S,
    miny: -box.max.z / S,
    maxy: -box.min.z / S,
    minz: box.min.y / S,
    maxz: box.max.y / S
  };
  for (const o of pipes) {
    const p = pipeGeometry(o).bounds;
    for (const k of [ 'minx', 'miny', 'minz' ]) b[k] = Math.min(b[k], p[k]);
    for (const k of [ 'maxx', 'maxy', 'maxz' ]) b[k] = Math.max(b[k], p[k]);
  }
  return b;
}
