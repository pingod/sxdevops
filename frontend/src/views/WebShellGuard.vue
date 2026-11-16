<template>
  <div class="fade-in webshell-guard-page workbench-page-shell">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon"><el-icon><Monitor /></el-icon></span>
        <h2>WebShell 防护</h2>
        <p class="page-inline-desc">主机 / 容器 / K8s 终端的高危命令拦截、告警与操作审计</p>
      </div>
    </section>

    <div class="audit-grid">
      <div class="audit-card audit-card--inline">
        <div class="stat-value">{{ rules.length }}</div>
        <div class="stat-label">规则总数</div>
      </div>
      <div class="audit-card audit-card--inline audit-card--success">
        <div class="stat-value">{{ enabledCount }}</div>
        <div class="stat-label">启用中</div>
      </div>
      <div class="audit-card audit-card--inline audit-card--danger">
        <div class="stat-value">{{ blockCount }}</div>
        <div class="stat-label">拦截规则</div>
      </div>
      <div class="audit-card audit-card--inline audit-card--warning">
        <div class="stat-value">{{ warnCount }}</div>
        <div class="stat-label">告警规则</div>
      </div>
    </div>

    <div class="neo-tabs theme-blue">
      <button type="button" class="neo-tab-btn" :class="{ active: tab === 'rules' }" @click="tab = 'rules'">
        <el-icon><SetUp /></el-icon>拦截规则
      </button>
      <button type="button" class="neo-tab-btn" :class="{ active: tab === 'audit' }" @click="switchToAudit">
        <el-icon><Document /></el-icon>防护审计
      </button>
    </div>

    <div v-if="tab === 'rules'" class="workbench-card">
      <div class="section-toolbar">
        <div class="toolbar-head">
          <span class="toolbar-title">命令规则</span>
          <span class="toolbar-desc">回车提交时按优先级匹配；拦截动作会清掉远端命令使其不执行。</span>
        </div>
        <div class="workbench-card-actions">
          <el-button v-if="canManage" type="primary" @click="openRuleDialog()">
            <el-icon><Plus /></el-icon>新建规则
          </el-button>
        </div>
      </div>
      <div class="workbench-toolbar workbench-toolbar--history">
        <div class="workbench-toolbar-left">
          <el-input v-model="testCommand" clearable placeholder="输入命令测试命中规则，如 rm -rf /" style="width: 320px" @keyup.enter="runTest" />
          <el-button :loading="testing" @click="runTest">
            <el-icon><Aim /></el-icon>测试
          </el-button>
          <el-tag v-if="testResult" :type="testResult.matched ? (testResult.rule.action === 'block' ? 'danger' : 'warning') : 'success'" effect="light">
            {{ testResult.matched ? `命中「${testResult.rule.name}」· ${testResult.rule.action_display}` : '未命中任何规则' }}
          </el-tag>
        </div>
        <div class="workbench-toolbar-right">
          <el-button class="filter-refresh-btn" :loading="loading" @click="fetchRules">
            <el-icon><RefreshRight /></el-icon>刷新
          </el-button>
        </div>
      </div>
      <el-table v-loading="loading" :data="rules" size="default" class="webshell-table">
        <el-table-column prop="name" label="规则名称" min-width="140">
          <template #default="{ row }">
            {{ row.name }}
            <el-tag v-if="row.is_builtin" size="small" effect="plain" type="info">内置</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="pattern" label="匹配正则" min-width="220" show-overflow-tooltip>
          <template #default="{ row }"><code class="pattern-code">{{ row.pattern }}</code></template>
        </el-table-column>
        <el-table-column label="动作" width="100">
          <template #default="{ row }">
            <el-tag :type="actionTag(row.action)" size="small" effect="light">{{ row.action_display }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="severity_display" label="级别" width="80" />
        <el-table-column prop="priority" label="优先级" width="80" align="right" />
        <el-table-column label="启用" width="80">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" :disabled="!canManage" @change="toggleRule(row, $event)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="!canManage" @click="openRuleDialog(row)">编辑</el-button>
            <el-button link type="danger" size="small" :disabled="!canManage || row.is_builtin" @click="removeRule(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div v-else class="workbench-card">
      <div class="section-toolbar">
        <div class="toolbar-head">
          <span class="toolbar-title">防护审计</span>
          <span class="toolbar-desc">终端会话、命令拦截、告警与审计记录。</span>
        </div>
        <div class="workbench-card-actions">
          <el-select v-model="auditAction" clearable placeholder="事件类型" style="width: 150px" @change="fetchAudit">
            <el-option label="命令拦截" value="webshell_block" />
            <el-option label="命令告警" value="webshell_warn" />
            <el-option label="命令审计" value="webshell_audit" />
            <el-option label="打开终端" value="webshell_connect" />
            <el-option label="关闭终端" value="webshell_disconnect" />
          </el-select>
          <el-button class="filter-refresh-btn" :loading="auditLoading" @click="fetchAudit">
            <el-icon><RefreshRight /></el-icon>刷新
          </el-button>
        </div>
      </div>
      <el-table v-loading="auditLoading" :data="auditEvents" size="default" class="webshell-table">
        <el-table-column label="时间" min-width="150">
          <template #default="{ row }">{{ formatTime(row.occurred_at) }}</template>
        </el-table-column>
        <el-table-column label="事件" width="110">
          <template #default="{ row }">
            <el-tag :type="auditTag(row.action)" size="small" effect="light">{{ auditLabel(row.action) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
        <el-table-column prop="command" label="命令" min-width="160" show-overflow-tooltip>
          <template #default="{ row }"><code v-if="row.command" class="pattern-code">{{ row.command }}</code><span v-else>—</span></template>
        </el-table-column>
        <el-table-column prop="actor_username" label="操作人" width="110" />
        <el-table-column prop="resource_name" label="资源" min-width="130" show-overflow-tooltip />
        <template #empty>
          <div class="table-empty">暂无防护审计记录。</div>
        </template>
      </el-table>
      <div class="table-pagination">
        <el-pagination v-model:current-page="auditPage" :page-size="20" :total="auditTotal" layout="total, prev, pager, next" @current-change="fetchAudit" />
      </div>
    </div>

    <el-dialog v-model="ruleDialogVisible" :title="ruleForm.id ? '编辑规则' : '新建规则'" width="600px" top="5vh" append-to-body class="workbench-edit-dialog">
      <el-form ref="ruleFormRef" :model="ruleForm" :rules="ruleRules" label-position="top">
        <el-form-item label="规则名称" prop="name">
          <el-input v-model="ruleForm.name" maxlength="100" placeholder="如 删除根目录" />
        </el-form-item>
        <el-form-item label="匹配正则" prop="pattern">
          <el-input v-model="ruleForm.pattern" type="textarea" :rows="2" placeholder="Python 正则，如 \brm\s+-rf\s+/" />
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="动作" prop="action">
            <el-select v-model="ruleForm.action" style="width: 100%">
              <el-option label="拦截（阻止执行）" value="block" />
              <el-option label="告警放行" value="warn" />
              <el-option label="仅审计" value="audit" />
            </el-select>
          </el-form-item>
          <el-form-item label="级别" prop="severity">
            <el-select v-model="ruleForm.severity" style="width: 100%">
              <el-option label="信息" value="info" />
              <el-option label="警告" value="warning" />
              <el-option label="严重" value="critical" />
            </el-select>
          </el-form-item>
          <el-form-item label="优先级（小者优先）" prop="priority">
            <el-input-number v-model="ruleForm.priority" :min="1" :max="9999" style="width: 100%" />
          </el-form-item>
          <el-form-item label="启用">
            <el-switch v-model="ruleForm.enabled" />
          </el-form-item>
        </div>
        <el-form-item label="描述">
          <el-input v-model="ruleForm.description" type="textarea" :rows="2" maxlength="255" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveRule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Aim, Document, Monitor, Plus, RefreshRight, SetUp } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import {
  createWebShellRule, deleteWebShellRule, getWebShellAudit, listWebShellRules,
  patchWebShellRule, testWebShellCommand, updateWebShellRule,
} from '@/api/modules/webshell'

const authStore = useAuthStore()
const canManage = authStore.hasPermission('ops.webshell.rule.manage')

const tab = ref('rules')
const loading = ref(false)
const rules = ref([])
const testCommand = ref('')
const testing = ref(false)
const testResult = ref(null)

const auditLoading = ref(false)
const auditEvents = ref([])
const auditTotal = ref(0)
const auditPage = ref(1)
const auditAction = ref('')

const ruleDialogVisible = ref(false)
const saving = ref(false)
const ruleFormRef = ref()
const ruleForm = reactive({})
const ruleRules = {
  name: [{ required: true, message: '请输入规则名称', trigger: 'blur' }],
  pattern: [{ required: true, message: '请输入匹配正则', trigger: 'blur' }],
}

const enabledCount = computed(() => rules.value.filter(r => r.enabled).length)
const blockCount = computed(() => rules.value.filter(r => r.action === 'block').length)
const warnCount = computed(() => rules.value.filter(r => r.action === 'warn').length)

function actionTag(action) {
  return { block: 'danger', warn: 'warning', audit: 'info' }[action] || 'info'
}
function auditTag(action) {
  return { webshell_block: 'danger', webshell_warn: 'warning', webshell_audit: 'info', webshell_connect: 'success', webshell_disconnect: 'info' }[action] || 'info'
}
function auditLabel(action) {
  return { webshell_block: '拦截', webshell_warn: '告警', webshell_audit: '审计', webshell_connect: '打开', webshell_disconnect: '关闭', webshell_rule_create: '建规则', webshell_rule_update: '改规则', webshell_rule_delete: '删规则' }[action] || action
}
function formatTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

async function fetchRules() {
  loading.value = true
  try {
    const data = await listWebShellRules()
    rules.value = data.results || []
  } finally {
    loading.value = false
  }
}

async function runTest() {
  if (!testCommand.value.trim()) return
  testing.value = true
  try {
    testResult.value = await testWebShellCommand(testCommand.value.trim())
  } finally {
    testing.value = false
  }
}

function openRuleDialog(row) {
  Object.assign(ruleForm, {
    id: row?.id || null,
    name: row?.name || '',
    pattern: row?.pattern || '',
    action: row?.action || 'block',
    severity: row?.severity || 'warning',
    priority: row?.priority ?? 100,
    enabled: row?.enabled ?? true,
    description: row?.description || '',
  })
  ruleDialogVisible.value = true
}

async function saveRule() {
  await ruleFormRef.value.validate()
  saving.value = true
  try {
    const payload = { ...ruleForm }
    delete payload.id
    if (ruleForm.id) {
      await updateWebShellRule(ruleForm.id, payload)
      ElMessage.success('规则已更新')
    } else {
      await createWebShellRule(payload)
      ElMessage.success('规则已创建')
    }
    ruleDialogVisible.value = false
    fetchRules()
  } finally {
    saving.value = false
  }
}

async function toggleRule(row, enabled) {
  await patchWebShellRule(row.id, { enabled })
  ElMessage.success(enabled ? '规则已启用' : '规则已停用')
  fetchRules()
}

async function removeRule(row) {
  await ElMessageBox.confirm(`确认删除规则 ${row.name}？`, '删除规则', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  await deleteWebShellRule(row.id)
  ElMessage.success('规则已删除')
  fetchRules()
}

function switchToAudit() {
  tab.value = 'audit'
  fetchAudit()
}

async function fetchAudit() {
  auditLoading.value = true
  try {
    const params = { page: auditPage.value }
    if (auditAction.value) params.action = auditAction.value
    const data = await getWebShellAudit(params)
    auditEvents.value = data.results || []
    auditTotal.value = data.count || 0
  } finally {
    auditLoading.value = false
  }
}

onMounted(fetchRules)
</script>

<style scoped>
.webshell-guard-page {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.webshell-guard-page > .neo-tabs {
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

.webshell-table {
  width: 100%;
}

.pattern-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.table-empty {
  color: #94a3b8;
  font-size: 13px;
  padding: 32px 0;
  text-align: center;
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

@media (max-width: 760px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>