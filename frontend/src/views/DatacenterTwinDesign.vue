<template>
  <div class="twin-design-page workbench-page-shell">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon">
          <el-icon><EditPen /></el-icon>
        </span>
        <h2>三维机房设计</h2>
        <p class="page-inline-desc">拖放机柜、画墙体与桥架，保存后即为数字孪生展示的三维机房</p>
      </div>
    </section>

    <section class="panel design-stage workbench-fill-panel">
      <div class="design-toolbar">
        <div class="design-toolbar__left">
          <el-select
            v-model="selectedId"
            class="design-select"
            placeholder="选择项目"
            :disabled="!projects.length"
            filterable
            @change="switchProject"
          >
            <el-option v-for="item in projects" :key="item.id" :label="item.name" :value="item.id">
              <span class="design-option">{{ item.name }}</span>
              <span class="design-option__meta">{{ item.object_count }} 对象</span>
            </el-option>
          </el-select>
          <el-input
            v-model="search"
            class="design-search"
            placeholder="搜索项目名称/说明"
            clearable
            :prefix-icon="Search"
            @update:model-value="onSearchInput"
          />
          <el-button v-if="hasMore" text :loading="loadingList" @click="loadMore">加载更多</el-button>
          <span class="design-meta">
            <template v-if="currentProject">
              {{ currentProject.object_count }} 个对象 · v{{ currentProject.version }} ·
              {{ formatTime(currentProject.updated_at) }}
            </template>
            <template v-else>新建设计，保存后进入项目库</template>
            <span v-if="dirty" class="design-dirty">未保存</span>
          </span>
        </div>
        <div class="design-toolbar__right">
          <el-button :icon="Plus" @click="openRoomDialog">新建机房</el-button>
          <el-button :icon="DocumentAdd" @click="saveAs">另存为</el-button>
          <el-button v-if="canManage" :icon="Clock" :disabled="!currentProject" @click="openVersions">版本</el-button>
          <el-button type="primary" :icon="Check" :loading="saving" @click="save">保存</el-button>
          <el-button :icon="View" @click="backToViewer">查看孪生</el-button>
        </div>
      </div>

      <div class="design-body">
        <iframe
          v-if="viewerBuilt"
          ref="frameRef"
          class="design-frame"
          src="/dc-viewer-app/design.html"
          title="三维机房设计器"
          sandbox="allow-scripts allow-same-origin allow-downloads"
          referrerpolicy="no-referrer"
        />
        <div v-else class="design-placeholder">
          <el-icon :size="38"><EditPen /></el-icon>
          <strong>三维设计器未构建</strong>
          <p>请在 tools/dc-viewer 执行 npm install && npm run build，产物由 /dc-viewer-app/ 托管。</p>
        </div>
      </div>
    </section>

    <el-dialog
      v-model="roomDialog.visible"
      title="新建机房"
      width="560px"
      top="5vh"
      append-to-body
      class="workbench-edit-dialog"
      :close-on-click-modal="false"
    >
      <el-form label-position="top" class="design-form">
        <el-form-item label="机房名称">
          <el-input v-model="roomDialog.name" maxlength="120" placeholder="如：403 房一期" />
        </el-form-item>
        <div class="design-form-row">
          <el-form-item label="房间宽（mm）">
            <el-input-number v-model="roomDialog.width" :min="2000" :max="60000" :step="1000" controls-position="right" />
          </el-form-item>
          <el-form-item label="房间深（mm）">
            <el-input-number v-model="roomDialog.depth" :min="2000" :max="60000" :step="1000" controls-position="right" />
          </el-form-item>
        </div>
        <div class="design-form-row">
          <el-form-item label="层高（mm）">
            <el-input-number v-model="roomDialog.height" :min="2000" :max="12000" :step="100" controls-position="right" />
          </el-form-item>
          <el-form-item label="架空地板（mm）">
            <el-input-number v-model="roomDialog.floorHeight" :min="0" :max="1500" :step="50" controls-position="right" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="roomDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="createRoom">创建并编辑</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="saveDialog.visible"
      title="保存三维机房项目"
      width="560px"
      top="5vh"
      append-to-body
      class="workbench-edit-dialog"
      :close-on-click-modal="false"
      @closed="onSaveDialogClosed"
    >
      <el-form label-position="top" class="design-form">
        <el-form-item label="项目名称">
          <el-input v-model="saveDialog.name" maxlength="120" show-word-limit placeholder="项目库中的名称" />
        </el-form-item>
        <el-form-item label="说明（可选）">
          <el-input v-model="saveDialog.description" maxlength="255" placeholder="如：一期方案，含 A/B 通道" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="saveDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!saveDialog.name.trim()" @click="confirmCreate">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="versionDialog.visible"
      title="版本历史"
      width="620px"
      top="8vh"
      append-to-body
      class="workbench-edit-dialog"
    >
      <el-table :data="versionDialog.rows" size="small" empty-text="还没有历史版本（保存两次以上才会产生）">
        <el-table-column prop="version" label="版本" width="80" />
        <el-table-column prop="object_count" label="对象数" width="90" />
        <el-table-column label="文件大小" width="110">
          <template #default="{ row }">{{ formatBytes(row.size_bytes) }}</template>
        </el-table-column>
        <el-table-column prop="created_by" label="保存人" width="120" />
        <el-table-column label="时间">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button link type="primary" @click="rollbackTo(row.version)">回滚</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="versionDialog.visible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, Clock, DocumentAdd, EditPen, Plus, Search, View } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { theme, THEME_CHANGE_EVENT } from '@/theme'
