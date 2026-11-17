/**
 * 3D 查看器主控：场景 / 相机 / 灯光 / 渲染循环 / 2D↔3D 切换。
 * 仅查看渲染，不提供任何编辑能力；数据变更时通过 ui.render3d 钩子自动重建场景。
 * 由 main.js 调用 initViewer3D() 初始化；对外仅暴露 is3DActive / enter3D / exit3D。
 *
 * 渲染后端：three.js r185 的 WebGPURenderer（WebGPU 优先，不支持时自动回退 WebGL 2，
 * 由 renderer3d.js 统一创建）；进入 3D 时状态栏提示实际生效的后端。
 */
import * as THREE from '../../lib/three/three.webgpu.min.js';
import { createRenderer3D, backendOf, backendLabel } from './renderer3d.js';
import { state, ui } from '../state.js';
import { buildRoom } from './builders3d.js';
import { mergeStatics } from './merge3d.js';
import { Orbit3D } from './orbit3d.js';
import { initPick3D, pickFrame, resetPick3D, pickNeedsFrame, consumePickDraw } from './pick3d.js';
import { initIsolate3D, setIsolateRoot, resetIsolate3D } from './isolate3d.js';
import { initLabels3D, setLabelsVisible3D, buildLabels3D, labelsFrame, labels3D, toggleLabels3D, setLabelsFitR3D } from './labels3d.js';
import { S, sharedMaterials } from './materials3d.js';
import { style3D, toggleStyle3D as toggleTheme3D, sceneStyle } from './theme3d.js';
import { EDGE_MAT } from './edges3d.js';
import { exportFullPNG as captureFullPNG } from './export3d.js';
import { patchUI } from '../uistate.js';
import { applyPipeView } from './pipes3d.js';
import { t } from '../i18n.js';
import { initJointControls3D, jointOptions3D, updateJointReport3D } from './joint-controls3d.js';
export { setJointOptions3D, jointOptions3D } from './joint-controls3d.js';

let active = false, ready = false, entering = false; // entering = 首次初始化渲染器进行中（防重入）
let exporting = false;                             // 全景导出进行中（防重入；期间暂停渲染循环）
let pendingResize = false;                         // 导出期间发生的尺寸变化（导出结束后补做）
let pendingJoints = false;                         // 导出期间修改展示偏好：延后重建，不改正在捕获的场景
let renderer, scene, camera, controls, room = null;
let api = '';                                     // 实际生效的渲染后端名（WebGPU / WebGL）
let built = null; // 最近一次重建结果 { group, bounds, roomH, ceilH }，供全景导出取包围盒
let dirLight, raf = 0;
let hemiLight = null, fillLight = null;              // 环境光/补光：强度随显示风格（theme3d.SCENE）变化
let dirty = true;                                 // 脏标记：需要出帧（静态场景不出帧，见 loop）
let frames = 0;                                   // 已渲染帧数（自检/测试用：静止时不增长）
let cv3, cv2, btn, wrap, styleBtn, labelBtn;
let vw = 0, vh = 0;                               // 3D 画布尺寸（CSS 像素）：机柜编号浮标投影用（resize3D 里更新）
let lit = null;                                   // 主光随视角参数 { cx, cz, h, H }（layoutLights 按房间尺度确定）
let lx = Math.SQRT1_2, lz = Math.SQRT1_2;         // 主光水平方位单位向量（初始东南，与默认视角同侧）

let pipeView = false;
export function setPipeView3D(on) {
  pipeView=!!on;
  if(built) { applyPipeView(built,pipeView); resetPick3D(); invalidateScene(); }
  const b=document.getElementById('btn-pipe-view');if(b)b.classList.toggle('active',pipeView);
  return pipeView;
}
export function is3DActive() { return active; }

/** 相机视角快照（刷新记忆用）：球坐标（距离 / 方位角 / 俯仰角）+ 观察目标点 */
export function view3DInfo() {
  if (!controls) return null;
  const { r, t: th, p } = controls.cur;
  const tg = controls.tg;
  return { r, t: th, p, tx: tg.x, ty: tg.y, tz: tg.z };
}

/** 应用保存的相机视角（刷新恢复用，须在 rebuild() 之后调用）：
 *  直接落到位（不跑阻尼动画），并补一帧重绘 */
