/**
 * 机房数字孪生 Three.js 渲染器（纯渲染，无 Vue 依赖）。
 *
 * 几何真值来自规划引擎 /api/scene（毫米），本模块只做渲染投影。
 * 常量与公式镜像 planning/web/src/domain/scene3d.ts（该处有单测与导出铁线），
 * 改几何请改引擎侧，不要在这里另拍数字。
 *
 * 渲染纪律（与 vendored 3D 视图同源，已在 SwiftShader 软渲染验证）：
 * - 机柜/设备全部 InstancedMesh，禁止一设备一 Mesh（draw call 爆炸）。
 * - 柜体 BackSide 不透明盒 + 顶面亮条（透明盒排序不稳、线框软渲染出尖刺）。
 * - 毫米→米只在本模块 mm() 一处换算。
 */
import * as THREE from 'three'

const MM_PER_U = 44.45
const CABINET_WIDTH_MM = 600
const CABINET_HEIGHT_MM = 2000
const CABINET_DEPTH_MM = 1200
const RACK_SPACE_MM = 42 * MM_PER_U
const U_BASE_MM = (CABINET_HEIGHT_MM - RACK_SPACE_MM) / 2

export const CATEGORY_COLOR = {
  core: '#7f5af0',
  switch: '#2e7dd1',
  server: '#2f8f6f',
  storage: '#b0821f',
  security: '#b04a5a',
  other: '#4a5568',
}

export const STATUS_COLOR = {
  offline: '#dc2626',
  warning: '#d97706',
}

const mm = (v) => v / 1000

function deviceBox(startU, sizeU) {
  const heightMm = sizeU * MM_PER_U - 1
  return {
    widthMm: CABINET_WIDTH_MM - 40,
    heightMm,
    depthMm: CABINET_DEPTH_MM - 120,
    centerYMm: U_BASE_MM + (startU - 1) * MM_PER_U + heightMm / 2,
  }
}

function cameraBasis(theta, phi) {
  const dir = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)]
  const forward = [-dir[0], -dir[1], -dir[2]]
  const right = [-forward[2], 0, forward[0]]
  const rl = Math.hypot(right[0], right[1], right[2]) || 1
  const rn = [right[0] / rl, right[1] / rl, right[2] / rl]
  const up = [
    rn[1] * forward[2] - rn[2] * forward[1],
    rn[2] * forward[0] - rn[0] * forward[2],
    rn[0] * forward[1] - rn[1] * forward[0],
  ]
  return { right: rn, up }
}

function fitCamera(rooms, theta, phi, aspect, fovDeg = 45) {
  const box = rooms.length
    ? {
        minX: Math.min(...rooms.map(r => r.originX)),
        maxX: Math.max(...rooms.map(r => r.originX + r.widthMm)),
        minY: 0,
        maxY: CABINET_HEIGHT_MM,
        minZ: Math.min(...rooms.map(r => r.originZ)),
        maxZ: Math.max(...rooms.map(r => r.originZ + r.depthMm)),
      }
    : { minX: -1000, maxX: 1000, minY: 0, maxY: CABINET_HEIGHT_MM, minZ: -1000, maxZ: 1000 }
  const { right, up } = cameraBasis(theta, phi)
  const c = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2]
  let halfW = 0
  let halfH = 0
  for (const x of [box.minX, box.maxX]) {
    for (const y of [box.minY, box.maxY]) {
      for (const z of [box.minZ, box.maxZ]) {
        const d = [x - c[0], y - c[1], z - c[2]]
        halfW = Math.max(halfW, Math.abs(d[0] * right[0] + d[1] * right[1] + d[2] * right[2]))
        halfH = Math.max(halfH, Math.abs(d[0] * up[0] + d[1] * up[1] + d[2] * up[2]))
      }
    }
  }
  const vFov = (fovDeg * Math.PI) / 180
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(aspect, 0.1))
  const distance = Math.max(halfH / Math.tan(vFov / 2), halfW / Math.tan(hFov / 2), 1) * 1.15
  return {
    distance: mm(distance),
    target: new THREE.Vector3(mm(c[0]), mm(c[1]), mm(c[2])),
  }
}

