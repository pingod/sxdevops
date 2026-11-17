/**
 * 3D 渲染器后端（three.js r185 · WebGPURenderer）：WebGPU 优先，浏览器不支持时自动回退 WebGL 2。
 *
 * 为什么用 WebGPURenderer：r185 的 WebGPURenderer 是「双后端」渲染器——同一套材质/节点代码，
 * 内部按 `navigator.gpu` + 适配器可用性自动选择 WebGPU 或 WebGL 2 后端（回退时仅打印一条
 * console 警告，调用方无需分支）。因此本项目 3D 场景（materials3d/builders3d）完全不用改写，
 * 只把渲染器创建集中到本模块：
 *   · createRenderer3D()  —— 建渲染器 + 统一输出色彩/色调映射/阴影设置 + await init()
 *   · backendOf()/backendLabel() —— 报告实际生效的后端（状态栏提示、导出瓦片规格按它决定）
 *   · maxTextureSize()    —— 取后端纹理上限（导出分瓦片用；取不到给保守值 4096）
 *
 * 排障开关：地址栏加 ?renderer=webgl（或 ?renderer=webgpu）可强制后端，便于对比驱动问题；
 * 3D 里按 2/Esc 回 2D、再按 3 进来不会重建渲染器（与旧实现一致，上下文常驻）。
 *
 * 兼容性：WebGPU 需要 Chrome/Edge 113+、Safari 18+ 等；不支持时自动走 WebGL 2，
 * 纯 WebGL 1 环境（Safari 15 之前）无法运行 three r185 的 WebGLBackend，会由调用方提示降级。
 */
import * as THREE from '../../lib/three/three.webgpu.min.js';

/** 读取排障开关：?renderer=webgl 强制 WebGL 2；?renderer=webgpu 强制优先 WebGPU（默认） */
function forceWebGLFromQuery() {
  try {
    const v = new URLSearchParams(location.search).get('renderer');
    if (!v) return null;
    if (v.toLowerCase() === 'webgl') return true;
    if (v.toLowerCase() === 'webgpu') return false;
  } catch (e) { /* 非浏览器环境（如单测直接 import）忽略 */ }
  return null;
}

/** three.js 版本号（读自库本身，便于自检/排障） */
export function threeRevision() { return THREE.REVISION; }

/**
 * 创建 3D 渲染器并完成异步初始化。
 * @param {HTMLCanvasElement} canvas 目标画布（交互视图或导出用离屏画布）
 * @param {{antialias?:boolean, alpha?:boolean, forceWebGL?:boolean}} [opts]
 *        forceWebGL=true 时跳过 WebGPU 直接用 WebGL 2（导出跟随主渲染器后端时用）
 * @returns {Promise<THREE.WebGPURenderer>} 已完成 init 的渲染器
 */
export async function createRenderer3D(canvas, opts = {}) {
  const q = forceWebGLFromQuery();
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: opts.antialias !== false,
    alpha: !!opts.alpha,
    // false = 优先 WebGPU：不可用时 three 内部自动回退 WebGL 2 后端
    forceWebGL: opts.forceWebGL !== undefined ? !!opts.forceWebGL : q === true,
  });

  // 与旧 WebGLRenderer 完全一致的观感参数（色调映射/色彩空间/软阴影）
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // 必须 await：r185 的 renderer.render() 在后端未初始化时会直接抛错
  await renderer.init();
  return renderer;
}

/**
 * 等待渲染器队列空闲（WebGPU 提交是异步的）：在「改阴影贴图尺寸 / 销毁纹理」前调用，
 * 避免旧提交仍在引用被销毁的纹理而报 GPUValidationError。WebGL 后端按顺序执行，直接返回。
 * @param {THREE.WebGPURenderer} renderer
 */
export async function waitRendererIdle3D(renderer) {
  const b = renderer && renderer.backend;
  try {
    if (b && b.isWebGPUBackend && b.device && b.device.queue) await b.device.queue.onSubmittedWorkDone();
  } catch (e) { /* 设备已丢失/已销毁：忽略，调用方继续 */ }
}

/**
 * 销毁渲染器（导出用临时渲染器）：
 * WebGPU 队列是异步提交的，直接 dispose 会在「上一次提交仍在执行」时销毁纹理/设备，
 * 触发 “Destroyed texture ... used in a submit” 的 GPUValidationError（控制台报错），
 * 因此先等队列空闲再销毁；WebGL 后端按顺序执行，直接 dispose 即可。
 * @param {THREE.WebGPURenderer} renderer
 */
export async function disposeRenderer3D(renderer) {
  if (!renderer) return;
  await waitRendererIdle3D(renderer);
  try { renderer.dispose(); } catch (e) { /* 已销毁则忽略 */ }
}

/** 实际生效的后端标识：'webgpu' | 'webgl' | 'unknown' */
export function backendOf(renderer) {
  const b = renderer && renderer.backend;
  if (!b) return 'unknown';
  if (b.isWebGPUBackend) return 'webgpu';
  if (b.isWebGLBackend) return 'webgl';
  return 'unknown';
}

/** 后端展示名（状态栏提示用）：WebGPU / WebGL */
export function backendLabel(renderer) {
  const k = backendOf(renderer);
  return k === 'webgpu' ? 'WebGPU' : k === 'webgl' ? 'WebGL' : '—';
}

/** 后端最大 2D 纹理尺寸（导出分瓦片用）：WebGPU 读设备限制，WebGL 读 GL 参数；读不到用 4096 保守值 */
export function maxTextureSize(renderer) {
  const b = renderer && renderer.backend;
  try {
    if (b && b.isWebGPUBackend && b.device && b.device.limits) {
      return b.device.limits.maxTextureDimension2D || 4096;
    }
    if (b && b.isWebGLBackend && b.gl) {
      return b.gl.getParameter(b.gl.MAX_TEXTURE_SIZE) || 4096;
    }
  } catch (e) { /* 后端内部结构变化时退回保守值，不影响导出 */ }
  return 4096;
}
