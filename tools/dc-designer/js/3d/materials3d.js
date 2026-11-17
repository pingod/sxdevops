/**
 * 3D 材质与程序纹理库：全部由 Canvas 程序化生成，无外部图片资源依赖。
 * 纹理风格对准数据中心机房实景：HPL 防静电地板、彩钢板墙面、混凝土柱、
 * 机柜网孔门（大孔径透明打孔+孔沿高光）、U 位立柱孔条、网格桥架钢丝网（透明打孔）、
 * 柜内设备指示灯（按 U 行规则排布）、地板风口（格栅/孔板）等。
 * 本模块仅被 3D 渲染使用，与 2D 编辑器完全解耦，可独立迭代。
 */
import * as THREE from '../../lib/three/three.webgpu.min.js';
import { cabPaint, normalizeCabColor, mixHex, rgbaHex, hexInt } from '../cabinetcolor.js';

/** mm → m 换算（3D 场景以米为单位） */
export const S = 0.001;

/* ---------- Canvas 纹理生成 ---------- */
/** 绘制坐标保持逻辑尺寸不变，整体放大 k 倍（纹理密度提升 k 倍，保证 4096px 全景导出与近景放大细节清晰） */
function ctex(w, h, draw, k = 1) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const x = c.getContext('2d');
  if (k !== 1) x.scale(k, k);
  draw(x, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 16;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 随机细斑点（材质表面噪点） */
function speckle(x, w, h, n, alpha, light = false) {
  for (let i = 0; i < n; i++) {
    x.fillStyle = light ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
    x.fillRect(Math.random() * w, Math.random() * h, 1.4, 1.4);
  }
}

/** 静电地板砖（一帧 = 600×600mm 一块板）：浅灰 HPL 贴面 + 板缝 + 四角支架位 */
export const floorTex = ctex(96, 96, (x, w, h) => {
  x.fillStyle = '#d7d9dc'; x.fillRect(0, 0, w, h);
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, 'rgba(255,255,255,.12)'); g.addColorStop(1, 'rgba(0,0,0,.06)');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  speckle(x, w, h, 240, .05);
  speckle(x, w, h, 120, .05, true);
  x.strokeStyle = '#9ba0a6'; x.lineWidth = 2;
  x.strokeRect(1, 1, w - 2, h - 2);
  x.fillStyle = '#848b92';
  for (const [cx, cy] of [[4, 4], [w - 4, 4], [4, h - 4], [w - 4, h - 4]]) x.fillRect(cx - 2, cy - 2, 4, 4);
}, 4);

/** 吊顶板（一帧 = 600×600mm 一块板）：矿棉吸音板哑光面 + 明架 T 型龙骨网格边，
 *  四边各画半根龙骨，平铺后合成完整 600 模数网格 */
export const ceilTex = ctex(96, 96, (x, w, h) => {
  x.fillStyle = '#f2f3f4'; x.fillRect(0, 0, w, h);
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, 'rgba(255,255,255,.10)'); g.addColorStop(1, 'rgba(0,0,0,.05)');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  speckle(x, w, h, 260, .045);
  speckle(x, w, h, 120, .05, true);
  // T 型龙骨（白漆烤漆型钢）：龙骨面 + 板侧凹槽阴影线（半根 ≈15mm，拼合后 ≈30mm 视宽）；
  // 对比适度加强：俯视半透明纱罩下网格仍可读
  const bw = 2.4;
  x.fillStyle = '#b6bdc6';
  x.fillRect(0, 0, w, bw); x.fillRect(0, h - bw, w, bw);
  x.fillRect(0, 0, bw, h); x.fillRect(w - bw, 0, bw, h);
  x.fillStyle = 'rgba(0,0,0,.22)';
  x.fillRect(0, bw, w, 1); x.fillRect(0, h - bw - 1, w, 1);
  x.fillRect(bw, 0, 1, h); x.fillRect(w - bw - 1, 0, 1, h);
}, 4);

