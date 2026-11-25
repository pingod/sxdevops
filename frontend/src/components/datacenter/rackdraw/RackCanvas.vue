<template>
  <div ref="stageRef" class="rack-canvas" @pointerdown.self="clearSelection">
    <svg
      ref="svgRef"
      class="rack-svg"
      :viewBox="`0 0 ${FRAME_W} ${geometry.height}`"
      :width="FRAME_W * zoom / 100"
      :height="geometry.height * zoom / 100"
      role="img"
      :aria-label="`${state.rack} 机柜布设图，共 ${state.devices.length} 台设备`"
      @dragover.prevent="onDragOver"
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
    >
      <defs>
        <linearGradient
          v-for="key in categoryKeys"
          :id="`rack-grad-${key}`"
          :key="key"
          x1="0" y1="0" x2="0" y2="1"
        >
          <stop offset="0%" :stop-color="metaOf(key).c0" />
          <stop offset="55%" :stop-color="metaOf(key).c1" />
          <stop offset="100%" :stop-color="metaOf(key).c2" />
        </linearGradient>
        <pattern id="rack-u-stripe" width="8" height="48" patternUnits="userSpaceOnUse">
          <rect width="8" height="48" fill="#f8fafc" />
          <rect width="8" height="24" fill="#eef2f7" />
        </pattern>
        <pattern id="rack-rail-holes" width="14" height="24" patternUnits="userSpaceOnUse">
          <rect width="14" height="24" fill="#334155" />
          <circle cx="7" cy="4" r="1.6" fill="#0f172a" />
          <circle cx="7" cy="12" r="1.6" fill="#0f172a" />
          <circle cx="7" cy="20" r="1.6" fill="#0f172a" />
        </pattern>
        <pattern id="rack-blank-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="7" height="7" :fill="metaOf('accessory').c2" />
          <line x1="0" y1="0" x2="0" y2="7" :stroke="metaOf('accessory').c0" stroke-width="2" />
        </pattern>
      </defs>

      <!-- 柜体外框与上下盖 -->
      <rect x="0" y="0" :width="FRAME_W" :height="geometry.height" rx="16" fill="#1e293b" />
      <rect x="8" y="6" :width="FRAME_W - 16" :height="CAP_H - 10" rx="6" fill="#0f172a" />
      <rect
        x="8" :y="geometry.height - CAP_H + 4" :width="FRAME_W - 16" :height="CAP_H - 10"
        rx="6" fill="#0f172a"
      />
      <text x="22" :y="CAP_H - 1" class="rack-cap-text">{{ state.rack }} · {{ state.rackWidth }}mm</text>
      <text :x="FRAME_W - 22" :y="CAP_H - 1" class="rack-cap-text" text-anchor="end">
        {{ state.devices.length }} 台 / {{ usedUnits }}U
      </text>

      <!-- U 号栏 -->
      <rect
        :x="geometry.innerLeft - RAIL_W - LABEL_W" :y="geometry.innerTop"
        :width="LABEL_W" :height="geometry.bodyH" fill="#0f172a"
      />
      <text
        v-for="unit in unitLabels"
        :key="unit.u"
        :x="geometry.innerLeft - RAIL_W - 7"
        :y="geometry.innerTop + (geometry.units - unit.u) * U_PX + U_PX / 2 + 3.5"
        class="rack-u-text"
        text-anchor="end"
      >{{ unit.u }}</text>

      <!-- 左右立柱与内框 -->
      <rect
        :x="geometry.innerLeft - RAIL_W" :y="geometry.innerTop"
        :width="RAIL_W" :height="geometry.bodyH" fill="url(#rack-rail-holes)"
      />
      <rect
        :x="geometry.innerLeft + geometry.innerW" :y="geometry.innerTop"
        :width="RAIL_W" :height="geometry.bodyH" fill="url(#rack-rail-holes)"
      />
      <rect
        :x="geometry.innerLeft" :y="geometry.innerTop"
        :width="geometry.innerW" :height="geometry.bodyH"
        fill="url(#rack-u-stripe)" stroke="#94a3b8" stroke-width="1.5"
      />

      <!-- 千分尺刻度：每 U 的上下边界 -->
      <line
        v-for="unit in geometry.units + 1"
        :key="`tick-${unit}`"
        :x1="geometry.innerLeft"
        :y1="geometry.innerTop + (unit - 1) * U_PX"
        :x2="geometry.innerLeft + geometry.innerW"
        :y2="geometry.innerTop + (unit - 1) * U_PX"
        stroke="#cbd5e1" stroke-width="1"
      />

      <!-- 空白处点击取消选中（放在设备下方，不挡设备事件） -->
      <rect
        x="0" y="0" :width="FRAME_W" :height="geometry.height"
        fill="transparent" @pointerdown.stop="clearSelection"
      />

      <!-- 已放置设备 -->
      <g
        v-for="device in state.devices"
        :key="device.id"
        class="rack-device"
        :class="{ 'is-selected': device.id === selectedId, 'is-dragging': dragDevice && dragDevice.id === device.id }"
        :transform="`translate(${rectOf(device).x}, ${rectOf(device).y})`"
        @pointerdown.stop="onDevicePointerDown($event, device)"
      >
        <rect
          :width="rectOf(device).width" :height="rectOf(device).height" rx="3"
          :fill="device.cat === 'accessory' && isBlankPanel(device) ? 'url(#rack-blank-hatch)' : `url(#rack-grad-${device.cat})`"
          :stroke="device.id === selectedId ? '#60a5fa' : 'rgba(255,255,255,0.32)'"
          :stroke-width="device.id === selectedId ? 2 : 1"
        />
        <rect
          x="1.5" y="1.5" :width="Math.max(0, rectOf(device).width - 3)" height="2"
          rx="1" fill="rgba(255,255,255,0.32)"
        />
        <!-- 面板装饰 -->
        <template v-if="device.cat === 'accessory'">
          <template v-if="isCableMgr(device)">
            <path
              v-for="index in 4" :key="`cm-${index}`"
              :d="cableMgrPath(device, index)"
              stroke="rgba(255,255,255,0.55)" stroke-width="1.4" fill="none"
            />
          </template>
          <template v-else-if="isPatchPanel(device)">
            <rect
              v-for="index in portCount(device)" :key="`pp-${index}`"
              :x="portX(device, index, portCount(device))" :y="rectOf(device).height / 2 - 3"
              width="6" height="6" rx="1" fill="rgba(255,255,255,0.62)"
            />
          </template>
        </template>
        <template v-else>
          <!-- 端口 -->
          <line
            v-for="index in portCount(device)" :key="`port-${index}`"
            :x1="portX(device, index, portCount(device))"
            :x2="portX(device, index, portCount(device))"
            :y1="rectOf(device).height - Math.min(7, rectOf(device).height * 0.32)"
            :y2="rectOf(device).height - 3"
            stroke="rgba(255,255,255,0.55)" stroke-width="1.6"
          />
          <!-- LED -->
          <circle
            v-for="(led, index) in ledsOf(device)" :key="`led-${index}`"
            :cx="rectOf(device).width - 10 - index * 7"
            :cy="Math.min(8, rectOf(device).height * 0.3)"
            r="2.2"
            :fill="led === 'g' ? '#4ade80' : '#fbbf24'"
          />
          <!-- 监控录像机硬盘位 -->
          <template v-if="isRecorder(device)">
            <rect
              v-for="index in portCount(device)" :key="`bay-${index}`"
              :x="portX(device, index, portCount(device))"
              :y="rectOf(device).height / 2 - 4"
              width="8" height="8" rx="1" fill="rgba(15,23,42,0.35)"
              stroke="rgba(255,255,255,0.28)"
            />
          </template>
        </template>
        <text
          class="rack-device-name"
          :x="rectOf(device).width / 2"
          :y="rectOf(device).height / 2 + Math.min(4, rectOf(device).height * 0.18)"
          text-anchor="middle"
          :font-size="deviceNameSize(device)"
        >{{ clipName(device) }}</text>
        <text
          v-if="rectOf(device).width > 110 && rectOf(device).height >= 20"
          class="rack-device-span"
          :x="rectOf(device).width - 6" :y="rectOf(device).height - 5"
          text-anchor="end"
        >{{ spanText(device) }}</text>
      </g>

      <!-- 拖放预览 -->
      <g v-if="ghost" :transform="`translate(${ghostRect.x}, ${ghostRect.y})`" class="rack-ghost">
        <rect
          :width="ghostRect.width" :height="ghostRect.height" rx="3"
          :fill="ghost.ok ? 'rgba(34,197,94,0.22)' : 'rgba(239,68,68,0.22)'"
          :stroke="ghost.ok ? '#22c55e' : '#ef4444'"
          stroke-width="1.6" stroke-dasharray="5 4"
        />
        <text
          :x="ghostRect.width / 2" :y="ghostRect.height / 2 + 4"
          text-anchor="middle" class="rack-ghost-text"
        >{{ ghost.ok ? `${ghost.w === 6 ? '全宽' : ghost.w === 3 ? '1/2' : '1/3'} · ${ghost.hU}U` : '位置冲突' }}</text>
      </g>

      <!-- 空柜提示 -->
      <text
        v-if="!state.devices.length && !ghost"
        :x="geometry.innerLeft + geometry.innerW / 2"
        :y="geometry.innerTop + geometry.bodyH / 2"
        text-anchor="middle"
        class="rack-empty-text"
      >从左侧目录拖入设备，或点击目录项快速上架</text>
    </svg>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  CAP_H, CATEGORY_META, FRAME_W, H_GRID, HOLES_PER_U, LABEL_W, RAIL_W, SLOT_PX, U_PX,
  clampInt, collides, deviceRect, rackUnits, snapDevice, slotGeometry, spanText,
} from './model'

