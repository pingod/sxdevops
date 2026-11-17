<template>
  <div class="twin-page workbench-page-shell">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon">
          <el-icon><Box /></el-icon>
        </span>
        <h2>数字孪生</h2>
        <p class="page-inline-desc">只读三维机房查看器：视角、显示、剖切、定位、漫游与拆解</p>
      </div>
    </section>

    <section class="panel twin-stage workbench-fill-panel">
      <div class="twin-toolbar">
        <div class="twin-toolbar__left">
          <el-select
            v-model="selectedId"
            class="twin-select"
            placeholder="选择三维项目"
            :disabled="!projects.length || loading"
            filterable
            @change="openProject"
          >
            <el-option v-for="item in projects" :key="item.id" :label="item.name" :value="item.id">
              <span class="twin-option-name">{{ item.name }}</span>
              <span class="twin-option-meta">{{ item.object_count }} 对象</span>
            </el-option>
          </el-select>
          <span v-if="selectedProject" class="twin-meta">
            {{ selectedProject.object_count }} 个对象 · {{ formatBytes(selectedProject.size_bytes) }}
            <template v-if="selectedProject.uploaded_by"> · {{ selectedProject.uploaded_by }} 上传</template>
            · {{ formatTime(selectedProject.updated_at) }}
          </span>
        </div>
        <div class="twin-toolbar__right">
          <el-button v-if="canManage" :icon="EditPen" @click="$router.push('/datacenter/twin-design')">设计</el-button>
          <el-button v-if="canManage" type="primary" :icon="Upload" @click="openUploadDialog">上传项目</el-button>
          <el-button v-if="canManage" :icon="Delete" :disabled="!selectedProject || loading" @click="removeProject">删除</el-button>
          <el-button :icon="RefreshRight" :loading="loading" @click="reloadAll">刷新</el-button>
        </div>
      </div>

      <div class="twin-body">
        <iframe
          v-if="frameSrc && viewerBuilt"
          :key="frameSrc"
          class="twin-frame"
          :src="frameSrc"
          title="三维机房查看器"
          sandbox="allow-scripts allow-same-origin allow-downloads"
          referrerpolicy="no-referrer"
          @load="onFrameLoad"
        />
        <div v-else class="twin-placeholder">
          <el-icon :size="38"><Box /></el-icon>
          <strong>{{ placeholderTitle }}</strong>
          <p>{{ placeholderText }}</p>
          <el-button v-if="canManage && !projects.length && viewerBuilt" type="primary" plain @click="openUploadDialog">
            上传第一个项目
          </el-button>
        </div>
      </div>
    </section>

    <el-dialog
      v-model="uploadDialog"
      title="上传三维机房项目"
      width="640px"
      top="5vh"
      append-to-body
      class="workbench-edit-dialog"
      :close-on-click-modal="false"
      @closed="resetUpload"
    >
      <el-form label-position="top" class="twin-upload-form">
        <el-form-item label="项目文件">
          <label class="twin-file-drop" :class="{ 'is-filled': uploadFile }">
            <input type="file" accept=".json,application/json" @change="onFileChange">
            <el-icon :size="22"><FolderOpened /></el-icon>
            <span class="twin-file-name">{{ uploadFile ? uploadFile.name : '选择 DCDesigner 项目 JSON' }}</span>
            <span class="twin-file-hint">{{ fileHint }}</span>
          </label>
        </el-form-item>
        <el-form-item label="项目名称">
          <el-input v-model="uploadName" maxlength="120" show-word-limit placeholder="默认取项目文件内的 name 字段" />
        </el-form-item>
        <el-form-item label="说明（可选）">
          <el-input v-model="uploadDescription" maxlength="255" placeholder="如：403 房一期，含 A/B 通道" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="uploadDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!uploadFile" @click="submitUpload">上传</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Box, Delete, EditPen, FolderOpened, RefreshRight, Upload } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import {
  deleteTwinProject,
  fetchTwinProjectContent,
  getTwinViewerStatus,
  listTwinProjects,
  uploadTwinProject,
} from '@/api/modules/datacenter'

const FALLBACK_VIEWER_PATH = '/dc-viewer-app/'
const DEFAULT_MAX_UPLOAD_BYTES = 16 * 1024 * 1024