export function applyView3D(v) {
  if (!controls || !v) return;
  const tg = new THREE.Vector3(+v.tx || 0, +v.ty || 0, +v.tz || 0);
  controls.fit(tg, +v.r || 20, +v.t || Math.PI / 4, +v.p || 1.02);
  invalidateFrame();
}

/** 自检/测试用：渲染器状态与后端（'webgpu' | 'webgl' | 'none'） */
export function rendererInfo3D() {
  return {
    active, ready, api,
    backend: renderer ? backendOf(renderer) : 'none',
    three: THREE.REVISION,
    size: renderer ? renderer.getSize(new THREE.Vector2()).toArray() : null,
    frames,                                       // 渲染帧计数（静止应停止增长：脏标记渲染生效）
    scene: sceneCount3D(),                        // { meshes, objects }：draw call 量级（性能基准/自检用）
  };
}

/** 自检/测试用：场景规模（Mesh 数 ≈ 主 pass 的 draw call 量级） */
function sceneCount3D() {
  if (!scene) return { meshes: 0, objects: 0 };
  let meshes = 0, objects = 0;
  scene.traverse(o => { objects++; if (o.isMesh) meshes++; });
  return { meshes, objects };
}

/** 初始化：绑定切换按钮、注册数据变更钩子与视图区尺寸监听（页面加载时调用一次） */
export function initViewer3D() {
  cv3 = document.getElementById('cv3d');
  cv2 = document.getElementById('cv');
  btn = document.getElementById('btn-3d');
  wrap = document.getElementById('view-wrap');
  btn.addEventListener('click', () => (active ? exit3D() : enter3D()));
  styleBtn = document.getElementById('btn-style');
  if (styleBtn) styleBtn.addEventListener('click', toggleStyle); // 3D 显示风格（实景 / 素模）
  syncStyleBtn();
  labelBtn = document.getElementById('btn-label');
  if (labelBtn) labelBtn.addEventListener('click', toggleLabels); // 3D 机柜编号浮标开关
  const pipeBtn=document.getElementById('btn-pipe-view');
  if(pipeBtn)pipeBtn.onclick=()=>setPipeView3D(!pipeView);
  syncLabelBtn();
  initJointControls3D(() => {
    if (exporting) pendingJoints = true;
    else if (active) rebuild(true);
  });
  ui.render3d = () => { if (active) rebuild(); };      // 编辑数据变化 → 3D 同步重建
  new ResizeObserver(() => { if (active) resize3D(); }).observe(wrap);
  // 标签页切回前台补一帧：脏标记渲染下后台不重绘，避免切回来看到空白/旧画面
  document.addEventListener('visibilitychange', () => { if (active && !document.hidden) invalidateFrame(); });
}

/** 首次进入时创建渲染器 / 场景 / 灯光（WebGPU 与 WebGL 2 都不可用则保持 2D） */
async function ensureGL() {
  if (ready) return true;
  try {
    // WebGPU 优先；浏览器不支持（无 navigator.gpu / 取不到适配器）时 three 内部自动回退 WebGL 2
    renderer = await createRenderer3D(cv3, { antialias: true });
  } catch (e) {
    console.warn('[3D] 渲染器初始化失败（WebGPU / WebGL 2 均不可用）：', e);
    renderer = null;
    ui.hint(t('hint.noWebGL'));
    return false;
  }
  api = backendLabel(renderer);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x151a21);
  camera = new THREE.PerspectiveCamera(45, 1, 0.05, 1000);
  controls = new Orbit3D(camera, cv3);
  initPick3D(cv3); // 悬停尺寸提示（射线拾取，渲染循环内驱动）
  initIsolate3D(cv3, () => ({ camera, built }), invalidateScene); // 右键隔离（隐藏对象；隐藏/还原要重绘并重算阴影）
  initLabels3D(wrap); // 机柜编号浮标（DOM 覆盖层，DOM 与投影同步在出帧时做）

  // 半球环境光：模拟数据大厅整体漫反射（强度/色温按显示风格，见 layoutLights）
  hemiLight = new THREE.HemisphereLight(0xdfe8f5, 0x2a2d33, 0.9);
  scene.add(hemiLight);
  // 主平行光：斜上方投射，产生机柜阴影
  dirLight = new THREE.DirectionalLight(0xffffff, 2.1);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.bias = -0.0004;
  // 阴影按需重算（性能）：2048² 全场景投影是本场景最贵的一趟渲染，不再每帧重做；
  // 只在光源真正移动（syncLight 死区外）、场景重建/隔离隐藏（invalidateScene）时置一次 needsUpdate
  dirLight.shadow.autoUpdate = false;
  dirLight.shadow.needsUpdate = true;
  scene.add(dirLight); scene.add(dirLight.target);
  // 反向补光（无阴影），避免背光面死黑
  fillLight = new THREE.DirectionalLight(0xbfd0e4, 0.55);
  fillLight.position.set(-1, 0.8, -1);
  scene.add(fillLight);
  applyStyleScene(); // 背景/光照按当前风格（进 3D 前用户可能已选过素模）
  ready = true;
  return true;
}

