/**
 * 设计器三维视口：复用只读查看器的 buildRoom 渲染器，保证「设计稿 = 数字孪生呈现」。
 *
 * 编辑态与查看态的差别只在交互：这里不做墙/柜自动隐藏、不做剖切与漫游，
 * 选中对象用 Box3Helper 描边，拖动只更新 Group 的位移，松手后由 store 回写数据。
 *
 * 更新分两级：点对象（机柜/空调/立柱…）在原地增量重建自己的对象组；墙体、
 * 开洞、桥架、横梁与层高会影响包围盒/网格/阴影，交给调用方整场重建。
 */
import * as THREE from 'three/webgpu';
import { S } from '../data/units.js';
import { buildRoom, buildObjectInto, buildWallInto } from '../scene/builders.js';
import { disposeGroup } from '../scene/dispose.js';
import { createRendererWithFallback, backendOf } from '../scene/renderer.js';
import { createRoomEnvironment } from '../scene/environment.js';
import { projectOnWall, nearestWall, clampTOnWall } from './opening.js';

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ACCENT = new THREE.Color('#245bdb');

/** 可以在原地增量重建的类型：几何只依赖自己，不影响包围盒。 */
const INCREMENTAL_TYPES = new Set([
  'cabinet', 'ac', 'pdu', 'ups', 'column', 'vent', 'extinguisher', 'battery', 'aisle',
]);

const BACKGROUNDS = { light: '#e9edf3', charcoal: '#1b1f24', dark: '#101722' };

