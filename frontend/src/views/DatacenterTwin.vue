<template>
  <div class="fade-in twin-page workbench-page-shell">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon"><el-icon><Box /></el-icon></span>
        <h2>机房数字孪生</h2>
        <p class="page-inline-desc">三维机房场景叠加 SNMP 实时运行状态，机柜与设备按在线/离线/高负载着色</p>
      </div>
    </section>

    <div class="audit-grid">
      <div class="audit-card audit-card--inline">
        <div class="stat-value">{{ sceneTotals.rooms }}</div>
        <div class="stat-label">机房</div>
      </div>
      <div class="audit-card audit-card--inline">
        <div class="stat-value">{{ sceneTotals.racks }}</div>
        <div class="stat-label">机柜</div>
      </div>
      <div class="audit-card audit-card--inline">
        <div class="stat-value">{{ sceneTotals.devices }}</div>
        <div class="stat-label">规划设备</div>
      </div>
      <div class="audit-card audit-card--inline" :class="{ 'audit-card--success': liveDevices.length, 'audit-card--danger': offlineCount > 0 }">
        <div class="stat-value">{{ onlineCount }}<span class="stat-sub">/ {{ liveDevices.length }}</span></div>
        <div class="stat-label">纳管设备在线</div>
      </div>
    </div>

    <div class="workbench-card twin-stage-card">
      <div class="section-toolbar">
        <div class="toolbar-head">
          <span class="toolbar-title">三维场景</span>
          <span class="toolbar-desc">拖动旋转、滚轮缩放、点击机柜查看设备；实时状态每 30 秒刷新。</span>
        </div>
        <div class="workbench-card-actions">
          <el-button class="filter-refresh-btn" :loading="loading" @click="refresh">
            <el-icon><RefreshRight /></el-icon>刷新
          </el-button>
        </div>
      </div>
      <div class="twin-body">
        <div class="twin-canvas-wrap">
          <div ref="canvasMount" class="twin-canvas"></div>
          <div v-if="webglError" class="twin-fallback">
            <el-icon :size="34"><WarningFilled /></el-icon>
            <p>{{ webglError }}</p>
            <el-button type="primary" plain @click="$router.push('/datacenter/planning')">前往平面与机柜视图</el-button>
          </div>
          <div v-if="!webglError" class="twin-legend">
            <span v-for="item in legendItems" :key="item.label" class="legend-item">
              <span class="legend-dot" :style="{ background: item.color }"></span>{{ item.label }}
            </span>
          </div>
        </div>
        <aside class="twin-side">
          <div class="side-section">
            <div class="side-title">纳管设备实时状态</div>
            <div v-if="!liveDevices.length" class="side-empty">暂无纳管设备，请先在「网络设备」页添加。</div>
            <button v-for="dev in liveDevices" :key="dev.id" type="button" class="side-device" :class="{ 'is-active': activeDeviceId === dev.id }" @click="focusDevice(dev)">
              <span class="device-dot" :class="`device-dot--${dev.status}`"></span>
              <span class="device-info">
                <span class="device-name">{{ dev.name }}</span>
                <span class="device-meta">{{ dev.mgmt_ip }} · {{ dev.matchedCount }} 台关联</span>
              </span>
              <el-tag :type="dev.status === 'online' ? 'success' : dev.status === 'offline' ? 'danger' : 'info'" size="small" effect="light">{{ dev.status_display }}</el-tag>
            </button>
          </div>
          <div v-if="pickedRack" class="side-section">
            <div class="side-title">通道 {{ pickedRack.channel }} · 机柜 {{ pickedRack.rack }}（{{ pickedRackDevices.length }} 台）</div>
            <div class="rack-device-list">
              <div v-for="d in pickedRackDevices" :key="d.key" class="rack-device">
                <span class="legend-dot" :style="{ background: deviceColor(d) }"></span>
                <span class="rack-device-name">{{ d.displayName || d.model }}</span>
                <span class="rack-device-u">{{ d.startU }}-{{ d.endU }}U</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Box, RefreshRight, WarningFilled } from '@element-plus/icons-vue'
import { colorScheme, THEME_CHANGE_EVENT } from '@/theme'
import { getPlanningScene } from '@/api/modules/planning'
import { getNetworkOverview, listNetworkDevices } from '@/api/modules/network'
import { CATEGORY_COLOR, STATUS_COLOR, TwinScene } from '@/lib/twinScene'

const canvasMount = ref()
const loading = ref(false)
const webglError = ref('')
const scenePayload = ref(null)
const liveDevices = ref([])
const topUtil = ref([])
const pickedRack = ref(null)
const activeDeviceId = ref(null)
let twin = null
let timer = null
let resizeObserver = null