const authStore = useAuthStore()
const canManage = computed(() => authStore.hasPermission('datacenter.twin.manage'))

const status = ref(null)
const projects = ref([])
const selectedId = ref(null)
const selectedProject = computed(() => projects.value.find(item => item.id === selectedId.value) || null)
const viewerBuilt = computed(() => status.value?.viewer_built ?? true)
const viewerPath = computed(() => status.value?.viewer_path || FALLBACK_VIEWER_PATH)
const maxUploadBytes = computed(() => status.value?.max_upload_bytes || DEFAULT_MAX_UPLOAD_BYTES)

const loading = ref(false)
const errorText = ref('')
const frameSrc = ref('')
let blobUrls = []
let activeBlobUrl = ''

const uploadDialog = ref(false)
const uploadFile = ref(null)
const uploadName = ref('')
const uploadDescription = ref('')
const uploadParsed = ref(null)
const saving = ref(false)

const fileHint = computed(() => {
  if (!uploadFile.value) return `UTF-8 JSON，上限 ${formatBytes(maxUploadBytes.value)}`
  const parsed = uploadParsed.value
  const count = parsed ? `${parsed.count} 个对象 · ` : ''
  return `${count}${formatBytes(uploadFile.value.size)}`
})

const placeholderTitle = computed(() => {
  if (errorText.value) return '项目加载失败'
  if (!viewerBuilt.value) return '三维查看器未构建'
  if (!projects.value.length) return '还没有三维机房项目'
  return '正在加载项目'
})

const placeholderText = computed(() => {
  if (errorText.value) return errorText.value
  if (!viewerBuilt.value) {
    return '请在 tools/dc-viewer 执行 npm install && npm run build，产物由 /dc-viewer-app/ 托管。'
  }
  if (!projects.value.length) {
    return canManage.value
      ? '上传一份 DCDesigner 导出的项目 JSON 后即可查看三维机房。'
      : '请联系管理员上传三维机房项目。'
  }
  return '正在读取项目文件，请稍候。'
})

function formatBytes(value) {
  const size = Number(value) || 0
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { hour12: false })
}

function releaseBlobs(keep = '') {
  blobUrls = blobUrls.filter((url) => {
    if (url === keep) return true
    URL.revokeObjectURL(url)
    return false
  })
}

function onFrameLoad() {
  releaseBlobs(activeBlobUrl)
}

async function loadStatus() {
  try {
    status.value = await getTwinViewerStatus()
  } catch {
    status.value = null
  }
}

async function refreshProjects({ keepSelection = true } = {}) {
  const data = await listTwinProjects()
  projects.value = data.results || data || []
  if (!projects.value.length) {
    selectedId.value = null
    frameSrc.value = ''
    return
  }
  if (!keepSelection || !projects.value.some(item => item.id === selectedId.value)) {
    selectedId.value = projects.value[0].id
  }
}

async function openProject(id) {
  if (!id) return
  loading.value = true
  errorText.value = ''
  try {
    const text = await fetchTwinProjectContent(id)
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    blobUrls.push(url)
    activeBlobUrl = url
    frameSrc.value = `${viewerPath.value}?src=${encodeURIComponent(url)}`
  } catch (error) {
    errorText.value = error?.response?.data?.detail || error?.message || '项目文件读取失败'
    frameSrc.value = ''
  } finally {
    loading.value = false
  }
}

async function reloadAll() {
  try {
    errorText.value = ''
    await refreshProjects()
    if (selectedId.value) await openProject(selectedId.value)
  } catch (error) {
    errorText.value = error?.response?.data?.detail || error?.message || '项目列表加载失败'
    ElMessage.error(errorText.value)
  }
}

