/** 会话相关的 localStorage key 与缓存清理，供 api 层与 store 共用（避免循环依赖）。 */
export const TOKEN_KEY = 'sxdevops_token'
export const USER_KEY = 'sxdevops_user'
export const CACHE_PREFIX = 'sxdevops.cache.'

/** 按用户隔离的缓存 key；userId 缺失时用 anonymous，避免串号。 */
export function scopedCacheKey(name, userId) {
    return `${CACHE_PREFIX}${userId || 'anonymous'}.${name}`
}

export function clearUserCaches() {
    for (const storage of [window.localStorage, window.sessionStorage]) {
        try {
            Object.keys(storage)
                .filter(key => key.startsWith(CACHE_PREFIX))
                .forEach(key => storage.removeItem(key))
        } catch {
            // 隐私模式或配额异常时忽略：缓存清理失败不应阻断登出。
        }
    }
}
