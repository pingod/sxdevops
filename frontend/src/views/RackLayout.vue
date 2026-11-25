<template>
  <div class="rack-page workbench-page-shell fade-in">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon"><el-icon><OfficeBuilding /></el-icon></span>
        <h2>机柜布设</h2>
        <span class="hero-inline-tag">{{ content.rack }} · {{ content.rackWidth }}mm</span>
      </div>
    </section>

    <div class="rack-stats">
      <div class="release-stat-card">
        <div class="stat-value">{{ projects.length }}</div>
        <div class="stat-label">布设方案</div>
      </div>
      <div class="release-stat-card">
        <div class="stat-value">{{ stats.deviceCount }}</div>
        <div class="stat-label">当前设备</div>
      </div>
      <div class="release-stat-card">
        <div class="stat-value">{{ stats.usedU }}<small>U</small></div>
        <div class="stat-label">已占用高度 / {{ stats.capacityU }}U</div>
      </div>
      <div class="release-stat-card" :class="{ 'warning-card': stats.rate >= 85 }">
        <div class="stat-value">{{ stats.rate }}<small>%</small></div>
        <div class="stat-label">空间利用率</div>
      </div>
    </div>

    <section class="panel rack-hint-strip">
      <span class="hint-dot" :class="{ 'is-dirty': dirty }" aria-hidden="true"></span>
      <strong>{{ content.mode === 'U' ? 'U 对齐' : '孔位精调' }}</strong>
      <span class="hint-text">
        从左侧目录拖拽设备到机柜；同一 U 内可并排放置 1/2、1/3 宽设备；选中设备后可用方向键微调，Ctrl/⌘ + S 保存。
      </span>
      <span class="hint-spacer"></span>
      <el-tag v-if="!current" size="small" type="info" effect="plain">未选择方案</el-tag>
      <el-tag size="small" :type="dirty ? 'warning' : 'success'" effect="plain">
        {{ dirty ? '未保存' : '已同步' }}
      </el-tag>
    </section>

    <section v-loading="loading" class="workbench-card rack-card">
      <div class="rack-toolbar">
        <div class="rack-toolbar-left">
          <el-select
            v-model="currentId"
            class="rack-project-select"
            placeholder="选择布设方案"
            filterable
            :loading="projectsLoading"
            @change="onSelectProject"
          >
            <el-option v-for="item in projects" :key="item.id" :value="item.id" :label="item.name">
              <span class="project-option-name">{{ item.name }}</span>
              <span class="project-option-meta">{{ item.rack_kind }} · {{ item.device_count }} 台</span>
            </el-option>
          </el-select>
          <template v-if="current">
            <span class="rack-project-meta">
              v{{ current.version }} · {{ current.updated_by || current.uploaded_by || '—' }} ·
              {{ formatTime(current.updated_at) }}
            </span>
            <el-button v-if="canManage" text :icon="EditPen" @click="openMetaDialog">方案信息</el-button>
          </template>
          <el-button text :icon="RefreshRight" :loading="projectsLoading" @click="reloadProjects">刷新</el-button>
        </div>

        <div class="rack-toolbar-right">
          <el-button v-if="canManage" :icon="Plus" @click="openCreateDialog">新建</el-button>
          <el-button v-if="canManage" type="primary" :icon="Check" :loading="saving" @click="save">保存</el-button>
          <el-button v-if="canManage && current" :icon="CopyDocument" @click="openSaveAsDialog">另存为</el-button>
          <el-button v-if="current" :icon="Clock" @click="openVersions">版本</el-button>
          <el-button v-if="canManage && current" :icon="Delete" @click="removeProject">删除</el-button>
          <span class="toolbar-divider" />
          <el-button v-if="canManage" :icon="Upload" @click="triggerImport">导入布设</el-button>
          <el-button :icon="Download" @click="exportMarkdown">导出布设</el-button>
          <el-button :icon="Picture" @click="exportPng">导出图片</el-button>
          <span class="toolbar-divider" />
          <el-select
            :model-value="content.rack"
            class="rack-kind-select"
            :disabled="!canManage"
            @change="changeRack"
          >
            <el-option v-for="item in RACK_KINDS" :key="item.value" :value="item.value" :label="item.label" />
          </el-select>
          <el-select
            :model-value="content.rackWidth"
            class="rack-width-select"
            :disabled="!canManage"
            @change="changeRackWidth"
          >
            <el-option :value="600" label="600mm" />
            <el-option :value="800" label="800mm" />
            <el-option :value="1000" label="1000mm" />
          </el-select>
          <el-select
            :model-value="content.mode"
            class="rack-mode-select"
            :disabled="!canManage"
            @change="changeMode"
          >
            <el-option value="U" label="U 对齐" />
            <el-option value="hole" label="孔位精调" />
          </el-select>
          <el-button-group class="rack-zoom">
            <el-button :icon="ZoomOut" @click="changeZoom(-10)" />
            <el-button class="zoom-value" disabled>{{ zoom }}%</el-button>
            <el-button :icon="ZoomIn" @click="changeZoom(10)" />
          </el-button-group>
        </div>
      </div>

      <div class="rack-body">
        <RackCatalogPanel
          :custom-devices="content.customDevices"
          :disabled="!canManage"
          @add="addFromCatalog"
          @drag-start="onCatalogDragStart"
          @drag-end="onCatalogDragEnd"
          @create-custom="openCustomDeviceDialog"
          @remove-custom="removeCustomDevice"
        />

        <div class="rack-stage-column">
          <div class="rack-stage-head">
            <span class="stage-title">{{ current ? current.name : '未保存方案' }}</span>
            <span class="stage-sub">
              {{ content.rack }} · {{ stats.deviceCount }} 台 · 已用 {{ stats.usedU }}U / 空余 {{ stats.freeU }}U
            </span>
            <span class="stage-spacer" />
            <el-button v-if="lastImportUndo" text size="small" @click="undoImport">撤销导入</el-button>
          </div>
          <RackCanvas
            ref="canvasRef"
            :state="content"
            :selected-id="selectedId"
            :zoom="zoom"
            :drag-payload="catalogDrag"
            @select="selectedId = $event"
            @add-device="addDevice"
            @move-device="moveDevice"
          />
        </div>

        <aside class="rack-props">
          <template v-if="selected">
            <div class="props-head">
              <span class="props-title">设备属性</span>
              <span class="props-cat-tag" :style="{ background: categoryMeta(selected.cat).chip }">
                {{ categoryMeta(selected.cat).label }}
              </span>
            </div>
            <div class="props-scroll">
              <el-form label-position="top" size="small" class="props-form">
                <el-form-item label="设备名称">
                  <el-input v-model="selected.name" maxlength="60" show-word-limit />
                </el-form-item>
                <el-form-item label="设备类别">
                  <el-select v-model="selected.cat">
                    <el-option
                      v-for="(meta, key) in CATEGORY_META"
                      :key="key"
                      :value="key"
                      :label="meta.label"
                    />
                  </el-select>
                </el-form-item>
                <div class="props-grid">
                  <el-form-item label="宽度">
                    <el-select :model-value="selected.w" @change="changeSelectedWidth">
                      <el-option
                        v-for="item in DEVICE_WIDTHS"
                        :key="item.value"
                        :value="item.value"
                        :label="item.label"
                      />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="高度（U）">
                    <el-input-number
                      :model-value="selected.hU"
                      :min="1"
                      :max="24"
                      controls-position="right"
                      @change="changeSelectedHeight"
                    />
                  </el-form-item>
                </div>
                <div class="props-grid">
                  <el-form-item label="顶边 U 位">
                    <el-input-number
                      :model-value="selectedTopU"
                      :min="1"
                      :max="rackUnits(content.rack)"
                      controls-position="right"
                      @change="changeSelectedU"
                    />
                  </el-form-item>
                  <el-form-item label="横向位置">
                    <el-select :model-value="selected.col" @change="changeSelectedCol">
                      <el-option
                        v-for="col in colOptions"
                        :key="col.value"
                        :value="col.value"
                        :label="col.label"
                      />
                    </el-select>
                  </el-form-item>
                </div>
                <div class="props-readonly">
                  <span>占用 U 区间</span>
                  <strong>{{ selectedBottomU }}U – {{ selectedTopU }}U</strong>
                  <span>尺寸</span>
                  <strong>{{ selected.hU }}U × {{ widthText(selected.w) }}</strong>
                </div>

                <el-divider content-position="left">资产信息</el-divider>
                <el-form-item label="资产编号">
                  <el-input v-model="selected.assetNo" maxlength="80" placeholder="可选，与 CMDB 对账用" />
                </el-form-item>
                <div class="props-grid">
                  <el-form-item label="序列号">
                    <el-input v-model="selected.serial" maxlength="80" placeholder="可选" />
                  </el-form-item>
                  <el-form-item label="负责人">
                    <el-input v-model="selected.owner" maxlength="60" placeholder="可选" />
                  </el-form-item>
                </div>
                <el-form-item label="备注">
                  <el-input v-model="selected.note" type="textarea" :rows="2" maxlength="500" />
                </el-form-item>
              </el-form>
            </div>
            <div class="props-actions">
              <el-button :icon="CopyDocument" :disabled="!canManage" @click="duplicateSelected">复制到空位</el-button>
              <el-button type="danger" plain :icon="Delete" :disabled="!canManage" @click="removeSelected">移除设备</el-button>
            </div>
          </template>

          <template v-else>
            <div class="props-head">
              <span class="props-title">方案概览</span>
              <el-tag v-if="current" size="small" type="success" effect="plain">v{{ current.version }}</el-tag>
            </div>
            <div class="props-scroll">
              <div class="summary-grid">
                <div><span>机柜规格</span><strong>{{ content.rack }} / {{ content.rackWidth }}mm</strong></div>
                <div><span>卡位版式</span><strong>{{ content.mode === 'U' ? '标准 U 数' : '螺丝孔位' }}</strong></div>
                <div><span>设备总数</span><strong>{{ stats.deviceCount }} 台</strong></div>
                <div><span>空间利用率</span><strong>{{ stats.rate }}%</strong></div>
              </div>
              <div class="usage-bar"><span :style="{ width: `${Math.min(100, stats.rate)}%` }" /></div>
              <div class="usage-caption">
                已用 {{ stats.usedU }}U · 空余 {{ stats.freeU }}U · 总容量 {{ stats.capacityU }}U
              </div>

              <h4 class="summary-heading">按类别统计</h4>
              <table class="summary-table">
                <thead><tr><th>类别</th><th>数量</th><th>占用</th></tr></thead>
                <tbody>
                  <tr v-for="(item, key) in stats.byCategory" :key="key">
                    <td><span class="summary-dot" :style="{ background: categoryMeta(key).chip }" />{{ item.label }}</td>
                    <td>{{ item.count }}</td>
                    <td>{{ item.u }}U</td>
                  </tr>
                </tbody>
              </table>
              <el-empty v-if="!stats.deviceCount" description="机柜还是空的" :image-size="58" />
              <p class="summary-tip">选中机柜内的设备后，这里会显示可编辑的属性。</p>
            </div>
          </template>
        </aside>
      </div>
    </section>

    <input ref="fileInput" type="file" accept=".md,.markdown,.txt" class="hidden-file" @change="onImportFile" />

    <el-dialog v-model="createDialog.visible" title="新建机柜布设方案" width="480px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="方案名称" required>
          <el-input v-model="createDialog.name" maxlength="120" placeholder="如：403 机房 A01 机柜" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="createDialog.description" maxlength="255" placeholder="可选" />
        </el-form-item>
        <div class="dialog-grid">
          <el-form-item label="机柜规格">
            <el-select v-model="createDialog.rack">
              <el-option v-for="item in RACK_KINDS" :key="item.value" :value="item.value" :label="item.label" />
            </el-select>
          </el-form-item>
          <el-form-item label="机柜宽度">
            <el-select v-model="createDialog.width">
              <el-option :value="600" label="600mm（标准）" />
              <el-option :value="800" label="800mm" />
              <el-option :value="1000" label="1000mm" />
            </el-select>
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="createDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="createDialog.saving" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="copyDialog.visible" title="另存为" width="460px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="新方案名称" required>
          <el-input v-model="copyDialog.name" maxlength="120" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="copyDialog.description" maxlength="255" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="copyDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="copyDialog.saving" @click="submitCopy">保存副本</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="metaDialog.visible" title="方案信息" width="460px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="方案名称" required>
          <el-input v-model="metaDialog.name" maxlength="120" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="metaDialog.description" maxlength="255" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="metaDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="metaDialog.saving" @click="submitMeta">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="customDialog.visible" title="新建自定义设备" width="460px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="设备名称" required>
          <el-input v-model="customDialog.name" maxlength="60" placeholder="如：KVM 切换器" />
        </el-form-item>
        <div class="dialog-grid">
          <el-form-item label="宽度">
            <el-select v-model="customDialog.w">
              <el-option v-for="item in DEVICE_WIDTHS" :key="item.value" :value="item.value" :label="item.label" />
            </el-select>
          </el-form-item>
          <el-form-item label="高度（U）">
            <el-input-number v-model="customDialog.hU" :min="1" :max="24" controls-position="right" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="customDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitCustomDevice">加入目录</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="versionsDialog.visible" title="版本历史" width="620px" append-to-body>
      <el-table v-loading="versionsDialog.loading" :data="versionsDialog.rows" size="small" max-height="360">
        <el-table-column prop="version" label="版本" width="82">
          <template #default="{ row }">v{{ row.version }}</template>
        </el-table-column>
        <el-table-column prop="device_count" label="设备" width="76" />
        <el-table-column prop="used_u" label="占用" width="76">
          <template #default="{ row }">{{ row.used_u }}U</template>
        </el-table-column>
        <el-table-column prop="created_by" label="保存人" width="120" />
        <el-table-column label="时间" min-width="150">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="96" align="right">
          <template #default="{ row }">
            <el-button v-if="canManage" text type="primary" size="small" @click="rollbackTo(row)">回滚</el-button>
            <span v-else class="text-muted">只读</span>
          </template>
        </el-table-column>
        <template #empty>
          <span class="text-muted">保存后每次内容变化都会留一份快照，最多保留 30 个版本。</span>
        </template>
      </el-table>
    </el-dialog>

    <el-dialog v-model="importDialog.visible" title="导入布设报告" width="560px" append-to-body>
      <div class="import-summary">{{ importDialog.summary }}</div>
      <ul class="import-rows">
        <li v-for="(row, index) in importDialog.rows" :key="index" :class="`is-${row.kind}`">
          {{ kindIcon(row.kind) }} {{ row.text }}
        </li>
      </ul>
      <template #footer>
        <el-button @click="importDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="applyImport">应用到机柜</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="conflictDialog.visible" title="版本冲突" width="460px" append-to-body>
      <p class="conflict-text">
        该方案已被 {{ conflictDialog.info?.updated_by || '他人' }} 更新到
        v{{ conflictDialog.info?.current_version }}，当前页面的内容不是最新版本。
      </p>
      <p class="text-muted">可以加载最新内容后重新编辑，或把当前内容另存为一个新方案。</p>
      <template #footer>
        <el-button @click="conflictDialog.visible = false">取消</el-button>
        <el-button @click="saveCopyFromConflict">另存为副本</el-button>
        <el-button type="primary" @click="reloadFromConflict">加载最新</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Check, Clock, CopyDocument, Delete, Download, EditPen, OfficeBuilding,
  Picture, Plus, RefreshRight, Upload, ZoomIn, ZoomOut,
} from '@element-plus/icons-vue'

