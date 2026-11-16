/**
 * 呈现方式：线框调试（scene.overrideMaterial）与白模线稿（面材质替换 + 边线）。
 * 两者互斥；白模线稿开启时会先退出透视/隔离/线框。
 */
import * as THREE from 'three/webgpu';

export const WIRE = Object.freeze({
  mode: 'wire',
  color: 0x0c7c96,
  css: '#0c7c96',
  label: '线框调试',
  note: '仅用于几何重叠/净距/对象数量检查，不代表最终效果',
});

export const LINEART = Object.freeze({
  mode: 'lineart',
  label: '白模线稿',
  note: '白模 + 边线 · 用于汇报截图，不是真实消隐线',
  faceColor: 0xf6f5f1,
  faceColorCss: '#f6f5f1',
  edgeColor: 0x26343a,
  edgeColorCss: '#26343a',
  threshold: 30,
  edgeOpacity: 0.92,
});

export function wireMaterial(color = WIRE.color) {
  return new THREE.MeshBasicMaterial({ color, wireframe: true, fog: true });
}

const ownMeshes = group => {
  const out = [];
  const walk = n => {
    for (const c of n.children) {
      if (c.userData && c.userData.obj) continue;
      if (c.isMesh) out.push(c);
      else if (c.children && c.children.length) walk(c);
    }
  };
  walk(group);
  return out;
};

export class Presentation {
  constructor(deps = {}) {
    this.scene = deps.scene;
    this.invalidate = deps.invalidate || (() => {});
    this.onchange = deps.onchange || null;
    this.beforeEnable = deps.beforeEnable || null;
    this.extras = deps.extras || [];
    this.roomRoot = null;
    this.wireOn = false;
    this.wireMat = null;
    this.lineartOn = false;
    this.faceMat = new THREE.MeshStandardMaterial({
      color: LINEART.faceColor,
      roughness: 0.94,
      metalness: 0,
      side: THREE.DoubleSide,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.edgeMat = new THREE.LineBasicMaterial({
      color: LINEART.edgeColor,
      transparent: true,
      opacity: LINEART.edgeOpacity,
      depthWrite: false,
      depthTest: true,
      fog: true,
      toneMapped: false,
    });
    this.units = [];
  }

  get wire() {
    return this.wireOn;
  }

  get lineart() {
    return this.lineartOn;
  }

  setModel(roomRoot, built) {
    this._restoreLineart();
    this.roomRoot = roomRoot;
    if (this.lineartOn) this._applyLineart();
    this.invalidate();
  }

  setWire(on) {
    const next = !!on;
    if (next === this.wireOn) return false;
    this.wireOn = next;
    if (next) {
      if (this.lineartOn) this.setLineart(false);
      if (this.beforeEnable) this.beforeEnable('wire');
      this.wireMat = this.wireMat || wireMaterial();
      this.scene.overrideMaterial = this.wireMat;
      for (const g of this.extras) if (g) g.visible = false;
    } else {
      this.scene.overrideMaterial = null;
      for (const g of this.extras) if (g) g.visible = true;
    }
    this.invalidate();
    this._emit('wire');
    return true;
  }

  toggleWire() {
    return this.setWire(!this.wireOn);
  }

  setLineart(on) {
    const next = !!on;
    if (next === this.lineartOn) return false;
    this.lineartOn = next;
    if (next) {
      if (this.wireOn) this.setWire(false);
      if (this.beforeEnable) this.beforeEnable('lineart');
      this._applyLineart();
    } else {
      this._restoreLineart();
    }
    this.invalidate();
    this._emit('lineart');
    return true;
  }

  toggleLineart() {
    return this.setLineart(!this.lineartOn);
  }

  _applyLineart() {
    if (!this.roomRoot) return;
    const root = this.roomRoot;
    root.updateWorldMatrix(true, true);
    const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const visit = group => {
      const own = ownMeshes(group);
      const saved = new Map();
      const positions = [];
      const m = new THREE.Matrix4();
      const invGroup = new THREE.Matrix4().copy(group.matrixWorld).invert();
      for (const mesh of own) {
        saved.set(mesh, mesh.material);
        mesh.material = this.faceMat;
        mesh.updateWorldMatrix(true, false);
        m.multiplyMatrices(invGroup, mesh.matrixWorld);
        const edges = new THREE.EdgesGeometry(mesh.geometry, LINEART.threshold);
        edges.applyMatrix4(m);
        const arr = edges.attributes.position.array;
        for (let i = 0; i < arr.length; i++) positions.push(arr[i]);
        edges.dispose();
      }
      if (saved.size) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const lines = new THREE.LineSegments(geo, this.edgeMat);
        lines.name = 'lineart-edges';
        lines.userData.lineartEdge = true;
        lines.userData.noPick = true;
        lines.raycast = () => {};
        lines.castShadow = false;
        lines.receiveShadow = false;
        lines.renderOrder = 1;
        group.add(lines);
        this.units.push({ group, saved, lines });
      }
      for (const c of group.children) {
        if (c.userData && c.userData.obj) visit(c);
      }
    };
    const visitTree = node => {
      for (const c of node.children) {
        if (c.userData && c.userData.obj) visit(c);
        else if (c.children && c.children.length) visitTree(c);
      }
    };
    if (root.userData && root.userData.obj) visit(root);
    visitTree(root);
  }

  _restoreLineart() {
    for (const unit of this.units) {
      for (const [mesh, mat] of unit.saved) mesh.material = mat;
      if (unit.lines) {
        unit.group.remove(unit.lines);
        unit.lines.geometry.dispose();
      }
    }
    this.units = [];
  }

  info() {
    let edges = 0;
    for (const u of this.units) edges += u.lines ? 1 : 0;
    return {
      wire: { on: this.wireOn, color: WIRE.css, label: WIRE.label, note: WIRE.note, material: !!this.scene.overrideMaterial },
      lineart: {
        on: this.lineartOn,
        label: LINEART.label,
        note: LINEART.note,
        units: this.units.length,
        edges,
        face: LINEART.faceColorCss,
        edgeColor: LINEART.edgeColorCss,
      },
    };
  }

  dispose() {
    this._restoreLineart();
    if (this.wireMat) this.wireMat.dispose();
    this.faceMat.dispose();
    this.edgeMat.dispose();
  }

  _emit(reason) {
    if (typeof this.onchange === 'function') {
      try {
        this.onchange(this.info(), reason);
      } catch (err) {
        console.warn('[呈现] onchange 异常：', err);
      }
    }
  }
}
