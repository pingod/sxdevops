<template>
  <div class="inspection-center">
    <div class="inspection-switch">
      <el-radio-group v-model="activeTab" size="small">
        <el-radio-button v-for="tab in innerTabs" :key="tab.key" :value="tab.key">
          {{ tab.label }}
        </el-radio-button>
      </el-radio-group>
      <div class="inspection-switch__hint">
        <el-icon><InfoFilled /></el-icon>
        <span>巡检只读采集，结论由阈值判定，AI 仅做解读与建议</span>
      </div>
    </div>

    <!-- 概览 -->
    <template v-if="activeTab === 'overview'">
      <div class="audit-grid inspection-stat-grid">
        <div class="audit-card audit-card--inline">
          <div class="stat-value">{{ overview.today_runs }}</div>
          <div class="stat-label">今日巡检</div>
        </div>
        <div class="audit-card audit-card--inline audit-card--warning">
          <div class="stat-value">{{ overview.open_issues }}</div>
          <div class="stat-label">未闭环隐患</div>
        </div>
        <div class="audit-card audit-card--inline audit-card--danger">
          <div class="stat-value">{{ overview.critical_issues }}</div>
          <div class="stat-label">严重隐患</div>
        </div>
        <div class="audit-card audit-card--inline audit-card--success">
          <div class="stat-value">{{ overview.avg_score_7d }}</div>
          <div class="stat-label">7 日平均得分</div>
        </div>
      </div>

      <div class="inspection-overview-grid">
        <div class="glass-card">
          <div class="card-head">
            <span>近 7 日得分趋势</span>
            <el-tag size="small" type="info">满分 100</el-tag>
          </div>
          <div ref="trendChartRef" class="inspection-trend-chart" />
        </div>
        <div class="glass-card">
          <div class="card-head">
            <span>Top 隐患</span>
            <el-button text size="small" @click="activeTab = 'issues'">查看台账</el-button>
          </div>
          <el-table :data="overview.top_issues" size="small" empty-text="暂无未闭环隐患">
            <el-table-column prop="title" label="隐患" min-width="180" show-overflow-tooltip />
            <el-table-column label="级别" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="severityTagType(row.severity)">{{ severityLabel(row.severity) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="occurrences" label="次数" width="70" />
            <el-table-column prop="days_open" label="天数" width="70" />
          </el-table>
        </div>
      </div>
    </template>

    <!-- 巡检计划 -->
    <template v-else-if="activeTab === 'plans'">
      <div class="glass-card">
        <div class="card-head">
          <span>巡检计划</span>
          <div class="head-actions">
            <el-button size="small" @click="openItemCatalog">巡检项</el-button>
            <el-button size="small" type="primary" :disabled="!canManage" @click="openPlanDialog()">新建计划</el-button>
          </div>
        </div>
        <el-table v-loading="planLoading" :data="plans" size="small" empty-text="暂无巡检计划">
          <el-table-column prop="name" label="计划名称" min-width="180" show-overflow-tooltip />
          <el-table-column label="巡检范围" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">{{ scopeSummary(row.scope) }}</template>
          </el-table-column>
          <el-table-column label="巡检项" width="90">
            <template #default="{ row }">{{ (row.item_codes || []).length }}</template>
          </el-table-column>
          <el-table-column label="调度" width="140">
            <template #default="{ row }">{{ scheduleSummary(row) }}</template>
          </el-table-column>
          <el-table-column label="下次执行" width="160">
            <template #default="{ row }">{{ formatTime(row.next_run_at) || '-' }}</template>
          </el-table-column>
          <el-table-column label="上次状态" width="110">
            <template #default="{ row }">
              <el-tag v-if="row.last_status" size="small" :type="severityTagType(row.last_status)">
                {{ runStatusLabel(row.last_status) }}
              </el-tag>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="250" fixed="right">
            <template #default="{ row }">
              <el-button text size="small" :disabled="!canExecute" @click="runPlan(row)">执行</el-button>
              <el-button text size="small" :disabled="!canManage" @click="openPlanDialog(row)">编辑</el-button>
              <el-button text size="small" :disabled="!canManage" @click="togglePlan(row)">
                {{ row.enabled ? '停用' : '启用' }}
              </el-button>
              <el-button text size="small" :disabled="!canManage" @click="removePlan(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <!-- 执行记录 -->
    <template v-else-if="activeTab === 'runs'">
      <div class="glass-card">
        <div class="card-head">
          <span>执行记录</span>
          <div class="head-actions">
            <el-select v-model="runFilters.status" size="small" placeholder="全部状态" clearable style="width: 130px" @change="loadRuns">
              <el-option v-for="item in runStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-button size="small" @click="loadRuns">刷新</el-button>
          </div>
        </div>
        <el-table v-loading="runLoading" :data="runs" size="small" empty-text="暂无执行记录">
          <el-table-column label="时间" width="160">
            <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
          </el-table-column>
          <el-table-column prop="plan_name" label="计划" min-width="160" show-overflow-tooltip />
          <el-table-column label="触发" width="90">
            <template #default="{ row }">{{ row.trigger_source_display }}</template>
          </el-table-column>
          <el-table-column prop="target_count" label="目标" width="70" />
          <el-table-column prop="critical_count" label="严重" width="70" />
          <el-table-column prop="warning_count" label="警告" width="70" />
          <el-table-column prop="score" label="得分" width="70" />
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="severityTagType(row.status)">{{ row.status_display }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="AI" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="aiTagType(row.ai_status)">{{ row.ai_status_display }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="250" fixed="right">
            <template #default="{ row }">
              <el-button text size="small" @click="openRunDetail(row)">详情</el-button>
              <el-button text size="small" :disabled="!canExecute" @click="rerun(row)">重新执行</el-button>
              <el-button text size="small" :disabled="!canAnalyze" @click="analyze(row)">AI 分析</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <!-- 隐患台账 -->
    <template v-else>
      <div class="glass-card">
        <div class="card-head">
          <span>隐患台账</span>
          <div class="head-actions">
            <el-select v-model="issueFilters.status" size="small" placeholder="全部状态" clearable style="width: 130px" @change="loadIssues">
              <el-option v-for="item in issueStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-select v-model="issueFilters.severity" size="small" placeholder="全部级别" clearable style="width: 120px" @change="loadIssues">
              <el-option label="严重" value="critical" />
              <el-option label="警告" value="warning" />
            </el-select>
            <el-button size="small" @click="loadIssues">刷新</el-button>
          </div>
        </div>
        <el-table v-loading="issueLoading" :data="issues" size="small" empty-text="暂无隐患">
          <el-table-column prop="title" label="隐患" min-width="220" show-overflow-tooltip />
          <el-table-column prop="target_name" label="对象" min-width="140" show-overflow-tooltip />
          <el-table-column label="级别" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="severityTagType(row.severity)">{{ row.severity_display }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="issueStatusTagType(row.status)">{{ row.status_display }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="occurrences" label="出现" width="70" />
          <el-table-column prop="days_open" label="天数" width="70" />
          <el-table-column label="最近发现" width="160">
            <template #default="{ row }">{{ formatTime(row.last_seen_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="240" fixed="right">
            <template #default="{ row }">
              <el-button text size="small" @click="openIssueDetail(row)">详情</el-button>
              <el-button text size="small" :disabled="!canManage" @click="setIssueStatus(row, 'acknowledge')">确认</el-button>
              <el-button text size="small" :disabled="!canManage" @click="setIssueStatus(row, 'ignore')">忽略</el-button>
              <el-button text size="small" :disabled="!canManage" @click="setIssueStatus(row, 'resolve')">标记修复</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <!-- 计划编辑 -->
    <el-dialog v-model="planDialogVisible" :title="planForm.id ? '编辑巡检计划' : '新建巡检计划'" class="workbench-edit-dialog" width="980px" top="5vh" destroy-on-close append-to-body>
      <el-form :model="planForm" label-width="96px">
        <div class="inspection-form-section">
          <div class="inspection-form-section__title">基础</div>
          <div class="form-row">
            <el-form-item label="计划名称" class="form-col">
              <el-input v-model="planForm.name" placeholder="例如：生产环境夜间巡检" />
            </el-form-item>
            <el-form-item label="启用" class="form-col">
              <el-switch v-model="planForm.enabled" />
              <span class="inspection-inline-hint">AI 解读</span>
              <el-switch v-model="planForm.ai_analysis_enabled" />
            </el-form-item>
          </div>
          <el-form-item label="说明">
            <el-input v-model="planForm.description" placeholder="写明巡检目的、覆盖范围与执行窗口" />
          </el-form-item>
        </div>

        <div class="inspection-form-section">
          <div class="inspection-form-section__title">范围</div>
          <div class="form-row">
            <el-form-item label="主机环境" class="form-col">
              <el-select v-model="planForm.hostEnvironmentIds" multiple collapse-tags placeholder="全部环境" style="width: 100%">
                <el-option v-for="item in environmentOptions" :key="item.id" :label="item.name" :value="item.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="主机系统" class="form-col">
              <el-select v-model="planForm.hostSystemIds" multiple collapse-tags placeholder="全部系统" style="width: 100%">
                <el-option v-for="item in systemOptions" :key="item.id" :label="item.name" :value="item.id" />
              </el-select>
            </el-form-item>
          </div>
          <el-form-item label="主机资源">
            <el-select v-model="planForm.hostResourceIds" multiple filterable collapse-tags placeholder="不选则按环境/系统范围匹配" style="width: 100%">
              <el-option v-for="item in hostResourceOptions" :key="item.id" :label="`${item.name}${item.ip_address ? ` (${item.ip_address})` : ''}`" :value="item.id" />
            </el-select>
          </el-form-item>
          <div class="form-row">
            <el-form-item label="K8s 集群" class="form-col">
              <el-select v-model="planForm.clusterIds" multiple collapse-tags placeholder="不选则不巡检 K8s" style="width: 100%">
                <el-option v-for="item in clusterOptions" :key="item.id" :label="item.name" :value="item.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="命名空间" class="form-col">
              <el-input v-model="planForm.namespaceText" placeholder="多个用逗号分隔，留空表示全部" />
            </el-form-item>
          </div>
          <el-form-item label="中间件类型">
            <el-select v-model="planForm.middlewareTypeCodes" multiple collapse-tags placeholder="不选则不巡检中间件" style="width: 100%">
              <el-option v-for="item in middlewareTypeOptions" :key="item.code" :label="item.name" :value="item.code" />
            </el-select>
          </el-form-item>
        </div>

        <div class="inspection-form-section">
          <div class="inspection-form-section__title">
            巡检项
            <el-button text size="small" type="primary" :disabled="!canAnalyze" @click="recommendItems">AI 推荐巡检项</el-button>
          </div>
          <div v-for="group in itemGroups" :key="group.category" class="inspection-item-group">
            <div class="inspection-item-group__title">{{ group.label }}</div>
            <el-checkbox-group v-model="planForm.item_codes">
              <el-checkbox v-for="item in group.items" :key="item.code" :value="item.code" :label="item.code">
                {{ item.name }}<span class="inspection-item-hint">{{ thresholdSummary(item.threshold_config) }}</span>
              </el-checkbox>
            </el-checkbox-group>
          </div>
        </div>

        <div class="inspection-form-section">
          <div class="inspection-form-section__title">调度</div>
          <div class="form-row">
            <el-form-item label="调度方式" class="form-col">
              <el-select v-model="planForm.schedule_type" style="width: 100%">
                <el-option label="仅手动" value="manual" />
                <el-option label="单次" value="once" />
                <el-option label="间隔" value="interval" />
                <el-option label="Cron" value="cron" />
              </el-select>
            </el-form-item>
            <el-form-item label="时区" class="form-col">
              <el-input v-model="planForm.timezone" />
            </el-form-item>
          </div>
          <div v-if="planForm.schedule_type === 'cron'" class="form-row">
            <el-form-item label="Cron" class="form-col">
              <el-input v-model="planForm.cron_expression" placeholder="例如：0 2 * * *" />
            </el-form-item>
            <el-form-item label="下次执行" class="form-col">
              <el-button size="small" :disabled="!planForm.id" @click="previewRuns">预览下次执行</el-button>
              <span class="inspection-inline-hint">{{ previewText }}</span>
            </el-form-item>
          </div>
          <div v-else-if="planForm.schedule_type === 'interval'" class="form-row">
            <el-form-item label="间隔秒数" class="form-col">
              <el-input-number v-model="planForm.interval_seconds" :min="60" :step="60" style="width: 100%" />
            </el-form-item>
          </div>
          <div v-else-if="planForm.schedule_type === 'once'" class="form-row">
            <el-form-item label="执行时间" class="form-col">
              <el-date-picker v-model="planForm.run_at" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" style="width: 100%" />
            </el-form-item>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="planDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="planSaving" @click="savePlan">保存</el-button>
      </template>
    </el-dialog>

    <!-- 巡检项目录 -->
    <el-dialog v-model="itemDialogVisible" title="巡检项目录" class="workbench-edit-dialog" width="900px" top="6vh" destroy-on-close append-to-body>
      <div v-for="group in itemGroups" :key="group.category" class="inspection-item-group">
        <div class="inspection-item-group__title">{{ group.label }}</div>
        <el-table :data="group.items" size="small">
          <el-table-column prop="name" label="巡检项" min-width="160" />
          <el-table-column label="阈值" min-width="200">
            <template #default="{ row }">{{ thresholdSummary(row.threshold_config) }}</template>
          </el-table-column>
          <el-table-column label="权重" width="130">
            <template #default="{ row }">
              <el-input-number v-model="row.weight" :min="1" :max="100" size="small" :disabled="!canManage" @change="saveItem(row)" />
            </template>
          </el-table-column>
          <el-table-column label="启用" width="90">
            <template #default="{ row }">
              <el-switch v-model="row.is_enabled" :disabled="!canManage" @change="saveItem(row)" />
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>

    <!-- 执行详情 -->
    <el-drawer v-model="runDrawerVisible" :title="runDetail ? `巡检详情 · ${runDetail.plan_name}` : '巡检详情'" size="68%">
      <div v-if="runDetail" class="inspection-drawer">
        <div class="inspection-chip-row">
          <el-tag size="small" :type="severityTagType(runDetail.status)">{{ runDetail.status_display }}</el-tag>
          <el-tag size="small" type="info">得分 {{ runDetail.score }}</el-tag>
          <el-tag size="small" type="danger">严重 {{ runDetail.critical_count }}</el-tag>
          <el-tag size="small" type="warning">警告 {{ runDetail.warning_count }}</el-tag>
          <el-tag size="small" type="success">正常 {{ runDetail.ok_count }}</el-tag>
          <el-tag size="small">未知 {{ runDetail.unknown_count }}</el-tag>
        </div>
        <div class="inspection-drawer__summary">{{ runDetail.summary }}</div>

        <div class="inspection-drawer__actions">
          <el-button size="small" :disabled="!canExecute" @click="rerun(runDetail)">重新执行</el-button>
          <el-button size="small" :disabled="!canAnalyze" @click="analyze(runDetail)">AI 分析</el-button>
          <el-button size="small" @click="copyReport">复制报告</el-button>
          <el-button size="small" @click="downloadReport">下载 .md</el-button>
        </div>

        <div v-if="runDetail.ai_status !== 'none'" class="inspection-ai-panel">
          <div class="inspection-ai-panel__title">AI 解读</div>
          <template v-if="runDetail.ai_status === 'success'">
            <div class="inspection-ai-panel__summary">{{ runDetail.ai_summary }}</div>
            <ul v-if="(runDetail.ai_payload?.risks || []).length" class="inspection-ai-panel__list">
              <li v-for="(risk, index) in runDetail.ai_payload.risks" :key="index">
                <el-tag size="small" :type="severityTagType(risk.severity)">{{ severityLabel(risk.severity) }}</el-tag>
                <strong>{{ risk.title }}</strong>
                <span class="inspection-muted">{{ risk.evidence }}</span>
                <div class="inspection-advice">{{ risk.advice }}</div>
              </li>
            </ul>
            <div v-if="runDetail.ai_payload?.trend" class="inspection-muted">趋势：{{ runDetail.ai_payload.trend }}</div>
            <ul v-if="(runDetail.ai_payload?.next_actions || []).length" class="inspection-ai-panel__list">
              <li v-for="(action, index) in runDetail.ai_payload.next_actions" :key="`action-${index}`">{{ action }}</li>
            </ul>
          </template>
          <template v-else>
            <div class="inspection-muted">{{ runDetail.ai_error || 'AI 分析未完成' }}</div>
            <el-button size="small" :disabled="!canAnalyze" @click="analyze(runDetail, true)">重新分析</el-button>
          </template>
        </div>

        <div v-for="group in runGroups" :key="group.key" class="inspection-run-group">
          <div class="inspection-run-group__title">{{ group.name }}<span class="inspection-muted">{{ group.ip }}</span></div>
          <el-table :data="group.rows" size="small">
            <el-table-column prop="item_name" label="巡检项" min-width="150" />
            <el-table-column label="级别" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="severityTagType(row.severity)">{{ row.severity_display }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="value" label="当前值" width="110" />
            <el-table-column prop="threshold" label="阈值" min-width="150" show-overflow-tooltip />
            <el-table-column prop="message" label="说明" min-width="200" show-overflow-tooltip />
          </el-table>
        </div>
      </div>
    </el-drawer>

    <!-- 隐患详情 -->
    <el-drawer v-model="issueDrawerVisible" :title="issueDetail ? issueDetail.title : '隐患详情'" size="46%">
      <div v-if="issueDetail" class="inspection-drawer">
        <div class="inspection-chip-row">
          <el-tag size="small" :type="severityTagType(issueDetail.severity)">{{ issueDetail.severity_display }}</el-tag>
          <el-tag size="small" :type="issueStatusTagType(issueDetail.status)">{{ issueDetail.status_display }}</el-tag>
          <el-tag size="small" type="info">出现 {{ issueDetail.occurrences }} 次</el-tag>
          <el-tag size="small" type="info">持续 {{ issueDetail.days_open }} 天</el-tag>
        </div>
        <div class="inspection-drawer__summary">{{ issueDetail.target_name }} · {{ issueDetail.item_name }}</div>
        <pre class="inspection-pre">{{ issueDetail.detail }}</pre>
        <div class="inspection-ai-panel__title">处置建议</div>
        <pre class="inspection-pre">{{ issueDetail.ai_advice || '暂无建议' }}</pre>
        <el-button size="small" :disabled="!issueDetail.ai_advice" @click="copyText(issueDetail.ai_advice)">复制建议</el-button>
        <div class="inspection-drawer__actions">
          <el-button size="small" :disabled="!issueDetail.last_run" @click="openRunById(issueDetail.last_run)">查看关联巡检</el-button>
          <el-button size="small" :disabled="!canManage" @click="setIssueStatus(issueDetail, 'acknowledge')">确认</el-button>
          <el-button size="small" :disabled="!canManage" @click="setIssueStatus(issueDetail, 'resolve')">标记修复</el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { InfoFilled } from '@element-plus/icons-vue'
import echarts from '@/lib/echarts'
import { resolveThemeColor, THEME_CHANGE_EVENT, theme } from '@/theme'
import { useRouteTabState } from '@/composables/useRouteTabState'
import { useAuthStore } from '@/stores/auth'
import { getTaskResourceOptions } from '@/api/modules/ops'
import { getK8sClusters } from '@/api/modules/container'
import { getCITypes } from '@/api/modules/cmdb'
import {
  analyzeInspectionRun,
  createInspectionPlan,
  deleteInspectionPlan,
  getInspectionIssues,
  getInspectionItems,
  getInspectionOverview,
  getInspectionPlans,
  getInspectionReport,
  getInspectionRun,
  getInspectionRuns,
  previewInspectionPlanRuns,
  recommendInspectionItems,
  rerunInspectionRun,
  runInspectionPlanNow,
  toggleInspectionPlan,
  updateInspectionIssueStatus,
  updateInspectionItem,
  updateInspectionPlan,
} from '@/api/modules/inspection'

const props = defineProps({
  resourceTree: {
    type: Array,
    default: () => [],
  },
})

const innerTabs = [
  { key: 'overview', label: '概览' },
  { key: 'plans', label: '巡检计划' },
  { key: 'runs', label: '执行记录' },
  { key: 'issues', label: '隐患台账' },
]

const runStatusOptions = [
  { label: '正常', value: 'success' },
  { label: '存在警告', value: 'warning' },
  { label: '存在严重问题', value: 'critical' },
  { label: '执行失败', value: 'failed' },
]

const issueStatusOptions = [
  { label: '待处理', value: 'open' },
  { label: '已确认', value: 'acknowledged' },
  { label: '已修复', value: 'resolved' },
  { label: '已忽略', value: 'ignored' },
]

const CATEGORY_LABELS = { host: '主机', k8s: 'K8s', middleware: '中间件' }
const MIDDLEWARE_TYPES = ['REDIS', 'MYSQL', 'ELASTICSEARCH']

const authStore = useAuthStore()
const canManage = computed(() => authStore.hasPermission('ops.inspection.manage'))
const canExecute = computed(() => authStore.hasPermission('ops.inspection.execute'))
const canAnalyze = computed(() => authStore.hasPermission('ops.inspection.analyze'))

const tabState = useRouteTabState({
  tabs: () => innerTabs.map(item => item.key),
  defaultTab: 'overview',
  queryKey: 'inspectionTab',
})
const activeTab = tabState.activeTab

const overview = reactive({
  today_runs: 0,
  open_issues: 0,
  critical_issues: 0,
  avg_score_7d: 0,
  score_trend: [],
  severity_distribution: { ok: 0, warning: 0, critical: 0, unknown: 0 },
  top_issues: [],
})

const plans = ref([])
const planLoading = ref(false)
const planDialogVisible = ref(false)
const planSaving = ref(false)
const runs = ref([])
const runLoading = ref(false)
const runFilters = reactive({ status: '' })
const issues = ref([])
const issueLoading = ref(false)
const issueFilters = reactive({ status: '', severity: '' })
const items = ref([])
const itemDialogVisible = ref(false)
const runDrawerVisible = ref(false)
const runDetail = ref(null)
const issueDrawerVisible = ref(false)
const issueDetail = ref(null)
const hostResourceOptions = ref([])
const clusterOptions = ref([])
const ciTypes = ref([])
const previewText = ref('')
const trendChartRef = ref(null)
let trendChart = null

const planForm = reactive({
  id: null,
  name: '',
  description: '',
  enabled: true,
  ai_analysis_enabled: true,
  hostEnvironmentIds: [],
  hostSystemIds: [],
  hostResourceIds: [],
  clusterIds: [],
  namespaceText: '',
  middlewareTypeCodes: [],
  item_codes: [],
  schedule_type: 'manual',
  cron_expression: '',
  interval_seconds: 3600,
  run_at: null,
  timezone: 'Asia/Shanghai',
})

const environmentOptions = computed(() => {
  const seen = new Map()
  for (const node of props.resourceTree || []) {
    const environments = node.children || []
    for (const environment of environments) {
      if (environment.cmdb_node && !seen.has(environment.cmdb_node)) {
        seen.set(environment.cmdb_node, { id: environment.cmdb_node, name: environment.name })
      }
    }
  }
  return Array.from(seen.values())
})

const systemOptions = computed(() => {
  const seen = new Map()
  for (const node of props.resourceTree || []) {
    if (node.cmdb_node && !seen.has(node.cmdb_node)) {
      seen.set(node.cmdb_node, { id: node.cmdb_node, name: node.name })
    }
  }
  return Array.from(seen.values())
})

const middlewareTypeOptions = computed(() =>
  ciTypes.value
    .filter(item => MIDDLEWARE_TYPES.includes(item.code))
    .map(item => ({ code: item.code, name: item.name })),
)

const itemGroups = computed(() => {
  const groups = {}
  for (const item of items.value) {
    if (!groups[item.category]) groups[item.category] = []
    groups[item.category].push(item)
  }
  return Object.entries(groups).map(([category, rows]) => ({
    category,
    label: CATEGORY_LABELS[category] || category,
    items: rows,
  }))
})

const runGroups = computed(() => {
  const groups = {}
  for (const row of runDetail.value?.results || []) {
    if (!groups[row.target_key]) {
      groups[row.target_key] = { key: row.target_key, name: row.target_name, ip: row.target_ip, rows: [] }
    }
    groups[row.target_key].rows.push(row)
  }
  return Object.values(groups)
})

function normalizeList(res) {
  if (Array.isArray(res)) return res
  if (Array.isArray(res?.results)) return res.results
  return []
}

function severityTagType(severity) {
  return { critical: 'danger', warning: 'warning', ok: 'success', success: 'success', failed: 'danger' }[severity] || 'info'
}

function severityLabel(severity) {
  return { critical: '严重', warning: '警告', ok: '正常', unknown: '未知' }[severity] || severity || '-'
}

function issueStatusTagType(status) {
  return { open: 'danger', acknowledged: 'warning', resolved: 'success', ignored: 'info' }[status] || 'info'
}

function aiTagType(status) {
  return { success: 'success', failed: 'danger', running: 'warning', pending: 'info' }[status] || 'info'
}

function runStatusLabel(status) {
  return {
    success: '正常', warning: '存在警告', critical: '存在严重问题', failed: '执行失败',
    running: '执行中', pending: '待执行', canceled: '已取消',
  }[status] || status
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function thresholdSummary(config) {
  if (!config || !config.comparison) return ''
  const unit = config.unit || ''
  if (config.comparison === 'gte' || config.comparison === 'lte') {
    const operator = config.comparison === 'gte' ? '≥' : '≤'
    const parts = []
    if (config.warning !== undefined && config.warning !== null) parts.push(`${operator}${config.warning}${unit} 警告`)
    if (config.critical !== undefined && config.critical !== null) parts.push(`${operator}${config.critical}${unit} 严重`)
    return parts.join(' / ')
  }
  if (config.comparison === 'eq') return `期望 ${config.expect || '-'}`
  if (config.comparison === 'flag') return '命中即告警'
  return ''
}

function scopeSummary(scope) {
  const value = scope || {}
  const parts = []
  const host = value.host || {}
  if ((host.resource_ids || []).length) parts.push(`主机 ${host.resource_ids.length} 台`)
  else if ((host.environment_ids || []).length || (host.system_ids || []).length) parts.push('主机按环境/系统')
  const k8s = value.k8s || {}
  if ((k8s.cluster_ids || []).length) parts.push(`K8s ${k8s.cluster_ids.length} 个集群`)
  const middleware = value.middleware || {}
  if ((middleware.ci_type_codes || []).length) parts.push(`中间件 ${middleware.ci_type_codes.join('/')}`)
  return parts.length ? parts.join(' · ') : '未配置范围'
}

function scheduleSummary(plan) {
  if (plan.schedule_type === 'manual') return '仅手动'
  if (plan.schedule_type === 'once') return '单次'
  if (plan.schedule_type === 'interval') return `每 ${plan.interval_seconds || 0} 秒`
  return plan.cron_expression || 'Cron'
}

async function loadOverview() {
  try {
    const data = await getInspectionOverview()
    Object.assign(overview, data || {})
    await nextTick()
    renderTrend()
  } catch (error) {
    // request 包装已提示错误
  }
}

function renderTrend() {
  if (!trendChartRef.value) return
  if (!trendChart) trendChart = echarts.init(trendChartRef.value)
  const textColor = resolveThemeColor('#64748b')
  const lineColor = resolveThemeColor('#245bdb')
  const dates = (overview.score_trend || []).map(item => item.date)
  const values = (overview.score_trend || []).map(item => item.score)
  trendChart.setOption({
    color: [lineColor],
    grid: { left: 40, right: 16, top: 24, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: value => (value === null || value === undefined ? '无数据' : `${value} 分`) },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine: { lineStyle: { color: resolveThemeColor('#e2e8f0', 'border') } },
      axisLabel: { color: textColor, fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      splitLine: { lineStyle: { color: resolveThemeColor('#eef2f7', 'border') } },
      axisLabel: { color: textColor, fontSize: 11 },
    },
    series: [{
      type: 'line',
      smooth: true,
      connectNulls: false,
      data: values,
      areaStyle: { opacity: 0.12 },
      symbolSize: 6,
      label: { show: false },
    }],
    textStyle: { color: textColor },
    backgroundColor: 'transparent',
  }, true)
}

function resizeTrend() {
  trendChart?.resize()
}

async function loadPlans() {
  planLoading.value = true
  try {
    plans.value = normalizeList(await getInspectionPlans({ page_size: 200 }))
  } finally {
    planLoading.value = false
  }
}

async function loadRuns() {
  runLoading.value = true
  try {
    runs.value = normalizeList(await getInspectionRuns({ page_size: 100, status: runFilters.status || undefined }))
  } finally {
    runLoading.value = false
  }
}

async function loadIssues() {
  issueLoading.value = true
  try {
    issues.value = normalizeList(await getInspectionIssues({
      page_size: 100,
      status: issueFilters.status || undefined,
      severity: issueFilters.severity || undefined,
    }))
  } finally {
    issueLoading.value = false
  }
}

async function loadItems() {
  items.value = normalizeList(await getInspectionItems({ page_size: 200 }))
}

async function loadScopeOptions() {
  const [resources, clusters, types] = await Promise.all([
    getTaskResourceOptions({ resource_type: 'host' }).catch(() => []),
    getK8sClusters().catch(() => []),
    getCITypes({ page_size: 200 }).catch(() => []),
  ])
  hostResourceOptions.value = normalizeList(resources)
  clusterOptions.value = normalizeList(clusters)
  ciTypes.value = normalizeList(types)
}

function openItemCatalog() {
  itemDialogVisible.value = true
}

function openPlanDialog(plan) {
  previewText.value = ''
  if (plan) {
    const scope = plan.scope || {}
    Object.assign(planForm, {
      id: plan.id,
      name: plan.name,
      description: plan.description || '',
      enabled: plan.enabled,
      ai_analysis_enabled: plan.ai_analysis_enabled,
      hostEnvironmentIds: scope.host?.environment_ids || [],
      hostSystemIds: scope.host?.system_ids || [],
      hostResourceIds: scope.host?.resource_ids || [],
      clusterIds: scope.k8s?.cluster_ids || [],
      namespaceText: (scope.k8s?.namespaces || []).join(','),
      middlewareTypeCodes: scope.middleware?.ci_type_codes || [],
      item_codes: plan.item_codes || [],
      schedule_type: plan.schedule_type || 'manual',
      cron_expression: plan.cron_expression || '',
      interval_seconds: plan.interval_seconds || 3600,
      run_at: plan.run_at || null,
      timezone: plan.timezone || 'Asia/Shanghai',
    })
  } else {
    Object.assign(planForm, {
      id: null, name: '', description: '', enabled: true, ai_analysis_enabled: true,
      hostEnvironmentIds: [], hostSystemIds: [], hostResourceIds: [], clusterIds: [],
      namespaceText: '', middlewareTypeCodes: [], item_codes: [],
      schedule_type: 'manual', cron_expression: '', interval_seconds: 3600, run_at: null,
      timezone: 'Asia/Shanghai',
    })
  }
  planDialogVisible.value = true
}

function buildPlanPayload() {
  return {
    name: planForm.name,
    description: planForm.description,
    enabled: planForm.enabled,
    ai_analysis_enabled: planForm.ai_analysis_enabled,
    scope: {
      host: {
        resource_ids: planForm.hostResourceIds,
        environment_ids: planForm.hostEnvironmentIds,
        system_ids: planForm.hostSystemIds,
      },
      k8s: {
        cluster_ids: planForm.clusterIds,
        namespaces: planForm.namespaceText.split(',').map(item => item.trim()).filter(Boolean),
      },
      middleware: { ci_type_codes: planForm.middlewareTypeCodes, config_item_ids: [] },
    },
    item_codes: planForm.item_codes,
    schedule_type: planForm.schedule_type,
    cron_expression: planForm.cron_expression,
    interval_seconds: planForm.schedule_type === 'interval' ? planForm.interval_seconds : null,
    run_at: planForm.schedule_type === 'once' ? planForm.run_at : null,
    timezone: planForm.timezone,
  }
}

async function savePlan() {
  if (!planForm.name.trim()) {
    ElMessage.warning('请填写巡检计划名称')
    return
  }
  planSaving.value = true
  try {
    const payload = buildPlanPayload()
    if (planForm.id) await updateInspectionPlan(planForm.id, payload)
    else await createInspectionPlan(payload)
    planDialogVisible.value = false
    ElMessage.success('巡检计划已保存')
    await loadPlans()
    await loadOverview()
  } catch (error) {
    // 后端 detail 已由 request 包装提示
  } finally {
    planSaving.value = false
  }
}

async function runPlan(plan) {
  try {
    await runInspectionPlanNow(plan.id)
    ElMessage.success('已触发巡检')
    await Promise.all([loadRuns(), loadOverview()])
    activeTab.value = 'runs'
  } catch (error) {
    // 已提示
  }
}

async function togglePlan(plan) {
  await toggleInspectionPlan(plan.id)
  await loadPlans()
}

async function removePlan(plan) {
  try {
    await ElMessageBox.confirm(`确认删除巡检计划「${plan.name}」？`, '删除巡检计划', { type: 'warning' })
  } catch (error) {
    return
  }
  await deleteInspectionPlan(plan.id)
  await loadPlans()
}

async function previewRuns() {
  if (!planForm.id) return
  try {
    const data = await previewInspectionPlanRuns(planForm.id, 5)
    previewText.value = (data.next_runs || []).map(item => formatTime(item)).join(' / ') || '无后续执行'
  } catch (error) {
    previewText.value = ''
  }
}

async function recommendItems() {
  try {
    const data = await recommendInspectionItems({ scope: buildPlanPayload().scope, goal: planForm.description || planForm.name })
    const codes = (data.items || []).map(item => item.code)
    planForm.item_codes = Array.from(new Set([...planForm.item_codes, ...codes]))
    const reason = (data.items || []).find(item => item.reason)?.reason || ''
    ElMessage.success(data.source === 'ai' ? `已推荐 ${codes.length} 项：${reason}` : '未配置模型，已回退为全部启用巡检项')
  } catch (error) {
    // 已提示
  }
}

async function saveItem(item) {
  try {
    await updateInspectionItem(item.id, { weight: item.weight, is_enabled: item.is_enabled })
  } catch (error) {
    await loadItems()
  }
}

async function openRunDetail(row) {
  const data = await getInspectionRun(row.id)
  runDetail.value = data
  runDrawerVisible.value = true
}

async function openRunById(runId) {
  if (!runId) return
  issueDrawerVisible.value = false
  activeTab.value = 'runs'
  await openRunDetail({ id: runId })
}

async function rerun(row) {
  await rerunInspectionRun(row.id)
  ElMessage.success('已提交重新执行')
  await Promise.all([loadRuns(), loadOverview()])
}

async function analyze(row, force = false) {
  try {
    const data = await analyzeInspectionRun(row.id, force)
    if (runDetail.value && runDetail.value.id === row.id) {
      runDetail.value = { ...runDetail.value, ...data }
    }
    await loadRuns()
    ElMessage.success('AI 分析已完成')
  } catch (error) {
    // 未配置模型时后端返回 400 detail，包装已提示
  }
}

function openIssueDetail(row) {
  issueDetail.value = row
  issueDrawerVisible.value = true
}

async function setIssueStatus(row, action) {
  await updateInspectionIssueStatus(row.id, action)
  ElMessage.success('隐患状态已更新')
  issueDrawerVisible.value = false
  await Promise.all([loadIssues(), loadOverview()])
}

async function copyReport() {
  if (!runDetail.value) return
  try {
    const data = await getInspectionReport(runDetail.value.id)
    await copyText(data.markdown)
  } catch (error) {
    // 已提示
  }
}

async function downloadReport() {
  if (!runDetail.value) return
  try {
    const data = await getInspectionReport(runDetail.value.id)
    const blob = new Blob([data.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = data.filename || `inspection-${runDetail.value.id}.md`
    link.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    // 已提示
  }
}

async function copyText(text) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制')
  } catch (error) {
    ElMessage.warning('浏览器拒绝访问剪贴板')
  }
}

watch(activeTab, async (tab) => {
  if (tab === 'overview') await loadOverview()
  else if (tab === 'plans') await loadPlans()
  else if (tab === 'runs') await loadRuns()
  else if (tab === 'issues') await loadIssues()
})

onMounted(async () => {
  window.addEventListener('resize', resizeTrend)
  window.addEventListener(THEME_CHANGE_EVENT, renderTrend)
  await Promise.all([loadItems(), loadScopeOptions()])
  if (activeTab.value === 'plans') await loadPlans()
  else if (activeTab.value === 'runs') await loadRuns()
  else if (activeTab.value === 'issues') await loadIssues()
  else await loadOverview()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeTrend)
  window.removeEventListener(THEME_CHANGE_EVENT, renderTrend)
  trendChart?.dispose()
  trendChart = null
})
</script>

<style scoped>
.inspection-center {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.inspection-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 2px 0;
}

.inspection-switch__hint {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}

.inspection-switch :deep(.el-radio-button__inner) {
  height: 32px;
  line-height: 30px;
  padding: 0 16px;
  border-radius: 8px;
  border-color: var(--border, rgba(15, 23, 42, 0.08));
  color: var(--text-secondary);
  font-size: 13px;
}

.inspection-switch :deep(.el-radio-button.is-active .el-radio-button__inner) {
  background: #245bdb;
  border-color: #245bdb;
  color: #fff;
  box-shadow: none;
}

.inspection-stat-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.inspection-overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 12px;
}

.inspection-trend-chart {
  width: 100%;
  height: 260px;
}

.glass-card {
  background: var(--card-bg);
  border: 1px solid var(--border, rgba(15, 23, 42, 0.08));
  border-radius: 14px;
  box-shadow: var(--card-shadow);
  padding: 14px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.inspection-form-section {
  margin-bottom: 16px;
}

.inspection-form-section__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.inspection-inline-hint {
  margin-left: 10px;
  margin-right: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-col {
  flex: 1;
  min-width: 0;
}

.inspection-item-group {
  margin-bottom: 12px;
}

.inspection-item-group__title {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.inspection-item-hint {
  margin-left: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}

.inspection-drawer {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.inspection-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.inspection-drawer__summary {
  color: var(--text-secondary);
  font-size: 13px;
}

.inspection-drawer__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.inspection-ai-panel {
  padding: 12px;
  border: 1px solid var(--border, rgba(15, 23, 42, 0.08));
  border-radius: 12px;
  background: var(--card-bg);
}

.inspection-ai-panel__title {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.inspection-ai-panel__summary {
  margin-bottom: 8px;
  color: var(--text-primary);
  font-size: 13px;
}

.inspection-ai-panel__list {
  margin: 0 0 8px 16px;
  padding: 0;
  color: var(--text-primary);
  font-size: 13px;
}

.inspection-ai-panel__list li {
  margin-bottom: 6px;
}

.inspection-advice {
  color: var(--text-secondary);
  font-size: 12px;
}

.inspection-muted {
  margin-left: 8px;
  color: var(--text-secondary);
  font-size: 12px;
}

.inspection-run-group__title {
  margin: 6px 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.inspection-pre {
  margin: 0;
  padding: 10px;
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--border, rgba(15, 23, 42, 0.08));
  border-radius: 10px;
  background: var(--card-bg);
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}

@media (max-width: 1200px) {
  .inspection-overview-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .inspection-stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
