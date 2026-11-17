/**
 * 3D 整机全景 PNG 导出：取景角度跟随用户当前旋转到的视角，透视相机按包围盒取整机全景
 * （与屏幕交互同为透视投影、同一 45° 垂直视场角，观感与屏幕一致不变形）。
 * 高精度输出：基准 8192px 长边，按瓦片分块离屏渲染（单瓦片 ≤4096px，投影矩阵
 * NDC 缩放+平移精确无缝拼接），白底、去雾、阴影提精、带比例尺与工勘落款。
 * 仅被 viewer3d.js 调用；渲染结束后临时渲染器即销毁，不打扰交互视角。
 * 渲染后端跟随主渲染器（主用 WebGPU 则导出也用 WebGPU，主回退 WebGL 2 则导出同样走 WebGL 2），
 * 避免两套后端驱动表现不一致；瓦片渲染 + 2D 画布拼接对两种后端均适用。
 *
 * 注意：exportFullPNG 现在是异步的（r185 的渲染器需 await init()，由 renderer3d.js 完成）。
 * 导出时把投影灯换成「克隆灯」，避免与主渲染器共享同一盏灯的阴影贴图（r185 会互相销毁）。
 */
import * as THREE from '../../lib/three/three.webgpu.min.js';
import { createRenderer3D, disposeRenderer3D, backendOf, maxTextureSize } from './renderer3d.js';
import { state } from '../state.js';
import { S } from './materials3d.js';
import { drawLabelsExport } from './labels3d.js';
import { t } from '../i18n.js';

const FALLBACK_T = Math.PI / 4;  // 默认方位角：东南（视角不可用时回退）
const FALLBACK_P = 0.85;         // 默认极角 ≈49°（与 fitCamera 默认取景一致）
const VFOV = Math.PI / 4;        // 垂直视场角 45°：与交互相机一致（同一投影观感）
const MARGIN = 1.06;             // 取景边距 6%
const BASE = 8192;               // 基准长边像素（高精度：4×4096 像素量，细节可放大阅读）
const PIX_BUDGET = 32e6;         // 单帧离屏缓冲总像素预算（≈128MB 显存，超采样自适应）

/**
 * 导出整机 3D 全景图。
 * @param {THREE.Scene} scene 当前 3D 场景
 * @param {{bounds:object, roomH:number, ceilH:number}} built buildRoom() 的返回值（整机包围盒）
 * @param {THREE.WebGPURenderer} main 主渲染器（拷贝色调映射/阴影参数，并决定离屏后端）
 * @param {{t:number, p:number}|null} view 当前视角（方位角/极角，跟随 Orbit3D 控制器的实际朝向）
 * @returns {Promise<boolean>} 是否成功
 */