import RackCanvas from '@/components/datacenter/rackdraw/RackCanvas.vue'
import RackCatalogPanel from '@/components/datacenter/rackdraw/RackCatalogPanel.vue'
import {
  CATEGORY_META, DEVICE_WIDTHS, H_GRID, RACK_KINDS, HOLES_PER_U,
  clampH, clampInt, clampW, collides, computeStats, emptyProject, findFreeHole,
  holeToUText, importLayout, makeId, normalizeProject, rackUnits, topU,
  totalHoles, widthText,
} from '@/components/datacenter/rackdraw/model'
import { buildLayoutMarkdown, markdownFileName } from '@/components/datacenter/rackdraw/model'
import {
  createRackProject, deleteRackProject, fetchRackProjectContent, listRackProjects,
  listRackVersions, patchRackProject, rollbackRackProject, updateRackProject,
} from '@/api/modules/datacenter'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const canManage = computed(() => authStore.hasPermission('datacenter.rack.manage'))

const projects = ref([])
const projectsLoading = ref(false)
const loading = ref(false)
const saving = ref(false)
const current = ref(null)
const currentId = ref(null)
const content = ref(emptyProject())
const selectedId = ref(0)
const zoom = ref(90)
const dirty = ref(false)
const baseline = ref('')
const catalogDrag = ref(null)
const lastImportUndo = ref(null)
const canvasRef = ref(null)
const fileInput = ref(null)