const props = defineProps({
  state: { type: Object, required: true },
  selectedId: { type: Number, default: 0 },
  zoom: { type: Number, default: 100 },
  dragPayload: { type: Object, default: null },
})
const emit = defineEmits(['select', 'add-device', 'move-device'])

/**
 * 导出 PNG 时 SVG 会脱离页面 CSS，必须把样式随 SVG 一起序列化。
 * 模板里不能写 <style>（Vue 会判为副作用标签并报错），所以在导出时注入。
 */
const EXPORT_CSS = `
  text { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
  .rack-cap-text { fill: #94a3b8; font-size: 10px; letter-spacing: 0.04em; }
  .rack-u-text { fill: #64748b; font-size: 9px; font-variant-numeric: tabular-nums; }
  .rack-device-name { fill: #f8fafc; font-weight: 600; }
  .rack-device-span { fill: rgba(248, 250, 252, 0.72); font-size: 8px; }
  .rack-ghost-text { fill: #e2e8f0; font-size: 9px; }
  .rack-empty-text { fill: #94a3b8; font-size: 11px; }
`

const stageRef = ref(null)
const svgRef = ref(null)
const ghost = ref(null)
const dragDevice = ref(null)

const categoryKeys = Object.keys(CATEGORY_META)
const geometry = computed(() => slotGeometry(props.state))
const unitLabels = computed(() => Array.from({ length: geometry.value.units }, (_, index) => ({
  u: geometry.value.units - index,
})))
const usedUnits = computed(() => props.state.devices.reduce((sum, device) => sum + device.hU, 0))
const ghostRect = computed(() => {
  if (!ghost.value) return { x: 0, y: 0, width: 0, height: 0 }
  const colW = geometry.value.colW
  return {
    x: geometry.value.innerLeft + ghost.value.col * colW,
    y: geometry.value.innerTop + ghost.value.hole * SLOT_PX,
    width: ghost.value.w * colW,
    height: ghost.value.hU * U_PX,
  }
})

