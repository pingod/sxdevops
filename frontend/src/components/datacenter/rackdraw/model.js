/**
 * 机柜布设核心口径（移植自 RackDraw，Apache-2.0）。
 *
 * 与上游保持同一套坐标系，布设 Markdown 可双向互导：
 * - 横向 6 等分，宽度只用 6（全宽）/ 3（1/2）/ 2（1/3）；
 * - 纵向 3 个螺丝孔位 = 1U，设备只存「顶边孔位」，U 号由孔位推导；
 * - 机柜规格 42U / 36U / 24U。
 *
 * 本文件不做任何 DOM 操作，方便单独测试与复用。
 */

export const RACK_KINDS = [
  { value: '42U', label: '42U', units: 42 },
  { value: '36U', label: '36U', units: 36 },
  { value: '24U', label: '24U', units: 24 },
]

export const H_GRID = 6
export const HOLES_PER_U = 3
export const DEVICE_WIDTHS = [
  { value: 6, label: '标准全宽' },
  { value: 3, label: '1/2 宽' },
  { value: 2, label: '1/3 宽' },
]
export const COLUMN_LABELS = ['最左', '偏左', '左中', '右中', '偏右', '最右']

/* 画布几何：与上游导出口径同构，像素值按 Web 端重新取整便于 1/3U 对齐。 */
export const U_PX = 24
export const SLOT_PX = U_PX / HOLES_PER_U
export const INNER_W = 312
export const LABEL_W = 30
export const RAIL_W = 14
export const FRAME_PAD = 12
export const CAP_H = 22
export const PAD_TOP = 12
export const PAD_BOTTOM = 12
export const FRAME_W = FRAME_PAD * 2 + LABEL_W + RAIL_W + INNER_W + RAIL_W

export const CATEGORY_META = {
  router: { label: '路由器', c0: '#3f89c9', c1: '#2b6cb0', c2: '#22568c', chip: '#3182ce', leds: 'gag' },
  switch: { label: '交换机', c0: '#556273', c1: '#2d3748', c2: '#1f2733', chip: '#4a5568', leds: 'ga' },
  firewall: { label: '防火墙', c0: '#d35f5f', c1: '#b13a3a', c2: '#8a2c2c', chip: '#c53030', leds: 'gga' },
  wireless: { label: '无线设备', c0: '#57b183', c1: '#35785a', c2: '#275e45', chip: '#2f855a', leds: 'ga' },
  small: { label: '小型设备', c0: '#e0ac55', c1: '#b57f22', c2: '#8a611a', chip: '#b7791f', leds: '' },
  monitor: { label: '监控设备', c0: '#8c7bd4', c1: '#6c5cb8', c2: '#4f418c', chip: '#7a6ac8', leds: 'gag' },
  accessory: { label: '机柜配件', c0: '#8496ad', c1: '#5f7186', c2: '#4a5a6d', chip: '#5f7186', leds: '' },
  custom: { label: '自定义', c0: '#93a1b3', c1: '#66727f', c2: '#4b5563', chip: '#718096', leds: '' },
}

let leafSeq = 0
function leaf(cat, label, full, w, hU) {
  leafSeq += 1
  return { id: `leaf-${leafSeq}`, cat, label, full, w, hU }
}

