<template>
  <div class="ai-modeling-page workbench-page-shell">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon">
          <el-icon><MagicStick /></el-icon>
        </span>
        <h2>AI 机房建模</h2>
        <p class="page-inline-desc">
          用自然语言生成或修改机房平面；AI 只负责规划，几何、编号、推挤与检查由设计器指令层执行
          <a class="page-inline-link" href="/dc-designer-app/?ai=1" target="_blank" rel="noopener">在新窗口打开</a>
        </p>
      </div>
    </section>

    <section class="panel ai-modeling-stage workbench-fill-panel">
      <iframe
        class="ai-modeling-frame"
        src="/dc-designer-app/?ai=1&embed=1&lang=zh-CN"
        title="AI 机房建模"
        referrerpolicy="no-referrer"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </section>
  </div>
</template>

<script setup>
import { MagicStick } from '@element-plus/icons-vue'
</script>

<style scoped>
.ai-modeling-page {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ai-modeling-stage {
  position: relative;
  flex: 1;
  min-height: 420px;
  overflow: hidden;
  padding: 0;
}
.ai-modeling-frame {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  background: #f6f8fa;
  inset: 0;
  position: absolute;
}
</style>
