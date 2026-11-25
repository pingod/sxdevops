<template>
  <aside class="rack-catalog">
    <div class="catalog-head">
      <span class="catalog-title">设备目录</span>
      <span class="catalog-count">{{ leafCount }} 项</span>
    </div>
    <el-input
      v-model="search"
      size="small"
      clearable
      placeholder="搜索设备名称"
      :prefix-icon="Search"
      class="catalog-search"
    />
    <div class="catalog-scroll">
      <section v-for="group in filteredGroups" :key="group.key" class="catalog-group">
        <button type="button" class="catalog-group-head" @click="toggle(group.key)">
          <el-icon class="catalog-caret" :class="{ 'is-open': isOpen(group.key) }"><ArrowRight /></el-icon>
          <span>{{ group.label }}</span>
          <span class="catalog-group-count">{{ group.items.length }}</span>
        </button>
        <div v-show="isOpen(group.key)" class="catalog-items">
          <button
            v-for="item in group.items"
            :key="item.id"
            type="button"
            class="catalog-item"
            :disabled="disabled"
            draggable="true"
            :title="`拖动到机柜，或单击放到首个空位（${item.full}）`"
            @dragstart="onDragStart($event, item)"
            @dragend="$emit('drag-end')"
            @click="$emit('add', toPayload(item))"
          >
            <span class="catalog-dot" :style="{ background: metaOf(item.cat).chip }" />
            <span class="catalog-item-name">{{ item.label }}</span>
            <span class="catalog-item-size">{{ sizeText(item) }}</span>
          </button>
        </div>
      </section>

      <section v-if="customDevices.length" class="catalog-group">
        <button type="button" class="catalog-group-head" @click="toggle('custom')">
          <el-icon class="catalog-caret" :class="{ 'is-open': isOpen('custom') }"><ArrowRight /></el-icon>
          <span>我的设备</span>
          <span class="catalog-group-count">{{ customDevices.length }}</span>
        </button>
        <div v-show="isOpen('custom')" class="catalog-items">
          <div v-for="item in customDevices" :key="item.id" class="catalog-custom-row">
            <button
              type="button"
              class="catalog-item catalog-item--custom"
              :disabled="disabled"
              draggable="true"
              @dragstart="onCustomDragStart($event, item)"
              @dragend="$emit('drag-end')"
              @click="$emit('add', customPayload(item))"
            >
              <span class="catalog-dot" :style="{ background: metaOf('custom').chip }" />
              <span class="catalog-item-name">{{ item.name }}</span>
              <span class="catalog-item-size">{{ sizeText(item) }}</span>
            </button>
            <button
              v-if="!disabled"
              type="button"
              class="catalog-custom-remove"
              title="删除自定义设备"
              @click.stop="$emit('remove-custom', item.id)"
            >×</button>
          </div>
        </div>
      </section>
    </div>

    <el-button v-if="!disabled" class="catalog-create" plain size="small" @click="$emit('create-custom')">
      <el-icon><Plus /></el-icon>
      新建自定义设备
    </el-button>
  </aside>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { ArrowRight, Plus, Search } from '@element-plus/icons-vue'
import { CATALOG, CATEGORY_META } from './model'

const props = defineProps({
  customDevices: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['add', 'drag-start', 'drag-end', 'create-custom', 'remove-custom'])

const search = ref('')
const openState = reactive({})

const leafCount = computed(() => CATALOG.reduce((sum, group) => sum + group.items.length, 0))

const filteredGroups = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return CATALOG
  return CATALOG
    .map(group => ({
      ...group,
      items: group.items.filter(item => `${item.label}${item.full}`.toLowerCase().includes(keyword)),
    }))
    .filter(group => group.items.length)
})

function isOpen(key) {
  return openState[key] !== false
}

function toggle(key) {
  openState[key] = !isOpen(key)
}

function metaOf(cat) {
  return CATEGORY_META[cat] || CATEGORY_META.custom
}

function sizeText(item) {
  return `${item.w === 6 ? '全宽' : item.w === 3 ? '1/2' : '1/3'} · ${item.hU}U`
}

function toPayload(item) {
  return { cat: item.cat, name: item.full, w: item.w, hU: item.hU }
}

function customPayload(item) {
  return { cat: 'custom', name: item.name, w: item.w, hU: item.hU }
}

function writeDrag(event, payload) {
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData('application/x-rack-device', JSON.stringify(payload))
  emit('drag-start', payload)
}

function onDragStart(event, item) {
  writeDrag(event, toPayload(item))
}

function onCustomDragStart(event, item) {
  writeDrag(event, customPayload(item))
}
</script>

<style scoped>
.rack-catalog {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px 10px 12px;
  border-right: 1px solid #e2e8f0;
  background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%);
}

.catalog-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.catalog-title {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.catalog-count {
  font-size: 11px;
  color: #94a3b8;
}

.catalog-search {
  margin-bottom: 8px;
}

.catalog-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.catalog-group {
  margin-bottom: 4px;
}

.catalog-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 4px;
  border: none;
  background: transparent;
  color: #475569;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border-radius: 8px;
}

.catalog-group-head:hover {
  background: #eef2f7;
}

.catalog-caret {
  font-size: 11px;
  transition: transform 0.16s ease;
}

.catalog-caret.is-open {
  transform: rotate(90deg);
}

.catalog-group-count {
  margin-left: auto;
  font-size: 10px;
  color: #94a3b8;
  font-weight: 500;
}

.catalog-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0 4px 14px;
}

.catalog-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: #334155;
  font-size: 12px;
  text-align: left;
  cursor: grab;
}

.catalog-item:hover {
  border-color: #dbeafe;
  background: #eff6ff;
}

.catalog-item:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.catalog-dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  flex: none;
}

.catalog-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catalog-item-size {
  flex: none;
  font-size: 10px;
  color: #94a3b8;
}

.catalog-custom-row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.catalog-custom-row .catalog-item {
  flex: 1;
}

.catalog-custom-remove {
  flex: none;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  line-height: 1;
}

.catalog-custom-remove:hover {
  background: #fee2e2;
  color: #dc2626;
}

.catalog-create {
  margin-top: 8px;
  width: 100%;
}
</style>