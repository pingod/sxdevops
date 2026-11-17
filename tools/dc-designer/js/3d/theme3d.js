/**
 * 3D 显示风格（主题）切换：**实景风（默认）** 与 **素模 / BIM 风**。
 *
 * 两套风格差在哪（同一份数据、同一套几何，只换材质与光照/背景）：
 *   · 实景风：程序化实景材质（静电地板、彩钢板墙、矿棉板吊顶、网孔门…）+ 深色底 + 强主光 + ACES，
 *     与历史外观逐像素一致——工勘记录「所见即现场」；
 *   · 素模风：浅色低饱和素模材质（按专业族分色：结构灰 / 配电暖金 / 暖通冷蓝 / 消防低饱和红）、
 *     去掉金属高光与实景纹理、构件加轮廓线、浅灰白底 + 柔和均匀光照——BIM 图纸式的方案汇报观感。
 *
 * 本模块负责：风格状态与记忆（localStorage 用户偏好，与语言/面板宽度同类）、场景光照参数、
 * 专业族配色映射，以及「逐对象创建的内联材质」的素模分支（墙体/风口/桥架网/吊顶/地板等）。
 * 材质表本体在 materials3d.js（REAL / BIM 两套，键名一一对应）。
 *
 * 约定：切换风格会整场景重建（几何不变、只换材质与光照），**不动数据、不动 2D**；
 *       3D 仍是纯查看，风格开关只影响渲染。
 */
import * as THREE from '../../lib/three/three.webgpu.min.js';
import { applyStyleMats } from './materials3d.js';

const KEY = 'idc2d_style3d_v1'; // 用户偏好：与语言（idc2d_locale_v1）同类，走 localStorage

let style = load();

function load() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'bim') return 'bim';
  } catch (e) { /* 隐私模式 / Node：用默认 */ }
  return 'real';
}
function save(s) {
  try { localStorage.setItem(KEY, s); } catch (e) { /* 存储不可用：忽略 */ }
}

/** 当前风格：'real'（实景，默认） | 'bim'（素模 / BIM） */
export function style3D() { return style; }
export function isBim3D() { return style === 'bim'; }

/** 设定风格（须在建模前调用）：同步材质表 M，并记忆为下次启动的默认 */
export function setStyle3D(s) {
  style = s === 'bim' ? 'bim' : 'real';
  applyStyleMats(style);
  save(style);
  return style;
}

/** 在两种风格间切换，返回新风格 */
export function toggleStyle3D() { return setStyle3D(style === 'bim' ? 'real' : 'bim'); }

/* 启动即同步一次材质表：即使不进 3D，材质索引也与风格一致（buildRoom 在测试/自检里被直接调用） */
setStyle3D(style);

/* ---------- 场景与光照参数（两套风格） ----------
 * fogNear/fogFar 为「按场景对角线的倍数」（viewer3d.layoutLights 里乘 diag）：
 * 实景用浓一点的雾压远墙、素模用很淡的雾（白模不该发灰）。 */
export const SCENE = {
  real: {
    bg: 0x151a21, fog: 0x151a21,
    hemiSky: 0xdfe8f5, hemiGround: 0x2a2d33, hemi: .9,
    dir: 2.1, fill: .55, fogNear: 1.6, fogFar: 3.4,
  },
  bim: {
    bg: 0xe6ebf0, fog: 0xeaeef2,
    hemiSky: 0xffffff, hemiGround: 0xc2cad2, hemi: 1,
    dir: 1.6, fill: .45, fogNear: 2.6, fogFar: 5.5,
  },
};

/** 当前风格的光照/背景参数 */
export function sceneStyle() { return SCENE[style]; }

/* ---------- 专业族配色 ---------- */
/** 实景色 → 素模色：低饱和、提亮；表外颜色原样返回（自动兼容新增类型色） */
const SYS = {
  0x2f6fb2: 0x5f7fa6, // 冷通道蓝
  0xc0392b: 0xa86055, // 热通道红 / 强电红
  0x2980b9: 0x63849f, // 弱电蓝
  0x27ae60: 0x5f9070, // 光纤绿
  0x8e44ad: 0x7d7391, // 其他类型（紫）
  0xc9a23b: 0xa88a4e, // 铜金（电池极柱等）
};
export function themeColor(hex) { return style === 'bim' ? (SYS[hex] ?? hex) : hex; }

/* ---------- 内联材质（逐对象创建，不进共享材质表） ---------- */
/**
 * 逐对象创建的材质取用：实景风跑 makeReal()（与历史代码完全一致），素模风跑 makeBim()。
 * 墙体/风口/桥架钢丝网/吊顶板/地板这些材质本就「每对象一份」（尺寸不同、纹理平铺次数不同），
 * 素模分支同样每对象一份——合并（merge3d）与销毁（disposeGroup）语义与实景完全一致。
 */
export function bimPick(makeReal, makeBim) { return style === 'bim' ? makeBim() : makeReal(); }

/** 素模专用：浅素色 PBR 材质（去高光的小工具，墙/风口等素模分支用） */
export function flat(color, roughness = .8, metalness = .03) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}
