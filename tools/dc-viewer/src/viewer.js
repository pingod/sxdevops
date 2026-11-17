/**
 * 查看器核心与门面：渲染器 / 场景 / 相机 / 灯光 / 雾 / 渲染循环 / 全部 3D 功能装配。
 * UI 与 main.js 只经本模块导出的门面访问 3D 能力（形状与参考站 __dc3d 对齐）。
 */
import * as THREE from 'three/webgpu';
import { createRendererWithFallback, backendOf } from './scene/renderer.js';
import { createRoomEnvironment } from './scene/environment.js';
import { buildRoom } from './scene/builders.js';
import { STATUS_COLORS, resolveCabinets } from './live/status.js';
import { mergeStatics } from './scene/merge.js';
import { disposeGroup } from './scene/dispose.js';
import { CameraRig, MODES } from './camera/rig.js';
import { Orbit } from './camera/orbit.js';
import { Section3D, createClipVisual, updateClipVisual } from './features/section.js';
import { createWallHider } from './features/wallhide.js';
import { XRAY, xrayPlan, xraySummary } from './features/xray.js';
import { TypeVis } from './features/typevis.js';
import { Isolate } from './features/isolate.js';
import { Explode } from './features/explode.js';
import { Compare } from './features/compare.js';
import { Presentation } from './features/presentation.js';
import { Perf } from './features/perf.js';
import { Views } from './features/views.js';
import { Tour } from './features/tour.js';
import { Walk } from './features/walk.js';
import { createCoordinator } from './features/coordinator.js';
import { createCompass } from './features/compass.js';
import * as PICK from './features/selection.js';
import { listViewpoints, summarizeViewpoints } from './camera/pose.js';
import { createFocusFacade } from './features/focus.js';

const S = 0.001;

/** 主题底色：与设计器一致，避免同一项目两种观感。 */
export const THEME_BACKGROUNDS = { light: 0xe9edf3, charcoal: 0x1b1f24, dark: 0x101722 };

export const SCENE = Object.freeze({
  bg: 0xe9ecef,
  fog: 0xe9ecef,
  hemiSky: 0xe4edf8,
  hemiGround: 0x51585f,
  hemi: 0.82,
  dir: 2.2,
  fill: 0.6,
  fogNear: 2.2,
  fogFar: 4.6,
  env: 0.38,
});

const state = {
  ready: false,
  canvas: null,
  renderer: null,
  scene: null,
  rig: null,
  controls: null,
  project: null,
  built: null,
  clipGroup: null,
  room: null,
  clipPlane: null,
  clipVisual: null,
  envTex: null,
  hemi: null,
  dir: null,
  fill: null,
  lit: null,
  fitRadius: 10,
  fitTarget: new THREE.Vector3(),
  dirty: true,
  raf: 0,
  lastT: 0,
  lastRenderEnd: 0,
  buildMs: 0,
  frames: 0,
  shadowDirty: true,
  preExplodeR: 0,
  live: null,
  liveRings: [],
  theme: 'light',
  hooks: [],
};

/* 功能控制器 */
export const section = new Section3D();
export const typeVis = new TypeVis();
export const isolate = new Isolate();
export const explode = new Explode();
export const perf = new Perf({
  getScene: () => state.scene,
  getRenderer: () => state.renderer,
  invalidate: () => invalidate(),
  getMeta: () => ({ backend: backendOf(state.renderer), size: sizeOf(), view: views ? views.activeId : 'orbit' }),
});
export let compare = null;
export let presentation = null;
export let views = null;
export let tour = null;
export let walk = null;
export let coordinator = null;
export let compass = null;
export let wallHider = null;
export let focusCtl = null;

export function invalidate() {
  state.dirty = true;
}

export function runtime() {
  return state;
}

export function onchange(fn) {
  state.hooks.push(fn);
}

function notify(reason) {
  for (const fn of state.hooks) {
    try {
      fn(reason);
    } catch (err) {
      console.warn('[查看器] 变更回调异常：', err);
    }
  }
}

function sizeOf() {
  return state.canvas ? [state.canvas.clientWidth, state.canvas.clientHeight] : [0, 0];
}

/** 场景尺寸（米）与中心 */
export function sceneBoundsOf(built) {
  const b = built.bounds;
  return {
    minx: b.minx * S,
    maxx: b.maxx * S,
    minz: -b.maxy * S,
    maxz: -b.miny * S,
    miny: 0,
    maxy: built.roomH * S,
  };
}

