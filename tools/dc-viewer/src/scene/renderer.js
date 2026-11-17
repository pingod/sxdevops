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

const messageOf = (error) => (error && error.message) || String(error);

/**
 * 建渲染器：WebGPU 优先，失败回退 WebGL2，两者都失败抛合并错误。
 * 查看器与设计器共用，避免各自写一份回退逻辑而漏掉某条路径。
 */
export async function createRendererWithFallback(canvas, opts = {}) {
  try {
    return await createRenderer(canvas, opts);
  } catch (primary) {
    try {
      return await createRenderer(canvas, { ...opts, forceWebGL: true });
    } catch (fallback) {
      const error = new Error(`${messageOf(primary)}；WebGL2 回退也失败：${messageOf(fallback)}`);
      error.primary = primary;
      error.fallback = fallback;
      throw error;
    }
  }
}

/** 后端标识：webgpu | webgl | unknown */
export function backendOf(renderer) {
  if (!renderer) return 'unknown';
  const r = renderer.backend || renderer._backend;
  const name = String((r && (r.isWebGPUBackend ? 'webgpu' : r.isWebGLBackend ? 'webgl' : '')) || '');
  if (name) return name;
  return renderer.constructor && /webgpu/i.test(renderer.constructor.name) ? 'webgpu' : 'webgl';
}