import { useTwinProjects } from '@/composables/useTwinProjects'
import {
  fetchTwinProjectContent,
  getTwinViewerStatus,
  listTwinMonitorTargets,
  listTwinVersions,
  rollbackTwinProject,
  updateTwinProject,
  uploadTwinProject,
} from '@/api/modules/datacenter'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const canManage = computed(() => authStore.hasPermission('datacenter.twin.manage'))

const {
  projects, loading: loadingList, search, selectedId, selected: currentProject,
  hasMore, refresh, loadMore, ensureSelection,
} = useTwinProjects({ pageSize: 50 })

const frameRef = ref()
const viewerBuilt = ref(true)
const frameReady = ref(false)
const saving = ref(false)
const dirty = ref(false)
const pendingMessage = shallowRef(null)
const pendingPayload = ref(null)
const saveAsMode = ref(false)
let loadToken = 0
let searchTimer = null
let readyTimer = null
// 是否已经把某个项目推给设计器：ready 与列表加载是两条独立时序，
// 谁先到都可能；用这个标记保证「后到的一方」补一次加载，且不覆盖用户刚新建的机房。
let designerLoaded = false

const roomDialog = reactive({
  visible: false, name: '', width: 12000, depth: 8000, height: 3000, floorHeight: 400,
})
const saveDialog = reactive({ visible: false, name: '', description: '', project: null })
const versionDialog = reactive({ visible: false, rows: [] })

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatBytes(value) {
  const size = Number(value) || 0
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

function frameWindow() {
  return frameRef.value?.contentWindow || null
}

function post(message) {
  frameWindow()?.postMessage(message, '*')
}

/** 设计器还没握手完成时先排队，避免用户点了按钮却什么都没发生。 */
function send(message) {
  if (frameReady.value) post(message)
  else pendingMessage.value = message
}

function syncQuery(id) {
  const next = { ...route.query }
  if (id) next.project = String(id)
  else delete next.project
  const current = route.query.project ? String(route.query.project) : ''
  if (current === (id ? String(id) : '')) return
  router.replace({ query: next }).catch(() => {})
}

async function loadStatus() {
  try {
    const status = await getTwinViewerStatus()
    viewerBuilt.value = status.viewer_built !== false
  } catch {
    viewerBuilt.value = true
  }
}

/** 绑定下拉需要网络设备清单：进了设计器就拉一次，父页面转给 iframe。 */
async function pushMonitorTargets() {
  try {
    const data = await listTwinMonitorTargets()
    post({ type: 'monitor-targets', items: data.items || [] })
  } catch {
    post({ type: 'monitor-targets', items: [] })
  }
}

function onDesignerMessage(event) {
  const frame = frameWindow()
  if (!frame || event.source !== frame) return
  const data = event.data || {}
  if (data.source !== 'dc-designer') return

  if (data.type === 'ready') {
    clearTimeout(readyTimer)
    frameReady.value = true
    post({ type: 'theme', theme: theme.value })
    pushMonitorTargets()
    if (pendingMessage.value) {
      post(pendingMessage.value)
      pendingMessage.value = null
    } else if (pendingPayload.value) {
      post(pendingPayload.value)
      pendingPayload.value = null
    } else if (selectedId.value) {
      loadProject(selectedId.value, { token: ++loadToken })
    } else if (projects.value.length) {
      loadProject(projects.value[0].id, { token: ++loadToken })
    }
    return
  }
  if (data.type === 'dirty') {
    dirty.value = Boolean(data.dirty)
    return
  }
  if (data.type === 'save' && data.project) {
    handleSave(data.project)
    return
  }
  if (data.type === 'error') {
    ElMessage.error(data.message || '三维设计器初始化失败')
  }
}

function onThemeChange(event) {
  post({ type: 'theme', theme: event?.detail || theme.value })
}

onMounted(async () => {
  window.addEventListener('message', onDesignerMessage)
  window.addEventListener(THEME_CHANGE_EVENT, onThemeChange)
  readyTimer = setTimeout(() => {
    if (!frameReady.value) {
      ElMessage.warning('三维设计器初始化较慢或失败，请确认浏览器已开启硬件加速（需要 WebGL2）')
    }
  }, 12000)
  await loadStatus()
  try {
    await refresh()
    const preferred = Number(route.query.project)
    ensureSelection(Number.isFinite(preferred) && preferred > 0 ? preferred : null)
    // 设计器可能比项目列表先握手完成，这里补一次加载。
    if (frameReady.value && !designerLoaded && !dirty.value && selectedId.value) {
      await loadProject(selectedId.value, { token: ++loadToken })
    }
  } catch (error) {
    ElMessage.error(error?.response?.data?.detail || error?.message || '项目列表加载失败')
  }
})

onBeforeUnmount(() => {
  clearTimeout(readyTimer)
  clearTimeout(searchTimer)
  window.removeEventListener('message', onDesignerMessage)
  window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange)
})