function roomMetrics(built) {
  const b = built.bounds;
  const W = (b.maxx - b.minx) * S;
  const D = (b.maxy - b.miny) * S;
  const cx = ((b.minx + b.maxx) / 2) * S;
  const cz = -((b.miny + b.maxy) / 2) * S;
  return { W, D, cx, cz, diag: Math.hypot(W, D) };
}

export async function ensureScene(canvas) {
  if (state.ready) return;
  if (!canvas) throw new Error('缺少 #cv3d 画布');
  state.canvas = canvas;
  const renderer = await createRendererWithFallback(canvas);
  state.renderer = renderer;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SCENE.bg);
  scene.environment = createRoomEnvironment();
  scene.environmentIntensity = SCENE.env;
  state.envTex = scene.environment;
  state.scene = scene;

  const rig = new CameraRig({ fov: 45, aspect: 1, near: 0.05, far: 1000, transitionSec: 0.75 });
  state.rig = rig;
  const controls = new Orbit(rig, canvas);
  state.controls = controls;

  state.hemi = new THREE.HemisphereLight(SCENE.hemiSky, SCENE.hemiGround, SCENE.hemi);
  scene.add(state.hemi);
  const dir = new THREE.DirectionalLight(0xffffff, SCENE.dir);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.bias = -0.0004;
  dir.shadow.autoUpdate = false;
  dir.shadow.needsUpdate = true;
  scene.add(dir);
  scene.add(dir.target);
  state.dir = dir;
  state.fill = new THREE.DirectionalLight(0xd6e2f0, SCENE.fill);
  state.fill.position.set(-1, 0.8, -1);
  scene.add(state.fill);

  const clipGroup = typeof THREE.ClippingGroup === 'function' ? new THREE.ClippingGroup() : new THREE.Group();
  clipGroup.name = 'room-clip';
  clipGroup.clipShadows = true;
  clipGroup.enabled = false;
  scene.add(clipGroup);
  state.clipGroup = clipGroup;
  state.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.2);
  const clipVisual = createClipVisual();
  scene.add(clipVisual);
  state.clipVisual = clipVisual;

  presentation = new Presentation({
    scene,
    extras: [clipVisual],
    invalidate: () => invalidate(),
    beforeEnable: kind => beforePresentation(kind),
    onchange: () => notify('presentation'),
  });

  PICK.initPick(canvas);
  PICK.onObjectFocus(obj => focusObject(obj));
  PICK.onSelectionChange(() => {
    syncIsolateSelection();
    notify('selection');
  });

  views = new Views({
    rig,
    controls,
    invalidate: () => invalidate(),
    onchange: () => {
      syncCeilingForced();
      section.refresh();
      if (wallHider) wallHider.setViewSide(views.elevationSide);
      syncSuspension();
      invalidate();
      notify('view');
    },
    beforeStart: reason => beforeFirstPerson(reason),
    hideCeiling: on => {
      state.ceilingHidden = !!on;
      syncCeilingForced();
    },
    getSelected: () => PICK.selectedObject(),
    getHovered: () => PICK.hoveredObject(),
    isHidden: obj => isObjectHidden(obj),
    onSelect: obj => {
      PICK.selectObject(obj, { announce: true });
    },
  });

  wallHider = null;

  tour = new Tour({
    controls,
    rig,
    getProject: () => state.project,
    setPick: on => PICK.setPickEnabled(on),
    beforeStart: reason => beforeFirstPerson(reason),
    invalidate: () => invalidate(),
    onchange: () => {
      syncSuspension();
      invalidate();
      notify('tour');
    },
  });
  walk = new Walk({
    controls,
    rig,
    canvas,
    getProject: () => state.project,
    getBuilt: () => state.built,
    setPick: on => PICK.setPickEnabled(on),
    beforeStart: reason => beforeFirstPerson(reason),
    invalidate: () => invalidate(),
    onchange: () => {
      syncSuspension();
      invalidate();
      notify('walk');
    },
  });
  coordinator = createCoordinator({ tour, walk, onchange: () => notify('firstPerson') });

  compass = createCompass({
    rig,
    controls,
    getActiveId: () => views.activeId,
    getCorner: () => views.corner,
    getViewpointLabel: () => {
      const vp = views.vp ? views.viewpoints.find(v => v.id === views.vp) : null;
      return vp ? vp.label : '';
    },
    isSuppressed: () => tour.active || walk.active,
    getViewport: () => {
      const [w, h] = sizeOf();
      return { w, h };
    },
  });

  focusCtl = createFocusFacade({
    getViews: () => views,
    getSelected: () => PICK.selectedObject(),
    getTour: () => tour,
    getWalk: () => walk,
    exploder: explode,
    focus: obj => focusObject(obj),
    exit: () => views.exitFocus(),
  });

  section.onchange = detail => {
    // 先同步挂起状态（剖切激活时近墙管理器让位），再按新状态应用可见性，
    // 否则墙体的整组隐藏会被近墙管理器覆盖。
    syncSuspension();
    section.refresh();
    syncClip();
    if (detail && detail.visibilityChanged) {
      state.dir.shadow.needsUpdate = true;
      PICK.refreshPick();
    }
    invalidate();
    notify('section');
  };
  typeVis.onchange = () => {
    section.refresh();
    if (wallHider) wallHider.setForceHidden(g => typeVis.isHiddenGroup(g));
    PICK.refreshPick();
    invalidate();
    notify('typevis');
  };
  isolate.onchange = detail => {
    section.refresh();
    PICK.refreshPick();
    if (detail && detail.visibilityChanged) state.dir.shadow.needsUpdate = true;
    invalidate();
    notify('isolate');
  };
  explode.onchange = detail => {
    handleExplodeChange(detail);
    notify('explode');
  };
  section.registerForced('typevis', g => typeVis.isHiddenGroup(g));
  section.registerForced('isolate', g => isolate.isHiddenGroup(g));
  section.registerForced('viewCeiling', g => !!state.ceilingHidden && g === (state.built && state.built.ceiling));

  controls.oninput = () => {
    views.cancelTween();
    invalidate();
  };

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  window.addEventListener('resize', resize);
  resize();
  state.ready = true;
  startLoop();
}

