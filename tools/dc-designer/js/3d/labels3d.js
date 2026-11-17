/**
 * 3D 机柜编号浮标（3D 查看模式）：把每台机柜的编号（props.name）以浮标形式标在柜顶上方，
 * 一眼看清哪个编号是哪台柜，不必逐台悬停。纯查看装饰，**不写任何数据、不动 2D**。
 *
 * 为什么用 DOM 覆盖层，而不是场景里的贴图 Sprite / 广告牌四边形：
 *   · **任何缩放下都清晰**——浏览器直接排文字，没有「纹素密度 vs 放大倍数」的矛盾。
 *     场景贴图在 8192px 全景导出时要 4× 密度重制才不糊（见 materials3d.ctex），浮标若也用贴图
 *     同理只能靠加分辨率，而机柜数量多、每台一份纹理显存也吃不消；
 *   · **零 draw call、零显存**——本场景的性能瓶颈本就是 draw call（见 merge3d.js 的实测）。
 *     90 台机柜再多 90 个 Sprite/四边形会直接把合并优化省下的开销吃回去；
 *     DOM 只在实际出帧时更新 transform（脏标记渲染：相机静止则一次都不做）；
 *   · **不挡交互**——容器 pointer-events:none，悬停拾取（pick3d）照常命中机柜；
 *   · **导出即矢量文字**——整机全景导出由 export3d 调到 drawLabelsExport()，按导出的实际比例尺换算后
 *     画进导出画布（世界尺寸 × 导出 px/m），8192px 下文字仍是矢量边缘（见 README「整机 3D 全景导出」）。
 * 代价（刻意的）：浮标不参与深度测试（墙体挡不住它）——从室外 / 俯视角度也能一眼读到室内编号，
 *     这正是编号浮标的用途；被隔离（隐藏）的机柜，其浮标同步消失（不给「看不见却能读编号」的幽灵提示）。
 *
 * 尺寸：屏幕上浮标大小取「视口高度的固定比例」（地图图钉观感）——缩放时字号恒定不跟着变大变小，
 *      远近一致可读；**导出**时换算成世界尺寸（= 取景半径 × 固定比例，见 WORLD_H_K/WORLD_F_K）
 *      再按导出的比例尺画：导出图里浮标与机柜的相对大小固定，不随用户当时屏幕大小/缩放而变，
 *      仍是矢量文字（8192px 下依然锐利）。
 * 什么时候不显示（两层规则，缩小视图不会堆成一团、也不是“一堆碎字”）：
 *   ① **过远不标**：机柜屏幕观感宽度（按相机距离折算，不受朝向斜视影响）不足 MIN_RACK_PX(18px)
 *     时不标编号——这时编号比柜子还宽、无从对应，缩小到一定程度编号自然全部隐去
 *     （回近自动重现，并在状态栏提示一次）；
 *   ② **去重叠**：机柜够大但浮标互相压住时，按「近处优先」在屏幕空间贪心占位，
 *     重叠的暂时隐去（同地标式标注 decluttering）——摄像机拉近、浮标分开后自动重现；
 *   悬停的那台机柜永远保留（优先级最高）。导出图用同一套规则（按导出分辨率等比换算）。
 * 联动：isolate3d（被隔离的机柜不显示浮标）、pick3d（悬停的机柜浮标转为琥珀色高亮）。
 */
import * as THREE from '../../lib/three/three.webgpu.min.js';
import { ui } from '../state.js';
import { t } from '../i18n.js';
import { deviceZ } from '../device.js';
import { S } from './materials3d.js';
import { isIsolated3D } from './isolate3d.js';
import { hoveredObject } from './pick3d.js';

const KEY = 'idc2d_labels3d_v1';      // 用户偏好（与语言 / 显示风格同类），走 localStorage
const TOP_GAP = 160;                  // 浮标锚点高于柜顶（mm）：三角指针大概指向柜顶
const PLATE_HEX = '#151b23';          // 浮标底板色（与 CSS .lb3d 背景一致）
const FONT = '"Microsoft YaHei","PingFang SC",system-ui,-apple-system,sans-serif';
const EDGE = 320, EDGE_Y = 120;       // 视口外余量（px）：超出这么多就不必再写样式