const createDialog = reactive({ visible: false, name: '', description: '', rack: '42U', width: 600, saving: false })
const copyDialog = reactive({ visible: false, name: '', description: '', saving: false })
const metaDialog = reactive({ visible: false, name: '', description: '', saving: false })
const customDialog = reactive({ visible: false, name: '', w: 6, hU: 1 })
const versionsDialog = reactive({ visible: false, loading: false, rows: [] })
const importDialog = reactive({ visible: false, rows: [], summary: '', next: null })
const conflictDialog = reactive({ visible: false, info: null })

const stats = computed(() => computeStats(content.value))
const selected = computed(() => content.value.devices.find(item => item.id === selectedId.value) || null)
const selectedTopU = computed(() => (selected.value ? topU(content.value, selected.value) : 1))
const selectedBottomU = computed(() => (
  selected.value ? holeToUText(content.value.rack, selected.value.hole + selected.value.hU * HOLES_PER_U - 1) : 0
))
const colOptions = computed(() => {
  const width = selected.value?.w || 6
  const labels = ['左侧', '偏左', '左中', '右中', '偏右', '右侧']
  const total = H_GRID - width + 1
  return Array.from({ length: total }, (_, col) => {
    let label = labels[Math.min(col, labels.length - 1)]
    if (width === H_GRID) label = '全宽'
    else if (col === total - 1) label = '右侧'
    else if (col === 0) label = '左侧'
    else label = `第 ${col + 1} 列`
    return { value: col, label }
  })
})