export function resize() {
  if (!state.renderer) return;
  const canvas = state.canvas;
  const cw = Math.max(1, canvas.clientWidth || 1);
  const ch = Math.max(1, canvas.clientHeight || 1);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  state.renderer.setPixelRatio(dpr);
  state.renderer.setSize(cw, ch, false);
  state.rig.resize(cw / ch);
  if (views) views.onResize();
  invalidate();
}

function layoutLight() {
  const built = state.built;
  if (!built || !state.dir) return;
  const { cx, cz, diag } = roomMetrics(built);
  const lit = { cx, cz, h: diag * 0.55, H: built.roomH * S * 2 + diag * 0.6, lx: Math.SQRT1_2, lz: Math.SQRT1_2, diag };
  state.lit = lit;
  const d = state.dir;
  d.position.set(cx + lit.lx * lit.h, lit.H, cz + lit.lz * lit.h);
  d.target.position.set(cx, 0, cz);
  d.target.updateMatrixWorld();
  const cam = d.shadow.camera;
  cam.left = -diag * 0.68;
  cam.right = diag * 0.68;
  cam.top = diag * 0.68;
  cam.bottom = -diag * 0.68;
  cam.near = 0.1;
  cam.far = diag * 4 + built.roomH * S * 3;
  cam.updateProjectionMatrix();
  d.shadow.needsUpdate = true;
  if (state.scene) {
    state.scene.fog = new THREE.Fog(SCENE.fog, diag * SCENE.fogNear, diag * SCENE.fogFar);
    state.baseFog = { near: diag * SCENE.fogNear, far: diag * SCENE.fogFar };
  }
}

function syncLight() {
  const lit = state.lit;
  if (!lit || !state.dir || !state.rig) return;
  if (tour.active || walk.active) return;
  const cam = state.rig.camera.position;
  const dx = cam.x - lit.cx;
  const dz = cam.z - lit.cz;
  const len = Math.hypot(dx, dz);
  if (len <= 1e-4) return;
  const nx = dx / len;
  const nz = dz / len;
  if (nx * lit.lx + nz * lit.lz >= Math.cos((1 * Math.PI) / 180)) return;
  lit.lx = nx;
  lit.lz = nz;
  state.dir.position.set(lit.cx + nx * lit.h, lit.H, lit.cz + nz * lit.h);
  state.dir.shadow.needsUpdate = true;
}

