<template>
  <div class="fade-in network-page workbench-page-shell">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon"><el-icon><Connection /></el-icon></span>
        <h2>网络设备</h2>
        <p class="page-inline-desc">SNMP 设备纳管、凭据管理与接口流量台账</p>
      </div>
    </section>

    <div class="audit-grid">
      <button type="button" class="audit-card audit-card--inline audit-card--action" :class="{ 'is-active': !filters.status }" @click="applyStatusFilter('')">
        <div class="stat-value">{{ stats.devices.total }}</div>
        <div class="stat-label">设备总数</div>
      </button>
      <button type="button" class="audit-card audit-card--inline audit-card--success audit-card--action" :class="{ 'is-active': filters.status === 'online' }" @click="applyStatusFilter('online')">
        <div class="stat-value">{{ stats.devices.online }}</div>
        <div class="stat-label">在线</div>
      </button>
      <button type="button" class="audit-card audit-card--inline audit-card--danger audit-card--action" :class="{ 'is-active': filters.status === 'offline' }" @click="applyStatusFilter('offline')">
        <div class="stat-value">{{ stats.devices.offline }}</div>
        <div class="stat-label">离线</div>
      </button>
      <div class="audit-card audit-card--inline">
        <div class="stat-value">{{ stats.interfaces.up }}<span class="stat-sub">/ {{ stats.interfaces.total }}</span></div>
        <div class="stat-label">接口 UP / 总数</div>
      </div>
    </div>

    <div class="neo-tabs theme-blue">
      <button type="button" class="neo-tab-btn" :class="{ active: tab === 'devices' }" @click="tab = 'devices'">
        <el-icon><Connection /></el-icon>设备列表
      </button>
      <button type="button" class="neo-tab-btn" :class="{ active: tab === 'credentials' }" @click="switchToCredentials">
        <el-icon><Key /></el-icon>SNMP 凭据
      </button>
    </div>

    <div v-if="tab === 'devices'" class="workbench-card">
      <div class="section-toolbar">
        <div class="toolbar-head">
          <span class="toolbar-title">设备列表</span>
          <span class="toolbar-desc">采集器按设备间隔自动轮询，也可手动测试连通性或立即采集。</span>
        </div>
        <div class="workbench-card-actions">
          <el-button v-if="canManage" type="primary" @click="openDeviceDialog()">
            <el-icon><Plus /></el-icon>纳管设备
          </el-button>
        </div>
      </div>
      <div class="workbench-toolbar workbench-toolbar--history">
        <div class="workbench-toolbar-left">
          <el-input v-model="filters.search" clearable placeholder="搜索名称 / IP / 型号 / 位置" style="width: 240px" @keyup.enter="reloadDevices" @clear="reloadDevices" />
          <el-select v-model="filters.device_type" clearable placeholder="类型" style="width: 116px" @change="reloadDevices">
            <el-option v-for="item in deviceTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="filters.vendor" clearable placeholder="厂商" style="width: 116px" @change="reloadDevices">
            <el-option v-for="item in vendorOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="filters.status" clearable placeholder="状态" style="width: 104px" @change="reloadDevices">
            <el-option label="在线" value="online" />
            <el-option label="离线" value="offline" />
            <el-option label="未探测" value="unknown" />
          </el-select>
        </div>
        <div class="workbench-toolbar-right">
          <el-button class="filter-refresh-btn" :loading="loading" @click="reloadDevices">
            <el-icon><RefreshRight /></el-icon>刷新
          </el-button>
        </div>
      </div>
      <el-table v-loading="loading" :data="devices" size="default" class="network-table">
        <el-table-column label="设备名称" min-width="150">
          <template #default="{ row }">
            <div class="device-name">{{ row.name }}</div>
            <div class="device-sub">{{ row.sys_name || row.model || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="管理地址" min-width="140">
          <template #default="{ row }">{{ row.mgmt_ip }}:{{ row.snmp_port }}</template>
        </el-table-column>
        <el-table-column prop="device_type_display" label="类型" width="90" />
        <el-table-column prop="vendor_display" label="厂商" width="90" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)" size="small" effect="light">{{ row.status_display }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="interface_count" label="接口数" width="80" align="right" />
        <el-table-column label="最近采集" min-width="150">
          <template #default="{ row }">{{ formatTime(row.last_poll_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="252" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :loading="rowAction === `test-${row.id}`" :disabled="!canManage" @click="testDevice(row)">测试</el-button>
            <el-button link type="primary" size="small" :loading="rowAction === `poll-${row.id}`" :disabled="!canManage" @click="pollDevice(row)">采集</el-button>
            <el-button link type="primary" size="small" @click="openDrawer(row)">接口</el-button>
            <el-button link type="primary" size="small" :disabled="!canManage" @click="openDeviceDialog(row)">编辑</el-button>
            <el-button link type="danger" size="small" :disabled="!canManage" @click="removeDevice(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="table-empty">暂无网络设备，点击右上角「纳管设备」添加第一台设备。</div>
        </template>
      </el-table>
      <div class="table-pagination">
        <el-pagination v-model:current-page="page" :page-size="20" :total="total" layout="total, prev, pager, next" @current-change="fetchDevices" />
      </div>
    </div>

    <div v-else class="workbench-card">
      <div class="section-toolbar">
        <div class="toolbar-head">
          <span class="toolbar-title">SNMP 凭据</span>
          <span class="toolbar-desc">Community 与 v3 密钥加密存储，任何接口不回显明文。</span>
        </div>
        <div class="workbench-card-actions">
          <el-button v-if="canManage" type="primary" @click="openCredentialDialog()">
            <el-icon><Plus /></el-icon>新建凭据
          </el-button>
        </div>
      </div>
      <el-table v-loading="credentialsLoading" :data="credentials" size="default" class="network-table">
        <el-table-column prop="name" label="凭据名称" min-width="140" />
        <el-table-column label="版本" width="100">
          <template #default="{ row }">{{ row.version === 'v3' ? 'SNMPv3' : 'SNMPv2c' }}</template>
        </el-table-column>
        <el-table-column label="安全参数" min-width="200">
          <template #default="{ row }">
            <span v-if="row.version === 'v3'">{{ row.v3_username }} · {{ authLabel(row.v3_auth_protocol) }} / {{ privLabel(row.v3_priv_protocol) }}</span>
            <span v-else>Community ******</span>
          </template>
        </el-table-column>
        <el-table-column prop="device_count" label="引用设备" width="90" align="right" />
        <el-table-column prop="description" label="描述" min-width="160" show-overflow-tooltip />
        <el-table-column label="更新时间" min-width="150">
          <template #default="{ row }">{{ formatTime(row.updated_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="!canManage" @click="openCredentialDialog(row)">编辑</el-button>
            <el-button link type="danger" size="small" :disabled="!canManage" @click="removeCredential(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="table-empty">暂无 SNMP 凭据。</div>
        </template>
      </el-table>
    </div>

    <el-dialog v-model="deviceDialogVisible" :title="deviceForm.id ? '编辑设备' : '纳管设备'" width="640px" top="5vh" append-to-body class="workbench-edit-dialog">
      <el-form ref="deviceFormRef" :model="deviceForm" :rules="deviceRules" label-position="top">
        <div class="form-grid">
          <el-form-item label="设备名称" prop="name">
            <el-input v-model="deviceForm.name" placeholder="如 core-sw-01" maxlength="100" />
          </el-form-item>
          <el-form-item label="管理 IP" prop="mgmt_ip">
            <el-input v-model="deviceForm.mgmt_ip" placeholder="如 10.0.0.1" />
          </el-form-item>
          <el-form-item label="设备类型" prop="device_type">
            <el-select v-model="deviceForm.device_type" style="width: 100%">
              <el-option v-for="item in deviceTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="厂商" prop="vendor">
            <el-select v-model="deviceForm.vendor" style="width: 100%">
              <el-option v-for="item in vendorOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="型号">
            <el-input v-model="deviceForm.model" placeholder="如 CE6881-48S6CQ" maxlength="100" />
          </el-form-item>
          <el-form-item label="位置">
            <el-input v-model="deviceForm.location" placeholder="如 信息港 403 机房 A01 机柜" maxlength="200" />
          </el-form-item>
          <el-form-item label="SNMP 凭据" prop="credential">
            <el-select v-model="deviceForm.credential" style="width: 100%" placeholder="选择凭据">
              <el-option v-for="item in credentialOptions" :key="item.id" :label="`${item.name}（${item.version}）`" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="SNMP 端口" prop="snmp_port">
            <el-input-number v-model="deviceForm.snmp_port" :min="1" :max="65535" style="width: 100%" />
          </el-form-item>
          <el-form-item label="系统采集间隔（秒）" prop="system_interval">
            <el-input-number v-model="deviceForm.system_interval" :min="30" :max="86400" style="width: 100%" />
          </el-form-item>
          <el-form-item label="接口采集间隔（秒）" prop="interface_interval">
            <el-input-number v-model="deviceForm.interface_interval" :min="30" :max="86400" style="width: 100%" />
          </el-form-item>
        </div>
        <el-form-item label="描述">
          <el-input v-model="deviceForm.description" type="textarea" :rows="2" maxlength="255" />
        </el-form-item>
        <el-form-item label="启用采集">
          <el-switch v-model="deviceForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="deviceDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveDevice">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="credentialDialogVisible" :title="credentialForm.id ? '编辑凭据' : '新建凭据'" width="560px" top="5vh" append-to-body class="workbench-edit-dialog">
      <el-form ref="credentialFormRef" :model="credentialForm" :rules="credentialRules" label-position="top">
        <el-form-item label="凭据名称" prop="name">
          <el-input v-model="credentialForm.name" placeholder="如 public-readonly" maxlength="100" />
        </el-form-item>
        <el-form-item label="SNMP 版本" prop="version">
          <el-radio-group v-model="credentialForm.version">
            <el-radio-button value="v2c">SNMPv2c</el-radio-button>
            <el-radio-button value="v3">SNMPv3</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="credentialForm.version === 'v2c'" label="Community" prop="community">
          <el-input v-model="credentialForm.community" type="password" show-password :placeholder="credentialForm.id ? '留空保持不变' : '只读 Community'" />
        </el-form-item>
        <template v-else>
          <el-form-item label="用户名" prop="v3_username">
            <el-input v-model="credentialForm.v3_username" maxlength="64" />
          </el-form-item>
          <div class="form-grid">
            <el-form-item label="认证协议">
              <el-select v-model="credentialForm.v3_auth_protocol" style="width: 100%">
                <el-option v-for="item in authOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="认证密钥" prop="v3_auth_key">
              <el-input v-model="credentialForm.v3_auth_key" type="password" show-password :placeholder="credentialForm.id ? '留空保持不变' : '至少 8 位'" />
            </el-form-item>
            <el-form-item label="加密协议">
              <el-select v-model="credentialForm.v3_priv_protocol" style="width: 100%">
                <el-option v-for="item in privOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="加密密钥" prop="v3_priv_key">
              <el-input v-model="credentialForm.v3_priv_key" type="password" show-password :placeholder="credentialForm.id ? '留空保持不变' : '至少 8 位'" />
            </el-form-item>
          </div>
        </template>
        <el-form-item label="描述">
          <el-input v-model="credentialForm.description" type="textarea" :rows="2" maxlength="255" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="credentialDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveCredential">保存</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="drawerVisible" :title="drawerDevice ? `${drawerDevice.name} · 接口与健康` : ''" size="76%" append-to-body @closed="onDrawerClosed">
      <div v-if="drawerDevice" class="drawer-body">
        <div class="drawer-meta">
          <span>{{ drawerDevice.mgmt_ip }}:{{ drawerDevice.snmp_port }}</span>
          <el-tag :type="statusTag(drawerDevice.status)" size="small" effect="light">{{ drawerDevice.status_display }}</el-tag>
          <span class="drawer-meta-sub">{{ drawerDevice.sys_descr || drawerDevice.model || '' }}</span>
        </div>
        <div class="neo-tabs theme-blue drawer-tabs">
          <button type="button" class="neo-tab-btn" :class="{ active: drawerTab === 'interfaces' }" @click="switchToInterfaces">接口台账</button>
          <button type="button" class="neo-tab-btn" :class="{ active: drawerTab === 'health' }" @click="switchToHealth">健康趋势</button>
          <div class="drawer-hours">
            <el-select v-model="hours" style="width: 110px" @change="reloadCharts">
              <el-option label="近 1 小时" :value="1" />
              <el-option label="近 6 小时" :value="6" />
              <el-option label="近 24 小时" :value="24" />
              <el-option label="近 7 天" :value="168" />
            </el-select>
          </div>
        </div>
        <template v-if="drawerTab === 'interfaces'">
          <el-table v-loading="interfacesLoading" :data="interfaces" size="small" highlight-current-row class="network-table" @current-change="selectInterface">
            <el-table-column prop="name" label="接口" min-width="130" show-overflow-tooltip />
            <el-table-column prop="alias" label="别名" min-width="110" show-overflow-tooltip />
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.oper_status === 1 ? 'success' : 'danger'" size="small" effect="light">{{ row.oper_status === 1 ? 'UP' : 'DOWN' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="速率" width="100">
              <template #default="{ row }">{{ formatBps(row.speed_bps) }}</template>
            </el-table-column>
            <el-table-column label="入向" width="110" align="right">
              <template #default="{ row }">{{ formatBps(row.in_bps) }}</template>
            </el-table-column>
            <el-table-column label="出向" width="110" align="right">
              <template #default="{ row }">{{ formatBps(row.out_bps) }}</template>
            </el-table-column>
            <el-table-column label="利用率" min-width="140">
              <template #default="{ row }">
                <el-progress :percentage="Math.max(row.in_util, row.out_util)" :stroke-width="8" :color="utilColor" />
              </template>
            </el-table-column>
          </el-table>
          <div class="chart-card">
            <div class="chart-title">{{ activeInterface ? `${activeInterface.name} 流量趋势` : '选择上方接口查看流量趋势' }}</div>
            <div ref="trafficChartRef" class="chart-box"></div>
          </div>
        </template>
        <template v-else>
          <div class="chart-card">
            <div class="chart-title">CPU / 内存 / 温度趋势</div>
            <div ref="healthChartRef" class="chart-box"></div>
          </div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Connection, Key, Plus, RefreshRight } from '@element-plus/icons-vue'