export async function exportFullPNG(scene, built, main, view) {
  // 取景角度跟随当前视角；极角限幅与 Orbit3D 一致，避免 lookAt 退化
  const THETA = view?.t ?? FALLBACK_T;
  const PHI = Math.min(1.52, Math.max(0.08, view?.p ?? FALLBACK_P));
  const b = built.sceneBounds3d || built.bounds, Hm = (built.sceneBounds3d?.maxz ?? built.roomH ?? 3000) * S;
  const floorBot = (built.sceneBounds3d?.minz ?? -(((state.project.meta || {}).floorHeight ?? 400) + 40)) * S;
  const W = (b.maxx - b.minx) * S, D = (b.maxy - b.miny) * S;
  const diag = Math.hypot(W, D, Hm - floorBot);
  const target = new THREE.Vector3(
    (b.minx + b.maxx) / 2 * S, built.sceneBounds3d ? (Hm+floorBot)*.5 : Hm*.32, -(b.miny + b.maxy) / 2 * S);
  const dir = new THREE.Vector3().setFromSphericalCoords(1, PHI, THETA); // 目标→相机的单位向量

  // 透视相机：先按估算距离摆位，求相机空间坐标轴（方位/俯仰与屏幕视角一致）
  const cam = new THREE.PerspectiveCamera(VFOV * 180 / Math.PI, 1, 0.01, 1000);
  cam.position.copy(target).addScaledVector(dir, Math.max(diag * 1.05, 3));
  cam.lookAt(target);
  cam.updateMatrixWorld();
  const mInv = cam.matrixWorld.clone().invert();

  // 包围盒 8 角（含结构楼板底）转相机空间：相机空间 z = -(s + d)，s 为角点沿视线相对目标的分量
  const x0 = b.minx * S, x1 = b.maxx * S;
  const z0 = -b.maxy * S, z1 = -b.miny * S; // 世界 z = -y*S（与 builders3d 一致）
  const world = [];
  for (const x of [x0, x1]) for (const z of [z0, z1]) for (const y of [floorBot, Hm]) {
    world.push(new THREE.Vector3(x, y, z));
  }
  // 垂直约束：所有角点 |y| ≤ (d+s)·tan(VFOV/2) → 求最小取景距离 d（投影观感与屏幕一致）
  const tanV = Math.tan(VFOV / 2);
  let needD = 0;
  for (const w of world) {
    const v = w.clone().applyMatrix4(mInv);
    needD = Math.max(needD, Math.abs(v.y) / tanV - v.z);
  }
  const d = Math.max(diag * 1.05, needD) * MARGIN;

  // 按最终距离重新摆位；水平约束由图像长宽比承担：aspect ≥ max |x|/(d_i·tanV)
  cam.position.copy(target).addScaledVector(dir, d);
  cam.lookAt(target);
  cam.updateMatrixWorld();
  const mInv2 = cam.matrixWorld.clone().invert();
  let needA = 1, maxZ = -Infinity, minZ = Infinity;
  for (const w of world) {
    const v = w.clone().applyMatrix4(mInv2);
    const di = -v.z;
    needA = Math.max(needA, Math.abs(v.x) / (di * tanV));
    maxZ = Math.max(maxZ, v.z);
    minZ = Math.min(minZ, v.z);
  }
  cam.aspect = Math.max(needA, .5) * MARGIN;
  const mgZ = diag * .15;
  cam.near = Math.max(0.01, -maxZ - mgZ);
  cam.far = -minZ + mgZ * 2;

  // 离屏渲染器：与主渲染器同后端（WebGPU/WebGL 2）；r185 需 await init() 后才能 render
  const off = await createRenderer3D(document.createElement('canvas'), {
    antialias: true,
    forceWebGL: backendOf(main) === 'webgl',
  });
  // 相机坐标系统必须与后端一致（两者裁剪空间深度约定不同）：否则渲染器每次都会用 fov/aspect
  // 重算投影矩阵（updateProjectionMatrix），盖章式覆盖下面按瓦片手工设置的分块投影，
  // 导出图会变成几张重复的整机图（瓦片拼接失效）。先对齐坐标系统，再算基准投影。
  cam.coordinateSystem = off.coordinateSystem;
  cam.updateProjectionMatrix();

  // 导出分辨率：按取景长宽比定尺寸，BASE 为基准长边
  const aspect = cam.aspect;
  let wpx, hpx;
  if (aspect >= 1) { wpx = BASE; hpx = Math.max(200, Math.round(BASE / aspect)); }
  else { hpx = BASE; wpx = Math.max(200, Math.round(BASE * aspect)); }

  try {
    off.setPixelRatio(1); // 分辨率完全由我们指定，避免 HiDPI 把离屏缓冲意外放大
    off.outputColorSpace = main.outputColorSpace;
    off.toneMapping = main.toneMapping;
    off.toneMappingExposure = main.toneMappingExposure;
    off.shadowMap.enabled = main.shadowMap.enabled;
    off.shadowMap.type = main.shadowMap.type;
    const maxTex = maxTextureSize(off);

    // 瓦片网格：单瓦片渲染缓冲不超过显卡纹理上限（且 ≤4096），低端显卡也可用
    const maxTile = Math.min(4096, maxTex);
    const nx = Math.max(1, Math.ceil(wpx / maxTile));
    const ny = Math.max(1, Math.ceil(hpx / maxTile));
    const tileW = Math.ceil(wpx / nx), tileH = Math.ceil(hpx / ny);
    // 超采样：仅在单帧（无需分瓦片）时按像素预算启用，瓦片渲染时瓦片本身已足够大；
    // 倍率还受后端纹理上限约束（低端 WebGPU 设备上限 4096 时不可超采样到 8192）
    const ssMax = Math.max(1, Math.floor(maxTile / Math.max(tileW, tileH)));
    const ss = (nx === 1 && ny === 1)
      ? Math.max(1, Math.min(2, ssMax, Math.floor(Math.sqrt(PIX_BUDGET / (wpx * hpx)))))
      : 1;
    const bw = tileW * ss, bh = tileH * ss;
    off.setSize(bw, bh, false);

    // 投影灯克隆（关键）：r185 的阴影贴图按「灯对象」共享，两套渲染器同时渲染同一盏灯会互相
    // 销毁对方正在使用的贴图（GPUValidationError: Destroyed texture ... used in a submit）。
    // 做法：导出前为场景里每盏投影灯克隆一份（独立阴影贴图），克隆灯上做阴影提精；原灯临时
    // 隐藏（调用方已暂停交互渲染循环，画面不受影响），导出结束后移除克隆并恢复原灯。
    const lights = cloneShadowLights(scene);
    try {
      for (const { clone } of lights) {
        if (!clone.shadow) continue;
        const sz = Math.min(8192, maxTex); // 全景下阴影临时提精：2048 会发糊发块
        clone.shadow.mapSize.set(sz, sz);
        // 各瓦片共用同一盏灯同一机位：阴影贴图只需在第一块瓦片算一次
        // （否则每块瓦片都重算 8192² 阴影，导出耗时翻倍）
        clone.shadow.autoUpdate = false;
        clone.shadow.needsUpdate = true;
      }

      // 临时：白底 + 去雾（交互取景的雾距在全景下会把远物发灰）
      const oldBg = scene.background, oldFog = scene.fog;
      scene.background = new THREE.Color(0xffffff);
      scene.fog = null;

      // 最终画布 + 瓦片渲染拼接（投影矩阵 NDC 缩放+平移，无缝精确拼接）
      const c = document.createElement('canvas');
      c.width = wpx; c.height = hpx;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      const baseProj = cam.projectionMatrix.clone();
      const M = new THREE.Matrix4();
      try {
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            // 瓦片 (ix,iy)：NDC 子区间放大到 [-1,1] → P_tile = Scale(nx,ny,1)·Translate(tx,ty,0)·P
            // x：NDC 向右、列号从左到右；y：NDC 向上、行号从顶部向下，两者符号相反
            const tx = (nx - 1 - 2 * ix) / nx, ty = (2 * iy - (ny - 1)) / ny;
            M.makeTranslation(tx, ty, 0);
            M.premultiply(new THREE.Matrix4().makeScale(nx, ny, 1));
            cam.projectionMatrix.copy(M).multiply(baseProj);
            cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
            off.render(scene, cam);
            g.drawImage(off.domElement, 0, 0, bw, bh,
              ix * tileW, iy * tileH, tileW, tileH);
          }
        }
      } finally {
        cam.projectionMatrix.copy(baseProj);
        cam.projectionMatrixInverse.copy(baseProj).invert();
        scene.background = oldBg;
        scene.fog = oldFog;
      }

      // 合成最终画布：机柜编号浮标 + 比例尺 + 工勘落款（样式对齐 2D 导出）
      // 浮标放在投影矩阵恢复之后画：与屏幕同一套透视（矢量文字）；尺寸按导出的实际比例尺
      // （px/m = 1/mPerPx，机房中心深度口径，与下面的比例尺同一套换算）换算世界尺寸，
      // 于是导出图里浮标与机柜的相对大小 = 屏幕上整机取景时的观感
      drawLabelsExport(g, cam, wpx, hpx, hpx / (2 * tanV * d));
      // 透视视图比例尺按机房中心深度标定，标注 ≈ 示意近似
      drawScaleBar(g, wpx, hpx, 2 * tanV * d / hpx, true);
      drawCaption(g, wpx, hpx);

      const a = document.createElement('a');
      a.download = (state.project.name || t('file.png3dName')) + t('file.png3dSuffix') + '.png';
      a.href = c.toDataURL('image/png');
      a.click();
      return true;
    } finally {
      releaseShadowLights(lights); // 移除克隆投影灯、恢复原灯可见性（失败也需还原）
    }
  } finally {
    // 释放临时渲染器（WebGPU 先等队列空闲再销毁，避免销毁纹理时的 GPU 校验报错）
    await disposeRenderer3D(off);
  }
}

