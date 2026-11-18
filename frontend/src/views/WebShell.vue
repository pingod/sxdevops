<template>
  <div class="webshell-page">
    <div class="webshell-header">
      <div class="webshell-title">
        <el-button link @click="$router.back()" style="color:#94a3b8; margin-right:12px;">
          <el-icon :size="18"><ArrowLeft /></el-icon>
        </el-button>
        <el-icon><Monitor /></el-icon>
        <span style="margin-left:8px;">WebShell — {{ hostInfo?.hostname || '...' }}</span>
        <el-tag v-if="hostInfo" size="small" type="info" style="margin-left:12px;">{{ hostInfo.ip_address }}</el-tag>
      </div>
      <div class="webshell-status">
        <span class="status-indicator" :class="wsStatus"></span>
        <span style="font-size:12px; color:#94a3b8;">{{ statusText }}</span>
      </div>
    </div>
    <div ref="terminalRef" class="terminal-container"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getHost } from '@/api/modules/ops'
import { fetchWebSocketTicket } from '@/api/modules/rbac'

const route = useRoute()
const hostId = route.params.hostId
const terminalRef = ref(null)
const hostInfo = ref(null)
const wsStatus = ref('connecting')
const statusText = ref('连接中...')

let term = null
let fitAddon = null
let ws = null
let resizeObserver = null

// 获取主机信息
async function fetchHostInfo() {
  try {
    hostInfo.value = await getHost(hostId)
  } catch (e) { /* */ }
}

function initTerminal() {
  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Monaco', monospace",
    theme: {
      background: '#0f172a',
      foreground: '#e2e8f0',
      cursor: '#6366f1',
      selectionBackground: '#6366f133',
      black: '#1e293b',
      red: '#ef4444',
      green: '#10b981',
      yellow: '#f59e0b',
      blue: '#3b82f6',
      magenta: '#a855f7',
      cyan: '#06b6d4',
      white: '#f1f5f9',
      brightBlack: '#475569',
      brightRed: '#f87171',
      brightGreen: '#34d399',
      brightYellow: '#fbbf24',
      brightBlue: '#60a5fa',
      brightMagenta: '#c084fc',
      brightCyan: '#22d3ee',
      brightWhite: '#ffffff',
    },
    scrollback: 5000,
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(terminalRef.value)
  fitAddon.fit()

  term.writeln('\x1b[1;36m⚡ SxDevOps WebShell\x1b[0m')
  term.writeln('\x1b[2m正在建立 SSH 连接...\x1b[0m')
  term.writeln('')

  // 监听终端输入
  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }))
    }
  })

  // 监听窗口变化
  resizeObserver = new ResizeObserver(() => {
    if (!term || !fitAddon) return
    if (fitAddon) {
      fitAddon.fit()
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }))
      }
    }
  })
  resizeObserver.observe(terminalRef.value)
}

async function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  // 每次连接前取一次性短票据：长期 Token 不进入 WS 查询串和访问日志。
  let ticket = ''
  try {
    ticket = (await fetchWebSocketTicket()).ticket || ''
  } catch {
    wsStatus.value = 'error'
    statusText.value = '获取终端票据失败，请重新登录后重试'
    return
  }
  const wsUrl = `${protocol}//${window.location.host}/ws/ssh/${hostId}/?ticket=${encodeURIComponent(ticket)}`

  ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    wsStatus.value = 'connected'
    statusText.value = '已连接'
  }

  ws.onmessage = (event) => {
    if (!term) return
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'output') {
        term.write(msg.data)
      } else if (msg.type === 'connected') {
        wsStatus.value = 'connected'
        statusText.value = '已连接'
        term.writeln(`\x1b[1;32m✓ ${msg.message}\x1b[0m`)
        term.writeln('')
      } else if (msg.type === 'error') {
        wsStatus.value = 'error'
        statusText.value = '连接异常'
        term.writeln(`\x1b[1;31m✗ ${msg.message}\x1b[0m`)
      }
    } catch (e) {
      // 非 JSON 数据直接写入
      term.write(event.data)
    }
  }

  ws.onclose = (event) => {
    wsStatus.value = 'disconnected'
    const code = Number(event?.code || 0)
    let message = '连接已断开，刷新页面可重新连接'
    if (code === 4401) {
      statusText.value = '登录状态已失效'
      message = '登录状态已失效或令牌无效，请重新登录后重试'
    } else if (code === 4403) {
      statusText.value = '无权访问该主机'
      message = '当前账号没有该主机的终端权限，请联系管理员授权'
    } else if (code === 4404) {
      statusText.value = '主机不存在'
      message = '目标主机不存在或已被删除'
    } else {
      statusText.value = '连接已断开'
    }
    if (!term) return
    term.writeln('')
    term.writeln(`\x1b[1;33m⚠ ${message}\x1b[0m`)
  }

  ws.onerror = () => {
    wsStatus.value = 'error'
    statusText.value = '连接失败'
  }
}

onMounted(async () => {
  await fetchHostInfo()
  await nextTick()
  initTerminal()
  connectWebSocket()
})

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (ws) {
    // 先解绑回调，避免 close 的异步事件在 term 销毁后仍写终端。
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    ws.close()
    ws = null
  }
  if (term) {
    term.dispose()
    term = null
  }
  fitAddon = null
})
</script>
