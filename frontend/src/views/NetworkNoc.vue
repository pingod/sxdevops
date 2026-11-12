<template>
  <div class="fade-in noc-page workbench-page-shell">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon"><el-icon><Odometer /></el-icon></span>
        <h2>网络监控</h2>
        <p class="page-inline-desc">SNMP 网络设备运行态势、接口利用率与监控事件总览</p>
      </div>
    </section>

    <div class="audit-grid">
      <div class="audit-card audit-card--inline audit-card--success">
        <div class="stat-value">{{ overview.devices.online }}</div>
        <div class="stat-label">在线设备</div>
      </div>
      <div class="audit-card audit-card--inline" :class="{ 'audit-card--danger': overview.devices.offline > 0 }">
        <div class="stat-value">{{ overview.devices.offline }}</div>
        <div class="stat-label">离线设备</div>
      </div>
      <div class="audit-card audit-card--inline">
        <div class="stat-value">{{ overview.interfaces.up }}<span class="stat-sub">/ {{ overview.interfaces.total }}</span></div>
        <div class="stat-label">接口 UP / 总数</div>
      </div>
      <div class="audit-card audit-card--inline">
        <div class="stat-value stat-value--small">{{ formatBps(overview.traffic.in_bps) }} / {{ formatBps(overview.traffic.out_bps) }}</div>
        <div class="stat-label">总流量（入/出）</div>
      </div>
    </div>

    <div class="workbench-card">
      <div class="section-toolbar">
        <div class="toolbar-head">
          <span class="toolbar-title">运行态势</span>
          <span class="toolbar-desc">每 30 秒自动刷新，数据来自 SNMP 采集器最近一轮采集。</span>
        </div>
        <div class="workbench-card-actions">
          <el-button class="filter-refresh-btn" :loading="loading" @click="refresh">
            <el-icon><RefreshRight /></el-icon>刷新
          </el-button>
        </div>
      </div>
      <div class="noc-grid">
        <div class="noc-panel noc-panel--devices">
          <div class="noc-panel-title">设备状态</div>
          <el-table v-loading="loading" :data="devices" size="small" class="network-table">
            <el-table-column label="设备" min-width="130">
              <template #default="{ row }">
                <div class="device-name">{{ row.name }}</div>
                <div class="device-sub">{{ row.mgmt_ip }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="device_type_display" label="类型" width="86" />
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="statusTag(row.status)" size="small" effect="light">{{ row.status_display }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="最近采集" min-width="140">
              <template #default="{ row }">{{ formatTime(row.last_poll_at) }}</template>
            </el-table-column>
            <template #empty>
              <div class="table-empty">暂无设备，请先在「网络设备」页纳管。</div>
            </template>
          </el-table>
        </div>
        <div class="noc-panel">
          <div class="noc-panel-title">接口利用率 TOP 10</div>
          <div ref="utilChartRef" class="chart-box chart-box--tall"></div>
        </div>
        <div class="noc-panel">
          <div class="noc-panel-title">最近监控事件</div>
          <div class="event-list">
            <div v-for="event in overview.recent_events" :key="event.id" class="event-item">
              <span class="event-dot" :class="`event-dot--${event.severity}`"></span>
              <div class="event-body">
                <div class="event-title">{{ event.title }}</div>
                <div class="event-meta">{{ formatTime(event.occurred_at) }}</div>
              </div>
            </div>
            <div v-if="!overview.recent_events.length" class="table-empty">暂无监控事件。</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Odometer, RefreshRight } from '@element-plus/icons-vue'
import echarts from '@/lib/echarts'
import { getNetworkOverview, listNetworkDevices } from '@/api/modules/network'

const loading = ref(false)
const devices = ref([])
const overview = ref({
  devices: { total: 0, online: 0, offline: 0, unknown: 0, enabled: 0 },
  interfaces: { total: 0, up: 0, down: 0 },
  traffic: { in_bps: 0, out_bps: 0 },
  top_utilization: [],
  recent_events: [],
})
const utilChartRef = ref()
let utilChart = null
let timer = null

function statusTag(status) {
  return { online: 'success', offline: 'danger', unknown: 'info' }[status] || 'info'
}
function formatTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
function formatBps(value) {
  const bps = Number(value || 0)
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mbps`
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} Kbps`
  return `${bps.toFixed(0)} bps`
}

async function refresh() {
  loading.value = true
  try {
    const [overviewData, deviceData] = await Promise.all([getNetworkOverview(), listNetworkDevices()])
    overview.value = overviewData
    devices.value = deviceData.results || []
    await nextTick()
    renderUtilChart()
  } finally {
    loading.value = false
  }
}

function renderUtilChart() {
  if (!utilChartRef.value) return
  if (!utilChart) utilChart = echarts.init(utilChartRef.value)
  const rows = [...(overview.value.top_utilization || [])].reverse()
  utilChart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: value => `${Number(value).toFixed(1)}%` },
    grid: { left: 8, right: 40, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
    yAxis: {
      type: 'category',
      data: rows.map(row => `${row.device__name} ${row.name}`),
      axisLabel: { width: 150, overflow: 'truncate' },
    },
    series: [{
      type: 'bar',
      data: rows.map(row => ({
        value: Number(row.util || 0).toFixed(1),
        itemStyle: { color: row.util >= 80 ? '#dc2626' : row.util >= 50 ? '#d97706' : '#245bdb', borderRadius: [0, 4, 4, 0] },
      })),
      barMaxWidth: 16,
      label: { show: true, position: 'right', formatter: '{c}%' },
    }],
  }, { notMerge: true })
}

function onResize() {
  utilChart?.resize()
}

onMounted(() => {
  refresh()
  timer = setInterval(refresh, 30000)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  window.removeEventListener('resize', onResize)
  utilChart?.dispose()
})
</script>

<style scoped>
.noc-page {
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

.stat-value--small {
  font-size: 15px;
  white-space: nowrap;
}

.noc-page .stat-label {
  white-space: nowrap;
}

.noc-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
}

.noc-panel {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 12px 14px;
}

.noc-panel--devices {
  grid-row: span 2;
}

.noc-panel-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
}

.network-table {
  width: 100%;
}

.device-name {
  font-weight: 600;
}

.device-sub {
  color: #94a3b8;
  font-size: 12px;
}

.table-empty {
  color: #94a3b8;
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}

.chart-box--tall {
  height: 300px;
  width: 100%;
}

.event-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 300px;
  overflow-y: auto;
}

.event-item {
  align-items: flex-start;
  border-radius: 8px;
  display: flex;
  gap: 8px;
  padding: 6px 8px;
}

.event-item:hover {
  background: rgba(36, 91, 219, 0.05);
}

.event-dot {
  border-radius: 50%;
  flex: none;
  height: 8px;
  margin-top: 5px;
  width: 8px;
}

.event-dot--info {
  background: #245bdb;
}

.event-dot--warning {
  background: #d97706;
}

.event-dot--critical {
  background: #dc2626;
}

.event-title {
  font-size: 13px;
  line-height: 1.4;
}

.event-meta {
  color: #94a3b8;
  font-size: 12px;
}

@media (max-width: 1100px) {
  .noc-grid {
    grid-template-columns: 1fr;
  }

  .noc-panel--devices {
    grid-row: auto;
  }
}
</style>