/**
 * 为场景中每盏投影灯建立一份克隆（返回克隆灯数组），并在导出期间隐藏原灯：
 * three r185 的阴影贴图以「灯对象」为键共享，主渲染器与导出渲染器用同一盏灯会互相销毁
 * 对方正在使用的阴影贴图；克隆灯自带完整的 shadow（mapSize/bias/相机范围，由 clone() 复制），
 * 与主渲染器彻底隔离。克隆灯加入原灯同一父节点（保持世界变换），目标点（DirectionalLight/
 * SpotLight 的 target）一并克隆并挂到原 target 的父节点，保证矩阵世界变换每帧被更新。
 */
function cloneShadowLights(scene) {
  const casters = [];
  scene.traverse(o => { if (o.isLight && o.castShadow) casters.push(o); });
  const pairs = [];
  for (const L of casters) {
    const C = L.clone();
    (L.parent || scene).add(C);
    if (C.target) { // 平行光/聚光灯的朝向目标点（原实现里 target 与灯同层级挂在场景下）
      if (L.target) C.target.position.copy(L.target.position);
      (L.target && L.target.parent ? L.target.parent : scene).add(C.target);
      C.target.updateMatrixWorld(true);
    }
    pairs.push({ light: L, clone: C, visible: L.visible });
    L.visible = false;      // 原灯退出导出渲染（隐藏的灯不参与渲染，也不更新阴影状态）
  }
  return pairs;
}