let on = loadEnabled();               // 编号浮标：默认显示（要隐藏按 L 或点「编号」按钮）
let visible = false;                  // 当前是否在 3D 查看模式（容器显隐 = on && visible）
let box = null;                       // 浮标容器（#view-wrap 内覆盖 3D 画布）
let items = [];                       // [{ id, name, twe, el, tx, hw, x/y/z, px/py, depth, show/shown/hi/zi }]
const byId = new Map();               // 对象 id → 浮标项（数据变更时复用 DOM 节点）
let farWarn = false;                  // “视图过远、编号已隐去”提示是否已发出（回近后复位）
let viewW = 0, viewH = 0;             // 最近一次布局的视口尺寸（CSS 像素）
let fontPx = 13, plateH = 21;         // 当前字号 / 浮标高（按视口高换算，见 applyMetrics）
let fitR = 0;                         // 整机取景半径（m，viewer3d.rebuild 传入）：导出换算世界尺寸的基准
let worldH = 0, worldFont = 0;        // 导出用浮标世界尺寸（m）= 取景半径 × 固定系数（见 applyMetrics）

const V = new THREE.Vector3();        // 复用向量：逐帧投影不产生 GC
const V2 = new THREE.Vector3();       // 复用向量：相机距离 / 坐标换算用
const M4 = new THREE.Matrix4();       // 导出投影复用（projection · matrixWorldInverse）
const MAX_EM = 13;                    // 浮标最大宽度（em，与 CSS max-width 一致）
const PAD_EM = .3;                    // 左右内边距（em，与 CSS padding 一致）
const GAP = 1;                        // 去重叠判定的最小间隔（px）
const MIN_RACK_PX = 18;               // 机柜屏幕宽度下限（px）：比这更小就不标编号（编号比柜子还宽，无从对应）
const TANV = Math.tan(Math.PI / 8);   // 相机垂直半视场角正切（viewer3d 的 PerspectiveCamera 45°）
const WORLD_H_K = .021, WORLD_F_K = .013; // 导出浮标世界尺寸 = 取景半径 × 这两个系数（≈ 屏幕 818px 高、整机取景时的观感）
let measureCtx = null;                // 文字宽度量尺（建标签时算一次，逐帧去重叠直接用，不读 DOM 布局）
let bands = null;                     // 去重叠占位桶：行号 → 已占位矩形（逐帧复用，避免 GC）
const usedBands = [];

function loadEnabled() {
  try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; } // 隐私模式/Node：默认开
}
function saveEnabled() {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* 存储不可用：忽略 */ }
}

/** 当前是否显示编号浮标（自检 / 测试用） */
export function labels3D() { return on; }
/** 浮标数量（自检 / 测试用） */
export function labelCount3D() { return items.length; }

/** 初始化（ensureGL 时调用一次）：在视图容器里建浮标层（DOM 覆盖 3D 画布，pointer-events:none） */
export function initLabels3D(host) {
  if (box || !host) return;
  box = document.createElement('div');
  box.id = 'labels3d';
  box.className = 'labels3d';
  host.appendChild(box);
  applyMetrics();
  syncBox();
}

/** 设定是否显示编号浮标（记忆为下次启动的默认）；返回设定后的状态 */
export function setLabels3D(v) {
  on = !!v;
  saveEnabled();
  syncBox();
  return on;
}

/** 在显示 / 隐藏之间切换，返回切换后的状态 */
export function toggleLabels3D() { return setLabels3D(!on); }

/** 进入 / 退出 3D 查看模式时调用：浮标只在 3D 中显示 */
export function setLabelsVisible3D(v) {
  visible = !!v;
  syncBox();
}

