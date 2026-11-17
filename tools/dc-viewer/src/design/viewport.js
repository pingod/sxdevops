/**
 * 设计器三维视口：复用只读查看器的 buildRoom 渲染器，保证「设计稿 = 数字孪生呈现」。
 *
 * 编辑态与查看态的差别只在交互：这里不做墙/柜自动隐藏、不做剖切与漫游，
 * 选中对象用 Box3Helper 描边，拖动只更新 Group 的位移，松手后由 store 回写数据并重建。
 */
import * as THREE from 'three/webgpu';
import { S } from '../data/units.js';
import { buildRoom } from '../scene/builders.js';
import { disposeGroup } from '../scene/dispose.js';
import { createRenderer, backendOf } from '../scene/renderer.js';
import { createRoomEnvironment } from '../scene/environment.js';

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ACCENT = new THREE.Color('#245bdb');

export async function createViewport(canvas) {
  let renderer;
  try {
    renderer = await createRenderer(canvas, { antialias: true });
  } catch (webgpuError) {
    // Safari / 关闭硬件加速的环境没有 WebGPU：回退 WebGL2，而不是让设计器整页不可用。
    try {
      renderer = await createRenderer(canvas, { antialias: true, forceWebGL: true });
    } catch (webglError) {
      throw new Error(`${webgpuError.message || webgpuError}；WebGL2 回退也失败：${webglError.message || webglError}`);
    }
  }
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9edf3');
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
  let selectionHelper = null;
  let grid = null;
  let ghostPoint = null;
  let ghostLine = null;

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

  function findNode(obj) {
    if (!roomGroup || !obj) return null;
    let found = null;
    roomGroup.traverse(node => {
      if (!found && node.userData && node.userData.obj === obj) found = node;
    });
    return found;
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

  function rebuild(project, { fit = false } = {}) {
    if (roomGroup) {
      scene.remove(roomGroup);
      disposeGroup(roomGroup);
      roomGroup = null;
      built = null;
    }
    clearSelection();
    built = buildRoom(project);
    roomGroup = built.group;
    scene.add(roomGroup);
    rebuildGrid(built.bounds);
    fitShadow(built.bounds);
    applyEnclosure();
    if (fit) fitView();
    return built;
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

  function clearSelection() {
    if (selectionHelper) {
      scene.remove(selectionHelper);
      selectionHelper.geometry.dispose();
      selectionHelper.material.dispose();
      selectionHelper = null;
    }
  }

  function setSelection(obj) {
    clearSelection();
    const node = findNode(obj);
    if (!node) return;
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return;
    box.expandByScalar(0.02);
    selectionHelper = new THREE.Box3Helper(box, ACCENT);
    selectionHelper.material.depthTest = false;
    selectionHelper.material.transparent = true;
    selectionHelper.renderOrder = 999;
    scene.add(selectionHelper);
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

  /** 拖动预览：按对象原始坐标 + 位移直接定位 Group，数据回写在松手时做。 */
  function previewOffset(obj, dxMm, dyMm) {
    const node = findNode(obj);
    if (!node) return;
    if (obj.x !== undefined) node.position.set((obj.x + dxMm) * S, 0, -(obj.y + dyMm) * S);
    else node.position.set(dxMm * S, 0, -dyMm * S);
    if (selectionHelper) selectionHelper.box.setFromObject(node).expandByScalar(0.02);
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
    fitView,
    pick,
    groundPoint,
    setSelection,
    clearSelection,
    previewOffset,
    showPointGhost,
    showLineGhost,
    clearGhost,
    setEnclosure: setEnclosureTranscript,
    get enclosureTranslucent() { return enclosureTranslucent; },
    orbit,
    pan,
    zoom,
    resize,
    get controls() { return controls; },
    get built() { return built; },
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