const serialize = state => JSON.stringify({
  rack: state.rack,
  rackWidth: state.rackWidth,
  mode: state.mode,
  devices: state.devices,
  customDevices: state.customDevices,
})

watch(content, () => {
  dirty.value = serialize(content.value) !== baseline.value
}, { deep: true })

function categoryMeta(key) {
  return CATEGORY_META[key] || CATEGORY_META.custom
}

function formatTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function apiError(error, fallback = '操作失败') {
  const data = error?.response?.data
  if (typeof data === 'string') return data
  if (data?.detail) return data.detail
  if (data && typeof data === 'object') {
    const first = Object.values(data)[0]
    if (Array.isArray(first) && first.length) return String(first[0])
    if (typeof first === 'string') return first
  }
  return error?.message || fallback
}

async function loadProjects() {
  projectsLoading.value = true
  try {
    const data = await listRackProjects({ page_size: 100, ordering: '-updated_at' })
    projects.value = data?.results || data || []
  } catch (error) {
    ElMessage.error(apiError(error, '加载布设方案失败'))
  } finally {
    projectsLoading.value = false
  }
}

async function openProject(id) {
  if (!id) return
  loading.value = true
  try {
    const meta = projects.value.find(item => item.id === id)
    const response = await fetchRackProjectContent(id)
    const text = typeof response === 'string' ? response : JSON.stringify(response)
    const parsed = JSON.parse(text || '{}')
    const next = normalizeProject(parsed)
    if (meta) next.name = meta.name
    content.value = next
    current.value = meta || null
    currentId.value = id
    selectedId.value = 0
    baseline.value = serialize(next)
    dirty.value = false
    lastImportUndo.value = null
    if (!meta) {
      await loadProjects()
      current.value = projects.value.find(item => item.id === id) || null
    }
    if (route.query.id !== String(id)) router.replace({ query: { ...route.query, id } })
  } catch (error) {
    ElMessage.error(apiError(error, '加载方案内容失败'))
  } finally {
    loading.value = false
  }
}

async function reloadProjects() {
  if (!(await confirmDiscard())) return
  await loadProjects()
  if (currentId.value) await openProject(currentId.value)
}

async function confirmDiscard() {
  if (!dirty.value) return true
  try {
    await ElMessageBox.confirm('当前方案有未保存修改，继续操作将丢失这些修改。', '未保存修改', {
      type: 'warning', confirmButtonText: '继续', cancelButtonText: '取消',
    })
    return true
  } catch {
    return false
  }
}

async function onSelectProject(id) {
  if (!id || id === current.value?.id) return
  if (!(await confirmDiscard())) {
    currentId.value = current.value?.id ?? null
    return
  }
  await openProject(id)
}

