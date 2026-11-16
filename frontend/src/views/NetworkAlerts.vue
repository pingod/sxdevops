<template>
  <div class="fade-in network-page workbench-page-shell">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon"><el-icon><Bell /></el-icon></span>
        <h2>网络告警</h2>
        <p class="page-inline-desc">阈值规则、活动与历史告警，复用平台统一通知、升级与静默</p>
      </div>
    </section>

    <div class="audit-grid">
      <button type="button" class="audit-card audit-card--inline audit-card--action" :class="{ 'audit-card--danger': stats.active > 0, 'is-active': tab === 'active' && !alertFilters.level }" @click="applyStat('')">
        <div class="stat-value">{{ stats.active }}</div>
        <div class="stat-label">活动告警</div>
      </button>
      <button type="button" class="audit-card audit-card--inline audit-card--danger audit-card--action" :class="{ 'is-active': tab === 'active' && alertFilters.level === 'critical' }" @click="applyStat('critical')">
        <div class="stat-value">{{ stats.critical }}</div>
        <div class="stat-label">严重</div>
      </button>
      <button type="button" class="audit-card audit-card--inline audit-card--warning audit-card--action" :class="{ 'is-active': tab === 'active' && alertFilters.level === 'warning' }" @click="applyStat('warning')">
        <div class="stat-value">{{ stats.warning }}</div>
        <div class="stat-label">警告</div>
      </button>
      <div class="audit-card audit-card--inline">
        <div class="stat-value">{{ stats.acknowledged }}</div>
        <div class="stat-label">已确认</div>
      </div>
    </div>

    <div class="neo-tabs theme-blue">
      <button type="button" class="neo-tab-btn" :class="{ active: tab === 'active' }" @click="switchTab('active')">
        <el-icon><Bell /></el-icon>活动告警
      </button>
      <button type="button" class="neo-tab-btn" :class="{ active: tab === 'history' }" @click="switchTab('history')">
        <el-icon><Clock /></el-icon>历史告警
      </button>
      <button type="button" class="neo-tab-btn" :class="{ active: tab === 'rules' }" @click="switchTab('rules')">
        <el-icon><Setting /></el-icon>告警规则
      </button>
    </div>

    <div v-if="isAlertTab" class="workbench-card">
      <div class="section-toolbar">
        <div class="toolbar-head">
          <span class="toolbar-title">{{ tab === 'active' ? '活动告警' : '历史告警' }}</span>
          <span class="toolbar-desc">{{ tab === 'active' ? '采集器每轮评估阈值，越限持续达到规则时长即触发，恢复后自动关闭。' : '已恢复与已关闭的网络告警留存于此，便于复盘。' }}</span>
        </div>
      </div>
      <div class="workbench-toolbar workbench-toolbar--history">
        <div class="workbench-toolbar-left">
          <el-input v-model="alertFilters.search" clearable placeholder="搜索标题 / 对象" style="width: 220px" @keyup.enter="reloadAlerts" @clear="reloadAlerts" />
          <el-select v-model="alertFilters.level" clearable placeholder="级别" style="width: 104px" @change="reloadAlerts">
            <el-option v-for="item in severityOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-if="tab === 'history'" v-model="alertFilters.status" placeholder="状态" style="width: 116px" @change="reloadAlerts">
            <el-option label="已恢复" value="resolved" />
            <el-option label="已关闭" value="closed" />
          </el-select>
        </div>
        <div class="workbench-toolbar-right">
          <el-button class="filter-refresh-btn" :loading="alertsLoading" @click="reloadAlerts">
            <el-icon><RefreshRight /></el-icon>刷新
          </el-button>
        </div>
      </div>
      <el-table v-loading="alertsLoading" :data="alerts" size="default" class="network-table">
        <el-table-column label="级别" width="80">
          <template #default="{ row }">
            <el-tag :type="levelTag(row.level)" size="small" effect="light">{{ row.level_display }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="告警" min-width="220">
          <template #default="{ row }">
            <div class="device-name">{{ row.title }}</div>
            <div class="device-sub">{{ row.resource }}</div>
          </template>
        </el-table-column>
        <el-table-column label="指标" min-width="130">
          <template #default="{ row }">{{ metricLabel(row.metric_name) }}</template>
        </el-table-column>
        <el-table-column v-if="tab === 'history'" label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)" size="small" effect="light">{{ row.status_display }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="occurrence_count" label="发生次数" width="90" align="right" />
        <el-table-column label="触发时间" min-width="150">
          <template #default="{ row }">{{ formatTime(row.starts_at) }}</template>
        </el-table-column>
        <el-table-column v-if="tab === 'history'" label="恢复时间" min-width="150">
          <template #default="{ row }">{{ formatTime(row.ends_at) }}</template>
        </el-table-column>
        <el-table-column v-else label="确认" width="90">
          <template #default="{ row }">
            <el-tag :type="row.is_acknowledged ? 'success' : 'info'" size="small" effect="light">{{ row.is_acknowledged ? '已确认' : '未确认' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button v-if="tab === 'active' && !row.is_acknowledged" link type="primary" size="small" :loading="rowAction === `ack-${row.id}`" :disabled="!canManage" @click="acknowledge(row)">确认</el-button>
            <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="table-empty">{{ tab === 'active' ? '当前无活动告警，网络运行正常。' : '暂无历史告警。' }}</div>
        </template>
      </el-table>
      <div class="table-pagination">
        <el-pagination v-model:current-page="alertPage" :page-size="20" :total="alertTotal" layout="total, prev, pager, next" @current-change="fetchAlerts" />
      </div>
    </div>

    <div v-else class="workbench-card">
      <div class="section-toolbar">
        <div class="toolbar-head">
          <span class="toolbar-title">告警规则</span>
          <span class="toolbar-desc">内置规则覆盖常见阈值，可调整或停用；自定义规则按设备或接口生效。</span>
        </div>
        <div class="workbench-card-actions">
          <el-button v-if="canManage" type="primary" @click="openRuleDialog()">
            <el-icon><Plus /></el-icon>新建规则
          </el-button>
        </div>
      </div>
      <div class="workbench-toolbar workbench-toolbar--history">
        <div class="workbench-toolbar-left">
          <el-input v-model="ruleFilters.search" clearable placeholder="搜索规则名称" style="width: 220px" @keyup.enter="reloadRules" @clear="reloadRules" />
          <el-select v-model="ruleFilters.target" clearable placeholder="对象" style="width: 104px" @change="reloadRules">
            <el-option v-for="item in targetOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="ruleFilters.enabled" clearable placeholder="启用" style="width: 104px" @change="reloadRules">
            <el-option label="启用" value="true" />
            <el-option label="停用" value="false" />
          </el-select>
        </div>
        <div class="workbench-toolbar-right">
          <el-button class="filter-refresh-btn" :loading="rulesLoading" @click="reloadRules">
            <el-icon><RefreshRight /></el-icon>刷新
          </el-button>
        </div>
      </div>
      <el-table v-loading="rulesLoading" :data="rules" size="default" class="network-table">
        <el-table-column label="规则名称" min-width="180">
          <template #default="{ row }">
            <span class="device-name">{{ row.name }}</span>
            <el-tag v-if="row.is_builtin" size="small" type="info" effect="plain" class="builtin-tag">内置</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="target_display" label="对象" width="80" />
        <el-table-column prop="metric_display" label="指标" min-width="140" />
        <el-table-column label="条件" width="100">
          <template #default="{ row }">{{ row.operator_display }} {{ row.threshold }}</template>
        </el-table-column>
        <el-table-column label="持续" width="90">
          <template #default="{ row }">{{ row.for_seconds ? `${row.for_seconds}s` : '即时' }}</template>
        </el-table-column>
        <el-table-column label="级别" width="80">
          <template #default="{ row }">
            <el-tag :type="levelTag(row.severity)" size="small" effect="light">{{ row.severity_display }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="限定设备" min-width="120">
          <template #default="{ row }">{{ row.device_name || '全部设备' }}</template>
        </el-table-column>
        <el-table-column label="启用" width="80">
          <template #default="{ row }">
            <el-switch v-model="row.enabled" :disabled="!canManage" @change="value => toggleRule(row, value)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="!canManage" @click="openRuleDialog(row)">编辑</el-button>
            <el-button link type="danger" size="small" :disabled="!canManage || row.is_builtin" @click="removeRule(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="table-empty">暂无告警规则，点击右上角「新建规则」添加。</div>
        </template>
      </el-table>
      <div class="table-pagination">
        <el-pagination v-model:current-page="rulePage" :page-size="20" :total="ruleTotal" layout="total, prev, pager, next" @current-change="fetchRules" />
      </div>
    </div>

    <el-dialog v-model="ruleDialogVisible" :title="ruleForm.id ? '编辑规则' : '新建规则'" width="640px" top="5vh" append-to-body class="workbench-edit-dialog">
      <el-form ref="ruleFormRef" :model="ruleForm" :rules="ruleRules" label-position="top">
        <div class="form-grid">
          <el-form-item label="规则名称" prop="name">
            <el-input v-model="ruleForm.name" placeholder="如 核心交换机 CPU 过高" maxlength="100" />
          </el-form-item>
          <el-form-item label="对象类型" prop="target">
            <el-radio-group v-model="ruleForm.target" @change="onTargetChange">
              <el-radio-button value="device">设备</el-radio-button>
              <el-radio-button value="interface">接口</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="指标" prop="metric">
            <el-select v-model="ruleForm.metric" style="width: 100%">
              <el-option v-for="item in metricOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="严重级" prop="severity">
            <el-select v-model="ruleForm.severity" style="width: 100%">
              <el-option v-for="item in severityOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="比较符" prop="operator">
            <el-select v-model="ruleForm.operator" style="width: 100%">
              <el-option v-for="item in operatorOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="阈值" prop="threshold">
            <el-input-number v-model="ruleForm.threshold" :precision="2" :step="1" style="width: 100%" />
          </el-form-item>
          <el-form-item label="持续时长（秒）" prop="for_seconds">
            <el-input-number v-model="ruleForm.for_seconds" :min="0" :max="86400" style="width: 100%" />
          </el-form-item>
          <el-form-item label="限定设备">
            <el-select v-model="ruleForm.device" clearable filterable placeholder="全部设备" style="width: 100%">
              <el-option v-for="item in deviceOptions" :key="item.id" :label="item.name" :value="item.id" />
            </el-select>
          </el-form-item>
        </div>
        <div class="form-hint">持续时长用于防抖：指标连续越限达到该时长才触发，0 表示立即触发。离线 / 接口中断指标建议设为 0。</div>
        <el-form-item label="描述">
          <el-input v-model="ruleForm.description" type="textarea" :rows="2" maxlength="255" />
        </el-form-item>
        <el-form-item label="启用规则">
          <el-switch v-model="ruleForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveRule">保存</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" :title="detailAlert ? detailAlert.title : ''" size="560px" append-to-body>
      <div v-if="detailAlert" class="detail-body">
        <div class="detail-tags">
          <el-tag :type="levelTag(detailAlert.level)" size="small" effect="light">{{ detailAlert.level_display }}</el-tag>
          <el-tag :type="statusTag(detailAlert.status)" size="small" effect="light">{{ detailAlert.status_display }}</el-tag>
          <el-tag v-if="detailAlert.is_acknowledged" type="success" size="small" effect="light">已确认</el-tag>
        </div>
        <p class="detail-message">{{ detailAlert.message }}</p>
        <div class="detail-grid">
          <div class="detail-item"><span class="detail-key">对象</span><span class="detail-val">{{ detailAlert.resource }}</span></div>
          <div class="detail-item"><span class="detail-key">指标</span><span class="detail-val">{{ metricLabel(detailAlert.metric_name) }}</span></div>
          <div class="detail-item"><span class="detail-key">发生次数</span><span class="detail-val">{{ detailAlert.occurrence_count }}</span></div>
          <div class="detail-item"><span class="detail-key">来源</span><span class="detail-val">{{ detailAlert.source }}</span></div>
          <div class="detail-item"><span class="detail-key">首次触发</span><span class="detail-val">{{ formatTime(detailAlert.starts_at) }}</span></div>
          <div class="detail-item"><span class="detail-key">最近发生</span><span class="detail-val">{{ formatTime(detailAlert.last_received_at) }}</span></div>
          <div class="detail-item"><span class="detail-key">恢复时间</span><span class="detail-val">{{ formatTime(detailAlert.ends_at) }}</span></div>
          <div class="detail-item"><span class="detail-key">确认人</span><span class="detail-val">{{ detailAlert.acknowledged_by || '—' }}</span></div>
        </div>
        <div class="detail-section">
          <div class="detail-section-title">阈值与取值</div>
          <div class="detail-grid">
            <div class="detail-item"><span class="detail-key">比较符</span><span class="detail-val">{{ detailAlert.annotations?.operator || '—' }}</span></div>
            <div class="detail-item"><span class="detail-key">阈值</span><span class="detail-val">{{ detailAlert.annotations?.threshold ?? '—' }}</span></div>
            <div class="detail-item"><span class="detail-key">当前值</span><span class="detail-val">{{ detailAlert.annotations?.value ?? '—' }}</span></div>
            <div class="detail-item"><span class="detail-key">峰值</span><span class="detail-val">{{ detailAlert.annotations?.peak ?? '—' }}</span></div>
          </div>
        </div>
        <div class="detail-section">
          <div class="detail-section-title">标签</div>
          <div class="detail-labels">
            <el-tag v-for="(value, key) in detailAlert.labels" :key="key" size="small" effect="plain" class="detail-label">{{ key }}: {{ value }}</el-tag>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Bell, Clock, Plus, RefreshRight, Setting } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import {
  acknowledgeNetworkAlert, createNetworkAlertRule, deleteNetworkAlertRule,
  getNetworkOverview, listNetworkAlertRules, listNetworkAlerts,
  listNetworkDevices, patchNetworkAlertRule, updateNetworkAlertRule,
} from '@/api/modules/network'

const authStore = useAuthStore()
const canManage = authStore.hasPermission('network.alert.manage')

const tab = ref('active')
const isAlertTab = computed(() => tab.value !== 'rules')
const stats = ref({ active: 0, critical: 0, warning: 0, acknowledged: 0 })
const rowAction = ref('')

const alerts = ref([])
const alertsLoading = ref(false)
const alertTotal = ref(0)
const alertPage = ref(1)
const alertFilters = reactive({ search: '', level: '', status: 'active' })

const rules = ref([])
const rulesLoading = ref(false)
const ruleTotal = ref(0)
const rulePage = ref(1)
const ruleFilters = reactive({ search: '', target: '', enabled: '' })

const ruleDialogVisible = ref(false)
const saving = ref(false)
const ruleFormRef = ref()
const ruleForm = reactive({})
const deviceOptions = ref([])

const detailVisible = ref(false)
const detailAlert = ref(null)

const targetOptions = [
  { value: 'device', label: '设备' }, { value: 'interface', label: '接口' },
]
const deviceMetricOptions = [
  { value: 'cpu_pct', label: 'CPU 使用率(%)' }, { value: 'mem_pct', label: '内存使用率(%)' },
  { value: 'temperature', label: '温度(℃)' }, { value: 'offline', label: '设备离线' },
]
const interfaceMetricOptions = [
  { value: 'in_util', label: '入向利用率(%)' }, { value: 'out_util', label: '出向利用率(%)' },
  { value: 'in_errors', label: '入向错包增量' }, { value: 'out_errors', label: '出向错包增量' },
  { value: 'down', label: '接口中断' },
]
const operatorOptions = [
  { value: 'gt', label: '>' }, { value: 'gte', label: '>=' }, { value: 'lt', label: '<' }, { value: 'lte', label: '<=' },
]
const severityOptions = [
  { value: 'critical', label: '严重' }, { value: 'warning', label: '警告' }, { value: 'info', label: '信息' },
]
const metricLabelMap = Object.fromEntries([...deviceMetricOptions, ...interfaceMetricOptions].map(item => [item.value, item.label]))
const metricOptions = computed(() => (ruleForm.target === 'interface' ? interfaceMetricOptions : deviceMetricOptions))

const ruleRules = {
  name: [{ required: true, message: '请输入规则名称', trigger: 'blur' }],
  metric: [{ required: true, message: '请选择指标', trigger: 'change' }],
}

function levelTag(level) {
  return { critical: 'danger', warning: 'warning', info: 'info' }[level] || 'info'
}
function statusTag(status) {
  return { active: 'danger', resolved: 'success', closed: 'info', muted: 'warning' }[status] || 'info'
}
function metricLabel(code) {
  return metricLabelMap[code] || code || '—'
}
function formatTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

async function fetchStats() {
  try {
    const data = await getNetworkOverview()
    stats.value = data.alerts || { active: 0, critical: 0, warning: 0, acknowledged: 0 }
  } catch {
    // 统计失败不阻塞列表
  }
}

async function fetchAlerts() {
  alertsLoading.value = true
  try {
    const params = { page: alertPage.value, status: alertFilters.status }
    if (alertFilters.level) params.level = alertFilters.level
    if (alertFilters.search) params.search = alertFilters.search
    const data = await listNetworkAlerts(params)
    alerts.value = data.results || []
    alertTotal.value = data.count || 0
  } finally {
    alertsLoading.value = false
  }
}

function reloadAlerts() {
  alertPage.value = 1
  fetchAlerts()
  fetchStats()
}

async function fetchRules() {
  rulesLoading.value = true
  try {
    const params = { page: rulePage.value }
    for (const [key, value] of Object.entries(ruleFilters)) {
      if (value) params[key] = value
    }
    const data = await listNetworkAlertRules(params)
    rules.value = data.results || []
    ruleTotal.value = data.count || 0
  } finally {
    rulesLoading.value = false
  }
}

function reloadRules() {
  rulePage.value = 1
  fetchRules()
}

function switchTab(value) {
  tab.value = value
  if (value === 'rules') {
    reloadRules()
    return
  }
  alertFilters.level = ''
  alertFilters.status = value === 'active' ? 'active' : 'resolved'
  reloadAlerts()
}

function applyStat(level) {
  tab.value = 'active'
  alertFilters.status = 'active'
  alertFilters.level = level
  reloadAlerts()
}

async function fetchDeviceOptions() {
  const data = await listNetworkDevices()
  deviceOptions.value = data.results || []
}

function openRuleDialog(row) {
  Object.assign(ruleForm, {
    id: row?.id || null,
    name: row?.name || '',
    target: row?.target || 'device',
    metric: row?.metric || 'cpu_pct',
    operator: row?.operator || 'gt',
    threshold: row?.threshold ?? 90,
    severity: row?.severity || 'warning',
    for_seconds: row?.for_seconds ?? 120,
    device: row?.device || null,
    enabled: row?.enabled ?? true,
    description: row?.description || '',
  })
  fetchDeviceOptions()
  ruleDialogVisible.value = true
}

function onTargetChange(target) {
  const options = target === 'interface' ? interfaceMetricOptions : deviceMetricOptions
  if (!options.some(item => item.value === ruleForm.metric)) {
    ruleForm.metric = options[0].value
  }
}

async function saveRule() {
  const valid = await ruleFormRef.value?.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const payload = { ...ruleForm, device: ruleForm.device || null }
    delete payload.id
    if (ruleForm.id) {
      await updateNetworkAlertRule(ruleForm.id, payload)
      ElMessage.success('规则已更新')
    } else {
      await createNetworkAlertRule(payload)
      ElMessage.success('规则已创建，采集器下一轮评估即生效')
    }
    ruleDialogVisible.value = false
    reloadRules()
  } finally {
    saving.value = false
  }
}

async function removeRule(row) {
  try {
    await ElMessageBox.confirm(`确认删除规则 ${row.name}？`, '删除规则', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch {
    return
  }
  try {
    await deleteNetworkAlertRule(row.id)
    ElMessage.success('规则已删除')
    reloadRules()
  } catch (error) {
    ElMessage.error(error?.response?.data?.detail || '删除失败')
  }
}

async function toggleRule(row, value) {
  try {
    await patchNetworkAlertRule(row.id, { enabled: value })
    ElMessage.success(value ? '规则已启用' : '规则已停用')
  } catch (error) {
    row.enabled = !value
    ElMessage.error(error?.response?.data?.detail || '更新失败')
  }
}

async function acknowledge(row) {
  rowAction.value = `ack-${row.id}`
  try {
    const updated = await acknowledgeNetworkAlert(row.id)
    Object.assign(row, updated)
    ElMessage.success('告警已确认')
    fetchStats()
  } catch (error) {
    ElMessage.error(error?.response?.data?.detail || '确认失败')
  } finally {
    rowAction.value = ''
  }
}

function openDetail(row) {
  detailAlert.value = row
  detailVisible.value = true
}

onMounted(() => {
  fetchStats()
  fetchAlerts()
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

.builtin-tag {
  margin-left: 6px;
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

.form-hint {
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
  margin: -4px 0 12px;
}

.detail-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.detail-message {
  background: rgba(36, 91, 219, 0.05);
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  color: #334155;
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
  padding: 10px 12px;
}

.detail-grid {
  display: grid;
  gap: 8px 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.detail-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.detail-key {
  color: #94a3b8;
  font-size: 12px;
}

.detail-val {
  color: #334155;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.detail-section {
  border-top: 1px solid #e5e7eb;
  padding-top: 12px;
}

.detail-section-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
}

.detail-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.detail-label {
  max-width: 100%;
}

@media (max-width: 760px) {
  .form-grid,
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
</style>