const sceneTotals = computed(() => scenePayload.value?.totals || { rooms: 0, racks: 0, devices: 0 })
const onlineCount = computed(() => liveDevices.value.filter(d => d.status === 'online').length)
const offlineCount = computed(() => liveDevices.value.filter(d => d.status === 'offline').length)
const pickedRackDevices = computed(() => {
  if (!pickedRack.value || !scenePayload.value) return []
  return scenePayload.value.devices.filter(d => d.channel === pickedRack.value.channel && d.rack === pickedRack.value.rack)
})
const legendItems = [
  { label: '核心', color: CATEGORY_COLOR.core },
  { label: '交换机', color: CATEGORY_COLOR.switch },
  { label: '服务器', color: CATEGORY_COLOR.server },
  { label: '存储', color: CATEGORY_COLOR.storage },
  { label: '安全', color: CATEGORY_COLOR.security },
  { label: '离线', color: STATUS_COLOR.offline },
  { label: '高负载', color: STATUS_COLOR.warning },
]

const LIGHT_PALETTE = {
  background: '#eef2f8',
  floor: '#d7e0ec',
  rackEmpty: '#b9c6d8',
  rackUsed: '#8fa5bf',
  capEmpty: '#a3b4c9',
  capUsed: '#6f87a6',
  selected: '#245bdb',
  capSelected: '#245bdb',
}

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '')
}

function matchSceneDevices(netDevice) {
  if (!scenePayload.value) return []
  const names = [normalize(netDevice.name), normalize(netDevice.sys_name)].filter(Boolean)
  return scenePayload.value.devices.filter((d) => {
    const display = normalize(d.displayName)
    const model = normalize(d.model)
    return names.some(n => display === n || model === n || display.startsWith(n) || n.startsWith(model) && model.length >= 4)
  })
}

function deviceStatus(netDevice) {
  if (netDevice.status === 'offline') return 'offline'
  const hot = topUtil.value.some(r => r.device_id === netDevice.id && Number(r.util) >= 80)
  return hot ? 'warning' : 'online'
}

function deviceColor(d) {
  const entry = liveDevices.value.find(dev => dev.matchedKeys?.includes(d.key))
  if (entry) {
    const status = deviceStatus(entry)
    if (STATUS_COLOR[status]) return STATUS_COLOR[status]
  }
  return CATEGORY_COLOR[d.category] || CATEGORY_COLOR.other
}

async function fetchAllNetworkDevices() {
  const first = await listNetworkDevices()
  const all = [...(first.results || [])]
  const pages = Math.ceil((first.count || 0) / 20)
  for (let page = 2; page <= pages; page++) {
    const data = await listNetworkDevices({ page })
    all.push(...(data.results || []))
  }
  return all
}

async function refresh() {
  loading.value = true
  try {
    const [scene, overview, devices] = await Promise.all([
      scenePayload.value ? Promise.resolve(scenePayload.value) : getPlanningScene(),
      getNetworkOverview().catch(() => null),
      fetchAllNetworkDevices().catch(() => []),
    ])
    scenePayload.value = scene
    topUtil.value = overview?.top_utilization || []
    liveDevices.value = devices.map((dev) => {
      const matched = matchSceneDevices(dev)
      return { ...dev, matchedCount: matched.length, matchedKeys: matched.map(d => d.key) }
    })
    if (twin) {
      if (!twin.payload) twin.setScene(scene)
      applyLiveStatus()
    }
  } catch (error) {
    webglError.value = ''
    if (!scenePayload.value) {
      webglError.value = '场景数据加载失败：' + (error?.response?.data?.detail || error?.message || '请确认规划引擎已就绪')
    }
  } finally {
    loading.value = false
  }
}

function applyLiveStatus() {
  const statusByKey = new Map()
  for (const dev of liveDevices.value) {
    const status = deviceStatus(dev)
    for (const key of dev.matchedKeys || []) statusByKey.set(key, status)
  }
  twin?.setDeviceStatus(statusByKey)
}

function focusDevice(dev) {
  activeDeviceId.value = dev.id
  const firstKey = dev.matchedKeys?.[0]
  if (firstKey && scenePayload.value) {
    const d = scenePayload.value.devices.find(item => item.key === firstKey)
    if (d) {
      pickedRack.value = { channel: d.channel, rack: d.rack }
      twin?.setSelectedRack(d.channel, d.rack)
    }
  }
}

function onPickRack(channel, rack) {
  pickedRack.value = { channel, rack }
  twin?.setSelectedRack(channel, rack)
}