function resetToEmpty() {
  current.value = null
  currentId.value = null
  content.value = emptyProject()
  selectedId.value = 0
  baseline.value = serialize(content.value)
  dirty.value = false
  lastImportUndo.value = null
}

function openCreateDialog() {
  createDialog.name = ''
  createDialog.description = ''
  createDialog.rack = content.value.rack
  createDialog.width = content.value.rackWidth
  createDialog.visible = true
}

async function submitCreate() {
  const name = createDialog.name.trim()
  if (!name) return ElMessage.warning('请填写方案名称')
  if (!(await confirmDiscard())) return
  createDialog.saving = true
  try {
    const project = emptyProject(createDialog.rack, createDialog.width)
    const data = await createRackProject({
      name, description: createDialog.description.trim(), project,
    })
    projects.value = [data, ...projects.value.filter(item => item.id !== data.id)]
    current.value = data
    currentId.value = data.id
    const next = normalizeProject(project)
    next.name = data.name
    content.value = next
    selectedId.value = 0
    baseline.value = serialize(next)
    dirty.value = false
    createDialog.visible = false
    ElMessage.success('方案已创建')
  } catch (error) {
    ElMessage.error(apiError(error, '创建方案失败'))
  } finally {
    createDialog.saving = false
  }
}

function openSaveAsDialog() {
  copyDialog.name = `${current.value?.name || '机柜布设'} 副本`
  copyDialog.description = current.value?.description || ''
  copyDialog.visible = true
}

async function submitCopy() {
  const name = copyDialog.name.trim()
  if (!name) return ElMessage.warning('请填写新方案名称')
  copyDialog.saving = true
  try {
    const data = await createRackProject({
      name, description: copyDialog.description.trim(), project: content.value,
    })
    projects.value = [data, ...projects.value.filter(item => item.id !== data.id)]
    copyDialog.visible = false
    current.value = data
    currentId.value = data.id
    content.value.name = data.name
    baseline.value = serialize(content.value)
    dirty.value = false
    ElMessage.success('已保存为副本')
  } catch (error) {
    ElMessage.error(apiError(error, '另存为失败'))
  } finally {
    copyDialog.saving = false
  }
}

function openMetaDialog() {
  if (!current.value) return
  metaDialog.name = current.value.name
  metaDialog.description = current.value.description || ''
  metaDialog.visible = true
}

async function submitMeta() {
  const name = metaDialog.name.trim()
  if (!name) return ElMessage.warning('请填写方案名称')
  metaDialog.saving = true
  try {
    const data = await patchRackProject(current.value.id, {
      name, description: metaDialog.description.trim(),
    })
    current.value = data
    content.value.name = data.name
    projects.value = projects.value.map(item => (item.id === data.id ? data : item))
    metaDialog.visible = false
    ElMessage.success('方案信息已更新')
  } catch (error) {
    ElMessage.error(apiError(error, '更新方案信息失败'))
  } finally {
    metaDialog.saving = false
  }
}

async function save() {
  if (!canManage.value) return
  if (!current.value) {
    openCreateDialog()
    return
  }
  saving.value = true
  try {
    const data = await updateRackProject(current.value.id, {
      name: current.value.name,
      description: current.value.description || '',
      base_version: current.value.version,
      project: content.value,
    })
    current.value = data
    projects.value = projects.value.map(item => (item.id === data.id ? data : item))
    content.value.name = data.name
    baseline.value = serialize(content.value)
    dirty.value = false
    lastImportUndo.value = null
    ElMessage.success('已保存')
  } catch (error) {
    if (error?.response?.status === 409) {
      conflictDialog.info = error.response.data
      conflictDialog.visible = true
    } else {
      ElMessage.error(apiError(error, '保存失败'))
    }
  } finally {
    saving.value = false
  }
}

async function reloadFromConflict() {
  conflictDialog.visible = false
  if (current.value) await openProject(current.value.id)
}

function saveCopyFromConflict() {
  conflictDialog.visible = false
  openSaveAsDialog()
}