/** 吊顶网格线（一帧 = 600×600mm，透明底）：专供吊顶上面（室外俯视）——
 *  板面近全透明，仅 T 型龙骨网格可见：亮色线体在深色设备上可读，
 *  中央深色缝线在白墙/白地板背景上可读（双色线保证任意背景网格清晰）。
 *  alpha 取值偏小是刻意的：混合在**线性空间**、输出再编码回 sRGB，
 *  低 alpha 会被显著提亮（板面 alpha .07 铺在纯黑机柜上≈29% 灰的纱罩，
 *  把室内陈设糊成一片）。故板面仅留 2% 存在感，龙骨线/缝线同步调淡，
 *  俯视时室内机柜、桥架清晰可辨，网格仍可读 */
export const ceilGridTex = ctex(96, 96, (x, w, h) => {
  x.clearRect(0, 0, w, h);
  x.fillStyle = 'rgba(255,255,255,.02)'; x.fillRect(0, 0, w, h);   // 板面极轻微存在感（几乎全透明）
  const bw = 2.4;
  x.fillStyle = 'rgba(228,234,240,.5)';                            // 龙骨亮线（四边半根，拼合成整条）
  x.fillRect(0, 0, w, bw); x.fillRect(0, h - bw, w, bw);
  x.fillRect(0, 0, bw, h); x.fillRect(w - bw, 0, bw, h);
  x.fillStyle = 'rgba(35,45,55,.28)';                              // 中央深色缝线（板缝）
  x.fillRect(0, 0, w, .8); x.fillRect(0, h - .8, w, .8);
  x.fillRect(0, 0, .8, h); x.fillRect(w - .8, 0, .8, h);
}, 4);

/** 机房彩钢板墙面（一帧 = 1200×1200mm）：浅灰白 + 600mm 模数竖缝 */
export const wallTex = ctex(128, 128, (x, w, h) => {
  x.fillStyle = '#eceff1'; x.fillRect(0, 0, w, h);
  speckle(x, w, h, 150, .03);
  x.strokeStyle = 'rgba(118,128,138,.5)'; x.lineWidth = 1.4;
  x.beginPath();
  x.moveTo(.7, 0); x.lineTo(.7, h);
  x.moveTo(w / 2 + .7, 0); x.lineTo(w / 2 + .7, h);
  x.stroke();
  x.strokeStyle = 'rgba(255,255,255,.5)';
  x.beginPath(); x.moveTo(2, 0); x.lineTo(2, h); x.moveTo(w / 2 + 2, 0); x.lineTo(w / 2 + 2, h); x.stroke();
}, 4);

/** 混凝土（柱子） */
export const concreteTex = ctex(128, 128, (x, w, h) => {
  x.fillStyle = '#c0c4c7'; x.fillRect(0, 0, w, h);
  speckle(x, w, h, 700, .06);
  speckle(x, w, h, 320, .05, true);
}, 4);

/** 机柜网孔（一帧 = 50×50mm 钣金单元，透明打孔）：孔径 5.6mm / 孔距 10mm 交错排列，
 *  孔沿金属高光环 + 大孔径低密布局——远看成立体灰而不糊片，近看孔壁有受光边。
 *  底色/孔沿色可传入：默认深灰配色 = 历史外观；设了柜色的机柜用该色钣金重画一份（见 perfTexFor） */
function makeRackPerfTex(base, ring) {
  return ctex(64, 64, (x, w, h) => {
    x.fillStyle = base; x.fillRect(0, 0, w, h);
    speckle(x, w, h, 60, .05);
    speckle(x, w, h, 30, .04, true);
    const pitch = w / 5, r = pitch * .28;
    const holes = [];
    for (let row = 0, yy = pitch / 2; yy < h; yy += pitch, row++) {
      for (let xx = pitch / 2 + (row % 2) * pitch / 2; xx < w; xx += pitch) holes.push([xx, yy]);
    }
    // 9 宫格环绕绘制，保证平铺边缘无缝
    const ring9 = (cx, cy, rr, style) => {
      x.fillStyle = style;
      for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) {
        x.beginPath(); x.arc(cx + dx, cy + dy, rr, 0, Math.PI * 2); x.fill();
      }
    };
    for (const [hx, hy] of holes) ring9(hx, hy, r + 1.5, ring);        // 孔沿高光（上冲孔受光）
    x.globalCompositeOperation = 'destination-out';
    for (const [hx, hy] of holes) ring9(hx, hy, r, '#000');            // 打孔（透明，透视柜内）
  }, 4);
}
/** 默认深灰网孔纹理（未设柜色的机柜沿用，与历史外观逐像素一致） */
export const rackPerfTex = makeRackPerfTex('#26292f', 'rgba(190,200,210,.5)');