function applyTheme() {
  twin?.setTheme(colorScheme.value === 'light' ? LIGHT_PALETTE : {})
}

function onThemeChange() {
  applyTheme()
}

onMounted(async () => {
  try {
    twin = new TwinScene(canvasMount.value, { onPickRack })
  } catch (exc) {
    webglError.value = `当前浏览器未能启用 WebGL（${exc?.message || exc}）。数字孪生需要硬件加速，可改用平面与机柜视图。`
    return
  }
  applyTheme()
  await refresh()
  if (twin && scenePayload.value && !twin.payload) twin.setScene(scenePayload.value)
  applyLiveStatus()
  resizeObserver = new ResizeObserver(() => twin?.resize())
  resizeObserver.observe(canvasMount.value)
  window.addEventListener(THEME_CHANGE_EVENT, onThemeChange)
  timer = setInterval(refresh, 30000)
})

onBeforeUnmount(() => {
  clearInterval(timer)
  resizeObserver?.disconnect()
  window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange)
  twin?.dispose()
  twin = null
})
</script>

<style scoped>
.twin-page {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.panel {
  background: linear-gradient(180deg, #ffffff 0%, #fffdf8 100%);
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  box-shadow: 0 6px 16px rgba(15, 23, 42, 0.04);
  padding: 12px 14px;
}

.hero {
  background: linear-gradient(135deg, #fbfdff 0%, #f7faff 52%, #f9fbfd 100%);
  border-color: rgba(36, 91, 219, 0.09);
}

.hero-title-row {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.hero-title-row h2 {
  font-size: 23px;
  line-height: 1.1;
  margin: 0;
}

.page-inline-desc {
  color: #64748b;
  font-size: 13px;
  line-height: 1.45;
  margin: 0;
  flex: 0 1 auto;
  transform: translateY(1px);
}

.hero-icon {
  align-items: center;
  background: linear-gradient(180deg, #f3f7ff 0%, #ebf2ff 100%);
  border: 1px solid rgba(36, 91, 219, 0.12);
  border-radius: 14px;
  color: #245bdb;
  display: inline-flex;
  font-size: 20px;
  height: 42px;
  justify-content: center;
  width: 42px;
}

.hero.panel {
  border-radius: 20px;
}

.stat-sub {
  color: #94a3b8;
  font-size: 14px;
  font-weight: 500;
}

.twin-stage-card {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.twin-body {
  display: grid;
  flex: 1;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) 300px;
  min-height: 480px;
}

.twin-canvas-wrap {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  min-height: 480px;
  overflow: hidden;
  position: relative;
}

.twin-canvas {
  height: 100%;
  min-height: 480px;
  width: 100%;
}

.twin-canvas :deep(canvas) {
  display: block;
}

.twin-fallback {
  align-items: center;
  color: #64748b;
  display: flex;
  flex-direction: column;
  gap: 12px;
  inset: 0;
  justify-content: center;
  padding: 24px;
  position: absolute;
  text-align: center;
}

.twin-legend {
  background: rgba(15, 23, 42, 0.55);
  border-radius: 8px;
  bottom: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  left: 10px;
  padding: 6px 10px;
  position: absolute;
}

.legend-item {
  align-items: center;
  color: #e2e8f0;
  display: inline-flex;
  font-size: 12px;
  gap: 5px;
}

.legend-dot {
  border-radius: 3px;
  display: inline-block;
  flex: none;
  height: 10px;
  width: 10px;
}

.twin-side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
}

.side-section {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 12px;
}

.side-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
}

.side-empty {
  color: #94a3b8;
  font-size: 12px;
  padding: 12px 0;
}

.side-device {
  align-items: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  gap: 8px;
  padding: 7px 8px;
  text-align: left;
  width: 100%;
}

.side-device:hover {
  background: rgba(36, 91, 219, 0.06);
}

.side-device.is-active {
  background: rgba(36, 91, 219, 0.1);
  border-color: rgba(36, 91, 219, 0.25);
}

.device-dot {
  border-radius: 50%;
  flex: none;
  height: 8px;
  width: 8px;
}

.device-dot--online {
  background: #16a34a;
}

.device-dot--offline {
  background: #dc2626;
}

.device-dot--unknown {
  background: #94a3b8;
}

.device-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.device-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device-meta {
  color: #94a3b8;
  font-size: 12px;
}

.rack-device-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}

.rack-device {
  align-items: center;
  display: flex;
  font-size: 12px;
  gap: 8px;
}

.rack-device-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rack-device-u {
  color: #94a3b8;
  flex: none;
}

@media (max-width: 1100px) {
  .twin-body {
    grid-template-columns: 1fr;
  }
}
</style>