function startLoop() {
  if (state.raf) return;
  const tick = t => {
    state.raf = requestAnimationFrame(tick);
    const frameStart = performance.now();
    const dt = Math.min(0.5, Math.max(0, (t - state.lastT) / 1000) || 0.016);
    state.lastT = t;
    step(dt);
    const need = state.dirty || PICK.pickNeedsFrame() || perf.benchActive;
    if (!need) return;
    state.dirty = false;
    state.frames++;
    const r0 = performance.now();
    state.renderer.render(state.scene, state.rig.camera);
    const r1 = performance.now();
    const prev = state.lastRenderEnd || r0 - 16.7;
    perf.recordFrame(r0 - prev, r1 - r0);
    state.lastRenderEnd = r1;
  };
  state.lastT = performance.now();
  state.raf = requestAnimationFrame(tick);
}

function step(dt) {
  if (!state.ready) return;
  const trans = state.rig.update(dt);
  if (trans) invalidate();
  if (state.controls.enabled) state.controls.update();
  if (state.controls.moving) invalidate();
  const [w, h] = sizeOf();
  const camera = state.rig.camera;
  views.update(dt, camera, { w, h });
  if (views.tweening) invalidate();
  tour.update(dt);
  walk.update(dt);
  if (explode.animating) {
    explode.update(dt);
    invalidate();
  }
  if (wallHider) {
    if (wallHider.update(camera.position, dt)) state.dir.shadow.needsUpdate = true;
    if (wallHider.animating) {
      invalidate();
      if (PICK.hasSelection()) PICK.refreshPick();
    }
  }
  compass.update();
  syncLight();
  PICK.pickFrame(camera, state.built);
  if (PICK.pickNeedsFrame()) invalidate();
  if (perf.benchActive) invalidate();
}

function beforePresentation(kind) {
  if (!views) return;
  if (explode.state !== 'assembled') explode.collapseNow();
  if (isolate.enabled) isolate.setMode('off');
  if (wallHider && wallHider.xray) xrayFacade.setEnabled(false);
  if (kind === 'lineart' && presentation.wire) presentation.setWire(false);
}

function beforeFirstPerson(reason) {
  if (reason === 'tour' || reason === 'walk') {
    if (presentation.lineart) presentation.setLineart(false);
    if (wallHider && wallHider.xray) xrayFacade.setEnabled(false);
    if (isolate.enabled) isolate.setMode('off');
    views.exit();
  }
  if (reason === 'view' || reason === 'focus') {
    if (tour.active) tour.exit();
    if (walk.active) walk.exit();
    if (explode.state !== 'assembled') explode.collapseNow();
  }
}

function isObjectHidden(obj) {
  if (!obj) return false;
  const node = PICK.objectNode(obj);
  if (!node) return true;
  let n = node;
  while (n) {
    if (n.visible === false) return true;
    n = n.parent;
  }
  return false;
}

function syncCeilingForced() {
  section.refresh();
}

/** 选中变化时同步隔离焦点；隔离生效时重建高亮基线（材质被替换过） */
function syncIsolateSelection() {
  const sel = PICK.selectedObject();
  const node = sel ? PICK.objectNode(sel) : null;
  isolate.setFocus(sel, node);
  if (isolate.active) {
    PICK.releasePickMaterials();
    PICK.refreshPick();
  }
}

function syncSuspension() {
  const fpClip = (tour.active || walk.active) && section.mode === 'clip';
  section.setSuspended(explode.animating || fpClip);
  if (wallHider) wallHider.setSuspended(explode.animating || section.active);
}

function syncClip() {
  const info = section.clipInfo();
  const on = info.applied;
  if (state.clipGroup) {
    state.clipGroup.enabled = on;
    state.clipGroup.clippingPlanes = on ? [state.clipPlane] : [];
    if (on) {
      const p = info.scenePlane;
      state.clipPlane.normal.set(p.normal.x, p.normal.y, p.normal.z);
      state.clipPlane.constant = p.constant;
    }
  }
  updateClipVisual(state.clipVisual, info, state.built);
  PICK.setPickClipTest(on ? pt => state.clipPlane.distanceToPoint(pt) >= 0 : null);
  state.dir.shadow.needsUpdate = true;
}