import echarts from '@/lib/echarts'
import { useAuthStore } from '@/stores/auth'
import {
  createNetworkDevice, createSnmpCredential, deleteNetworkDevice, deleteSnmpCredential,
  getDeviceInterfaces, getDeviceMetrics, getInterfaceMetrics, getNetworkOverview,
  listNetworkDevices, listSnmpCredentials, pollNetworkDevice,
  testNetworkDevice, updateNetworkDevice, updateSnmpCredential,
} from '@/api/modules/network'

const authStore = useAuthStore()
const canManage = authStore.hasPermission('network.device.manage')

const tab = ref('devices')
const loading = ref(false)
const devices = ref([])
const total = ref(0)
const page = ref(1)
const filters = reactive({ search: '', device_type: '', vendor: '', status: '' })
const stats = ref({ devices: { total: 0, online: 0, offline: 0 }, interfaces: { up: 0, total: 0 } })
const rowAction = ref('')

const credentials = ref([])
const credentialsLoading = ref(false)
const credentialOptions = ref([])

const deviceDialogVisible = ref(false)
const credentialDialogVisible = ref(false)
const saving = ref(false)
const deviceFormRef = ref()
const credentialFormRef = ref()
const deviceForm = reactive({})
const credentialForm = reactive({})

const drawerVisible = ref(false)
const drawerDevice = ref(null)
const drawerTab = ref('interfaces')
const interfaces = ref([])
const interfacesLoading = ref(false)
const activeInterface = ref(null)
const hours = ref(6)
const trafficChartRef = ref()
const healthChartRef = ref()
let trafficChart = null
let healthChart = null