async function loadProject(id, { token } = {}) {
  if (!id) return
  const mine = token ?? ++loadToken
  try {
    const text = await fetchTwinProjectContent(id)
    if (mine !== loadToken) return
    const project = JSON.parse(text)
    selectedId.value = id
    dirty.value = false
    designerLoaded = true
    syncQuery(id)
    post({ type: 'load', project, id, name: currentProject.value?.name, force: true })
  } catch (error) {
    ElMessage.error(error?.response?.data?.detail || error?.message || '项目内容加载失败')
  }
}

async function switchProject(id) {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('当前改动尚未保存，切换项目会丢弃，确定继续？', '切换项目', {
        type: 'warning', confirmButtonText: '继续', cancelButtonText: '取消',
      })
    } catch {
      selectedId.value = currentProject.value?.id ?? null
      return
    }
  }
  await loadProject(id)
}

function onSearchInput() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    try {
      await refresh()
      ensureSelection()
    } catch (error) {
      ElMessage.error(error?.response?.data?.detail || error?.message || '项目列表加载失败')
    }
  }, 300)
}

function openRoomDialog() {
  roomDialog.name = ''
  roomDialog.visible = true
}

async function createRoom() {
  loadToken += 1
  roomDialog.visible = false
  selectedId.value = null
  dirty.value = false
  designerLoaded = false
  syncQuery(null)
  send({
    type: 'new-room',
    name: roomDialog.name.trim() || '未命名机房',
    width: roomDialog.width,
    depth: roomDialog.depth,
    height: roomDialog.height,
    floorHeight: roomDialog.floorHeight,
  })
}

function save() {
  saveAsMode.value = false
  send({ type: 'request-save' })
}

function saveAs() {
  saveAsMode.value = true
  send({ type: 'request-save' })
}

function projectFileName(name) {
  const safe = String(name || 'room').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
  return `${safe || 'room'}.json`
}

function onSaveDialogClosed() {
  // 关掉「另存为」弹窗却没有真的保存：通知设计器清掉忙碌态。
  if (!saveDialog.project) return
  saveDialog.project = null
  post({ type: 'cancel' })
}

function openSaveDialog(project) {
  saveDialog.project = project
  saveDialog.name = (project.name || '').slice(0, 120) || '未命名机房'
  saveDialog.description = ''
  saveDialog.visible = true
}

/** 版本冲突：让用户选「加载最新」或「另存为副本」，绝不静默覆盖。 */
async function handleConflict(project, detail) {
  const who = detail?.updated_by || '其他人'
  const version = detail?.current_version ?? '?'
  const when = formatTime(detail?.updated_at)
  try {
    await ElMessageBox.confirm(
      `项目已被 ${who} 更新到 v${version}${when ? `（${when}）` : ''}。\n`
      + '「加载最新」会放弃你未保存的改动；「另存为副本」把当前内容保存成新项目。',
      '版本冲突',
      {
        type: 'warning',
        confirmButtonText: '加载最新',
        cancelButtonText: '另存为副本',
        distinguishCancelAndClose: true,
      },
    )
  } catch (action) {
    post({ type: 'cancel' })
    if (action === 'cancel') {
      saveAsMode.value = true
      openSaveDialog(project)
    }
    return
  }
  await refresh()
  await loadProject(selectedId.value, { token: ++loadToken })
  ElMessage.success('已加载最新版本')
}

async function handleSave(project) {
  const useExisting = selectedId.value && !saveAsMode.value
  if (!useExisting) {
    openSaveDialog(project)
    return
  }
  saving.value = true
  try {
    const updated = await updateTwinProject(selectedId.value, {
      project,
      base_version: currentProject.value?.version ?? 1,
    })
    await refresh()
    post({ type: 'saved', id: updated.id, name: updated.name })
    dirty.value = false
    ElMessage.success(`已保存「${updated.name}」v${updated.version}`)
  } catch (error) {
    const status = error?.response?.status
    const detail = error?.response?.data
    if (status === 409) {
      saving.value = false
      await handleConflict(project, detail)
      return
    }
    const message = detail?.project?.[0] || detail?.base_version?.[0] || detail?.detail
      || detail?.name?.[0] || error?.message || '保存失败'
    post({ type: 'error', message })
    ElMessage.error(message)
  } finally {
    saving.value = false
  }
}