function metaOf(key) {
  return CATEGORY_META[key] || CATEGORY_META.custom
}

function rectOf(device) {
  return deviceRect(props.state, device)
}

function deviceNameSize(device) {
  const height = rectOf(device).height
  return Math.max(8, Math.min(12, height * 0.38))
}

function clipName(device) {
  const width = rectOf(device).width
  const max = Math.max(4, Math.floor(width / 12))
  const name = device.name || ''
  return name.length > max ? `${name.slice(0, max)}…` : name
}

function ledsOf(device) {
  if (device.cat === 'monitor') return isRecorder(device) ? ['g', 'a', 'g'] : ['g', 'a']
  return (metaOf(device.cat).leds || '').split('')
}

function isRecorder(device) {
  return device.cat === 'monitor' && device.name.includes('录像')
}

function isCableMgr(device) {
  return device.cat === 'accessory' && device.name.includes('理线')
}

function isPatchPanel(device) {
  return device.cat === 'accessory' && device.name.includes('配线')
}

function isBlankPanel(device) {
  return device.cat === 'accessory' && !isCableMgr(device) && !isPatchPanel(device)
}

function isPoE(device) {
  return device.name.includes('PoE')
}

function portCount(device) {
  switch (device.cat) {
    case 'router': return device.w === 6 ? 4 : 2
    case 'switch': return device.w === 6 ? 14 : (device.w === 3 ? 7 : 4)
    case 'firewall': return device.w + 1 < 6 ? device.w + 1 : 6
    case 'wireless': return isPoE(device) ? 4 : 2
    case 'monitor':
      if (isRecorder(device)) return device.w === 6 ? 6 : (device.w === 3 ? 3 : 2)
      return device.w === 6 ? 14 : (device.w === 3 ? 7 : 4)
    case 'accessory':
      if (isCableMgr(device)) return device.w === 6 ? 8 : 4
      if (isPatchPanel(device)) return device.w === 6 ? 12 : 6
      return 0
    default: return 0
  }
}

function portX(device, index, count) {
  const width = rectOf(device).width
  const margin = Math.min(18, width * 0.16)
  const usable = Math.max(8, width - margin * 2)
  return margin + (usable * index) / Math.max(1, count - 1 || 1)
}

function cableMgrPath(device, index) {
  const width = rectOf(device).width
  const height = rectOf(device).height
  const x = width * (index / 5)
  return `M ${x} ${height * 0.25} C ${x + 8} ${height * 0.25}, ${x + 8} ${height * 0.75}, ${x} ${height * 0.75}`
}