/** 机柜 U 位立柱孔条（一帧 = 35mm 宽 × 178mm=4U）：钣金折边 + 每 U 三个方孔（笼螺母安装孔） */
export const rackColTex = ctex(35, 178, (x, w, h) => {
  x.fillStyle = '#1e2126'; x.fillRect(0, 0, w, h);
  speckle(x, w, h, 40, .05);
  // 两侧钣金折边：外缘受光亮线 + 内侧阴影线
  x.fillStyle = 'rgba(255,255,255,.12)'; x.fillRect(0, 0, 2, h); x.fillRect(w - 2.5, 0, 1.2, h);
  x.fillStyle = 'rgba(0,0,0,.4)'; x.fillRect(3, 0, 2.2, h); x.fillRect(w - 5.5, 0, 2.2, h);
  // 每 U 三孔（顶/中/底），孔沿 1px 受光边
  const U = h / 4;
  for (let u = 0; u < 4; u++) {
    for (const f of [.2, .5, .8]) {
      const cy = (u + f) * U;
      x.fillStyle = 'rgba(200,208,216,.45)'; x.fillRect(w / 2 - 5, cy - 5, 10, 10);
      x.fillStyle = '#04060a'; x.fillRect(w / 2 - 4, cy - 4, 8, 8);
    }
  }
}, 4);

/** 柜内设备灯板（一帧 = 4U 设备面板，网孔门后透出）：每 U 一行——面板顶缝受光线、
 *  底部阴影缝、左侧状态灯组（绿为主，偶发琥珀/蓝）、右侧散热槽，规则排布如真实上架设备 */
export const ledTex = ctex(96, 48, (x, w, h) => {
  const U = h / 4, cols = ['#3fd97e', '#3fd97e', '#3fd97e', '#3fd97e', '#f2b134', '#2f81f7'];
  x.fillStyle = '#0b0d10'; x.fillRect(0, 0, w, h);
  for (let u = 0; u < 4; u++) {
    const y0 = u * U;
    x.fillStyle = 'rgba(255,255,255,.07)'; x.fillRect(0, y0, w, 1);           // 面板顶缝
    x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(0, y0 + U - 1, w, 1);         // 面板底影
    const n = 1 + (Math.random() * 3 | 0);                                    // 状态灯组
    for (let i = 0; i < n; i++) {
      x.fillStyle = cols[(Math.random() * cols.length) | 0];
      x.fillRect(5 + i * 4 + Math.random(), y0 + U / 2 - 1, 2, 2);
    }
    x.fillStyle = 'rgba(255,255,255,.05)';                                    // 散热槽
    for (let sx = w * .45; sx < w - 6; sx += 5) x.fillRect(sx, y0 + U / 2 - 2, 2.4, 4);
  }
}, 4);

/** 地板风口 · 格栅（平行百叶，白色铝合金） */
export const ventGrilleTex = ctex(96, 96, (x, w, h) => {
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h);
  x.fillStyle = '#e8ebee';
  for (let y = 9; y < h - 5; y += 12) x.fillRect(9, y, w - 18, 4);
  x.strokeStyle = '#dde1e5'; x.lineWidth = 3; x.strokeRect(1.5, 1.5, w - 3, h - 3);
}, 4);

/** 地板风口 · 孔板（冲孔通风板，白色） */
export const ventPerfTex = ctex(96, 96, (x, w, h) => {
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h);
  x.fillStyle = '#e8ebee';
  for (let y = 9; y < h - 5; y += 9) {
    for (let xx = 9; xx < w - 5; xx += 9) { x.beginPath(); x.arc(xx, y, 2.2, 0, Math.PI * 2); x.fill(); }
  }
  x.strokeStyle = '#dde1e5'; x.lineWidth = 3; x.strokeRect(1.5, 1.5, w - 3, h - 3);
}, 4);

