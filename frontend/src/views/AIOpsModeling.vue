<template>
  <div class="ai-modeling-page workbench-page-shell">
    <section class="hero panel">
      <div class="hero-title-row">
        <span class="hero-icon">
          <el-icon><MagicStick /></el-icon>
        </span>
        <h2>AI 机房建模</h2>
        <p class="page-inline-desc">
          用自然语言生成或修改机房平面；模型调用经 AIOps 统一代理并写入审计，几何、编号、推挤与检查由设计器执行
          <a class="page-inline-link" href="/dc-designer-app/?ai=1" target="_blank" rel="noopener">在新窗口打开</a>
        </p>
      </div>
    </section>

    <section class="panel ai-modeling-stage workbench-fill-panel">
      <iframe
        ref="frameRef"
        class="ai-modeling-frame"
        src="/dc-designer-app/?ai=1&noWelcome=1&lang=zh-CN&aiProxy=1"
        title="AI 机房建模"
        referrerpolicy="no-referrer"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </section>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { MagicStick } from '@element-plus/icons-vue'
import { postAIOpsModelingChat } from '@/api/modules/aiops'

const frameRef = ref(null)

function respond(requestId, payload) {
  const frame = frameRef.value?.contentWindow
  if (!frame) return
  frame.postMessage({ source: 'dc-aiops', type: 'ai-chat-result', requestId, ...payload }, '*')
}

function onDesignerMessage(event) {
  const frame = frameRef.value?.contentWindow
  if (!frame || event.source !== frame) return
  const data = event.data || {}
  if (data.source !== 'dc-designer' || data.type !== 'ai-chat') return
  const requestId = data.requestId
  const payload = data.payload || {}
  postAIOpsModelingChat(payload)
    .then((response) => respond(requestId, { ok: true, data: response }))
    .catch((error) => respond(requestId, {
      ok: false,
      status: error?.response?.status || 0,
      message: error?.response?.data?.detail || error?.message || 'AIOps 模型代理调用失败',
    }))
}

onMounted(() => window.addEventListener('message', onDesignerMessage))
onBeforeUnmount(() => window.removeEventListener('message', onDesignerMessage))
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