async function removeProject() {
  if (!current.value) return
  try {
    await ElMessageBox.confirm(`确定删除方案「${current.value.name}」？删除后不可恢复。`, '删除方案', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await deleteRackProject(current.value.id)
    projects.value = projects.value.filter(item => item.id !== current.value.id)
    ElMessage.success('方案已删除')
    if (projects.value.length) await openProject(projects.value[0].id)
    else resetToEmpty()
  } catch (error) {
    ElMessage.error(apiError(error, '删除方案失败'))
  }
}

async function openVersions() {
  if (!current.value) return
  versionsDialog.visible = true
  versionsDialog.loading = true
  try {
    const data = await listRackVersions(current.value.id)
    versionsDialog.rows = data?.results || data || []
  } catch (error) {
    versionsDialog.rows = []
    ElMessage.error(apiError(error, '加载版本失败'))
  } finally {
    versionsDialog.loading = false
  }
}

async function rollbackTo(row) {
  try {
    await ElMessageBox.confirm(
      `回滚到 v${row.version}？当前内容会先留一份快照，回滚本身也可再回滚。`,
      '回滚版本',
      { type: 'warning', confirmButtonText: '回滚', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    const data = await rollbackRackProject(current.value.id, row.version)
    projects.value = projects.value.map(item => (item.id === data.id ? data : item))
    versionsDialog.visible = false
    await openProject(data.id)
    ElMessage.success(`已回滚到 v${row.version}`)
  } catch (error) {
    ElMessage.error(apiError(error, '回滚失败'))
  }
}

/* ---------------- 目录与画布 ---------------- */

function onCatalogDragStart(payload) {
  catalogDrag.value = payload
}

function onCatalogDragEnd() {
  catalogDrag.value = null
}

function addFromCatalog(payload) {
  if (!canManage.value) return
  const slot = canvasRef.value?.findSlot(payload.w, payload.hU)
  if (!slot) return ElMessage.warning(`${payload.name} 在 ${content.value.rack} 机柜里没有连续空位`)
  addDevice({ ...payload, ...slot })
}

function addDevice(payload) {
  if (!canManage.value) return
  const id = content.value.deviceSeq
  if (content.value.devices.some(item => item.id === id)) return
  content.value.deviceSeq = id + 1
  content.value.devices.push({
    id,
    cat: payload.cat,
    name: payload.name,
    w: payload.w,
    hU: payload.hU,
    col: payload.col,
    hole: payload.hole,
    assetNo: '',
    serial: '',
    owner: '',
    note: '',
    cmdbIds: [],
  })
  selectedId.value = id
}

function moveDevice({ id, col, hole }) {
  if (!canManage.value) return
  const device = content.value.devices.find(item => item.id === id)
  if (!device) return
  if (collides(content.value.devices, col, hole, device.w, device.hU, id)) {
    ElMessage.warning('目标位置已被占用')
    return
  }
  device.col = col
  device.hole = hole
}

function removeSelected() {
  if (!selected.value) return
  content.value.devices = content.value.devices.filter(item => item.id !== selectedId.value)
  selectedId.value = 0
}

function duplicateSelected() {
  if (!selected.value) return
  const source = selected.value
  const step = content.value.mode === 'U' ? HOLES_PER_U : 1
  const maxHole = Math.max(0, totalHoles(content.value.rack) - source.hU * HOLES_PER_U)
  const probe = findFreeHole(
    content.value, source.col, Math.min(maxHole, source.hole + source.hU * HOLES_PER_U),
    source.w, source.hU, step, maxHole,
  )
  if (!probe.found) return ElMessage.warning('机柜里没有连续空位可以复制')
  const id = content.value.deviceSeq
  content.value.deviceSeq = id + 1
  content.value.devices.push({
    ...source,
    id,
    hole: probe.hole,
    name: `${source.name.slice(0, 58)} 副本`,
    assetNo: '',
    serial: '',
    cmdbIds: [],
  })
  selectedId.value = id
}

function tryUpdate(device, patch) {
  const next = { ...device, ...patch }
  next.w = clampW(next.w)
  next.hU = clampH(next.hU)
  next.col = clampInt(next.col, 0, H_GRID - next.w)
  const maxHole = Math.max(0, totalHoles(content.value.rack) - next.hU * HOLES_PER_U)
  next.hole = clampInt(next.hole, 0, maxHole)
  if (content.value.mode === 'U') {
    next.hole = clampInt(Math.round(next.hole / HOLES_PER_U) * HOLES_PER_U, 0, maxHole)
  }
  if (collides(content.value.devices, next.col, next.hole, next.w, next.hU, device.id)) {
    ElMessage.warning('目标位置已被其他设备占用')
    return false
  }
  Object.assign(device, next)
  return true
}

function changeSelectedWidth(value) {
  if (!selected.value) return
  tryUpdate(selected.value, { w: Number(value) })
}

function changeSelectedHeight(value) {
  if (!selected.value) return
  tryUpdate(selected.value, { hU: Number(value) })
}

function changeSelectedU(value) {
  if (!selected.value) return
  const units = rackUnits(content.value.rack)
  const top = clampInt(Number(value) || 1, 1, units)
  if (top < selected.value.hU) {
    ElMessage.warning(`设备高度 ${selected.value.hU}U，顶边 U 位不能低于 ${selected.value.hU}U`)
    return
  }
  tryUpdate(selected.value, { hole: (units - top) * HOLES_PER_U })
}

function changeSelectedCol(value) {
  if (!selected.value) return
  tryUpdate(selected.value, { col: Number(value) })
}

function changeZoom(delta) {
  zoom.value = clampInt(zoom.value + delta, 50, 160)
}

function reflow(patch) {
  const next = { ...content.value, ...patch }
  const source = [...next.devices].sort((a, b) => a.hole - b.hole)
  next.devices = []
  const step = next.mode === 'U' ? HOLES_PER_U : 1
  for (const device of source) {
    const maxHole = Math.max(0, totalHoles(next.rack) - device.hU * HOLES_PER_U)
    const probe = findFreeHole(next, device.col, clampInt(device.hole, 0, maxHole), device.w, device.hU, step, maxHole)
    if (probe.found) next.devices.push({ ...device, hole: probe.hole })
    else ElMessage.warning(`「${device.name}」在 ${next.rack} 机柜里放不下，已移除`)
  }
  content.value = next
  selectedId.value = 0
}

function changeRackWidth(value) {
  if (!canManage.value) return
  content.value.rackWidth = clampInt(Number(value) || 600, 400, 1200)
}

async function changeRack(value) {
  if (!canManage.value || value === content.value.rack) return
  if (content.value.devices.length) {
    try {
      await ElMessageBox.confirm(
        `切换为 ${value} 后，现有设备会按 U 位重新排布，放不下的设备会被移除。`,
        '切换机柜规格',
        { type: 'warning', confirmButtonText: '切换', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }
  reflow({ rack: value })
}

async function changeMode(value) {
  if (!canManage.value || value === content.value.mode) return
  if (content.value.devices.length) {
    try {
      await ElMessageBox.confirm(
        value === 'U' ? '切换为 U 对齐后，设备孔位会吸附到整 U 边界。' : '切换为孔位精调后，设备可以停在 1/3U 的螺丝孔位上。',
        '切换卡位版式',
        { type: 'warning', confirmButtonText: '切换', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }
  const devices = content.value.devices.map(device => (
    value === 'U'
      ? { ...device, hole: Math.round(device.hole / HOLES_PER_U) * HOLES_PER_U }
      : device
  ))
  reflow({ mode: value, devices })
}

/* ---------------- 自定义设备 ---------------- */

function openCustomDeviceDialog() {
  customDialog.name = ''
  customDialog.w = 6
  customDialog.hU = 1
  customDialog.visible = true
}

function submitCustomDevice() {
  const name = customDialog.name.trim()
  if (!name) return ElMessage.warning('请填写设备名称')
  if (content.value.customDevices.some(item => item.name === name)) {
    return ElMessage.warning('目录里已有同名自定义设备')
  }
  content.value.customDevices.push({
    id: makeId(),
    name,
    w: clampW(customDialog.w),
    hU: clampH(customDialog.hU),
    createdAt: new Date().toISOString(),
  })
  customDialog.visible = false
  ElMessage.success('已加入「我的设备」')
}

function removeCustomDevice(id) {
  content.value.customDevices = content.value.customDevices.filter(item => item.id !== id)
}

/* ---------------- 导入导出 ---------------- */

function triggerImport() {
  fileInput.value?.click()
}

async function onImportFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const report = importLayout(text, content.value)
    if (!report.ok) {
      ElMessage.error(report.error)
      return
    }
    importDialog.rows = report.rows
    importDialog.summary = report.rows[0]?.text || ''
    importDialog.next = report.next
    importDialog.visible = true
  } catch (error) {
    ElMessage.error(apiError(error, '读取布设文件失败'))
  }
}

function applyImport() {
  if (!importDialog.next) return
  lastImportUndo.value = content.value
  content.value = importDialog.next
  selectedId.value = 0
  importDialog.visible = false
  ElMessage.success('布设已导入，可点击「撤销导入」还原')
}

function undoImport() {
  if (!lastImportUndo.value) return
  content.value = lastImportUndo.value
  lastImportUndo.value = null
  selectedId.value = 0
  ElMessage.success('已撤销导入')
}

function kindIcon(kind) {
  return { ok: '√', warn: '▲', unknown: '?', error: '×', indent: '　' }[kind] || ''
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function exportMarkdown() {
  const text = buildLayoutMarkdown(content.value)
  downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), markdownFileName(content.value))
}

async function exportPng() {
  const clone = canvasRef.value?.buildExportSvg()
  if (!clone) return
  try {
    const [vx, vy, vw, vh] = (clone.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)
    const width = Number(vw) || Number(clone.getAttribute('width'))
    const height = Number(vh) || Number(clone.getAttribute('height'))
    if (!width || !height) throw new Error('机柜画布尺寸无效')
    const data = new XMLSerializer().serializeToString(clone)
    const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml;charset=utf-8' }))
    const image = new Image()
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = reject
      image.src = url
    })
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)
    canvas.toBlob(blob => {
      if (blob) downloadBlob(blob, `机柜布设_${content.value.rack}_${Date.now()}.png`)
    }, 'image/png')
  } catch (error) {
    ElMessage.error(apiError(error, '导出图片失败'))
  }
}

/* ---------------- 键盘与离开保护 ---------------- */

function onKeydown(event) {
  const target = event.target
  const tag = target?.tagName
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || target?.isContentEditable) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    save()
    return
  }
  if (!canManage.value || !selected.value) return
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    removeSelected()
    return
  }
  const step = content.value.mode === 'U' ? HOLES_PER_U : 1
  let { col, hole } = selected.value
  if (event.key === 'ArrowUp') hole -= step
  else if (event.key === 'ArrowDown') hole += step
  else if (event.key === 'ArrowLeft') col -= 1
  else if (event.key === 'ArrowRight') col += 1
  else return
  event.preventDefault()
  const maxHole = Math.max(0, totalHoles(content.value.rack) - selected.value.hU * HOLES_PER_U)
  const nextCol = clampInt(col, 0, H_GRID - selected.value.w)
  const nextHole = clampInt(hole, 0, maxHole)
  if (collides(content.value.devices, nextCol, nextHole, selected.value.w, selected.value.hU, selected.value.id)) return
  selected.value.col = nextCol
  selected.value.hole = nextHole
}

