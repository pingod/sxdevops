export function openRouteInNewTab(router, location) {
  if (!router || !location) return
  const target = router.resolve(location)
  if (!target?.href) return
  window.open(target.href, '_blank', 'noopener,noreferrer')
}

// 登录后/无权限时的落地页：按用户实际权限挑选第一个可访问入口，
// 避免硬编码 /dashboard 让没有 ops.dashboard.view 的角色登录即 403。
export function landingRoute(authStore) {
  if (authStore?.hasPermission?.('ops.dashboard.view')) return '/dashboard'
  if (authStore?.hasPermission?.('eventwall.view')) return '/events/wall'
  if (authStore?.hasPermission?.('aiops.chat.view')) return '/aiops/chat'
  return '/403'
}

// 只接受站内绝对路径，防止 ?redirect= 被用来做开放重定向
export function safeRedirectTarget(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : ''
}
