<template>
  <div class="task-center-redirect" />
</template>

<script setup>
import { onBeforeMount } from 'vue'
import { useRouter } from 'vue-router'
import { authorizedLandingPath } from '@/utils/permission'

const router = useRouter()

onBeforeMount(() => {
  // 只有任务执行权限的角色才进工作台；仅有资源查看权限的角色应落到资源底座，
  // 否则会被工作台路由守卫弹到 /403。
  router.replace(authorizedLandingPath(router, ['/tasks/workbench', '/tasks/resources']))
})
</script>
