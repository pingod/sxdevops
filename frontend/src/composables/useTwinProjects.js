import { computed, ref } from 'vue'
import { listTwinProjects } from '@/api/modules/datacenter'

/**
 * 三维机房项目列表：搜索、按更新时间排序、分页追加与选中项。
 *
 * 查看器与设计器共用，避免两边各写一份 refreshProjects 而字段/分页行为漂移。
 */
export function useTwinProjects({ pageSize = 50, ordering = '-updated_at' } = {}) {
  const projects = ref([])
  const count = ref(0)
  const loading = ref(false)
  const search = ref('')
  const selectedId = ref(null)
  const nextPage = ref(null)

  const selected = computed(() => projects.value.find(item => item.id === selectedId.value) || null)
  const hasMore = computed(() => nextPage.value !== null)

  function pageFromNext(next) {
    if (!next) return null
    try {
      const url = new URL(next, window.location.origin)
      const page = Number(url.searchParams.get('page'))
      return Number.isFinite(page) ? page : null
    } catch {
      return null
    }
  }

  async function fetchPage(page = 1, { append = false } = {}) {
    const params = { page, page_size: pageSize, ordering }
    const keyword = search.value.trim()
    if (keyword) params.search = keyword
    const data = await listTwinProjects(params)
    const rows = data.results || data || []
    projects.value = append ? [...projects.value, ...rows] : rows
    count.value = Number.isFinite(data.count) ? data.count : projects.value.length
    nextPage.value = pageFromNext(data.next)
    return projects.value
  }

  async function refresh() {
    loading.value = true
    try {
      return await fetchPage(1)
    } finally {
      loading.value = false
    }
  }

  async function loadMore() {
    if (nextPage.value === null) return projects.value
    loading.value = true
    try {
      return await fetchPage(nextPage.value, { append: true })
    } finally {
      loading.value = false
    }
  }

  /** 选中项优先保留；否则挑第一个（或指定 id）。 */
  function ensureSelection(preferredId) {
    const wanted = preferredId ?? selectedId.value
    if (wanted && projects.value.some(item => item.id === wanted)) {
      selectedId.value = wanted
      return selectedId.value
    }
    selectedId.value = projects.value[0]?.id ?? null
    return selectedId.value
  }

  return {
    projects, count, loading, search, selectedId, selected, hasMore,
    refresh, loadMore, ensureSelection,
  }
}