/** 应用当前显示风格的观感：背景色 + 环境光/主光/补光强度（光源位置与雾距在 layoutLights 里按场景尺度算） */
function applyStyleScene() {
  const st = sceneStyle();
  if (!scene) return;
  scene.background = new THREE.Color(st.bg);
  if (hemiLight) {
    hemiLight.color.setHex(st.hemiSky); hemiLight.groundColor.setHex(st.hemiGround);
    hemiLight.intensity = st.hemi;
  }
  if (dirLight) dirLight.intensity = st.dir;
  if (fillLight) fillLight.intensity = st.fill;
}

/** 仅需重绘一帧（相机/画布尺寸/悬停高亮等变化，阴影贴图无需重算） */
function invalidateFrame() { dirty = true; }

/** 场景内容或光源变化（重建、隔离隐藏、光源移动）：重绘一帧并重算一次阴影贴图 */
function invalidateScene() {
  if(built)applyPipeView(built,pipeView);
  dirty = true;
  if (dirLight) dirLight.shadow.needsUpdate = true;
}

/** 重建机房模型（进入 3D / 数据变更时调用）；keepView=true 时保留当前视角（切显示风格用，不把镜头拉回默认） */
function rebuild(keepView = false) {
  const view = keepView ? view3DInfo() : null;
  invalidateScene(); // 场景内容整组更换：出帧并重算阴影
  resetPick3D(); // 旧对象引用随场景销毁，悬停提示失效
  if (room) { scene.remove(room); disposeGroup(room); room = null; }
  built = buildRoom(state.project, jointOptions3D());
  updateJointReport3D(built.joints);
  mergeStatics(built.group); // 静态几何合并（同材质/同阴影标记合成一个 Mesh，draw call 降 2~3 倍；功能语义不变）
  room = built.group;
  scene.add(room);
  setIsolateRoot(room); // 旧节点随场景销毁，按对象 id 在新场景里重新套用隔离（对象没了则自动退出）
  applyPipeView(built, pipeView);
  buildLabels3D(state.project); // 机柜编号浮标：按对象 id 复用 DOM 节点重建（被隔离的机柜进帧时自动隐藏）
  // 整机取景半径（与 fitCamera 同口径）：浮标导出图里的世界尺寸以它为基准（见 labels3d.setLabelsFitR3D）
  setLabelsFitR3D(Math.max(Math.hypot(
    ((built.sceneBounds3d || built.bounds).maxx - (built.sceneBounds3d || built.bounds).minx) * S,
    ((built.sceneBounds3d || built.bounds).maxy - (built.sceneBounds3d || built.bounds).miny) * S,
    built.sceneBounds3d ? (built.sceneBounds3d.maxz-built.sceneBounds3d.minz)*S : (built.roomH || 3000)*S) * 1.05, 3));
  layoutLights(built);
  if (view) applyView3D(view); else fitCamera(built);
}

/** 切换 3D 显示风格（实景 ↔ 素模 / BIM）：换材质表 → 整场景重建（保持当前视角）→ 更新按钮与状态栏提示。
 *  只影响渲染：几何由同一份数据派生，不写数据、不动 2D（3D 仍是纯查看）。 */