export const CATALOG = [
  {
    key: 'router',
    label: '路由器',
    items: [
      leaf('router', '标准', '路由器 · 标准', 6, 1),
      leaf('router', '小型（1/2 宽）', '路由器 · 小型', 3, 1),
      leaf('router', 'mini（1/3 宽）', '路由器 · mini', 2, 1),
    ],
  },
  {
    key: 'switch',
    label: '交换机',
    items: [
      leaf('switch', '标准', '交换机 · 标准', 6, 1),
      leaf('switch', '小型（1/2 宽）', '交换机 · 小型', 3, 1),
      leaf('switch', 'mini（1/3 宽）', '交换机 · mini', 2, 1),
    ],
  },
  {
    key: 'firewall',
    label: '防火墙',
    items: [
      leaf('firewall', '标准', '防火墙 · 标准', 6, 1),
      leaf('firewall', '小型（1/2 宽）', '防火墙 · 小型', 3, 1),
      leaf('firewall', 'mini（1/3 宽）', '防火墙 · mini', 2, 1),
    ],
  },
  {
    key: 'wireless',
    label: '无线设备',
    items: [
      leaf('wireless', 'AC 控制器 · 标准', 'AC控制器 · 标准', 6, 1),
      leaf('wireless', 'AC 控制器 · 小型', 'AC控制器 · 小型', 3, 1),
      leaf('wireless', 'AC 控制器 · mini', 'AC控制器 · mini', 2, 1),
      leaf('wireless', 'PoE 交换机 · 标准', 'PoE交换机 · 标准', 6, 1),
      leaf('wireless', 'PoE 交换机 · 小型', 'PoE交换机 · 小型', 3, 1),
      leaf('wireless', 'AC 路由一体机 · 标准', 'AC路由一体机 · 标准', 6, 1),
      leaf('wireless', 'AC 路由一体机 · mini', 'AC路由一体机 · mini', 2, 1),
    ],
  },
  {
    key: 'small',
    label: '小型设备',
    items: [
      leaf('small', '光电转换器', '光电转换器', 2, 1),
      leaf('small', '光猫', '光猫', 2, 1),
      leaf('small', 'HDMI 延长器', 'HDMI延长器', 2, 1),
    ],
  },
  {
    key: 'monitor',
    label: '监控设备',
    items: [
      leaf('monitor', '监控录像机', '监控录像机', 6, 3),
      leaf('monitor', '监控交换机', '监控交换机', 6, 1),
    ],
  },
  {
    key: 'accessory',
    label: '机柜配件',
    items: [
      leaf('accessory', '理线架', '理线架', 6, 1),
      leaf('accessory', '配线架', '配线架', 6, 1),
      leaf('accessory', '空位挡板', '空位挡板', 6, 1),
    ],
  },
]

const ALL_LEAVES = CATALOG.flatMap(group => group.items)

export function rackUnits(rack) {
  return RACK_KINDS.find(item => item.value === rack)?.units || 42
}

export function totalHoles(rack) {
  return rackUnits(rack) * HOLES_PER_U
}

export function holeToUText(rack, hole) {
  return Math.floor((totalHoles(rack) - hole - 1) / HOLES_PER_U) + 1
}

export function topU(state, device) {
  return holeToUText(state.rack, device.hole)
}

export function bottomU(state, device) {
  return holeToUText(state.rack, device.hole + device.hU * HOLES_PER_U - 1)
}

export function usedU(state) {
  return state.devices.reduce((sum, device) => sum + device.hU, 0)
}

export function clampInt(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value))
}

export function clampW(width) {
  return [6, 3, 2].includes(width) ? width : 6
}

export function clampH(height) {
  return clampInt(Number(height) || 1, 1, 24)
}

export function collides(devices, col, hole, width, heightU, excludeId = 0) {
  const holes = heightU * HOLES_PER_U
  return devices.some(device => {
    if (device.id === excludeId) return false
    return (
      col < device.col + device.w
      && col + width > device.col
      && hole < device.hole + device.hU * HOLES_PER_U
      && hole + holes > device.hole
    )
  })
}

export function findFreeHole(state, col, hole, width, heightU, step, maxHole) {
  if (!collides(state.devices, col, hole, width, heightU)) {
    return { found: true, hole, adjusted: false }
  }
  const reach = Math.max(maxHole, totalHoles(state.rack))
  for (let delta = step; delta <= reach; delta += step) {
    const down = hole + delta
    if (down <= maxHole && !collides(state.devices, col, down, width, heightU)) {
      return { found: true, hole: down, adjusted: true }
    }
    const up = hole - delta
    if (up >= 0 && !collides(state.devices, col, up, width, heightU)) {
      return { found: true, hole: up, adjusted: true }
    }
  }
  return { found: false, hole, adjusted: false }
}

export function widthText(width) {
  if (width === 6) return '标准全宽'
  if (width === 3) return '1/2 宽'
  return '1/3 宽'
}

