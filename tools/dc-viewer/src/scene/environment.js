/**
 * 室内环境贴图（IBL）：Canvas 等距柱状投影，上半部天光带三道灯槽，中部墙面冷灰。
 * 无外部 HDR 依赖。
 */
import * as THREE from 'three/webgpu';

export function createRoomEnvironment() {
  const W = 512;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.28, '#f4f7fa');
  g.addColorStop(0.46, '#eef1f5');
  g.addColorStop(0.54, '#dfe4ea');
  g.addColorStop(0.72, '#b8c0c8');
  g.addColorStop(1, '#8a929a');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);

  for (const y of [H * 0.06, H * 0.16, H * 0.26]) {
    const bar = x.createLinearGradient(0, y, 0, y + H * 0.05);
    bar.addColorStop(0, 'rgba(255,255,255,0)');
    bar.addColorStop(0.5, 'rgba(255,255,255,.55)');
    bar.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = bar;
    x.fillRect(0, y, W, H * 0.05);
  }
  x.fillStyle = 'rgba(226,236,246,0.35)';
  x.fillRect(0, H * 0.4, W, H * 0.18);

  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