const deviceTypeOptions = [
  { value: 'switch', label: '交换机' }, { value: 'router', label: '路由器' }, { value: 'firewall', label: '防火墙' },
  { value: 'load_balancer', label: '负载均衡' }, { value: 'wireless', label: '无线设备' }, { value: 'other', label: '其他' },
]
const vendorOptions = [
  { value: 'huawei', label: '华为' }, { value: 'h3c', label: '新华三' }, { value: 'cisco', label: '思科' },
  { value: 'ruijie', label: '锐捷' }, { value: 'zte', label: '中兴' }, { value: 'juniper', label: 'Juniper' },
  { value: 'fortinet', label: '飞塔' }, { value: 'linux', label: 'Linux' }, { value: 'other', label: '其他' },
]
const authOptions = [
  { value: 'none', label: '无认证' }, { value: 'md5', label: 'MD5' }, { value: 'sha', label: 'SHA-1' },
  { value: 'sha224', label: 'SHA-224' }, { value: 'sha256', label: 'SHA-256' }, { value: 'sha384', label: 'SHA-384' }, { value: 'sha512', label: 'SHA-512' },
]
const privOptions = [
  { value: 'none', label: '无加密' }, { value: 'des', label: 'DES' }, { value: 'aes128', label: 'AES-128' },
  { value: 'aes192', label: 'AES-192' }, { value: 'aes256', label: 'AES-256' },
]

