import { ref, unref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

// 多个 tab 状态实例会在同一 tick 内各自 replace，必须串行并读取最新 query，
// 否则每个实例都基于旧快照覆盖，最终只剩最后一个 tab 参数。
let routeQueryChain = Promise.resolve()

export function useRouteTabState(options = {}) {
  const {
    tabs,
    defaultTab = '',
    queryKey = 'tab',
  } = options

  const route = useRoute()
  const router = useRouter()
  const activeTab = ref('')

  function resolveTabs() {
    const value = typeof tabs === 'function' ? tabs() : unref(tabs)
    return Array.isArray(value) ? value.filter(Boolean) : []
  }

  function resolveDefaultTab() {
    return typeof defaultTab === 'function' ? defaultTab() : defaultTab
  }

  function normalizeTab(tab) {
    const availableTabs = resolveTabs()
    if (availableTabs.includes(tab)) return tab
    return availableTabs[0] || resolveDefaultTab() || ''
  }

  function currentQueryValue() {
    const query = router.currentRoute.value.query
    return typeof query[queryKey] === 'string' ? query[queryKey] : ''
  }

  function updateRouteQuery(tab) {
    if (currentQueryValue() === tab) return
    routeQueryChain = routeQueryChain
      .then(() => {
        const latest = router.currentRoute.value.query
        const latestValue = typeof latest[queryKey] === 'string' ? latest[queryKey] : ''
        if (latestValue === tab) return null
        return router.replace({
          query: {
            ...latest,
            [queryKey]: tab,
          },
        })
      })
      .catch(() => null)
  }

  function switchTab(tab) {
    const nextTab = normalizeTab(tab)
    if (activeTab.value === nextTab) return
    activeTab.value = nextTab
  }

  watch(
    () => resolveTabs().join('|'),
    () => {
      const routeTab = typeof route.query[queryKey] === 'string' ? route.query[queryKey] : ''
      const nextTab = normalizeTab(routeTab || activeTab.value)
      if (activeTab.value !== nextTab) {
        activeTab.value = nextTab
        return
      }
      if (routeTab !== nextTab) {
        updateRouteQuery(nextTab)
      }
    },
    { immediate: true }
  )

  watch(
    () => route.query[queryKey],
    (tab) => {
      const nextTab = normalizeTab(typeof tab === 'string' ? tab : '')
      if (activeTab.value !== nextTab) {
        activeTab.value = nextTab
      }
    }
  )

  watch(
    activeTab,
    (tab) => {
      if (!tab) return
      updateRouteQuery(tab)
    },
    { immediate: true }
  )

  return {
    activeTab,
    normalizeTab,
    switchTab,
  }
}