export async function createViewport(canvas) {
  const renderer = await createRendererWithFallback(canvas, { antialias: true });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUNDS.light);
  scene.environment = createRoomEnvironment();
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
  const controls = {
    target: new THREE.Vector3(0, 1, 0),
    radius: 18,
    theta: Math.PI * 0.32,
    phi: 1.02,
    minPhi: 0.12,
    maxPhi: 1.5,
    minRadius: 1.5,
    maxRadius: 220,
  };

  const hemi = new THREE.HemisphereLight(0xffffff, 0xb9c4d2, 1.15);
  const dir = new THREE.DirectionalLight(0xffffff, 1.55);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.bias = -0.0005;
  scene.add(hemi, dir, dir.target);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let built = null;
  let roomGroup = null;
  let project = null;
  let grid = null;
  let ghostPoint = null;
  let ghostLine = null;
  let theme = 'light';
  const nodeById = new Map();
  const helpers = new Map();
  const bench = { fullMs: 0, incrementalMs: 0, last: '' };

  function updateCamera() {
    const { radius, theta, phi, target } = controls;
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.cos(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.sin(theta),
    );
    camera.lookAt(target);
  }

  function ndc(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    return pointer;
  }

  function indexNodes() {
    nodeById.clear();
    if (!roomGroup) return;
    roomGroup.traverse((node) => {
      const obj = node.userData && node.userData.obj;
      if (obj && obj.id && !nodeById.has(obj.id)) nodeById.set(obj.id, node);
    });
  }

  function rebuildGrid(b) {
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      grid.material.dispose();
      grid = null;
    }
    const w = (b.maxx - b.minx) * S;
    const d = (b.maxy - b.miny) * S;
    const size = Math.max(6, Math.ceil(Math.max(w, d) / 2) * 2 + 4);
    grid = new THREE.GridHelper(size, Math.round(size), 0xc3cddb, 0xdde4ec);
    grid.position.set(((b.minx + b.maxx) / 2) * S, 0.002, -((b.miny + b.maxy) / 2) * S);
    scene.add(grid);
  }

  function fitShadow(b) {
    const cx = ((b.minx + b.maxx) / 2) * S;
    const cz = -((b.miny + b.maxy) / 2) * S;
    const size = Math.max(6, Math.max(b.maxx - b.minx, b.maxy - b.miny) * S);
    dir.position.set(cx + size * 0.55, Math.max(8, size * 0.95), cz + size * 0.55);
    dir.target.position.set(cx, 0, cz);
    dir.target.updateMatrixWorld();
    const cam = dir.shadow.camera;
    cam.left = -size; cam.right = size; cam.top = size; cam.bottom = -size;
    cam.near = 0.5; cam.far = size * 4 + 60;
    cam.updateProjectionMatrix();
  }

  let enclosureTranslucent = true;

  function ownerOf(node) {
    let cursor = node;
    while (cursor) {
      if (cursor.userData && cursor.userData.obj) return cursor.userData.obj;
      if (built && cursor === built.ceiling) return { type: '__ceiling__' };
      cursor = cursor.parent;
    }
    return null;
  }

  /** 围护（墙 + 吊顶）在编辑态默认半透明：不挡住内部机柜，同时仍能选中编辑。 */
  function applyEnclosure() {
    if (!roomGroup) return;
    const translucent = enclosureTranslucent;
    roomGroup.traverse(node => {
      if (!node.isMesh) return;
      const owner = ownerOf(node);
      if (!owner || (owner.type !== 'wall' && owner.type !== '__ceiling__')) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of mats) {
        if (!material) continue;
        material.transparent = translucent;
        material.opacity = translucent ? 0.22 : 1;
        material.depthWrite = !translucent;
        material.side = THREE.DoubleSide;
        material.needsUpdate = true;
      }
      node.castShadow = !translucent;
    });
  }

  function setEnclosureTranscript(translucent) {
    enclosureTranslucent = !!translucent;
    applyEnclosure();
  }

  function ctxOf() {
    return {
      objs: project?.objects || [],
      roomH: built?.roomH ?? 3000,
      ceilH: built?.ceilH ?? 3000,
      floorH: built?.floorH ?? 400,
      cabH: Math.max(2000, ...(project?.objects || []).filter(o => o.type === 'cabinet').map(o => o.props.h || 2000)),
    };
  }

  function rebuild(nextProject, { fit = false } = {}) {
    const started = performance.now();
    if (roomGroup) {
      scene.remove(roomGroup);
      disposeGroup(roomGroup);
      roomGroup = null;
      built = null;
    }
    clearSelection();
    nodeById.clear();
    project = nextProject;
    built = buildRoom(project);
    roomGroup = built.group;
    scene.add(roomGroup);
    indexNodes();
    // 阴影贴图按机柜量降级：800 柜项目里 2048 的阴影通道才是帧时间大头。
    const count = project.objects?.length || 0;
    dir.shadow.mapSize.set(count > 500 ? 1024 : 2048, count > 500 ? 1024 : 2048);
    if (dir.shadow.map) {
      dir.shadow.map.dispose();
      dir.shadow.map = null;
    }
    rebuildGrid(built.bounds);
    fitShadow(built.bounds);
    applyEnclosure();
    if (fit) fitView();
    bench.fullMs = performance.now() - started;
    bench.last = 'full';
    return built;
  }

  /** 点对象原地重建；返回 false 表示这个对象必须整场重建。 */
  function updateObject(obj) {
    if (!obj || !INCREMENTAL_TYPES.has(obj.type) || !roomGroup) return false;
    const started = performance.now();
    const old = nodeById.get(obj.id);
    if (old) {
      roomGroup.remove(old);
      disposeGroup(old);
    }
    const group = buildObjectInto(roomGroup, obj, ctxOf());
    if (!group) return false;
    nodeById.set(obj.id, group);
    applyEnclosure();
    refreshHelper(obj.id);
    bench.incrementalMs = performance.now() - started;
    bench.last = 'incremental';
    return true;
  }

  /** 只重建一面墙（含它的门窗/格栅）；墙端点/厚度/层高变化仍走整场重建。 */
  function rebuildWallGroup(wallId) {
    if (!roomGroup || !project) return false;
    const wall = (project.objects || []).find(o => o.id === wallId && o.type === 'wall');
    if (!wall) return false;
    const started = performance.now();
    const old = nodeById.get(wallId);
    if (old) {
      roomGroup.remove(old);
      disposeGroup(old);
      nodeById.clear();
    }
    buildWallInto(roomGroup, wall, project.objects, built?.roomH ?? 3000);
    indexNodes();
    applyEnclosure();
    for (const id of helpers.keys()) refreshHelper(id);
    bench.incrementalMs = performance.now() - started;
    bench.last = 'wall';
    return true;
  }

  function fitView() {
    if (!built) return;
    const b = built.bounds;
    const w = (b.maxx - b.minx) * S;
    const d = (b.maxy - b.miny) * S;
    const h = Math.max(2.5, built.roomH * S);
    controls.target.set(((b.minx + b.maxx) / 2) * S, h * 0.3, -((b.miny + b.maxy) / 2) * S);
    controls.radius = Math.min(controls.maxRadius, Math.max(6, Math.hypot(w, d, h) * 1.15));
    controls.theta = Math.PI * 0.34;
    controls.phi = 1.02;
    updateCamera();
  }

  function disposeHelper(helper) {
    scene.remove(helper);
    helper.geometry.dispose();
    helper.material.dispose();
  }

  function clearSelection() {
    for (const helper of helpers.values()) disposeHelper(helper);
    helpers.clear();
  }

  function refreshHelper(id) {
    const helper = helpers.get(id);
    if (!helper) return;
    const node = nodeById.get(id);
    if (!node) return;
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return;
    helper.box.copy(box).expandByScalar(0.02);
  }

  function setSelection(objects) {
    const list = (Array.isArray(objects) ? objects : [objects]).filter(Boolean);
    const wanted = new Set(list.map(o => o.id));
    for (const [id, helper] of [...helpers]) {
      if (!wanted.has(id)) {
        disposeHelper(helper);
        helpers.delete(id);
      }
    }
    for (const obj of list) {
      if (helpers.has(obj.id)) {
        refreshHelper(obj.id);
        continue;
      }
      const node = nodeById.get(obj.id);
      if (!node) continue;
      const box = new THREE.Box3().setFromObject(node);
      if (box.isEmpty()) continue;
      box.expandByScalar(0.02);
      const helper = new THREE.Box3Helper(box, ACCENT);
      helper.material.depthTest = false;
      helper.material.transparent = true;
      helper.renderOrder = 999;
      scene.add(helper);
      helpers.set(obj.id, helper);
    }
  }

  function pick(clientX, clientY) {
    if (!roomGroup) return null;
    raycaster.setFromCamera(ndc(clientX, clientY), camera);
    const hits = raycaster.intersectObject(roomGroup, true);
    for (const hit of hits) {
      let node = hit.object;
      while (node && !(node.userData && node.userData.obj)) node = node.parent;
      if (node && node.userData && node.userData.obj) return node.userData.obj;
    }
    return null;
  }

  function groundPoint(clientX, clientY) {
    raycaster.setFromCamera(ndc(clientX, clientY), camera);
    const point = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(GROUND, point)) return null;
    return { x: point.x / S, y: -point.z / S };
  }

  /**
   * 开洞落点：先射线命中墙体本身，否则用地面点找 500mm 内最近的墙。
   * `width` 给出洞口宽度时按 `[width/2L, 1-width/2L]` 夹取；墙太短返回 null。
   */
  function wallHit(clientX, clientY, width = 0) {
    if (!roomGroup || !project) return null;
    let hit = null;
    raycaster.setFromCamera(ndc(clientX, clientY), camera);
    const hits = raycaster.intersectObject(roomGroup, true);
    for (const candidate of hits) {
      let node = candidate.object;
      while (node && !(node.userData && node.userData.obj && node.userData.obj.type === 'wall')) node = node.parent;
      const wall = node?.userData?.obj;
      if (!wall) continue;
      const spot = projectOnWall(wall, candidate.point.x / S, -candidate.point.z / S);
      if (spot) { hit = { wall, t: spot.t }; break; }
    }
    if (!hit) {
      const ground = groundPoint(clientX, clientY);
      if (!ground) return null;
      hit = nearestWall(project.objects, ground.x, ground.y, 500);
      if (!hit) return null;
    }
    if (width > 0) {
      const t = clampTOnWall(hit.wall, width, hit.t);
      if (t === null) return null;
      hit.t = t;
    }
    return hit;
  }

  /** 世界 mm → 画布 CSS 坐标；自动化点击与框选调试用。 */
  function projectPoint(xMm, hMm, yMm) {
    const rect = canvas.getBoundingClientRect();
    const v = new THREE.Vector3(xMm * S, hMm * S, -yMm * S).project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
    };
  }

  /** 对象的 8 角投影矩形（CSS 像素），框选用。 */
  function screenBounds(obj) {
    const node = nodeById.get(obj?.id);
    if (!node) return null;
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return null;
    const rect = canvas.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i += 1) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      v.project(camera);
      const x = (v.x * 0.5 + 0.5) * rect.width + rect.left;
      const y = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { minX, minY, maxX, maxY };
  }

  /** 拖动预览：按对象原始坐标 + 位移直接定位 Group，数据回写在松手时做。 */
  function previewOffset(obj, dxMm, dyMm) {
    const node = nodeById.get(obj?.id);
    if (!node) return;
    if (obj.x !== undefined) node.position.set((obj.x + dxMm) * S, 0, -(obj.y + dyMm) * S);
    else node.position.set(dxMm * S, 0, -dyMm * S);
    refreshHelper(obj.id);
  }

  function previewMany(objects, dxMm, dyMm) {
    for (const obj of objects || []) previewOffset(obj, dxMm, dyMm);
  }

  function ensureGhostPoint() {
    if (ghostPoint) return ghostPoint;
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.56, 40),
      new THREE.MeshBasicMaterial({ color: 0x245bdb, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    group.add(ring);
    group.renderOrder = 998;
    scene.add(group);
    ghostPoint = group;
    return group;
  }

  function showPointGhost(xMm, yMm) {
    const group = ensureGhostPoint();
    group.visible = true;
    group.position.set(xMm * S, 0, -yMm * S);
  }

  function ensureGhostLine() {
    if (ghostLine) return ghostLine;
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const material = new THREE.LineBasicMaterial({ color: 0x245bdb, depthTest: false, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 998;
    scene.add(line);
    ghostLine = line;
    return line;
  }

  function showLineGhost(x1, y1, x2, y2) {
    const line = ensureGhostLine();
    line.visible = true;
    const positions = line.geometry.getAttribute('position');
    positions.setXYZ(0, x1 * S, 0.02, -y1 * S);
    positions.setXYZ(1, x2 * S, 0.02, -y2 * S);
    positions.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }

  function clearGhost() {
    if (ghostPoint) ghostPoint.visible = false;
    if (ghostLine) ghostLine.visible = false;
  }

  function orbit(dx, dy) {
    controls.theta -= dx * 0.006;
    controls.phi = Math.min(controls.maxPhi, Math.max(controls.minPhi, controls.phi - dy * 0.005));
    updateCamera();
  }

  function pan(dx, dy) {
    const scale = controls.radius * 0.0016;
    const forward = new THREE.Vector3().subVectors(controls.target, camera.position).setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    controls.target.addScaledVector(right, -dx * scale);
    controls.target.addScaledVector(forward, dy * scale);
    updateCamera();
  }

  function zoom(delta) {
    controls.radius = Math.min(controls.maxRadius, Math.max(controls.minRadius, controls.radius * Math.exp(delta * 0.0012)));
    updateCamera();
  }

  function setTheme(next) {
    theme = BACKGROUNDS[next] ? next : 'light';
    scene.background.set(BACKGROUNDS[theme]);
  }

  function resize() {
    const parent = canvas.parentElement;
    const width = Math.max(1, parent.clientWidth);
    const height = Math.max(1, parent.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement);
  resize();
  updateCamera();

  let running = true;
  function frame() {
    if (!running) return;
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    backend: backendOf(renderer),
    rebuild,
    updateObject,
    rebuildWallGroup,
    fitView,
    pick,
    groundPoint,
    wallHit,
    screenBounds,
    projectPoint,
    setSelection,
    clearSelection,
    previewOffset,
    previewMany,
    showPointGhost,
    showLineGhost,
    clearGhost,
    setEnclosure: setEnclosureTranscript,
    setTheme,
    get theme() { return theme; },
    get enclosureTranslucent() { return enclosureTranslucent; },
    orbit,
    pan,
    zoom,
    resize,
    bench: () => ({ ...bench, objects: project?.objects?.length || 0 }),
    nodeOf: (id) => nodeById.get(id) || null,
    get controls() { return controls; },
    get built() { return built; },
    get project() { return project; },
    dispose() {
      running = false;
      observer.disconnect();
      clearSelection();
      clearGhost();
      if (roomGroup) disposeGroup(roomGroup);
      renderer.dispose();
    },
  };
}