export function colText(device) {
  if (device.w === H_GRID) return '居中'
  if (device.col === 0) return '左侧'
  if (device.col === H_GRID - device.w) return '右侧'
  return `col ${device.col}-${device.col + device.w - 1}`
}

export function spanText(device) {
  const span = device.w === 6 ? '全宽' : device.w === 3 ? '1/2' : '1/3'
  return `${device.hU}U × ${span}`
}

export function slotGeometry(state) {
  const units = rackUnits(state.rack)
  return {
    units,
    innerLeft: FRAME_PAD + LABEL_W + RAIL_W,
    innerTop: CAP_H + PAD_TOP,
    innerW: INNER_W,
    bodyH: units * U_PX,
    height: CAP_H * 2 + PAD_TOP + units * U_PX + PAD_BOTTOM,
    colW: INNER_W / H_GRID,
    slotH: SLOT_PX,
  }
}

export function deviceRect(state, device) {
  const geometry = slotGeometry(state)
  return {
    x: geometry.innerLeft + device.col * geometry.colW,
    y: geometry.innerTop + device.hole * geometry.slotH,
    width: device.w * geometry.colW,
    height: device.hU * U_PX,
  }
}

/** 指针位置（设备左上角，SVG 坐标）→ 吸附格位。 */
export function snapDevice(state, topLeft, width, heightU, excludeId = 0) {
  const geometry = slotGeometry(state)
  const maxHole = Math.max(0, totalHoles(state.rack) - heightU * HOLES_PER_U)
  let col = Math.round((topLeft.x - geometry.innerLeft) / geometry.colW)
  let hole = Math.round((topLeft.y - geometry.innerTop) / geometry.slotH)
  col = clampInt(col, 0, H_GRID - width)
  hole = clampInt(hole, 0, maxHole)
  if (state.mode === 'U') {
    hole = clampInt(Math.round(hole / HOLES_PER_U) * HOLES_PER_U, 0, maxHole)
  }
  return {
    col,
    hole,
    ok: !collides(state.devices, col, hole, width, heightU, excludeId),
  }
}

export function normalizeName(value) {
  return String(value || '')
    .replace(/[\s·・　]/g, '')
    .toLowerCase()
}

export function matchDeviceName(name, customDevices = []) {
  const exactLeaf = ALL_LEAVES.find(item => item.full === name)
  if (exactLeaf) return { cat: exactLeaf.cat, name: exactLeaf.full, unknown: false }
  const exactCustom = customDevices.find(item => item.name === name)
  if (exactCustom) return { cat: 'custom', name: exactCustom.name, unknown: false }
  const wanted = normalizeName(name)
  const fuzzyLeaf = ALL_LEAVES.find(item => normalizeName(item.full) === wanted)
  if (fuzzyLeaf) return { cat: fuzzyLeaf.cat, name: fuzzyLeaf.full, unknown: false }
  const fuzzyCustom = customDevices.find(item => normalizeName(item.name) === wanted)
  if (fuzzyCustom) return { cat: 'custom', name: fuzzyCustom.name, unknown: false }
  return { cat: 'custom', name: String(name || '').trim().slice(0, 60), unknown: true }
}

export function makeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function emptyProject(rack = '42U', rackWidth = 600) {
  return {
    name: '',
    rack,
    rackWidth,
    mode: 'U',
    deviceSeq: 1,
    devices: [],
    customDevices: [],
  }
}

