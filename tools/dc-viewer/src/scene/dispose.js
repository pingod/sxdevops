/**
 * 场景组资源释放：几何一律释放；材质仅释放非共享材质（共享材质与其贴图跨重建保留）。
 */
import { sharedMaterials } from './materials.js';

export function disposeGroup(root) {
  const shared = new Set(sharedMaterials());
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || shared.has(m)) continue;
      if (m.map && !m.userData.keepMap) m.map.dispose();
      m.dispose();
    }
  });
}
