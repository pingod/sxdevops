<template>
  <div class="planning-page workbench-page-shell">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon">
          <el-icon><OfficeBuilding /></el-icon>
        </span>
        <h2>IDC 上架布线</h2>
        <p class="page-inline-desc">机柜上架、布线规划与标签导出的一体化工作台</p>
      </div>
    </section>

    <section class="panel engine-strip">
      <div class="engine-strip__status">
        <span class="engine-dot" :class="`engine-dot--${statusTone}`" aria-hidden="true"></span>
        <strong>{{ statusLabel }}</strong>
        <span v-if="statusHint" class="engine-strip__hint" :title="statusHint">{{ statusHint }}</span>
      </div>
      <div class="engine-strip__actions">
        <el-button size="small" :loading="statusLoading" @click="loadStatus">
          <el-icon><RefreshRight /></el-icon>刷新状态
        </el-button>
        <el-button size="small" plain :disabled="!engineReady" @click="openExternal">新窗口打开</el-button>
      </div>
    </section>

    <section class="panel engine-stage workbench-fill-panel">
      <iframe
        v-if="engineReady"
        class="engine-frame"
        src="/planning-app/"
        title="IDC 上架布线引擎"
        sandbox="allow-scripts allow-same-origin allow-downloads"
        referrerpolicy="no-referrer"
      />
      <div v-else class="engine-placeholder">
        <el-icon :size="40"><OfficeBuilding /></el-icon>
        <strong>{{ statusLabel }}</strong>
        <p>{{ placeholderText }}</p>
        <el-button size="small" type="primary" plain :loading="statusLoading" @click="loadStatus">重新检测</el-button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { OfficeBuilding, RefreshRight } from '@element-plus/icons-vue'
import { getPlanningStatus } from '@/api/modules/planning'

const RETRY_INTERVAL = 10000

const status = ref(null)
const statusLoading = ref(false)
const statusError = ref('')
let retryTimer = null

const engineReady = computed(() => status.value?.state === 'up' && status.value?.static_built)

const statusTone = computed(() => {
  if (statusError.value) return 'down'
  if (!status.value) return 'loading'
  if (!status.value.enabled || status.value.error) return 'disabled'
  if (status.value.state !== 'up') return 'down'
  return status.value.static_built ? 'up' : 'disabled'
})

const statusLabel = computed(() => {
  if (statusError.value) return '状态查询失败'
  if (!status.value) return '引擎状态检测中'
  if (!status.value.enabled) return '引擎未启用'
  if (status.value.error) return '引擎配置异常'
  if (status.value.state !== 'up') return '引擎离线'
  return status.value.static_built ? '引擎运行中' : '前端资源未构建'
})

const statusHint = computed(() => {
  if (statusError.value) return statusError.value
  if (!status.value) return ''
  if (status.value.error) return status.value.error
  if (status.value.state === 'up' && !status.value.static_built) return '在 planning/web 目录执行 pnpm build 后刷新'
  if (status.value.state === 'up') return '规划数据保存在服务端，可直接开始上架布线'
  return ''
})

const placeholderText = computed(() => {
  if (statusError.value) return '无法获取引擎状态，请确认平台服务正常后重试。'
  if (!status.value) return '正在检测引擎状态，请稍候。'
  if (!status.value.enabled) return 'IDC 规划引擎未启用。启用后这里会嵌入完整的上架布线工作台。'
  if (status.value.error) return '引擎配置存在异常，请根据上方提示处理后重试。'
  if (status.value.state !== 'up') return '引擎暂时不可达，可能是进程启动中或已退出，可点击重新检测。'
  return '引擎已运行，但前端静态资源尚未构建，构建完成后这里会自动可用。'
})

async function loadStatus() {
  statusLoading.value = true
  try {
    status.value = await getPlanningStatus()
    statusError.value = ''
  } catch (error) {
    statusError.value = error?.response?.data?.detail || error?.message || '请求失败'
  } finally {
    statusLoading.value = false
    scheduleRetry()
  }
}

function scheduleRetry() {
  if (retryTimer) clearTimeout(retryTimer)
  // 引擎未就绪时定时重检，覆盖 sidecar 启动窗口；就绪后停止轮询
  if (!engineReady.value) retryTimer = setTimeout(loadStatus, RETRY_INTERVAL)
}

function openExternal() {
  window.open('/planning-app/', '_blank', 'noopener')
}

onMounted(loadStatus)
onBeforeUnmount(() => {
  if (retryTimer) clearTimeout(retryTimer)
})
</script>

<style scoped>
.planning-page {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: var(--page-content-height);
  min-height: 0;
  overflow: hidden;
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

.engine-strip {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
  padding: 8px 14px;
}

.engine-strip__status {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.engine-strip__status strong {
  font-size: 13px;
}

.engine-strip__hint {
  color: #64748b;
  font-size: 12px;
  max-width: 520px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.engine-dot {
  border-radius: 50%;
  height: 8px;
  width: 8px;
}

.engine-dot--up {
  background: #16a34a;
}

.engine-dot--down {
  background: #dc2626;
}

.engine-dot--disabled {
  background: #94a3b8;
}

.engine-dot--loading {
  background: #245bdb;
}

.engine-strip__actions {
  align-items: center;
  display: flex;
  gap: 8px;
}

.engine-stage {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  position: relative;
}

.engine-frame {
  border: 0;
  border-radius: 11px;
  display: block;
  height: 100%;
  inset: 0;
  position: absolute;
  width: 100%;
}

.engine-placeholder {
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

.engine-placeholder strong {
  color: #334155;
  font-size: 15px;
}

.engine-placeholder p {
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
  max-width: 460px;
}

@media (max-width: 760px) {
  .engine-strip {
    align-items: stretch;
    flex-direction: column;
  }

  .engine-strip__hint {
    max-width: none;
    white-space: normal;
  }
}
</style>