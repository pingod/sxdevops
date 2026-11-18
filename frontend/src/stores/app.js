import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAppStore = defineStore('app', () => {
    const sidebarCollapsed = ref(false)
    // 模块级 Map 挂在 store 里，登出时才清得掉（页面组件卸载后仍然存活）。
    const costDataCache = new Map()

    function toggleSidebar() {
        sidebarCollapsed.value = !sidebarCollapsed.value
    }

    function clearCaches() {
        costDataCache.clear()
    }

    return { sidebarCollapsed, toggleSidebar, costDataCache, clearCaches }
})
