/**
 * 渲染器：three r185 WebGPURenderer（不支持 WebGPU 时自动回退 WebGL2）。
 * ?renderer=webgl 可强制 WebGL2 后端，便于截图对比。
 */
import * as THREE from 'three/webgpu';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export async function createRenderer(canvas, opts = {}) {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const forceWebGL = opts.forceWebGL !== undefined ? !!opts.forceWebGL : q.get('renderer') === 'webgl';
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: opts.antialias !== false,
    alpha: !!opts.alpha,
    forceWebGL,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const brightRaw = q.get('bright');
  const bright = brightRaw == null ? 1 : +brightRaw;
  renderer.toneMappingExposure = 1 * clamp(Number.isFinite(bright) ? bright : 1, 0.5, 2.5);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  await renderer.init();
  return renderer;
}

/** 后端标识：webgpu | webgl | unknown */
export function backendOf(renderer) {
  if (!renderer) return 'unknown';
  const r = renderer.backend || renderer._backend;
  const name = String((r && (r.isWebGPUBackend ? 'webgpu' : r.isWebGLBackend ? 'webgl' : '')) || '');
  if (name) return name;
  return renderer.constructor && /webgpu/i.test(renderer.constructor.name) ? 'webgpu' : 'webgl';
}