function handleExplodeChange(detail) {
  const st = detail.state;
  if (st === 'exploding') {
    state.preExplodeR = state.controls.dst.r;
    state.controls.dst.r = Math.max(state.controls.dst.r, state.fitRadius) * explode.dolly;
    widenAtmosphere(true);
    syncSuspension();
    PICK.setPickEnabled(false);
    state.dir.shadow.needsUpdate = true;
  } else if (st === 'assembling') {
    state.controls.dst.r = state.preExplodeR || state.fitRadius;
    syncSuspension();
    PICK.setPickEnabled(false);
  } else if (st === 'exploded') {
    widenAtmosphere(true);
    syncSuspension();
    PICK.setPickEnabled(true);
  } else if (st === 'assembled') {
    state.controls.dst.r = state.preExplodeR || state.controls.dst.r;
    widenAtmosphere(false);
    syncSuspension();
    PICK.setPickEnabled(true);
  }
  if (wallHider) {
    wallHider.setSuspended(explode.animating || section.active);
    if (!explode.animating && !section.active) wallHider.sync(state.rig.camera.position);
  }
  invalidate();
}

function widenAtmosphere(on) {
  const fog = state.scene && state.scene.fog;
  if (!fog || !state.baseFog) return;
  if (on) {
    fog.near = state.fitRadius * 5;
    fog.far = state.fitRadius * 15;
    const cam = state.dir.shadow.camera;
    const e = state.fitRadius * 2.2;
    cam.left = -e;
    cam.right = e;
    cam.top = e;
    cam.bottom = -e;
    cam.far = Math.max(state.fitRadius * 12, cam.far);
    cam.updateProjectionMatrix();
  } else {
    fog.near = state.baseFog.near;
    fog.far = state.baseFog.far;
    layoutLight();
  }
  state.dir.shadow.needsUpdate = true;
}

function disposeRoom() {
  clearLiveRings();
  if (!state.room) return;
  state.clipGroup.remove(state.room);
  disposeGroup(state.room);
  state.room = null;
  state.built = null;
  state.ceilingHidden = false;
}

/** 加载项目 */
export function loadProject(project, opts = {}) {
  if (!state.ready) throw new Error('3D 场景未就绪');
  const t0 = performance.now();
  const camSnap = opts.preserveCamera ? state.controls.snapshot() : null;
  const viewRestore = opts.preserveView && views
    ? (views.activeId === 'focus' ? 'orbit'
      : views.active === 'iso' ? 'iso-' + (views.corner || 'se') : views.activeId)
    : null;
  if (views) views.reset();
  if (tour && tour.active) tour.exit();
  if (walk && walk.active) walk.exit();
  if (explode.active) explode.collapseNow();
  PICK.releasePickMaterials();
  disposeRoom();
  const built = buildRoom(project);
  const merged = mergeStatics(built.group);
  state.project = project;
  state.built = built;
  const room = new THREE.Group();
  room.name = 'room';
  room.add(built.group);
  state.clipGroup.add(room);
  state.room = room;
  built.info = merged;

  layoutLight();
  PICK.setPickModel(built);
  PICK.setProject(project);
  section.wallHider = null;
  section.setModel(built, project);
  typeVis.setModel(project);
  isolate.setModel(built, project);
  explode.setModel(project, built);
  if (compare) compare.setModel();

  // 视图先就位（会触发 section.refresh），再让近墙管理器按最终机位就位，
  // 保证加载时就处于正确的墙体隐藏状态（顺序与参考站一致）。
  views.setModel(built, project);
  if (viewRestore && viewRestore !== 'orbit') views.goTo(viewRestore);
  if (opts.preserveCamera && camSnap) {
    if (opts.preserveView) views.snap = camSnap;
    state.controls.restore(camSnap);
  } else {
    fitCamera();
  }

  wallHider = createWallHider(built.walls, { enclosure: built.ceiling ? [built.ceiling] : [] });
  section.wallHider = wallHider;
  wallHider.setForceHidden(g => typeVis.isHiddenGroup(g));
  wallHider.setViewSide(views.elevationSide);
  wallHider.sync(state.rig.camera.position);
  presentation.setModel(room, built);

  state.buildMs = +(performance.now() - t0).toFixed(1);
  views.cancelTween();
  syncSuspension();
  syncClip();
  state.dirty = true;
  notify('model');
}

export function fitCamera() {
  const built = state.built;
  if (!built) return;
  const { target, radius } = state.rig.fit(sceneBoundsOf(built), 1.05);
  state.fitRadius = radius;
  state.fitTarget.copy(target);
  state.rig.setClip(radius / 200, radius * 30);
  state.controls.fit(target, radius, Math.PI / 4, 0.85);
  invalidate();
}