/** 导出结束后还原：移除克隆灯（含其 target）并恢复原灯可见性 */
function releaseShadowLights(pairs) {
  for (const { light, clone, visible } of pairs) {
    light.visible = visible; // 还原导出前可见性（本应用里投影灯恒可见，兼顾通用场景）
    if (clone.target && clone.target.parent) clone.target.parent.remove(clone.target);
    if (clone.parent) clone.parent.remove(clone);
  }
}

/** 底部左侧比例尺（与 2D 导出呼应）：长度取 1/2/5×10ⁿ 的整米数，白晕保证深色场景可读；approx=透视近似 */
function drawScaleBar(g, w, h, mPerPx, approx) {
  if (!(mPerPx > 0)) return;
  const target = Math.min(w / 5, 360);
  let nice = 1;
  outer: for (;;) {
    for (const s of [1, 2, 5]) {
      if (nice * s / mPerPx >= target) { nice *= s; break outer; }
    }
    nice *= 10;
  }
  const px = nice / mPerPx, y = h - 16;
  g.save();
  g.strokeStyle = '#5b6470';
  g.lineWidth = 2;
  g.shadowColor = 'rgba(255,255,255,.92)';
  g.shadowBlur = 5;
  g.beginPath();
  g.moveTo(24, y); g.lineTo(24 + px, y);                 // 主体
  g.moveTo(24, y - 4); g.lineTo(24, y + 4);              // 左端
  g.moveTo(24 + px, y - 4); g.lineTo(24 + px, y + 4);    // 右端
  g.stroke();
  g.shadowBlur = 4;
  g.fillStyle = '#5b6470';
  g.font = `${Math.max(12, Math.round(w / 160))}px sans-serif`;
  g.textAlign = 'left';
  g.textBaseline = 'bottom';
  g.fillText(`${approx ? '≈ ' : ''}${Math.round(nice)} m${approx ? t('export3d.approx') : ''}`, 24 + px + 8, y + 1);
  g.restore();
}

/** 工勘落款：机房名 | 勘测：xx | 日期，白晕保证在深色场景上可读 */
function drawCaption(g, w, h) {
  const meta = state.project.meta || {};
  const info = [state.project.name,
    meta.surveyor ? t('export.surveyor') + meta.surveyor : '',
    meta.date || ''].filter(Boolean).join('  |  ');
  if (!info) return;
  g.save();
  g.font = `${Math.max(12, Math.round(w / 160))}px sans-serif`;
  g.textAlign = 'right';
  g.textBaseline = 'bottom';
  g.shadowColor = 'rgba(255,255,255,.92)';
  g.shadowBlur = 6;
  g.fillStyle = '#5b6470';
  g.fillText(info, w - 16, h - 12);
  g.restore();
}