function beforeUnload(event) {
  if (!dirty.value) return
  event.preventDefault()
  event.returnValue = ''
}

onBeforeRouteLeave(async () => {
  if (!dirty.value) return true
  try {
    await ElMessageBox.confirm('当前方案有未保存修改，离开将丢失这些修改。', '未保存修改', {
      type: 'warning', confirmButtonText: '仍然离开', cancelButtonText: '留在本页',
    })
    return true
  } catch {
    return false
  }
})

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', beforeUnload)
  await loadProjects()
  const wanted = Number(route.query.id)
  if (wanted && projects.value.some(item => item.id === wanted)) await openProject(wanted)
  else if (projects.value.length) await openProject(projects.value[0].id)
  else baseline.value = serialize(content.value)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<style scoped>
.rack-page {
  min-height: 0;
}

.hero-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.hero-inline-tag {
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  color: #64748b;
  font-size: 11px;
}

.rack-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.rack-stats .release-stat-card {
  min-height: 72px;
  padding: 12px 14px;
}

.rack-stats .stat-value {
  font-size: 24px;
}

.rack-stats .stat-value small {
  margin-left: 2px;
  font-size: 13px;
  font-weight: 500;
  color: #94a3b8;
}

.rack-hint-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid #dbeafe;
  background: linear-gradient(90deg, #eff6ff 0%, #ffffff 72%);
  font-size: 12px;
  color: #475569;
}