/* ---------- 视图 / 聚焦 / 定位 ---------- */

export function focusObject(obj) {
  if (!obj) return false;
  if (tour.active || walk.active || explode.state !== 'assembled') return false;
  let node = PICK.objectNode(obj);
  if (!node) {
    const found = PICK.selectByQuery(String(obj));
    if (found) obj = found;
    else return false;
    node = PICK.objectNode(obj);
  } else {
    PICK.selectObject(obj, { silent: true });
  }
  const box = PICK.objectBounds(obj);
  return views.focusObject(obj, { box: box || undefined });
}

export function locate(obj) {
  if (tour.active || walk.active || explode.state !== 'assembled') return false;
  if (!obj) return false;
  const ok = PICK.selectObject(obj, { announce: true });
  if (!ok) return false;
  return views.focusObject(obj, { box: PICK.objectBounds(obj) || undefined });
}

export function selectedObject() {
  return PICK.selectedObject();
}

export function hoveredObject() {
  return PICK.hoveredObject();
}

export function setSelected(target) {
  if (!target) return PICK.clearSelection();
  if (typeof target === 'object') return PICK.selectObject(target, { announce: true });
  return !!PICK.selectByQuery(String(target));
}

export function clearSelected() {
  return PICK.clearSelection();
}

export function selectionInfo() {
  return PICK.selectionInfo();
}

export function focusInfo() {
  return { ...views.info().focus, canStart: focusCtl ? focusCtl.canStart : false };
}

export function exitFocus() {
  return views.exitFocus();
}

export function applyView(id) {
  return views.goTo(id);
}

export function viewpointList() {
  if (!state.project || !state.built) return [];
  return listViewpoints(state.project, state.built.bounds, { roomH: state.built.roomH, aspect: state.rig.aspect });
}

export function viewpointSummary() {
  return summarizeViewpoints(viewpointList());
}

export function projectPoint(x, y, z) {
  const v = new THREE.Vector3(x, y, z).project(state.rig.camera);
  const [w, h] = sizeOf();
  return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, z: v.z, visible: v.z >= -1 && v.z <= 1 };
}

/* ---------- 围护透视门面 ---------- */
export const xrayFacade = {
  get enabled() {
    return !!(wallHider && wallHider.xray);
  },
  setEnabled(on) {
    if (!wallHider) return false;
    const changed = wallHider.setXray(!!on);
    if (changed) {
      PICK.refreshPick();
      invalidate();
      notify('xray');
    }
    return changed;
  },
  toggle() {
    return this.setEnabled(!this.enabled);
  },
  info() {
    if (!wallHider) return { on: false };
    const info = wallHider.info();
    const plan = xrayPlan(state.project || { objects: [] }, { ceiling: !!(state.built && state.built.ceiling) });
    return {
      on: this.enabled,
      opacity: XRAY.opacity,
      summary: xraySummary(this.enabled, XRAY.opacity),
      groups: info.enclosure,
      materials: info.materials,
      plan: { total: plan.total, byType: plan.byType, wallGroups: plan.wallGroups, equipment: plan.equipment },
      walls: info,
    };
  },
};

/* ---------- 第一人称门面 ---------- */
export function tourCtl() {
  return tour;
}

export function routeInfo(id) {
  return tour && state.project ? tour.routeInfo(id) : null;
}

/* ---------- 自检 ---------- */
/* ---------- 实时运行状态（父页面 postMessage 推送） ---------- */