/** 数据变更 / 进入 3D 后重建浮标清单：**按对象 id 复用 DOM 节点**，名称变了只改文字，多余节点移除 */
export function buildLabels3D(project) {
  if (!box) return;
  const objs = (project && project.objects) || [];
  const next = [], seen = new Set();
  for (const o of objs) {
    if (o.type !== 'cabinet') continue;                       // 只标机柜编号（列头柜/UPS 等悬停即见名称）
    const name = String((o.props && o.props.name) || '').trim();
    if (!name) continue;                                      // 机柜没编号：无标可浮
    seen.add(o.id);
    let it = byId.get(o.id);
    if (!it) {
      const el = document.createElement('div');
      el.className = 'lb3d';
      const tx = document.createElement('span');
      tx.className = 'lb3d-t';
      el.appendChild(tx);
      box.appendChild(el);
      it = { id: o.id, name: '', el, tx, twe: 1, x: 0, y: 0, z: 0, hw: .3, px: -1e9, py: -1e9, lastX: -1e9, lastY: -1e9, depth: 0, show: false, shown: false, hi: false, zi: -1 };
      byId.set(o.id, it);
    }
    if (it.name !== name) { it.name = name; it.tx.textContent = name; it.twe = textEm(name); }
    // 世界坐标（m）：x3 = x·S，y3 = 高度·S，z3 = -y·S（与 builders3d 的映射一致）
    it.x = o.x * S;
    it.y = (deviceZ(o) + (+(o.props && o.props.h) || 2000) + TOP_GAP) * S;
    it.z = -o.y * S;
    it.hw = ((+(o.props && o.props.w) || 600) / 2) * S;   // 半宽（m）：“缩得太小就不标”的判据用（按相机距离折算）
    next.push(it);
  }
  for (const [id, it] of byId) if (!seen.has(id)) { it.el.remove(); byId.delete(id); }
  items = next;
  farWarn = false;                                            // 重建后重新允许“过远隐去”提示
}

/** 出帧时更新浮标：渲染循环在 renderer.render 之后调用（相机矩阵已是本帧渲染用的值）。
 *  相机静止时不调用（脏标记渲染），浮标随之静止——不产生任何每帧开销。
 *  逐帧三步：① 屏幕投影（并算每台机柜的屏幕宽度）；② 筛选（过小不标 + 去重叠）；③ 落到 DOM。 */
export function labelsFrame(camera, w, h) {
  if (!box || !camera) return;
  if (w > 0 && h > 0 && (w !== viewW || h !== viewH)) { viewW = w; viewH = h; applyMetrics(); }
  if (!on || !visible || !viewW || !viewH) return;
  camera.updateMatrixWorld();                                  // 相机矩阵（含 matrixWorldInverse）为当前值
  const hov = hoveredObject();
  const hiId = hov && hov.type === 'cabinet' ? hov.id : null;

  // ① 投影：筛出本帧候选（未隔离、在相机前方、在视口附近）；同时量出每台机柜的屏幕宽度
  const cand = [];
  let widest = 0, tooSmall = false;
  for (const it of items) {
    it.show = false;
    if (isIsolated3D(it.id)) continue;
    V.set(it.x, it.y, it.z).project(camera);                   // 世界 → NDC（自带透视除法）
    if (V.z < -1 || V.z > 1) continue;                         // 相机背后 / 超远平面
    const px = (V.x * .5 + .5) * viewW, py = (.5 - V.y * .5) * viewH;
    if (px < -EDGE || px > viewW + EDGE || py < -EDGE_Y || py > viewH + EDGE_Y) continue;
    it.px = px; it.py = py; it.depth = V.z;
    // 机柜屏幕观感宽度（按相机距离折算）：缩得太小时编号比柜子还宽、无从对应 → 干脆不标
    const rw = rackPxOf(camera, it, viewH);
    if (rw > widest) widest = rw;
    if (rw < MIN_RACK_PX) { tooSmall = true; continue; }
    cand.push(it);
  }

  // ② 去重叠（地标式标注去重）：近处优先 + 悬停项最优先（永远保留），
  //    按屏幕矩形贪心占位；与本帧已占位者重叠的隐去（不显示）
  if (cand.length > 1) cand.sort((a, b) => (a.id === hiId ? -1 : b.id === hiId ? 1 : a.depth - b.depth));
  clearBands();
  for (const it of cand) {
    const bw = Math.min(fontPx * (it.twe + PAD_EM * 2) + 2, fontPx * (MAX_EM + PAD_EM * 2) + 2);
    const x0 = it.px - bw / 2, x1 = it.px + bw / 2;
    const y0 = it.py - plateH, y1 = it.py + Math.round(plateH * .15); // 下三角只算一点：别为它多隐一个编号
    if (!place(x0, y0, x1, y1, plateH + 6)) continue;
    it.show = true;
  }

  // 视图过远：该标的全被“太小”筛掉时给一次提示（免得以为开关坏了；放大后自动重现）
  const far = tooSmall && widest > 0 && widest < MIN_RACK_PX;
  if (far && !farWarn) ui.hint(t('labels3d.far'));
  farWarn = far;

  // ③ 落到 DOM（位置变化 > 0.4px 才写样式；显隐/高亮/层次仅在变化时改）
  for (const it of items) {
    const show = it.show;
    if (show) {
      if (!it.shown || Math.abs(it.px - it.lastX) > .4 || Math.abs(it.py - it.lastY) > .4) {
        it.el.style.transform = `translate3d(${Math.round(it.px)}px,${Math.round(it.py)}px,0) translate(-50%,-100%)`;
        it.lastX = it.px; it.lastY = it.py;
      }
      // 层次：近处的浮标盖住远处的（按 NDC 深度量化，仅在跨档时写一次样式）
      const zi = Math.min(60, Math.max(0, Math.round((1 - (it.depth * .5 + .5)) * 60)));
      if (zi !== it.zi) { it.el.style.zIndex = String(zi); it.zi = zi; }
    }
    if (show !== it.shown) { it.el.classList.toggle('on', show); it.shown = show; }
    const hi = it.id === hiId;
    if (hi !== it.hi) { it.el.classList.toggle('hi', hi); it.hi = hi; }
  }
}