/** 网格桥架钢丝网（一帧 = 100×100mm 网格单元，透明底打孔）：镀锌圆钢丝，纵丝 100mm / 横丝 50mm，交叉焊点 */
export const meshTrayTex = ctex(128, 128, (x, w, h) => {
  const wire = (x0, y0, x1, y1) => { // 圆钢丝：暗边 + 亮芯
    x.strokeStyle = '#7d838a'; x.lineWidth = 9; x.lineCap = 'round';
    x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.stroke();
    x.strokeStyle = '#ced3d9'; x.lineWidth = 4.5;
    x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.stroke();
  };
  wire(0, -5, 0, h + 5); wire(w, -5, w, h + 5);                              // 纵丝（两边缘各半根，平铺无缝）
  wire(-5, 0, w + 5, 0); wire(-5, h / 2, w + 5, h / 2); wire(-5, h, w + 5, h); // 横丝（50mm 间距）
  x.fillStyle = '#c3c9d0';                                                   // 交叉焊点
  for (const dx of [0, w]) for (const dy of [0, h / 2, h]) {
    x.beginPath(); x.arc(dx, dy, 6, 0, Math.PI * 2); x.fill();
  }
}, 4);

/** 素模（BIM 风格）地板/吊顶板（一帧 = 600×600mm）：中浅素色 + 600 模数分缝线——
 *  没有实景材质的高光/斑点/彩钢板缝，只留「模数网格」这一层与工勘数据一致的信息 */
function panelTex(base, line) {
  return ctex(48, 48, (x, w, h) => {
    x.fillStyle = base; x.fillRect(0, 0, w, h);
    x.strokeStyle = line; x.lineWidth = 1;
    x.strokeRect(.5, .5, w - 1, h - 1);
  }, 4);
}
export const bimFloorTex = panelTex('#c2c9d0', 'rgba(120,133,146,.6)');
export const bimCeilTex = panelTex('#d0d6db', 'rgba(120,133,146,.55)');

/** 克隆纹理并设置重复次数（纹理图像共享，仅 UV 独立，开销极小） */
export function rep(tex, rx, ry) {
  const t = tex.clone();
  t.repeat.set(Math.max(rx, .01), Math.max(ry, .01));
  t.needsUpdate = true;
  return t;
}

/* ---------- 共享材质集（场景重建时不销毁，见 viewer3d.disposeGroup） ----------
 * 两套风格各一份材质表、键名完全相同：REAL = 实景风（默认，与历史外观逐像素一致），
 * BIM = 素模风（浅色低饱和、按专业族分色、去金属高光）。构建器统一读 M.xxx，
 * 由 applyStyleMats() 把当前风格那一套拷进 M —— 建模代码不必知道风格。 */
export const REAL = {
  plenum: new THREE.MeshStandardMaterial({ color: 0x2b2f34, roughness: .95, metalness: 0 }), // 结构底板/格栅暗腔（不修改透明度）
  concrete: new THREE.MeshStandardMaterial({ map: concreteTex, roughness: .95, metalness: 0 }),
  rackBody: new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: .5, metalness: .6 }), // 机柜黑色钣金
  rackFrame: new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: .45, metalness: .7 }), // 机柜门框梁
  rackColSide: new THREE.MeshStandardMaterial({ color: 0x1b1e23, roughness: .5, metalness: .65 }),// 立柱净面（侧面）
  rackInner: new THREE.MeshStandardMaterial({ color: 0x0a0c0f, roughness: .95, metalness: .1 }), // 柜内暗腔（后门背板）
  handleMetal: new THREE.MeshStandardMaterial({ color: 0x909aa4, roughness: .3, metalness: .9 }),// 门拉手金属座
  pduBody: new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: .5, metalness: .6 }),  // 列头柜黑色钣金（略浅于机柜）
  pduStripe: new THREE.MeshStandardMaterial({ color: 0xb8860b, roughness: .5, metalness: .55 }),// 列头柜铜金标识条（配电，与桥架同族色）
  acBody: new THREE.MeshStandardMaterial({ color: 0x3a4148, roughness: .55, metalness: .45 }), // 精密空调外壳
  upsBody: new THREE.MeshStandardMaterial({ color: 0x2a3037, roughness: .5, metalness: .6 }),  // UPS 黑色钣金柜体（略深于列头柜）
  upsStripe: new THREE.MeshStandardMaterial({ color: 0xc99b23, roughness: .45, metalness: .6 }),// UPS 铜金电池标识条
  batBody: new THREE.MeshStandardMaterial({ color: 0x33302a, roughness: .55, metalness: .55 }), // 蓄电池柜深棕灰钣金（与 UPS 区分）
  batCell: new THREE.MeshStandardMaterial({ color: 0x1f3a2a, roughness: .6, metalness: .3 }),  // 电池单元深绿壳体（铅酸/锂电电池包）
  batPole: new THREE.MeshStandardMaterial({ color: 0xc9a23b, roughness: .4, metalness: .8 }),  // 电池极柱铜金
  extBody: new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: .45, metalness: .5 }),  // 灭火器瓶体消防红
  extHose: new THREE.MeshStandardMaterial({ color: 0x2b2f34, roughness: .7, metalness: .3 }),   // 灭火器喷管/压把深灰
  acPanel: new THREE.MeshStandardMaterial({ color: 0x22272d, roughness: .6, metalness: .4 }),  // 空调风机面板
  acScreen: new THREE.MeshBasicMaterial({ color: 0x79c7e8 }),                          // 空调显示屏
  steel: new THREE.MeshStandardMaterial({ color: 0xb7bcc2, roughness: .4, metalness: .85 }),   // 镀锌桥架
  aluminum: new THREE.MeshStandardMaterial({ color: 0xc6ccd3, roughness: .35, metalness: .9 }),// 铝型材（窗框/风口）
  doorSteel: new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: .5, metalness: .6 }),// 钢质防火门
  glass: new THREE.MeshStandardMaterial({ // 玻璃窗
    color: 0xa8c8dc, roughness: .12, metalness: .1, transparent: true, opacity: .32, depthWrite: false,
  }),
  grilleFrame: new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: .45, metalness: .1 }), // 格栅白色铝合金框
  dark: new THREE.MeshStandardMaterial({ color: 0x1d2126, roughness: .8, metalness: .3 }),
};

