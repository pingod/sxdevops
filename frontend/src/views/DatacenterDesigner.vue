<template>
  <div class="cad-designer-page workbench-page-shell">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon">
          <el-icon><EditPen /></el-icon>
        </span>
        <h2>机房 CAD 设计</h2>
        <p class="page-inline-desc">
          高级/离线设计工作台：16 类构件、检查与 DXF/CSV 导出；平台项目库请用「三维机房设计」
          <a class="page-inline-link" href="/dc-designer-app/" target="_blank" rel="noopener">在新窗口打开</a>
        </p>
      </div>
    </section>

    <section class="panel cad-designer-stage workbench-fill-panel">
      <iframe
        v-if="built"
        class="cad-designer-frame"
        src="/dc-designer-app/?embed=1&lang=zh-CN"
        title="机房 CAD 设计器"
        referrerpolicy="no-referrer"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
      <div v-else class="cad-designer-placeholder">
        <el-icon :size="38"><EditPen /></el-icon>
        <strong>机房设计器未构建</strong>
        <p>请在 tools/dc-designer 执行 npm install && npm run build，产物由 /dc-designer-app/ 托管。</p>
      </div>
    </section>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { EditPen } from '@element-plus/icons-vue'
import { getTwinViewerStatus } from '@/api/modules/datacenter'

const built = ref(true)

onMounted(async () => {
  try {
    const status = await getTwinViewerStatus()
    built.value = status?.cad_designer_built !== false
  } catch (error) {
    built.value = true
  }
})
</script>

<style scoped>
.cad-designer-page {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.cad-designer-stage {
  position: relative;
  flex: 1;
  min-height: 420px;
  overflow: hidden;
  padding: 0;
}
.cad-designer-frame {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  background: #f6f8fa;
  inset: 0;
  position: absolute;
}
.cad-designer-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  min-height: 320px;
  color: var(--text-secondary);
  text-align: center;
}
.cad-designer-placeholder strong {
  color: var(--text-primary);
  font-size: 15px;
}
.cad-designer-placeholder p {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
</style>