const DEFAULT_PALETTE = {
  background: '#0f1319',
  floor: '#1e2734',
  rackEmpty: '#1c2431',
  rackUsed: '#2a3546',
  capEmpty: '#28323f',
  capUsed: '#4a6183',
  selected: '#3f6fd0',
  capSelected: '#8fb4ff',
}

export class TwinScene {
  constructor(mount, { onPickRack } = {}) {
    this.mount = mount
    this.onPickRack = onPickRack
    this.palette = { ...DEFAULT_PALETTE }
    this.cam = { theta: Math.PI / 4, phi: Math.PI / 3.2, radiusScale: 1 }
    this.payload = null
    this.deviceIndex = new Map()
    this.rackIndex = new Map()
    this.selectedKey = null
    this.deviceStatus = new Map()
    this._disposed = false

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(mount.clientWidth, Math.max(1, mount.clientHeight))
    this.renderer.setClearColor(this.palette.background, 1)
    mount.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(45, mount.clientWidth / Math.max(1, mount.clientHeight), 0.05, 500)
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6))
    const dir = new THREE.DirectionalLight(0xffffff, 1.6)
    dir.position.set(1, 2, 1.5)
    this.scene.add(dir)
    const dir2 = new THREE.DirectionalLight(0x88aaff, 0.5)
    dir2.position.set(-1, 1, -1.5)
    this.scene.add(dir2)

    this.raycaster = new THREE.Raycaster()
    this._bindControls()
  }

  setScene(payload) {
    this.payload = payload
    this._clearBuilt()
    this.deviceIndex.clear()
    this.rackIndex.clear()

    const floorMat = new THREE.MeshBasicMaterial({ color: this.palette.floor, side: THREE.DoubleSide })
    this.floorMeshes = []
    for (const room of payload.rooms) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(mm(room.widthMm), mm(room.depthMm)), floorMat)
      mesh.rotation.x = -Math.PI / 2
      mesh.position.set(mm(room.originX + room.widthMm / 2), 0, mm(room.originZ + room.depthMm / 2))
      this.scene.add(mesh)
      this.floorMeshes.push(mesh)
    }
    this.floorMat = floorMat

    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const yAxis = new THREE.Vector3(0, 1, 0)
    const scaleV = new THREE.Vector3(1, 1, 1)
    const posV = new THREE.Vector3()
    const color = new THREE.Color()

    const cabGeo = new THREE.BoxGeometry(mm(CABINET_WIDTH_MM), mm(CABINET_HEIGHT_MM), mm(CABINET_DEPTH_MM))
    this.cabMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide })
    this.cabinetMesh = new THREE.InstancedMesh(cabGeo, this.cabMat, payload.racks.length)
    const capGeo = new THREE.BoxGeometry(mm(CABINET_WIDTH_MM * 0.9), mm(20), mm(CABINET_DEPTH_MM * 0.9))
    this.capMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    this.capMesh = new THREE.InstancedMesh(capGeo, this.capMat, payload.racks.length)

    payload.racks.forEach((r, i) => {
      const key = `${r.channel}-${r.rack}`
      this.rackIndex.set(key, i)
      q.setFromAxisAngle(yAxis, (r.rotationY * Math.PI) / 180)
      posV.set(mm(r.x), mm(r.y), mm(r.z))
      m4.compose(posV, q, scaleV)
      this.cabinetMesh.setMatrixAt(i, m4)
      posV.set(mm(r.x), mm(CABINET_HEIGHT_MM + 10), mm(r.z))
      m4.compose(posV, q, scaleV)
      this.capMesh.setMatrixAt(i, m4)
    })
    this.cabinetMesh.instanceMatrix.needsUpdate = true
    this.capMesh.instanceMatrix.needsUpdate = true
    this.scene.add(this.cabinetMesh)
    this.scene.add(this.capMesh)

    const rackByKey = new Map(payload.racks.map(r => [`${r.channel}-${r.rack}`, r]))
    const bySize = new Map()
    for (const d of payload.devices) {
      const arr = bySize.get(d.sizeU) || []
      arr.push(d)
      bySize.set(d.sizeU, arr)
    }
    this.deviceMeshes = []
    for (const [sizeU, items] of bySize) {
      const box = deviceBox(1, sizeU)
      const geo = new THREE.BoxGeometry(mm(box.widthMm), mm(box.heightMm), mm(box.depthMm))
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff })
      const mesh = new THREE.InstancedMesh(geo, mat, items.length)
      items.forEach((d, i) => {
        const rack = rackByKey.get(`${d.channel}-${d.rack}`)
        if (!rack) {
          m4.identity()
          mesh.setMatrixAt(i, m4)
          return
        }
        const b = deviceBox(d.startU, d.sizeU)
        posV.set(mm(rack.x), mm(b.centerYMm), mm(rack.z))
        q.identity()
        m4.compose(posV, q, scaleV)
        mesh.setMatrixAt(i, m4)
        mesh.setColorAt(i, color.set(CATEGORY_COLOR[d.category] || CATEGORY_COLOR.other))
        this.deviceIndex.set(d.key, { mesh, index: i, device: d })
      })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      this.deviceMeshes.push(mesh)
      this.scene.add(mesh)
    }

    this._applyRackColors()
    this._applyDeviceColors()
    this.applyCamera()
    this.render()
  }

  setDeviceStatus(statusByKey) {
    this.deviceStatus = statusByKey
    this._applyDeviceColors()
    this._applyRackColors()
    this.render()
  }

  setSelectedRack(channel, rack) {
    this.selectedKey = channel != null ? `${channel}-${rack}` : null
    this._applyRackColors()
    this.render()
  }

  setTheme(palette) {
    this.palette = { ...DEFAULT_PALETTE, ...palette }
    this.renderer.setClearColor(this.palette.background, 1)
    if (this.floorMat) this.floorMat.color.set(this.palette.floor)
    this._applyRackColors()
    this.render()
  }

  _applyRackColors() {
    if (!this.cabinetMesh || !this.payload) return
    const color = new THREE.Color()
    const offlineRacks = new Set()
    for (const [key, status] of this.deviceStatus) {
      if (status === 'offline') {
        const entry = this.deviceIndex.get(key)
        if (entry) offlineRacks.add(`${entry.device.channel}-${entry.device.rack}`)
      }
    }
    this.payload.racks.forEach((r, i) => {
      const key = `${r.channel}-${r.rack}`
      const isSel = this.selectedKey === key
      const hasOffline = offlineRacks.has(key)
      const cabColor = isSel ? this.palette.selected : hasOffline ? '#5a2a33' : r.deviceCount === 0 ? this.palette.rackEmpty : this.palette.rackUsed
      const capColor = isSel ? this.palette.capSelected : hasOffline ? STATUS_COLOR.offline : r.deviceCount === 0 ? this.palette.capEmpty : this.palette.capUsed
      this.cabinetMesh.setColorAt(i, color.set(cabColor))
      this.capMesh.setColorAt(i, color.set(capColor))
    })
    if (this.cabinetMesh.instanceColor) this.cabinetMesh.instanceColor.needsUpdate = true
    if (this.capMesh.instanceColor) this.capMesh.instanceColor.needsUpdate = true
  }

  _applyDeviceColors() {
    const color = new THREE.Color()
    for (const [key, entry] of this.deviceIndex) {
      const status = this.deviceStatus.get(key)
      const base = CATEGORY_COLOR[entry.device.category] || CATEGORY_COLOR.other
      color.set(status && STATUS_COLOR[status] ? STATUS_COLOR[status] : base)
      entry.mesh.setColorAt(entry.index, color)
    }
    for (const mesh of this.deviceMeshes || []) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }

  applyCamera() {
    if (!this.payload) return
    const aspect = this.mount.clientWidth / Math.max(1, this.mount.clientHeight)
    const fit = fitCamera(this.payload.rooms, this.cam.theta, this.cam.phi, aspect)
    const distance = fit.distance * this.cam.radiusScale
    const dir = new THREE.Vector3(
      Math.sin(this.cam.phi) * Math.cos(this.cam.theta),
      Math.cos(this.cam.phi),
      Math.sin(this.cam.phi) * Math.sin(this.cam.theta),
    )
    this.camera.position.copy(fit.target).addScaledVector(dir, distance)
    this.camera.lookAt(fit.target)
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }

  _bindControls() {
    const el = this.renderer.domElement
    let dragging = false
    let lastX = 0
    let lastY = 0
    let moved = 0
    this._onPointerDown = (e) => {
      dragging = true
      moved = 0
      lastX = e.clientX
      lastY = e.clientY
      el.setPointerCapture(e.pointerId)
    }
    this._onPointerMove = (e) => {
      if (!dragging) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      moved += Math.abs(dx) + Math.abs(dy)
      lastX = e.clientX
      lastY = e.clientY
      this.cam.theta -= dx * 0.005
      this.cam.phi = Math.min(Math.PI / 2.05, Math.max(0.15, this.cam.phi - dy * 0.005))
      this.applyCamera()
      this.render()
    }
    this._onPointerUp = (e) => {
      dragging = false
      if (moved < 4 && this.onPickRack) this._pick(e)
    }
    this._onWheel = (e) => {
      e.preventDefault()
      this.cam.radiusScale = Math.min(4, Math.max(0.3, this.cam.radiusScale * (e.deltaY > 0 ? 1.1 : 0.9)))
      this.applyCamera()
      this.render()
    }
    el.addEventListener('pointerdown', this._onPointerDown)
    el.addEventListener('pointermove', this._onPointerMove)
    el.addEventListener('pointerup', this._onPointerUp)
    el.addEventListener('wheel', this._onWheel, { passive: false })
  }

  _pick(e) {
    if (!this.cabinetMesh) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    const hits = this.raycaster.intersectObject(this.cabinetMesh)
    if (hits.length && hits[0].instanceId != null) {
      const rack = this.payload.racks[hits[0].instanceId]
      if (rack) this.onPickRack(rack.channel, rack.rack)
    }
  }

  resize() {
    if (this._disposed) return
    this.renderer.setSize(this.mount.clientWidth, Math.max(1, this.mount.clientHeight))
    this.applyCamera()
    this.render()
  }

  render() {
    if (!this._disposed) this.renderer.render(this.scene, this.camera)
  }

  _clearBuilt() {
    for (const mesh of this.floorMeshes || []) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
    }
    for (const mesh of this.deviceMeshes || []) {
      this.scene.remove(mesh)
      mesh.dispose()
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    if (this.cabinetMesh) {
      this.scene.remove(this.cabinetMesh)
      this.cabinetMesh.dispose()
      this.cabinetMesh.geometry.dispose()
      this.cabMat.dispose()
    }
    if (this.capMesh) {
      this.scene.remove(this.capMesh)
      this.capMesh.dispose()
      this.capMesh.geometry.dispose()
      this.capMat.dispose()
    }
    if (this.floorMat) this.floorMat.dispose()
  }

  dispose() {
    this._disposed = true
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this._onPointerDown)
    el.removeEventListener('pointermove', this._onPointerMove)
    el.removeEventListener('pointerup', this._onPointerUp)
    el.removeEventListener('wheel', this._onWheel)
    this._clearBuilt()
    this.renderer.dispose()
    if (el.parentNode) el.parentNode.removeChild(el)
  }
}