/** 素模（BIM 风格）材质表：键名与 REAL 逐一对应（构建器代码两套共用），
 *  调子：浅色低饱和「白模 + 专业族分色」——结构/围护为灰白、配电为暖金、暖通为冷蓝、消防保留低饱和红，
 *  金属高光基本去掉（metalness ≤ .25）、粗糙度提高，配合浅底 + 弱主光 + 轮廓线成 BIM 图纸观感 */
const B = (color, roughness = .6, metalness = .05) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });
export const BIM = {
  plenum: B(0x6c757d, .95, 0),        // 结构底板/格栅暗腔：中灰（保持「暗腔」层次）
  concrete: B(0xb4bbc2, .92, 0),      // 结构柱/梁：素混凝灰
  rackBody: B(0x6f7a86, .55, .06),    // 机柜柜体：中性灰蓝（比围护深两档，透过吊顶网格一眼可分）
  rackFrame: B(0x616b76, .55, .06),   // 机柜门框梁
  rackColSide: B(0x7d8894, .55, .06), // 立柱净面（侧面）
  rackInner: B(0x3f474f, .9, .04),    // 柜内暗腔（后门背板）
  handleMetal: B(0x596269, .5, .12),  // 门拉手金属座
  pduBody: B(0xab8f5e, .6, .05),      // 列头柜：暖金族（配电）
  pduStripe: B(0xc9ae74, .55, .08),   // 列头柜铜金标识条
  acBody: B(0x7f9db5, .6, .05),       // 空调：暖通冷蓝
  upsBody: B(0x9c8352, .6, .05),      // UPS：暖金
  upsStripe: B(0xbfa066, .55, .08),   // UPS 铜金标识条
  batBody: B(0x8d867a, .6, .05),      // 蓄电池柜：暖灰
  batCell: B(0x6f8d7c, .65, .05),     // 电池单元：低饱和青绿
  batPole: B(0xb29456, .5, .12),      // 电池极柱铜金
  extBody: B(0xb35a4d, .6, .05),      // 灭火器：消防红（低饱和但更实）
  extHose: B(0x5f666d, .7, .08),      // 喷管/压把
  acPanel: B(0x6d8ba3, .65, .05),     // 空调风机面板
  acScreen: new THREE.MeshStandardMaterial({ color: 0x86b8cc, emissive: 0x5f93ab, emissiveIntensity: .22, roughness: .4, metalness: 0 }), // 显示屏
  steel: B(0x94a0ab, .5, .22),        // 桥架/镀锌件
  aluminum: B(0xa9b3bd, .5, .18),     // 铝型材（窗框/风口）
  doorSteel: B(0xa4adb6, .6, .1),     // 钢质防火门
  glass: new THREE.MeshStandardMaterial({ // 玻璃隔断/窗（比实景更实一点，白底上能看出体量）
    color: 0x9dc2d6, roughness: .12, metalness: .05, transparent: true, opacity: .24, depthWrite: false,
  }),
  grilleFrame: B(0xc6ced5, .6, .05),  // 格栅框：浅冷灰
  dark: B(0x4e565e, .7, .08),         // 拉手/底座/暗件（白底场景里保持“暗件”的对比）
};