export function normalizeProject(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const rack = RACK_KINDS.some(item => item.value === source.rack) ? source.rack : '42U'
  const mode = source.mode === 'hole' ? 'hole' : 'U'
  const rackWidth = clampInt(Number(source.rackWidth) || 600, 400, 1200)
  const state = {
    name: typeof source.name === 'string' ? source.name.slice(0, 120) : '',
    rack,
    rackWidth,
    mode,
    deviceSeq: 1,
    devices: [],
    customDevices: [],
  }

  const seenCustom = new Set()
  for (const item of Array.isArray(source.customDevices) ? source.customDevices : []) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.id || '').slice(0, 64) || makeId()
    if (seenCustom.has(id)) continue
    const name = String(item.name || '').trim().slice(0, 60)
    if (!name) continue
    seenCustom.add(id)
    state.customDevices.push({
      id,
      name,
      w: clampW(Number(item.w)),
      hU: clampH(item.hU),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt.slice(0, 40) : '',
    })
  }

  const seenIds = new Set()
  for (const item of Array.isArray(source.devices) ? source.devices : []) {
    if (!item || typeof item !== 'object') continue
    const id = Number(item.id)
    if (!Number.isInteger(id) || id <= 0 || seenIds.has(id)) continue
    const name = String(item.name || '').trim().slice(0, 60)
    if (!name) continue
    const width = clampW(Number(item.w))
    const heightU = clampH(item.hU)
    const maxHole = Math.max(0, totalHoles(rack) - heightU * HOLES_PER_U)
    const device = {
      id,
      cat: CATEGORY_META[item.cat] ? item.cat : 'custom',
      name,
      w: width,
      hU: heightU,
      col: clampInt(Number(item.col) || 0, 0, H_GRID - width),
      hole: clampInt(Number(item.hole) || 0, 0, maxHole),
      assetNo: String(item.assetNo || '').slice(0, 80),
      serial: String(item.serial || '').slice(0, 80),
      owner: String(item.owner || '').slice(0, 60),
      note: String(item.note || '').slice(0, 500),
      cmdbIds: Array.isArray(item.cmdbIds)
        ? item.cmdbIds.filter(value => Number.isInteger(value) && value > 0).slice(0, 64)
        : [],
    }
    if (state.mode === 'U') {
      device.hole = clampInt(Math.round(device.hole / HOLES_PER_U) * HOLES_PER_U, 0, maxHole)
    }
    // 脏数据里出现重叠时向下顺延，保证页面永远画得出来。
    const probe = findFreeHole(state, device.col, device.hole, width, heightU,
      state.mode === 'U' ? HOLES_PER_U : 1, maxHole)
    if (!probe.found) continue
    device.hole = probe.hole
    seenIds.add(id)
    state.devices.push(device)
    state.deviceSeq = Math.max(state.deviceSeq, id + 1)
  }
  return state
}

export function computeStats(state) {
  const capacity = rackUnits(state.rack)
  const occupied = usedU(state)
  const byCategory = {}
  for (const device of state.devices) {
    const meta = CATEGORY_META[device.cat] || CATEGORY_META.custom
    if (!byCategory[device.cat]) byCategory[device.cat] = { label: meta.label, count: 0, u: 0 }
    byCategory[device.cat].count += 1
    byCategory[device.cat].u += device.hU
  }
  return {
    deviceCount: state.devices.length,
    usedU: occupied,
    capacityU: capacity,
    freeU: capacity - occupied,
    rate: capacity ? Math.round((occupied / capacity) * 1000) / 10 : 0,
    byCategory,
  }
}

/* ------------------------------------------------------------------ */
/* Markdown 布设表：与 RackDraw 的导出格式保持一致，可双向互导。        */
/* ------------------------------------------------------------------ */

function mdEscape(text) {
  return String(text || '').replace(/([\\|*_])/g, '\\$1')
}

function mdUnescape(text) {
  return String(text || '').replace(/\\([\\|*_])/g, '$1')
}

function dispWidth(text) {
  let width = 0
  for (const ch of String(text || '')) width += ch.codePointAt(0) > 0x2e80 ? 2 : 1
  return width
}

function fitLabel(text, span) {
  const source = String(text || '')
  if (dispWidth(source) <= span) return source
  let out = ''
  let used = 0
  for (const ch of source) {
    const width = ch.codePointAt(0) > 0x2e80 ? 2 : 1
    if (used + width > span - 1) break
    out += ch
    used += width
  }
  return `${out}…`
}

function padLabel(text, span) {
  const width = dispWidth(text)
  if (width >= span) return fitLabel(text, span)
  return text + ' '.repeat(span - width)
}

function fileStamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`
}

function localStamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

export function markdownFileName(state) {
  return `布设_${state.rack}_${fileStamp()}.md`
}

export function buildAsciiMap(state) {
  const units = rackUnits(state.rack)
  const cols = H_GRID
  const cellW = 4
  const innerW = cols * cellW
  const lines = []
  lines.push('```')
  lines.push(`    ┌${'─'.repeat(innerW)}┐`)
  const grid = Array.from({ length: units }, () => Array(cols).fill(' '))
  for (const device of state.devices) {
    const top = units - topU(state, device)
    for (let row = top; row < Math.min(units, top + device.hU); row += 1) {
      for (let col = device.col; col < Math.min(cols, device.col + device.w); col += 1) {
        grid[row][col] = '█'
      }
    }
  }
  for (let row = 0; row < units; row += 1) {
    const u = units - row
    const label = `${String(u).padStart(2, ' ')}U`
    lines.push(` ${label} │${grid[row].join('')}│`)
  }
  lines.push(`    └${'─'.repeat(innerW)}┘`)
  lines.push('      宽度占比 1/6 · 1/6 · 1/6 · 1/6 · 1/6 · 1/6')
  lines.push('```')
  return lines.join('\n')
}

export function buildLayoutMarkdown(state) {
  const stats = computeStats(state)
  const lines = []
  lines.push('# 弱电机柜设备布设表')
  lines.push('')
  lines.push('## 一、基本信息')
  lines.push('')
  lines.push('| 项目 | 内容 |')
  lines.push('|---|---|')
  lines.push(`| 方案名称 | ${mdEscape(state.name || '未命名方案')} |`)
  lines.push(`| 机柜规格 | ${state.rack} 标准机柜（${state.rackWidth}mm） |`)
  lines.push(`| 卡位版式 | ${state.mode === 'U' ? '标准 U 数版式' : '螺丝孔位版式'} |`)
  lines.push(`| 设备总数 | ${stats.deviceCount} 台 |`)
  lines.push(`| 高度占用 | ${stats.usedU}U / ${stats.capacityU}U |`)
  lines.push(`| 导出时间 | ${localStamp()} |`)
  lines.push('')
  lines.push('## 二、设备清单（按 U 位自下而上）')
  lines.push('')
  lines.push('| 序号 | U 位 | 顶边孔位 | 横向位置 | 设备名称 | 宽度 | 高度 | 占用空间 |')
  lines.push('|---|---|---|---|---|---|---|---|')

  const sorted = [...state.devices].sort((a, b) => {
    const bottomDiff = (a.hole + a.hU * HOLES_PER_U) - (b.hole + b.hU * HOLES_PER_U)
    if (bottomDiff !== 0) return bottomDiff
    return a.col - b.col
  })
  if (!sorted.length) {
    lines.push('（机柜为空）')
  } else {
    sorted.forEach((device, index) => {
      lines.push(
        `| ${index + 1} | ${topU(state, device)}U | 第 ${device.hole + 1} 孔 | ${colText(device)} `
        + `| ${mdEscape(device.name)} | ${widthText(device.w)} | ${device.hU}U | ${spanText(device)} |`,
      )
    })
  }
  lines.push('')
  lines.push('## 三、U 位占用对照图')
  lines.push('')
  lines.push(buildAsciiMap(state))
  lines.push('')
  lines.push('## 四、空间统计')
  lines.push('')
  lines.push('| 统计项 | 数值 |')
  lines.push('|---|---|')
  lines.push(`| 机柜总容量 | ${stats.capacityU}U |`)
  lines.push(`| 已占用高度 | ${stats.usedU}U |`)
  lines.push(`| 剩余可用 | ${stats.freeU}U |`)
  lines.push(`| 空间利用率 | ${stats.rate.toFixed(1)}% |`)
  lines.push(`| 设备总数 | ${stats.deviceCount} 台 |`)
  lines.push('')
  lines.push('### 按类别统计')
  lines.push('')
  lines.push('| 类别 | 数量 | 占用高度 |')
  lines.push('|---|---|---|')
  let sumCount = 0
  let sumU = 0
  for (const item of Object.values(stats.byCategory)) {
    sumCount += item.count
    sumU += item.u
    lines.push(`| ${item.label} | ${item.count} | ${item.u}U |`)
  }
  lines.push(`| **合计** | **${sumCount}** | **${sumU}U** |`)
  lines.push('')
  lines.push('## 五、备注')
  lines.push('')
  lines.push('<!-- 由 SxDevOps 机柜布设生成（布设表格式兼容 RackDraw） -->')
  lines.push('')
  return lines.join('\n')
}