function clearLiveRings() {
  for (const mesh of state.liveRings) {
    if (mesh.parent) mesh.parent.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  state.liveRings.length = 0;
  state.live = null;
}

export function clearLiveStatus() {
  clearLiveRings();
  state.dirty = true;
  notify('live');
}

/**
 * 按服务端聚合结果给绑定机柜加地面状态环。
 * 未绑定的机柜不出现环——数据缺失不伪造在线。
 */
export function applyLiveStatus(payload) {
  clearLiveRings();
  if (!state.ready || !state.built || !payload) return null;
  const cabinets = resolveCabinets(payload);
  const objects = state.project?.objects || [];
  for (const [objectId, entry] of Object.entries(cabinets)) {
    const obj = objects.find(o => o.id === objectId && o.type === 'cabinet');
    if (!obj) continue;
    let group = null;
    state.built.group.traverse((node) => {
      if (!group && node.userData?.obj?.id === objectId) group = node;
    });
    if (!group) continue;
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.56, 32),
      new THREE.MeshBasicMaterial({
        color: STATUS_COLORS[entry.status] || STATUS_COLORS.unknown,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(obj.x * S, 0.02, -obj.y * S);
    mesh.renderOrder = 900;
    group.add(mesh);
    state.liveRings.push(mesh);
  }
  state.live = {
    generatedAt: payload.generated_at || new Date().toISOString(),
    thresholds: payload.thresholds || null,
    cabinets,
    devices: payload.devices || [],
    rings: state.liveRings.length,
  };
  state.dirty = true;
  notify('live');
  return state.live;
}

export function liveInfo() {
  return state.live;
}

/** 主题：只换场景底色，几何与材质不动。 */
export function setTheme(theme) {
  const next = THEME_BACKGROUNDS[theme] ? theme : 'light';
  state.theme = next;
  if (state.scene) state.scene.background.set(THEME_BACKGROUNDS[next]);
  state.dirty = true;
  notify('theme');
  return next;
}

export function themeName() {
  return state.theme;
}

export function viewerInfo() {
  const built = state.built;
  let meshes = 0;
  let objects = 0;
  if (state.scene) {
    state.scene.traverse(o => {
      objects++;
      if (o.isMesh) meshes++;
    });
  }
  const groups = {};
  if (built) {
    for (const child of built.group.children) {
      const o = child.userData && child.userData.obj;
      if (!o || !o.type) continue;
      const rec = groups[o.type] || (groups[o.type] = { type: o.type, total: 0, visible: 0 });
      rec.total++;
      if (child.visible) rec.visible++;
    }
  }
  let visibleObjects = 0;
  if (state.scene) state.scene.traverseVisible(() => visibleObjects++);
  return {
    ready: state.ready,
    backend: backendOf(state.renderer),
    size: sizeOf(),
    frames: state.frames,
    buildMs: state.buildMs,
    camera: state.rig ? state.rig.info() : null,
    scene: { meshes, objects, visible: visibleObjects, hidden: objects - visibleObjects },
    visibility: groups,
    views: views ? views.info() : null,
    section: section.info(),
    typeVis: typeVis.info(),
    isolate: isolate.info(),
    explode: explode.info(),
    xray: xrayFacade.info(),
    pick: PICK.selectionInfo(),
    focus: views ? views.info().focus : null,
    tour: tour ? tour.info() : null,
    walk: walk ? walk.info() : null,
    firstPerson: coordinator ? coordinator.info() : null,
    compare: compare ? compare.info() : null,
    presentation: presentation ? presentation.info() : null,
    compass: compass ? compass.info() : null,
    perf: perf.info(),
    walls: wallHider ? wallHider.info() : null,
    live: state.live,
    theme: state.theme,
  };
}

export function is3DReady() {
  return state.ready;
}

export function camera() {
  return state.rig;
}

export function viewsCtl() {
  return views;
}

export function tourWalk() {
  return { tour, walk, coordinator };
}

export function explodeCtl() {
  return explode;
}

export function compareCtl() {
  return compare;
}

export function presentationCtl() {
  return presentation;
}

export function perfCtl() {
  return perf;
}

export function compassCtl() {
  return compass;
}

export function sectionCtl() {
  return section;
}

export function typeVisCtl() {
  return typeVis;
}

export function isolateCtl() {
  return isolate;
}

export function focusController() {
  return focusCtl;
}

export function clipState() {
  return {
    enabled: !!(state.clipGroup && state.clipGroup.enabled),
    planes: state.clipGroup ? state.clipGroup.clippingPlanes.length : 0,
    visual: !!(state.clipVisual && state.clipVisual.visible),
    plane: state.clipPlane ? { normal: state.clipPlane.normal.toArray(), constant: +state.clipPlane.constant.toFixed(4) } : null,
  };
}

export function setCompare(a, b, opts = {}) {
  if (!compare) {
    compare = new Compare({
      getBuilt: () => state.built,
      invalidate: () => invalidate(),
      onSwitch: opts.onSwitch || null,
      onchange: () => notify('compare'),
    });
  }
  compare.setProjects(a, b, opts);
  compare.setModel();
  return compare;
}

export { MODES, CameraRig as Camera3D };