/** 当前风格材质索引：REAL/BIM 里那一套在建模前拷进来（活对象，构建器统一读 M.xxx） */
export const M = { ...REAL };

/* ---------- 动态共享材质（按柜体尺寸/柜色平铺纹理，key 相同只建一份；两套风格各一份缓存） ---------- */
const DYN = new Map(); // `${风格}|${key}` → 材质（与 REAL/BIM 一起列入共享材质，重建时不销毁）
/** 动态材质缓存上限：设了柜色的机柜会按「颜色 × 门尺寸」现做材质（同色共用），
 *  颜色种类理论上不受限（取色器），超过上限时整体清空——旧材质仍被当前场景引用，
 *  随下一次重建的 disposeGroup 一起释放，不会泄漏，只是要重做一次 */
const DYN_CAP = 240;
function dynMat(key, make) {
  const k = curStyle + '|' + key;
  if (!DYN.has(k)) {
    if (DYN.size >= DYN_CAP) DYN.clear();
    DYN.set(k, make());
  }
  return DYN.get(k);
}

/* ---------- 机柜自定义颜色（2D/3D 同一套派生规则，见 cabinetcolor.js） ---------- */
/** 3D 用色：素模风把自定义色向浅灰蓝压低一档饱和度（与 BIM 材质表同调），实景风原色 */
export function color3D(hex) {
  const c = normalizeCabColor(hex);
  if (!c) return '';
  return curStyle === 'bim' ? mixHex(c, '#8b949e', 0.45) : c;
}

/** 柜色派生结果（未设色返回 null：调用侧回退到共享默认材质） */
function paint3D(hex) {
  const c = color3D(hex);
  return c ? cabPaint(c) : null;
}

/** 网孔门纹理缓存：按钣金底色各画一份（一帧 256×256，同色机柜共用） */
const perfTexCache = new Map();
function perfTexFor(body, edge) {
  const k = body + '|' + edge;
  if (!perfTexCache.has(k)) {
    if (perfTexCache.size >= 32) perfTexCache.clear();
    perfTexCache.set(k, makeRackPerfTex(body, rgbaHex(edge, .5)));
  }
  return perfTexCache.get(k);
}

/** 设备外壳/面板共用配色；未设色直接复用历史材质。动态缓存与机柜同一生命周期。
 * 只给外壳与检修面板换色，显示屏、风扇、电池单元、金属五金仍保留功能色。 */
export function deviceMat(hex, base, part = 'body') {
  const pc = paint3D(hex);
  if (!pc) return base;
  return dynMat(`device|${base.uuid}|${pc[part]}`, () => {
    const m = base.clone();
    m.color.set(pc[part]);
    return m;
  });
}

/** 机柜柜身材质（侧板/底板/顶盖）：未设色 → 共享黑色钣金 M.rackBody */
export function rackBodyMat(hex) {
  const pc = paint3D(hex);
  if (!pc) return M.rackBody;
  const bim = curStyle === 'bim';
  return dynMat(`cabBody${pc.body}`, () => new THREE.MeshStandardMaterial({
    color: hexInt(pc.body), roughness: bim ? .55 : .5, metalness: bim ? .06 : .6,
  }));
}

/** 机柜门框梁 / 四角立柱净面材质（正面面向柜体色条方向）：未设色 → 共享 M.rackFrame / M.rackColSide */
export function rackFrameMat(hex, kind = 'frame') {
  const pc = paint3D(hex);
  if (!pc) return kind === 'col' ? M.rackColSide : M.rackFrame;
  const bim = curStyle === 'bim';
  return dynMat(`cab${kind === 'col' ? 'ColSide' : 'Frame'}${pc.front}`, () => new THREE.MeshStandardMaterial({
    color: hexInt(pc.front), roughness: bim ? .55 : (kind === 'col' ? .5 : .45), metalness: bim ? .06 : (kind === 'col' ? .65 : .7),
  }));
}