.hint-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.14);
  flex: none;
}

.hint-dot.is-dirty {
  background: #f59e0b;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.16);
}

.hint-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #64748b;
}

.hint-spacer {
  flex: 1;
}

.rack-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}

.rack-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-bottom: 1px solid #e2e8f0;
  background: #ffffff;
}

.rack-toolbar-left,
.rack-toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.rack-project-select {
  width: 210px;
}

.rack-project-meta {
  color: #94a3b8;
  font-size: 11px;
  white-space: nowrap;
}

.project-option-name {
  margin-right: 8px;
}

.project-option-meta {
  color: #94a3b8;
  font-size: 11px;
}

.toolbar-divider {
  width: 1px;
  height: 20px;
  margin: 0 2px;
  background: #e2e8f0;
}

.rack-kind-select {
  width: 84px;
}

.rack-width-select {
  width: 104px;
}

.rack-mode-select {
  width: 106px;
}

.rack-zoom .zoom-value {
  min-width: 54px;
  opacity: 1;
  color: #475569;
}

.rack-body {
  display: grid;
  grid-template-columns: 238px minmax(0, 1fr) 306px;
  height: calc(100vh - 336px);
  min-height: 540px;
}

.rack-stage-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: #f8fafc;
}

.rack-stage-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid #e2e8f0;
  background: #ffffff;
  font-size: 12px;
}

.stage-title {
  font-weight: 600;
  color: #0f172a;
}

.stage-sub {
  color: #94a3b8;
  font-size: 11px;
}

.stage-spacer {
  flex: 1;
}

.rack-props {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid #e2e8f0;
  background: #ffffff;
}

.props-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid #e2e8f0;
}

.props-title {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.props-cat-tag {
  padding: 2px 8px;
  border-radius: 999px;
  color: #ffffff;
  font-size: 11px;
  line-height: 1.5;
}

.props-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
}

.props-form :deep(.el-form-item) {
  margin-bottom: 10px;
}

.props-form :deep(.el-select),
.props-form :deep(.el-input-number) {
  width: 100%;
}

.props-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.props-readonly {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f8fafc;
  font-size: 11px;
  color: #64748b;
}

.props-readonly strong {
  color: #0f172a;
  font-weight: 600;
}

.props-actions {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid #e2e8f0;
}

.props-actions .el-button {
  flex: 1;
  margin-left: 0;
}

.summary-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.summary-grid > div {
  padding: 8px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

.summary-grid span {
  display: block;
  font-size: 10px;
  color: #94a3b8;
}

.summary-grid strong {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: #0f172a;
}

.usage-bar {
  height: 6px;
  margin: 14px 0 6px;
  border-radius: 999px;
  background: #e2e8f0;
  overflow: hidden;
}

.usage-bar span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #3b82f6, #22c55e);
}

.usage-caption {
  font-size: 11px;
  color: #94a3b8;
}

.summary-heading {
  margin: 18px 0 8px;
  font-size: 12px;
  color: #475569;
}

.summary-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.summary-table th {
  padding: 4px 6px;
  text-align: left;
  color: #94a3b8;
  font-weight: 500;
  border-bottom: 1px solid #e2e8f0;
}

.summary-table td {
  padding: 5px 6px;
  color: #334155;
  border-bottom: 1px solid #f1f5f9;
}

.summary-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 2px;
}

.summary-tip {
  margin-top: 12px;
  font-size: 11px;
  line-height: 1.6;
  color: #94a3b8;
}

.dialog-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.hidden-file {
  display: none;
}

.import-summary {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.import-rows {
  max-height: 300px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}

.import-rows li {
  padding: 4px 6px;
  border-bottom: 1px solid #f1f5f9;
  color: #475569;
}

.import-rows li.is-ok {
  color: #15803d;
}

.import-rows li.is-warn {
  color: #b45309;
}

.import-rows li.is-unknown {
  color: #7c3aed;
}

.import-rows li.is-error {
  color: #dc2626;
}

.import-rows li.is-indent {
  color: #94a3b8;
  padding-left: 18px;
}

.conflict-text {
  margin: 0 0 6px;
  font-size: 13px;
  color: #0f172a;
}

.text-muted {
  color: #94a3b8;
  font-size: 12px;
}

@media (max-width: 1440px) {
  .rack-body {
    grid-template-columns: 220px minmax(0, 1fr) 286px;
  }
}

@media (max-width: 1180px) {
  .rack-body {
    grid-template-columns: 200px minmax(0, 1fr);
    height: auto;
  }

  .rack-props {
    grid-column: 1 / -1;
    border-left: none;
    border-top: 1px solid #e2e8f0;
  }
}
</style>