export function toggleStyle() {
  const next = toggleTheme3D();
  if (ready) {
    rebuild(active); // 3D 中切：保持视角重建（不在 3D 时只换材质表，下次进去自然是新风格）
    if (active) invalidateScene();
  }
  syncStyleBtn();
  ui.hint(t('style3d.hint', { name: t('style3d.' + next) }));
}

/** 按钮文案/标题与 body 风格类（3D 画布底色、测试探针都用它） */
function syncStyleBtn() {
  const cur = style3D(), next = cur === 'bim' ? 'real' : 'bim';
  document.body.classList.toggle('style-bim', cur === 'bim');
  if (!styleBtn) return;
  styleBtn.textContent = t('style3d.' + next); // 与 2D/3D 按钮同一习惯：显示「将要切换到的」风格
  styleBtn.title = t('style3d.title', { name: t('style3d.' + cur) });
}

/** 语言切换后刷新风格按钮文案（main.js 的 onLocaleChange 调用） */
export function refreshStyleI18n() { syncStyleBtn(); }

/** 显示 / 隐藏机柜编号浮标（3D 内按钮与快捷键 L 共用）：只切 DOM 覆盖层，**不重建场景、不动阴影** */
export function toggleLabels() {
  const next = !labels3D();
  toggleLabels3D();
  syncLabelBtn();
  if (active) invalidateFrame(); // 浮标是 DOM 覆盖层：补一帧把投影 / 显隐落到当前视角
  ui.hint(t('labels3d.hint', { name: t(next ? 'labels3d.on' : 'labels3d.off') }));
}

/** 按钮状态与提示文案（显示中 → 高亮按下态；文案随语言与开关状态更新） */
function syncLabelBtn() {
  if (!labelBtn) return;
  const cur = labels3D();
  labelBtn.classList.toggle('active', cur);
  labelBtn.title = t('labels3d.title', { name: t(cur ? 'labels3d.on' : 'labels3d.off') });
}

/** 语言切换后刷新编号按钮文案（main.js 的 onLocaleChange 调用） */
export function refreshLabelsI18n() { syncLabelBtn(); }

/** 导出整机 3D 全景 PNG（取景角度跟随当前视角；3D 模式下由 btn-png 触发）
 *  导出期间暂停交互渲染循环：a) 导出渲染时场景不被修改（白底/去雾/克隆灯都是临时改动）；
 *  b) 两套渲染器不争 GPU，导出更快。完成后恢复循环（若导出期间已退出 3D 则不恢复）。 */
export async function exportFullPNG() {
  if (!active || !built || !renderer || exporting) return false;
  exporting = true;
  resetPick3D(); // PNG 不带临时悬停高亮
  cancelAnimationFrame(raf);
  try {
    // 把当前轨道相机的方位角/俯仰角传给导出（目标点仍取整机中心，保证全模型入画）
    const view = controls ? { t: controls.cur.t, p: controls.cur.p } : null;
    ui.hint(t('hint.exporting3D'));
    await captureFullPNG(scene, built, renderer, view);
    ui.hint(t('hint.exported3D'));
    return true;
  } catch (e) {
    ui.hint(t('hint.export3DFailed', { msg: e.message || e }));
    return false;
  } finally {
    exporting = false;
    if (active) {
      if (pendingResize) { pendingResize = false; resize3D(); } // 补做导出期间被跳过的尺寸变化
      if (pendingJoints) { pendingJoints = false; rebuild(true); }
      invalidateScene(); // 导出期间临时改过背景/雾/投影灯：恢复后重绘一帧并重算阴影
      loop(); // 恢复渲染循环
    }
  }
}

/** 销毁场景组：几何体一律销毁；共享材质（两套风格的 M + 动态材质 + 棱线材质）保留，私有材质及其纹理销毁 */
function disposeGroup(root) {
  const shared = new Set([...sharedMaterials(), EDGE_MAT]);
  const disposedMats = new Set();
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || shared.has(m) || disposedMats.has(m)) continue;
      disposedMats.add(m);
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
}

const LIGHT_AZ_DEADZONE_DEG = 1;                                        // 光源方位跟随死区（度）
const LIGHT_AZ_EPS = Math.cos(LIGHT_AZ_DEADZONE_DEG * Math.PI / 180);   // 单位向量点积阈值