/** 素模色门板：比柜体暗一档，避免与侧板糊成一片（保留门/柜体分件感） */
const shadedDoor = body => mixHex(body, '#6f7a86', .35);

/** 机柜网孔门材质：实景=50mm 网孔纹理（按门面物理尺寸取整平铺，孔径恒定不随柜体拉伸）；
 *  素模=整片素色门板（无贴图/不镂空，浅灰蓝色块，BIM 观感更干净也更快）。
 *  hex 非空时按机柜柜色渲染（实景=该色钣金打孔的网孔纹理，素模=该色净面门板） */
export function rackPerfMat(wmm, hmm, hex) {
  const rx = Math.max(1, Math.round(wmm / 50)), ry = Math.max(1, Math.round(hmm / 50));
  const pc = paint3D(hex);
  if (!pc) return dynMat(`rackPerf${rx}x${ry}`, () => curStyle === 'bim'
    ? new THREE.MeshStandardMaterial({ color: 0xa8b1ba, roughness: .55, metalness: .08, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({
      map: rep(rackPerfTex, rx, ry), alphaTest: .45, roughness: .5, metalness: .55, side: THREE.DoubleSide,
    }));
  return dynMat(`rackPerf${rx}x${ry}|${pc.body}`, () => curStyle === 'bim'
    ? new THREE.MeshStandardMaterial({ color: hexInt(shadedDoor(pc.body)), roughness: .55, metalness: .08, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({
      map: rep(perfTexFor(pc.body, pc.edge), rx, ry), alphaTest: .45,
      roughness: .5, metalness: .55, side: THREE.DoubleSide,
    }));
}

/** U 位列柱正面材质（实景=178mm=4U 安装孔条纹理；素模=素色净面）：
 *  设了柜色时用素色（35mm 窄条上的孔条纹理肉眼不可辨，换色后仍与柜体同色系） */
export function rackColFaceMat(colH, hex) {
  const ry = Math.max(1, Math.round(colH / 178));
  const pc = paint3D(hex);
  if (!pc) return dynMat(`rackCol${ry}`, () => curStyle === 'bim'
    ? new THREE.MeshStandardMaterial({ color: 0x98a1aa, roughness: .55, metalness: .08 })
    : new THREE.MeshStandardMaterial({ map: rep(rackColTex, 1, ry), roughness: .35, metalness: .8 }));
  return dynMat(`rackCol${ry}|${pc.body}`, () => new THREE.MeshStandardMaterial({
    color: hexInt(pc.front), roughness: curStyle === 'bim' ? .55 : .35, metalness: curStyle === 'bim' ? .08 : .8,
  }));
}

/** 柜内设备灯板材质（实景=U 行指示灯纹理；素模=浅蓝微光面，保留「设备面」观感） */
export function rackLedMat(hmm) {
  const ry = Math.max(1, Math.round(hmm / 178));
  return dynMat(`rackLed${ry}`, () => curStyle === 'bim'
    ? new THREE.MeshStandardMaterial({ color: 0xb9cbd6, emissive: 0x7fa8bf, emissiveIntensity: .18, roughness: .5, metalness: 0 })
    : new THREE.MeshBasicMaterial({ map: rep(ledTex, 1, ry) }));
}

/* ---------- 风格材质切换 ---------- */
let curStyle = 'real';

/** 当前风格材质表（'real' | 'bim'；供动态材质工厂按风格分支） */
export function styleMats() { return curStyle; }

/** 把指定风格的材质表拷进 M（建模前调用；M 是活对象，全模块的 M.xxx 立即跟随） */
export function applyStyleMats(style) {
  curStyle = style === 'bim' ? 'bim' : 'real';
  const src = curStyle === 'bim' ? BIM : REAL;
  for (const k of Object.keys(src)) M[k] = src[k];
}

/** 全部共享材质（两套风格 + 动态材质）：viewer3d.disposeGroup 据此判定「不销毁」——
 *  切风格后旧场景里引用的另一套材质同样不能被销毁（否则切回去时材质/纹理已被释放） */
export function sharedMaterials() {
  return [...Object.values(REAL), ...Object.values(BIM), ...DYN.values()];
}