async function confirmCreate() {
  const project = saveDialog.project
  if (!project) return
  saving.value = true
  try {
    const formData = new FormData()
    formData.append('file', new File([JSON.stringify(project)], projectFileName(saveDialog.name), { type: 'application/json' }))
    formData.append('name', saveDialog.name.trim())
    if (saveDialog.description.trim()) formData.append('description', saveDialog.description.trim())
    const created = await uploadTwinProject(formData)
    saveDialog.project = null
    saveDialog.visible = false
    saveAsMode.value = false
    selectedId.value = created.id
    dirty.value = false
    await refresh()
    syncQuery(created.id)
    post({ type: 'saved', id: created.id, name: created.name })
    ElMessage.success(`已保存到项目库「${created.name}」`)
  } catch (error) {
    const detail = error?.response?.data
    const message = detail?.file?.[0] || detail?.name?.[0] || detail?.detail || error?.message || '保存失败'
    post({ type: 'error', message })
    ElMessage.error(message)
  } finally {
    saving.value = false
  }
}

async function openVersions() {
  if (!selectedId.value) return
  try {
    const rows = await listTwinVersions(selectedId.value)
    versionDialog.rows = Array.isArray(rows) ? rows : (rows.results || [])
    versionDialog.visible = true
  } catch (error) {
    ElMessage.error(error?.response?.data?.detail || error?.message || '版本列表加载失败')
  }
}

async function rollbackTo(version) {
  if (!selectedId.value) return
  try {
    await ElMessageBox.confirm(
      `回滚到 v${version} 会把该版本内容写成新版本（当前内容仍保留在历史里），确定继续？`,
      '回滚版本',
      { type: 'warning', confirmButtonText: '回滚', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  saving.value = true
  try {
    const updated = await rollbackTwinProject(selectedId.value, version)
    ElMessage.success(`已回滚到 v${version}，当前 v${updated.version}`)
    await refresh()
    await loadProject(selectedId.value, { token: ++loadToken })
    await openVersions()
  } catch (error) {
    ElMessage.error(error?.response?.data?.detail || error?.message || '回滚失败')
  } finally {
    saving.value = false
  }
}

async function backToViewer() {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('当前改动尚未保存，离开会丢弃，确定继续？', '离开设计器', {
        type: 'warning', confirmButtonText: '离开', cancelButtonText: '取消',
      })
    } catch {
      return
    }
  }
  router.push(selectedId.value ? `/datacenter/twin?project=${selectedId.value}` : '/datacenter/twin')
}
</script>

<style scoped>
.twin-design-page {
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

.design-stage {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  padding: 0;
}

.design-toolbar {
  align-items: center;
  border-bottom: 1px solid #eef2f7;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
  padding: 10px 12px;
}

.design-toolbar__left {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
}

.design-toolbar__right {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.design-select {
  width: 280px;
}

.design-search {
  width: 200px;
}

.design-option {
  font-weight: 600;
}

.design-option__meta {
  color: #94a3b8;
  float: right;
  font-size: 12px;
  margin-left: 12px;
}

.design-meta {
  align-items: center;
  color: #64748b;
  display: inline-flex;
  font-size: 12px;
  gap: 8px;
  min-width: 0;
}

.design-dirty {
  background: #fff4e5;
  border: 1px solid #f3c98b;
  border-radius: 999px;
  color: #9a5b00;
  font-size: 11px;
  padding: 1px 8px;
}

.design-body {
  flex: 1;
  min-height: 420px;
  position: relative;
}

.design-frame {
  border: 0;
  border-radius: 0 0 11px 11px;
  display: block;
  height: 100%;
  inset: 0;
  position: absolute;
  width: 100%;
}

.design-placeholder {
  align-items: center;
  color: #64748b;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  justify-content: center;
  padding: 24px;
  text-align: center;
}

.design-placeholder strong {
  color: #334155;
  font-size: 15px;
}

.design-placeholder p {
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
  max-width: 480px;
}

.design-form-row {
  display: grid;
  gap: 12px;
  grid-template-columns: 1fr 1fr;
}

.design-form :deep(.el-input-number) {
  width: 100%;
}

@media (max-width: 760px) {
  .design-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .design-select,
  .design-search {
    width: 100%;
  }

  .design-form-row {
    grid-template-columns: 1fr;
  }
}
</style>