/** 主光随视角（方案 A）：水平方位跟随相机绕机房中心的角度，俯仰恒定（避免掠射长影）。
 *  任意观察方向机柜正面均受光、阴影始终落在远离观察者一侧；阴影贴图范围仍以机房为中心，覆盖不变。
 *  死区：方位变化小于 LIGHT_AZ_DEADZONE_DEG 时不动光源——阴影贴图（每帧重算很贵）只在真需要时重算。 */
function syncLight() {
  if (!lit) return;
  const dx = camera.position.x - lit.cx, dz = camera.position.z - lit.cz;
  const len = Math.hypot(dx, dz);
  if (len <= 1e-4) return;                       // 相机近正上方时保持上一方位，避免跳变
  const nx = dx / len, nz = dz / len;
  if (nx * lx + nz * lz >= LIGHT_AZ_EPS) return; // 死区内：光源与阴影都保持不动
  lx = nx; lz = nz;
  dirLight.position.set(lit.cx + lx * lit.h, lit.H, lit.cz + lz * lit.h);
  dirLight.target.position.set(lit.cx, lit.cy || 0, lit.cz);
  dirLight.shadow.needsUpdate = true;            // 光源动了：本次重算阴影贴图
}

/** 按场景范围与当前显示风格布置主光/补光/环境光与雾（水平偏移 h 与高度 H 固定，方位由 syncLight 每帧决定） */
function layoutLights({ bounds, roomH: H, sceneBounds3d }) {
  const b=sceneBounds3d || bounds, roomH=sceneBounds3d ? sceneBounds3d.maxz-sceneBounds3d.minz : H;
  const cy=sceneBounds3d ? (sceneBounds3d.maxz+sceneBounds3d.minz)/2*S : 0;
  const st = sceneStyle();
  applyStyleScene(); // 背景 + 光照强度按当前风格
  const W = (b.maxx - b.minx) * S, D = (b.maxy - b.miny) * S;
  const cx = (b.minx + b.maxx) / 2 * S, cz = -(b.miny + b.maxy) / 2 * S;
  const diag = sceneBounds3d ? Math.hypot(W, D, roomH*S) : Math.hypot(W,D);
  lit = { cx, cz, cy, h: diag * .55, H: cy+roomH * S * 2 + diag * .6 };
  dirLight.position.set(cx + lx * lit.h, lit.H, cz + lz * lit.h);
  dirLight.target.position.set(cx, cy, cz);
  const sc = dirLight.shadow.camera;
  sc.left = -diag * .68; sc.right = diag * .68;
  sc.top = diag * .68; sc.bottom = -diag * .68;
  sc.near = 0.1; sc.far = diag * 4 + roomH * S * 3;
  sc.updateProjectionMatrix();
  dirLight.shadow.needsUpdate = true; // 光源位置/阴影相机范围变了：重算一次阴影贴图
  scene.fog = new THREE.Fog(st.fog, diag * st.fogNear, diag * st.fogFar); // 雾距按风格（素模很淡，白模不发灰）
}

/** 相机取景：包围盒全景，东南上方 3/4 俯视 */
function fitCamera({ bounds, roomH: H, sceneBounds3d }) {
  const b=sceneBounds3d || bounds, roomH=sceneBounds3d ? sceneBounds3d.maxz-sceneBounds3d.minz : H;
  const W = (b.maxx - b.minx) * S, D = (b.maxy - b.miny) * S;
  const target = new THREE.Vector3(
    (b.minx + b.maxx) / 2 * S, sceneBounds3d ? (b.minz+b.maxz)/2*S : roomH * S * .32, -(b.miny + b.maxy) / 2 * S);
  const diag = Math.hypot(W, D, roomH * S);
  const fitAngle=Math.atan(Math.tan(camera.fov*Math.PI/360)*Math.min(1,camera.aspect));
  const radius = Math.max(sceneBounds3d ? diag/(2*Math.sin(fitAngle))*1.06 : diag*1.05, 3);
  camera.near = radius / 200;
  camera.far = radius * 30;
  camera.updateProjectionMatrix();
  controls.fit(target, radius, Math.PI / 4, 0.85); // 东南上方约 49° 俯视，越过近墙看到室内
}