function svgPoint(event) {
  const svg = svgRef.value
  const point = svg.createSVGPoint()
  point.x = event.clientX
  point.y = event.clientY
  return point.matrixTransform(svg.getScreenCTM().inverse())
}

function clearSelection() {
  emit('select', 0)
}

function onDragOver(event) {
  const payload = props.dragPayload
  if (!payload) return
  event.dataTransfer.dropEffect = 'copy'
  const point = svgPoint(event)
  const colW = geometry.value.colW
  const topLeft = {
    x: point.x - (payload.w * colW) / 2,
    y: point.y - (payload.hU * U_PX) / 2,
  }
  const snapped = snapDevice(props.state, topLeft, payload.w, payload.hU)
  ghost.value = { ...snapped, w: payload.w, hU: payload.hU }
}

function onDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) ghost.value = null
}

function onDrop(event) {
  const payload = props.dragPayload || readPayload(event)
  if (!payload) return
  const point = svgPoint(event)
  const colW = geometry.value.colW
  const topLeft = {
    x: point.x - (payload.w * colW) / 2,
    y: point.y - (payload.hU * U_PX) / 2,
  }
  const snapped = snapDevice(props.state, topLeft, payload.w, payload.hU)
  ghost.value = null
  if (!snapped.ok) return
  emit('add-device', {
    cat: payload.cat,
    name: payload.name,
    w: payload.w,
    hU: payload.hU,
    col: snapped.col,
    hole: snapped.hole,
  })
}

function readPayload(event) {
  const raw = event.dataTransfer?.getData('application/x-rack-device')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

let session = null

function onDevicePointerDown(event, device) {
  if (event.button !== 0) return
  emit('select', device.id)
  const point = svgPoint(event)
  const rect = rectOf(device)
  session = {
    id: device.id,
    device,
    start: point,
    rect,
    moved: false,
  }
  dragDevice.value = device
  event.currentTarget.setPointerCapture?.(event.pointerId)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}

function onPointerMove(event) {
  if (!session) return
  const point = svgPoint(event)
  const dx = point.x - session.start.x
  const dy = point.y - session.start.y
  if (!session.moved && Math.hypot(dx, dy) < 3) return
  session.moved = true
  const snapped = snapDevice(props.state, {
    x: session.rect.x + dx,
    y: session.rect.y + dy,
  }, session.device.w, session.device.hU, session.device.id)
  ghost.value = { ...snapped, w: session.device.w, hU: session.device.hU }
}

function onPointerUp() {
  if (!session) return
  const { id, moved } = session
  const target = ghost.value
  session = null
  dragDevice.value = null
  ghost.value = null
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  if (moved && target?.ok) {
    emit('move-device', { id, col: clampInt(target.col, 0, H_GRID - 1), hole: target.hole })
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
})

defineExpose({
  /** 导出用：返回带内联样式的 SVG 克隆，脱离页面 CSS 也能正确渲染。 */
  buildExportSvg() {
    const svg = svgRef.value
    if (!svg) return null
    const clone = svg.cloneNode(true)
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
    style.textContent = EXPORT_CSS
    clone.insertBefore(style, clone.firstChild)
    return clone
  },
  /** 供父组件做「首空位」定位：返回指定设备尺寸的可用格位。 */
  findSlot(width, heightU) {
    const step = props.state.mode === 'U' ? HOLES_PER_U : 1
    for (let hole = 0; hole <= rackUnits(props.state.rack) * HOLES_PER_U - heightU * HOLES_PER_U; hole += step) {
      for (let col = 0; col <= H_GRID - width; col += 1) {
        if (!collides(props.state.devices, col, hole, width, heightU)) return { col, hole }
      }
    }
    return null
  },
})
</script>

<style scoped>
.rack-canvas {
  display: flex;
  justify-content: center;
  padding: 10px 8px 18px;
  min-height: 0;
  overflow: auto;
}

.rack-svg {
  display: block;
  touch-action: none;
  user-select: none;
}

.rack-cap-text {
  fill: #94a3b8;
  font-size: 10px;
  letter-spacing: 0.04em;
}

.rack-u-text {
  fill: #64748b;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.rack-device {
  cursor: grab;
}

.rack-device.is-dragging {
  opacity: 0.45;
  cursor: grabbing;
}

.rack-device-name {
  fill: #f8fafc;
  font-weight: 600;
  pointer-events: none;
}

.rack-device-span {
  fill: rgba(248, 250, 252, 0.72);
  font-size: 8px;
  pointer-events: none;
}

.rack-ghost {
  pointer-events: none;
}

.rack-ghost-text {
  fill: #e2e8f0;
  font-size: 9px;
}

.rack-empty-text {
  fill: #94a3b8;
  font-size: 11px;
}
</style>