async function removeProject() {
  const project = selectedProject.value
  if (!project) return
  try {
    await ElMessageBox.confirm(
      `删除项目「${project.name}」后不可恢复，确定继续？`,
      '删除三维项目',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  loading.value = true
  try {
    await deleteTwinProject(project.id)
    ElMessage.success(`已删除项目「${project.name}」`)
    selectedId.value = null
    frameSrc.value = ''
    releaseBlobs()
    await refreshProjects({ keepSelection: false })
    if (selectedId.value) await openProject(selectedId.value)
  } catch (error) {
    ElMessage.error(error?.response?.data?.detail || error?.message || '删除失败')
  } finally {
    loading.value = false
  }
}

function openUploadDialog() {
  uploadDialog.value = true
}

function resetUpload() {
  uploadFile.value = null
  uploadName.value = ''
  uploadDescription.value = ''
  uploadParsed.value = null
  saving.value = false
}

function onFileChange(event) {
  const input = event.target
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > maxUploadBytes.value) {
    ElMessage.error(`项目文件超过 ${formatBytes(maxUploadBytes.value)} 上限`)
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || ''))
      const objects = Array.isArray(data?.objects) ? data.objects : null
      if (!objects?.length) throw new Error('缺少非空的 objects 数组')
      if (!objects.some(item => item?.type === 'cabinet')) throw new Error('没有任何 cabinet 对象')
      uploadFile.value = file
      uploadParsed.value = { count: objects.length, name: typeof data.name === 'string' ? data.name.trim() : '' }
      if (!uploadName.value) {
        uploadName.value = (uploadParsed.value.name || file.name.replace(/\.json$/i, '')).slice(0, 120)
      }
    } catch (error) {
      uploadFile.value = null
      uploadParsed.value = null
      ElMessage.error(`项目文件校验失败：${error.message}`)
    }
  }
  reader.onerror = () => ElMessage.error('项目文件读取失败')
  reader.readAsText(file)
}

async function submitUpload() {
  if (!uploadFile.value) return
  saving.value = true
  try {
    const formData = new FormData()
    formData.append('file', uploadFile.value)
    if (uploadName.value.trim()) formData.append('name', uploadName.value.trim())
    if (uploadDescription.value.trim()) formData.append('description', uploadDescription.value.trim())
    const project = await uploadTwinProject(formData)
    ElMessage.success(`已上传项目「${project.name}」`)
    uploadDialog.value = false
    await refreshProjects({ keepSelection: false })
    selectedId.value = project.id
    await openProject(project.id)
  } catch (error) {
    const detail = error?.response?.data
    const message = detail?.file?.[0] || detail?.name?.[0] || detail?.detail || error?.message || '上传失败'
    ElMessage.error(message)
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await loadStatus()
  try {
    await refreshProjects({ keepSelection: false })
    if (selectedId.value) await openProject(selectedId.value)
  } catch (error) {
    errorText.value = error?.response?.data?.detail || error?.message || '项目列表加载失败'
  }
})

onBeforeUnmount(() => {
  releaseBlobs()
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

.twin-stage {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  padding: 0;
}

.twin-toolbar {
  align-items: center;
  border-bottom: 1px solid #eef2f7;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
  padding: 10px 12px;
}

.twin-toolbar__left {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
}

.twin-toolbar__right {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.twin-select {
  width: 300px;
}

.twin-option-name {
  font-weight: 600;
}

.twin-option-meta {
  color: #94a3b8;
  float: right;
  font-size: 12px;
  margin-left: 12px;
}

.twin-meta {
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.twin-body {
  flex: 1;
  min-height: 320px;
  position: relative;
}

.twin-frame {
  border: 0;
  border-radius: 0 0 11px 11px;
  display: block;
  height: 100%;
  inset: 0;
  position: absolute;
  width: 100%;
}

.twin-placeholder {
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

.twin-placeholder strong {
  color: #334155;
  font-size: 15px;
}

.twin-placeholder p {
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
  max-width: 480px;
}

.twin-upload-form :deep(.el-form-item:last-child) {
  margin-bottom: 0;
}

.twin-file-drop {
  align-items: center;
  background: linear-gradient(180deg, #fbfdff 0%, #f7faff 100%);
  border: 1px dashed rgba(36, 91, 219, 0.28);
  border-radius: 12px;
  color: #245bdb;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px 16px;
  text-align: center;
  width: 100%;
}

.twin-file-drop.is-filled {
  border-style: solid;
  border-color: rgba(36, 91, 219, 0.4);
}

.twin-file-drop input {
  display: none;
}

.twin-file-name {
  color: #0f172a;
  font-size: 13px;
  font-weight: 600;
  word-break: break-all;
}

.twin-file-hint {
  color: #64748b;
  font-size: 12px;
}

@media (max-width: 760px) {
  .twin-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .twin-select {
    width: 100%;
  }

  .twin-meta {
    white-space: normal;
  }
}
</style>