function splitTableRow(line) {
  const text = String(line || '').trim()
  if (!text.startsWith('|')) return null
  const cells = []
  let buffer = ''
  let escaped = false
  for (const ch of text) {
    if (escaped) {
      buffer += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      buffer += ch
      escaped = true
      continue
    }
    if (ch === '|') {
      cells.push(buffer.trim())
      buffer = ''
      continue
    }
    buffer += ch
  }
  cells.push(buffer.trim())
  if (cells.length && cells[0] === '') cells.shift()
  if (cells.length && cells[cells.length - 1] === '') cells.pop()
  return cells
}

function isSeparatorRow(line) {
  const text = String(line || '').trim()
  return text.startsWith('|') && /^[|\s:-]+$/.test(text) && text.includes('-')
}

function firstInt(text) {
  const match = String(text || '').match(/-?\d+/)
  return match ? Number(match[0]) : null
}

function cell(cells, index) {
  return index >= 0 && index < cells.length ? cells[index] : ''
}

export function importLayout(text, current) {
  const result = {
    ok: false,
    error: '',
    next: null,
    rows: [],
    okCount: 0,
    adjCount: 0,
    unkCount: 0,
    skipCount: 0,
    canUndo: current.devices.length > 0,
  }
  const lines = String(text || '').split(/\r?\n/)

  let rackText = ''
  let modeText = ''
  for (const line of lines) {
    const cells = splitTableRow(line)
    if (!cells || cells.length < 2) continue
    if (cells[0] === '机柜规格') rackText = cells[1]
    if (cells[0] === '卡位版式') modeText = cells[1]
  }
  const rackNumber = firstInt(rackText)
  if (rackNumber === null) {
    result.error = '未找到「机柜规格」信息，文件可能不是 RackDraw 布设文件。'
    return result
  }
  const rack = `${rackNumber}U`
  if (!RACK_KINDS.some(item => item.value === rack)) {
    result.error = `不支持的机柜规格：${rack}。`
    return result
  }
  const mode = modeText.includes('螺丝孔位') ? 'hole' : 'U'

  let headerIndex = -1
  let header = []
  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitTableRow(lines[index])
    if (!cells) continue
    if (cells.includes('U 位') && cells.includes('设备名称')) {
      headerIndex = index
      header = cells
      break
    }
  }
  const emptyRack = String(text).includes('（机柜为空）')
  if (headerIndex < 0 && !emptyRack) {
    result.error = '未找到设备清单表（缺少「U 位」「设备名称」表头）。'
    return result
  }

  const parsed = []
  if (headerIndex >= 0) {
    const iU = header.indexOf('U 位')
    const iPos = header.indexOf('横向位置')
    const iName = header.indexOf('设备名称')
    const iW = header.indexOf('宽度')
    const iH = header.indexOf('高度')
    const iHole = header.indexOf('顶边孔位')
    const missing = [
      ['U 位', iU], ['横向位置', iPos], ['设备名称', iName], ['宽度', iW], ['高度', iH],
    ].filter(([, index]) => index < 0).map(([label]) => label)
    if (missing.length) {
      result.error = `设备清单缺少必需列：${missing.join('、')}。`
      return result
    }
    const need = Math.max(iU, iPos, iName, iW, iH)
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      const trimmed = lines[index].trim()
      if (!trimmed || !trimmed.startsWith('|')) {
        if (parsed.length) break
        continue
      }
      if (isSeparatorRow(trimmed)) continue
      const cells = splitTableRow(trimmed)
      if (!cells || cells.length <= need) continue
      const u = firstInt(cell(cells, iU))
      const hU = firstInt(cell(cells, iH))
      const widthTextValue = cell(cells, iW)
      let w = 0
      if (widthTextValue.includes('标准全宽')) w = 6
      else if (widthTextValue.includes('1/2')) w = 3
      else if (widthTextValue.includes('1/3')) w = 2
      if (u === null || hU === null || !w) continue
      let holeFromFile = -1
      if (iHole >= 0) {
        const holeText = cell(cells, iHole)
        const marker = holeText.indexOf('第')
        if (marker >= 0) {
          const value = firstInt(holeText.slice(marker + 1))
          if (value !== null && value >= 1) holeFromFile = value - 1
        }
      }
      parsed.push({
        u,
        hU: clampH(hU),
        w: clampW(w),
        pos: mdUnescape(cell(cells, iPos)),
        name: mdUnescape(cell(cells, iName)),
        holeFromFile,
      })
    }
  }

  const rackTotalU = rackUnits(rack)
  const rackTotalHoles = totalHoles(rack)
  const staged = []
  for (const item of parsed) {
    const match = matchDeviceName(item.name, current.customDevices)
    let hole = item.holeFromFile >= 0
      ? item.holeFromFile
      : (rackTotalU - item.u) * HOLES_PER_U
    if (item.holeFromFile < 0 && mode === 'U') {
      hole = Math.round(hole / HOLES_PER_U) * HOLES_PER_U
    }
    let col = 0
    const colMarker = item.pos.indexOf('col')
    let explicitCol = false
    if (colMarker >= 0) {
      const value = firstInt(item.pos.slice(colMarker + 3))
      if (value !== null) {
        col = value
        explicitCol = true
      }
    }
    if (!explicitCol) {
      if (item.pos.includes('左')) col = 0
      else if (item.pos.includes('右')) col = H_GRID - item.w
      else col = Math.round((H_GRID - item.w) / 2)
    }
    const rawCol = col
    col = clampInt(col, 0, H_GRID - item.w)
    const maxHole = rackTotalHoles - item.hU * HOLES_PER_U
    const rawHole = hole
    hole = clampInt(hole, 0, Math.max(0, maxHole))
    staged.push({
      ...match,
      w: item.w,
      hU: item.hU,
      col,
      hole,
      srcU: item.u,
      srcPos: item.pos,
      clamped: col !== rawCol || hole !== rawHole,
    })
  }

  const next = {
    ...current,
    rack,
    mode,
    deviceSeq: 1,
    devices: [],
  }
  const step = mode === 'U' ? HOLES_PER_U : 1
  for (const item of staged) {
    const maxHole = Math.max(0, totalHoles(next.rack) - item.hU * HOLES_PER_U)
    const probe = findFreeHole(next, item.col, item.hole, item.w, item.hU, step, maxHole)
    if (!probe.found) {
      result.skipCount += 1
      result.rows.push({ kind: 'error', text: `跳过（无可用卡位）：${item.name}` })
      continue
    }
    const device = {
      id: next.deviceSeq,
      cat: item.cat,
      name: item.name,
      w: item.w,
      hU: item.hU,
      col: item.col,
      hole: probe.hole,
      assetNo: '',
      serial: '',
      owner: '',
      note: '',
      cmdbIds: [],
    }
    next.deviceSeq += 1
    next.devices.push(device)
    result.okCount += 1
    if (probe.adjusted || item.clamped) {
      result.adjCount += 1
      result.rows.push({ kind: 'warn', text: `位置调整：${item.name}` })
      result.rows.push({
        kind: 'indent',
        text: `　 ${item.srcU}U ${item.srcPos} → ${holeToUText(next.rack, probe.hole)}U ${colText(device)}`,
      })
    }
    if (item.unknown) {
      result.unkCount += 1
      result.rows.push({
        kind: 'unknown',
        text: `未知设备：${item.name}（按 ${item.hU}U ${widthText(item.w)} 创建为自定义设备）`,
      })
    }
  }

  let summary = `成功导入：${result.okCount} 台`
  if (result.adjCount) summary += `　位置调整：${result.adjCount} 台`
  if (result.unkCount) summary += `　未知设备：${result.unkCount} 台`
  if (result.skipCount) summary += `　跳过：${result.skipCount} 台`
  result.rows.unshift({ kind: 'ok', text: summary })
  result.ok = true
  result.next = next
  return result
}