function resize3D() {
  if (exporting) { pendingResize = true; return; } // 导出期间不动主画布（避免与离屏渲染争抢 GPU / 交叠重建）
  const r = wrap.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(r.width, r.height, false); // 尺寸由 CSS 控制，仅设绘图缓冲
  vw = r.width; vh = r.height;                // 机柜编号浮标按画布尺寸做屏幕投影
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
  invalidateFrame(); // 画布尺寸变了：重绘一帧
}

/** 渲染循环（脏标记出帧）：相机静止 + 拾取无变化 + 场景无变更时整帧跳过，不向 GPU 提交任何工作。
 *  循环仍常驻 rAF（每帧只做几个布尔判断，开销可忽略）；任何变化都在当帧照常绘制，交互手感不变。 */
function loop() {
  raf = requestAnimationFrame(loop);
  const pickDrew = consumePickDraw(); // 悬停高亮刚变化（消费一次）
  if (!dirty && !pickDrew && !controls.moving && !pickNeedsFrame()) return;
  dirty = false;
  controls.update();
  persistCam(); // 视角变了就节流记忆（patchUI 内部比无变化不写盘）：刷新后回到同一角度
  syncLight(); // 主光水平方位跟随观察方位（死区内不动光源，也不重算阴影）
  pickFrame(camera, built); // 悬停拾取（鼠标位置脏了才做一次射线检测）
  renderer.render(scene, camera);
  labelsFrame(camera, vw, vh); // 机柜编号浮标：投影到屏幕（DOM 覆盖层；相机静止时循环不出帧，自然不做）
  frames++;
}

/** 视角变化时记忆相机（节流写盘；页面隐藏/刷新前由 main.js 再刷一次） */
function persistCam() {
  const c = view3DInfo();
  if (c) patchUI('cam3d', c);
}

/** 进入 3D 查看模式（首次进入需异步初始化渲染器：WebGPU 优先，自动回退 WebGL 2） */
export async function enter3D() {
  if (active || entering) return;
  entering = true;
  // 先让 3D 画布可见（有实际尺寸）再初始化：WebGPU/WebGL 上下文按画布尺寸配置
  cv2.style.display = 'none';
  cv3.hidden = false;
  const ok = await ensureGL();
  entering = false;
  if (!ok) { // 环境不支持 3D：恢复 2D 画布，保持可编辑
    cv3.hidden = true;
    cv2.style.display = '';
    return;
  }
  active = true;
  document.body.classList.add('mode3d');
  patchUI('mode3d', true); // 记住 3D 查看模式：刷新页面后仍在 3D 视图里
  btn.classList.add('active');
  btn.textContent = '2D';
  btn.title = t('hint.mode3dBack');
  syncStyleBtn(); // 风格按钮文案/标题按当前风格刷新
  setLabelsVisible3D(true); // 机柜编号浮标入场（开关状态与偏好不变）
  syncLabelBtn();
  const pngBtn = document.getElementById('btn-png');
  if (pngBtn) pngBtn.title = t('hint.export3dBtn');
  resize3D(); // 先确定 aspect，再按真实三维范围取景（窄视口也不裁掉高/长管）
  rebuild();
  loop();
  ui.hint(t('hint.mode3d') + ' · ' + t('hint.api3d', { api })); // 附带实际渲染后端（WebGPU / WebGL）
}

/** 退出 3D，返回 2D 编辑模式 */
export function exit3D() {
  if (!active) return;
  active = false;
  patchUI('mode3d', false); // 退出 3D 同样记进记忆：刷新后不再自动进 3D
  resetPick3D();
  resetIsolate3D(); // 重新显示被隔离隐藏的对象、收起右键菜单
  document.body.classList.remove('mode3d');
  cancelAnimationFrame(raf);
  cv3.hidden = true;
  cv2.style.display = '';
  btn.classList.remove('active');
  btn.textContent = '3D';
  btn.title = t('btn3d');
  setLabelsVisible3D(false); // 编号浮标只在 3D 中显示（2D 编辑视图不遮挡平面图）
  const pngBtn = document.getElementById('btn-png');
  if (pngBtn) pngBtn.title = t('btn.png');
  ui.resize(); // 重新布局 2D 画布
  ui.hint(t('hint.back2d'));
}