/**
 * 整机全景导出（export3d 在瓦片拼接完成后调用）：把浮标按导出的实际比例尺矢量画进导出画布。
 * 尺寸 = 世界尺寸 × 导出 px/m（世界尺寸由 setLabelsFitR3D 传入的取景半径换算，见 WORLD_H_K）；
 * 于是导出图里浮标与机柜的相对大小固定（不随用户当时屏幕大小/缩放而变），且是矢量文字（8192px 下不糊）；
 * 去重叠与“过远不标”规则与屏幕同一套（近处优先贪心占位），导出的全景图同样不会堆成一团。
 * @param {number} ppm 导出比例尺（px/m，机房中心深度口径，由 export3d 按 1/mPerPx 传入）
 */
export function drawLabelsExport(g, camera, wpx, hpx, ppm) {
  if (!on || !items.length || !(wpx > 8) || !(hpx > 8)) return;
  const fitPpm = fitPpmOf();                                 // 整机取景比例尺（px/m）：判断“这么小的柜子还要不要标”
  const ppmE = ppm > 0 ? ppm : (hpx / (2 * TANV * Math.max(fitR, 1))); // 导出比例尺（px/m，机房中心口径）
  const fs = Math.max(9, Math.round(worldFont * ppmE));       // 世界尺寸 × 导出比例尺 = 导出图字号
  const ph = Math.max(12, Math.round(worldH * ppmE));
  const padX = Math.round(fs * PAD_EM), tri = Math.max(2, Math.round(fs * .3));
  camera.updateMatrixWorld();
  M4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  // 投影 + 近处优先排序 + 贪心占位（与屏幕同一套去重叠规则）
  const cand = [];
  for (const it of items) {
    if (isIsolated3D(it.id)) continue;                         // 被隔离的机柜：导出图里也不画
    // 过远不标（与屏幕同口径）：机柜在「整机取景」比例尺下不足 MIN_RACK_PX 时就不标
    if (fitPpm > 0 && it.hw * 2 * fitPpm < MIN_RACK_PX) continue;
    const v = V.set(it.x, it.y, it.z).applyMatrix4(M4);
    if (v.z < -1 || v.z > 1) continue;
    it.ex = (v.x * .5 + .5) * wpx; it.ey = (.5 - v.y * .5) * hpx; it.depth = v.z;
    cand.push(it);
  }
  cand.sort((a, b) => a.depth - b.depth);
  clearBands();
  const keep = [];
  for (const it of cand) {
    const bw = Math.min(fs * (it.twe + PAD_EM * 2) + Math.max(2, fs * .05), fs * (MAX_EM + PAD_EM * 2) + Math.max(2, fs * .05));
    const x = it.ex - bw / 2, y = it.ey - ph - tri;            // 板底 = 三角指针上沿（与屏幕 CSS 一致）
    if (x > wpx || x + bw < 0 || y > hpx || y + ph + tri < 0) continue;
    if (!place(x, y, x + bw, y + ph + Math.round(ph * .15), ph + 8)) continue;
    keep.push({ it, x, y, bw });
  }
  g.save();
  g.font = `600 ${fs}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = PLATE_HEX;
  for (const { it, x, y, bw } of keep) {
    g.beginPath();                                             // 向下三角指针（指向锚点）
    g.moveTo(it.ex - tri, y + ph); g.lineTo(it.ex + tri, y + ph); g.lineTo(it.ex, y + ph + tri);
    g.closePath(); g.fill();
    roundRect(g, x, y, bw, ph, Math.round(fs * .28));
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(it.name, it.ex, y + ph / 2, Math.max(4, bw - padX * 2));
    g.fillStyle = PLATE_HEX;
  }
  g.restore();
}

/* ---------- 内部 ---------- */

/** 容器显隐：仅在「3D 查看模式 + 已开启」时显示 */
function syncBox() {
  if (box) box.classList.toggle('on', on && visible);
}

/** 整机取景比例尺（px/m）：整机刚好铺满视口时 1 米等于多少屏幕像素（导出换算世界尺寸用） */
function fitPpmOf() {
  return (viewH > 0 && fitR > 0) ? viewH / (2 * fitR * TANV) : 0;
}

/** 场景重建时由 viewer3d 传入整机取景半径（m，与 fitCamera 同口径）：导出换算世界尺寸的基准 */
export function setLabelsFitR3D(r) {
  fitR = +r > 0 ? +r : 0;
  applyMetrics();
}

/** 字号/浮标高按视口高换算：地图图钉观感（缩放时大小恒定），并写进 CSS 变量供样式取用；
 *  同时换算导出用的世界尺寸（取景半径 × 固定系数：与屏幕大小无关的固定观感） */
function applyMetrics() {
  fontPx = Math.max(11, Math.min(14, Math.round(viewH * .016)));
  plateH = Math.round(fontPx * 1.62);
  worldFont = fitR * WORLD_F_K;
  worldH = fitR * WORLD_H_K;
  if (!box) return;
  box.style.setProperty('--lb-fs', fontPx + 'px');
  box.style.setProperty('--lb-ph', plateH + 'px');
}

/** 机柜在屏幕上的观感宽度（px）：按「相机到机柜的距离 + 视口高」折算成**正对镜头**时的宽度
 *  （即不被朝向斜视压缩），用作「缩得太小就不标编号」的判据——机柜斜对镜头时不该被判老远。 */
function rackPxOf(camera, it, viewHpx) {
  V2.set(it.x, it.y, it.z);
  const d = camera.position.distanceTo(V2);
  return d > 0 ? (it.hw * 2) * (viewHpx / (2 * d * TANV)) : 1e4;
}

/** 文字宽度量尺：返回以 em 计的宽度（font-size 的倍数）。建标签时算一次，
 *  逐帧去重叠直接用——不读 DOM 布局（offsetWidth/getBoundingClientRect 会强制重排）。 */
function textEm(name) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `600 100px ${FONT}`;
  return measureCtx.measureText(String(name)).width / 100;
}

/** 清空去重叠占位桶（Map 逐帧复用，只清有记录的桶，不产生垃圾） */
function clearBands() {
  if (!bands) return;
  for (const b of usedBands) { const arr = bands.get(b); if (arr) arr.length = 0; }
  usedBands.length = 0;
}

/** 试占一个屏幕矩形（含 2px 间隔）：与已占位者相撞返回 false，否则占位并返回 true。
 *  用「行桶」把碰撞检测限制在相邻几行——同一排浮标是主要碰撞源，桶内比较就够（大场景也不慢）。 */
function place(x0, y0, x1, y1, cell) {
  if (!bands) bands = new Map();
  const b0 = Math.floor(y0 / cell), b1 = Math.floor(y1 / cell);
  for (let b = b0 - 1; b <= b1 + 1; b++) {
    const arr = bands.get(b);
    if (!arr) continue;
    for (const r of arr)
      if (!(x1 + GAP < r[0] || x0 - GAP > r[2] || y1 + GAP < r[1] || y0 - GAP > r[3])) return false;
  }
  for (let b = b0; b <= b1; b++) {
    let arr = bands.get(b);
    if (!arr) { arr = []; bands.set(b, arr); }
    if (!arr.length) usedBands.push(b);
    arr.push([x0, y0, x1, y1]);
  }
  return true;
}

/** 圆角矩形路径（不用 ctx.roundRect：老 Safari 无此 API，导出链路要稳） */
function roundRect(g, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y); g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr); g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h); g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr); g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}