const deviceRules = {
  name: [{ required: true, message: '请输入设备名称', trigger: 'blur' }],
  mgmt_ip: [{ required: true, message: '请输入管理 IP', trigger: 'blur' }],
  credential: [{ required: true, message: '请选择 SNMP 凭据', trigger: 'change' }],
}
const credentialRules = {
  name: [{ required: true, message: '请输入凭据名称', trigger: 'blur' }],
  v3_username: [{ required: true, message: '请输入 v3 用户名', trigger: 'blur' }],
}

function statusTag(status) {
  return { online: 'success', offline: 'danger', unknown: 'info' }[status] || 'info'
}
function authLabel(value) {
  return authOptions.find(item => item.value === value)?.label || value
}
function privLabel(value) {
  return privOptions.find(item => item.value === value)?.label || value
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
function utilColor(percentage) {
  if (percentage >= 80) return '#dc2626'
  if (percentage >= 50) return '#d97706'
  return '#245bdb'
}

async function fetchStats() {
  try {
    const data = await getNetworkOverview()
    stats.value = { devices: data.devices, interfaces: data.interfaces }
  } catch {
    // 统计失败不阻塞列表
  }
}

async function fetchDevices() {
  loading.value = true
  try {
    const params = { page: page.value }
    for (const [key, value] of Object.entries(filters)) {
      if (value) params[key] = value
    }
    const data = await listNetworkDevices(params)
    devices.value = data.results || []
    total.value = data.count || 0
  } finally {
    loading.value = false
  }
}

function reloadDevices() {
  page.value = 1
  fetchDevices()
  fetchStats()
}

function applyStatusFilter(status) {
  filters.status = status
  tab.value = 'devices'
  reloadDevices()
}

async function fetchCredentials() {
  credentialsLoading.value = true
  try {
    const data = await listSnmpCredentials()
    credentials.value = data.results || []
  } finally {
    credentialsLoading.value = false
  }
}

async function fetchCredentialOptions() {
  const data = await listSnmpCredentials()
  credentialOptions.value = data.results || []
}

function switchToCredentials() {
  tab.value = 'credentials'
  fetchCredentials()
}

function openDeviceDialog(row) {
  Object.assign(deviceForm, {
    id: row?.id || null,
    name: row?.name || '',
    mgmt_ip: row?.mgmt_ip || '',
    device_type: row?.device_type || 'switch',
    vendor: row?.vendor || 'other',
    model: row?.model || '',
    location: row?.location || '',
    description: row?.description || '',
    snmp_port: row?.snmp_port || 161,
    credential: row?.credential || null,
    enabled: row?.enabled ?? true,
    system_interval: row?.system_interval || 300,
    interface_interval: row?.interface_interval || 60,
  })
  fetchCredentialOptions()
  deviceDialogVisible.value = true
}

async function saveDevice() {
  await deviceFormRef.value.validate()
  saving.value = true
  try {
    const payload = { ...deviceForm }
    delete payload.id
    if (deviceForm.id) {
      await updateNetworkDevice(deviceForm.id, payload)
      ElMessage.success('设备已更新')
    } else {
      await createNetworkDevice(payload)
      ElMessage.success('设备已纳管，采集器将按间隔自动探测')
    }
    deviceDialogVisible.value = false
    reloadDevices()
  } finally {
    saving.value = false
  }
}

async function removeDevice(row) {
  await ElMessageBox.confirm(`确认移除设备 ${row.name}？接口台账与历史样本将一并删除。`, '移除设备', { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' })
  await deleteNetworkDevice(row.id)
  ElMessage.success('设备已移除')
  reloadDevices()
}

async function testDevice(row) {
  rowAction.value = `test-${row.id}`
  try {
    const result = await testNetworkDevice(row.id)
    if (result.reachable) {
      ElMessage.success(`${row.name} 可达：${result.sys_name || result.sys_descr?.slice(0, 60) || 'SNMP 响应正常'}`)
    } else {
      ElMessage.error(`${row.name} 不可达：${result.error}`)
    }
  } finally {
    rowAction.value = ''
  }
}

async function pollDevice(row) {
  rowAction.value = `poll-${row.id}`
  try {
    const result = await pollNetworkDevice(row.id)
    ElMessage.success(`${row.name} 采集完成：${result.status === 'online' ? '在线' : '离线'}，接口 ${result.interface_count ?? 0} 个`)
    fetchDevices()
    fetchStats()
  } catch (error) {
    ElMessage.error(error?.response?.data?.detail || `${row.name} 采集失败`)
  } finally {
    rowAction.value = ''
  }
}

function openCredentialDialog(row) {
  Object.assign(credentialForm, {
    id: row?.id || null,
    name: row?.name || '',
    version: row?.version || 'v2c',
    community: '',
    v3_username: row?.v3_username || '',
    v3_auth_protocol: row?.v3_auth_protocol || 'none',
    v3_auth_key: '',
    v3_priv_protocol: row?.v3_priv_protocol || 'none',
    v3_priv_key: '',
    description: row?.description || '',
  })
  credentialDialogVisible.value = true
}

async function saveCredential() {
  await credentialFormRef.value.validate()
  saving.value = true
  try {
    const payload = { ...credentialForm }
    delete payload.id
    if (credentialForm.id) {
      await updateSnmpCredential(credentialForm.id, payload)
      ElMessage.success('凭据已更新')
    } else {
      await createSnmpCredential(payload)
      ElMessage.success('凭据已创建')
    }
    credentialDialogVisible.value = false
    fetchCredentials()
  } finally {
    saving.value = false
  }
}

async function removeCredential(row) {
  await ElMessageBox.confirm(`确认删除凭据 ${row.name}？`, '删除凭据', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  try {
    await deleteSnmpCredential(row.id)
    ElMessage.success('凭据已删除')
    fetchCredentials()
  } catch (error) {
    ElMessage.error(error?.response?.data?.detail || '删除失败')
  }
}

async function openDrawer(row) {
  drawerDevice.value = row
  drawerTab.value = 'interfaces'
  activeInterface.value = null
  interfaces.value = []
  drawerVisible.value = true
  interfacesLoading.value = true
  try {
    interfaces.value = await getDeviceInterfaces(row.id)
    if (interfaces.value.length) {
      activeInterface.value = interfaces.value[0]
    }
  } finally {
    interfacesLoading.value = false
  }
  await nextTick()
  initTrafficChart()
  reloadCharts()
}

function selectInterface(row) {
  if (!row) return
  activeInterface.value = row
  reloadCharts()
}

function switchToHealth() {
  drawerTab.value = 'health'
  trafficChart?.dispose()
  trafficChart = null
  nextTick(() => {
    initHealthChart()
    reloadCharts()
  })
}

function switchToInterfaces() {
  drawerTab.value = 'interfaces'
  healthChart?.dispose()
  healthChart = null
  nextTick(() => {
    initTrafficChart()
    reloadCharts()
  })
}

function initTrafficChart() {
  // 切换子 tab 会销毁图表容器，旧实例必须重建，否则会画在脱离 DOM 的 canvas 上。
  if (trafficChart && trafficChart.getDom() !== trafficChartRef.value) {
    trafficChart.dispose()
    trafficChart = null
  }
  if (trafficChartRef.value && !trafficChart) {
    trafficChart = echarts.init(trafficChartRef.value)
  }
}

function initHealthChart() {
  if (healthChart && healthChart.getDom() !== healthChartRef.value) {
    healthChart.dispose()
    healthChart = null
  }
  if (healthChartRef.value && !healthChart) {
    healthChart = echarts.init(healthChartRef.value)
  }
}

async function reloadCharts() {
  if (drawerTab.value === 'interfaces' && activeInterface.value) {
    const data = await getInterfaceMetrics(activeInterface.value.id, { hours: hours.value })
    renderTrafficChart(data.series || [])
  } else if (drawerTab.value === 'health' && drawerDevice.value) {
    const data = await getDeviceMetrics(drawerDevice.value.id, { hours: hours.value })
    renderHealthChart(data.series || [])
  }
}

function seriesValue(point, field) {
  return point[field] ?? point[`${field}_avg`] ?? null
}

function renderTrafficChart(series) {
  if (!trafficChart) return
  trafficChart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['入向', '出向'] },
    grid: { left: 78, right: 20, top: 36, bottom: 28 },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', axisLabel: { formatter: value => formatBps(value) } },
    series: [
      { name: '入向', type: 'line', showSymbol: true, symbolSize: 5, smooth: true, data: series.map(point => [point.ts, seriesValue(point, 'in_bps')]), lineStyle: { color: '#245bdb' }, itemStyle: { color: '#245bdb' }, areaStyle: { color: 'rgba(36,91,219,0.10)' } },
      { name: '出向', type: 'line', showSymbol: true, symbolSize: 5, smooth: true, data: series.map(point => [point.ts, seriesValue(point, 'out_bps')]), lineStyle: { color: '#16a34a' }, itemStyle: { color: '#16a34a' }, areaStyle: { color: 'rgba(22,163,74,0.08)' } },
    ],
  }, { notMerge: true })
}

function renderHealthChart(series) {
  if (!healthChart) return
  healthChart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['CPU %', '内存 %', '温度 ℃'] },
    grid: { left: 44, right: 20, top: 36, bottom: 28 },
    xAxis: { type: 'time' },
    yAxis: { type: 'value' },
    series: [
      { name: 'CPU %', type: 'line', showSymbol: true, symbolSize: 5, smooth: true, data: series.map(point => [point.ts, seriesValue(point, 'cpu_pct')]), lineStyle: { color: '#245bdb' }, itemStyle: { color: '#245bdb' } },
      { name: '内存 %', type: 'line', showSymbol: true, symbolSize: 5, smooth: true, data: series.map(point => [point.ts, seriesValue(point, 'mem_pct')]), lineStyle: { color: '#d97706' }, itemStyle: { color: '#d97706' } },
      { name: '温度 ℃', type: 'line', showSymbol: true, symbolSize: 5, smooth: true, data: series.map(point => [point.ts, seriesValue(point, 'temperature')]), lineStyle: { color: '#dc2626' }, itemStyle: { color: '#dc2626' } },
    ],
  }, { notMerge: true })
}

function onDrawerClosed() {
  trafficChart?.dispose()
  healthChart?.dispose()
  trafficChart = null
  healthChart = null
  drawerDevice.value = null
  activeInterface.value = null
}

function onResize() {
  trafficChart?.resize()
  healthChart?.resize()
}

onMounted(() => {
  fetchDevices()
  fetchStats()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  trafficChart?.dispose()
  healthChart?.dispose()
})
</script>

<style scoped>
.network-page {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.network-page > .neo-tabs {
  margin-bottom: 0;
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
  padding: 32px 0;
}

.table-pagination {
  display: flex;
  justify-content: flex-end;
  padding-top: 10px;
}

.form-grid {
  display: grid;
  gap: 0 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.drawer-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.drawer-meta {
  align-items: center;
  color: #64748b;
  display: flex;
  flex-wrap: wrap;
  font-size: 13px;
  gap: 10px;
}

.drawer-meta-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-tabs {
  align-items: center;
  margin-bottom: 0;
}

.drawer-hours {
  margin-left: auto;
}

.chart-card {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 12px 14px;
}

.chart-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.chart-box {
  height: 280px;
  width: 100%;
}

@media (max-width: 760px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>