import axios from 'axios'
import { ElMessage } from 'element-plus/es/components/message/index'
import { pinia } from '@/stores'
import { useAuthStore } from '@/stores/auth'
import { TOKEN_KEY, USER_KEY } from '@/utils/session'
const PREVIEW_MESSAGE = '访客体验模式：可浏览页面和表单，暂不支持提交或执行操作。'
const PREVIEW_POST_PATHS = [
    /^\/auth\/(login|logout)\/$/,
    /^\/log\/query\/$/,
    /^\/log\/providers\/[^/]+\/catalog\/$/,
    /^\/observability\/(metrics\/query|grafana\/(promql|panel)\/query|tracing\/search)\/$/,
    /^\/observability\/datasource-links\/resolve_(trace_to_logs|log_to_trace|trace_to_grafana|log_to_grafana|grafana_to_logs|grafana_to_trace)\/$/,
]
let isHandlingSessionExpired = false

const request = axios.create({
    baseURL: '/api',
    timeout: 30000,
})

function flattenErrorPayload(payload, parentKey = '') {
    if (payload == null) return []
    if (typeof payload === 'string') return [payload]
    if (Array.isArray(payload)) {
        return payload.flatMap(item => flattenErrorPayload(item, parentKey))
    }
    if (typeof payload !== 'object') {
        return [String(payload)]
    }

    return Object.entries(payload).flatMap(([key, value]) => {
        const label = ['detail', 'non_field_errors'].includes(key)
            ? parentKey
            : parentKey
                ? `${parentKey}.${key}`
                : key
        return flattenErrorPayload(value, label).map((item) => {
            if (!label) return item
            return `${label}: ${item}`
        })
    })
}

function htmlErrorMessage(text, status) {
    if (typeof text !== 'string') return ''
    const normalized = text.trim()
    if (!/^<!doctype\s+html/i.test(normalized) && !/^<html[\s>]/i.test(normalized)) return ''
    const titleMatch = normalized.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim()
    if (title) return title
    if (status === 404) return '接口不存在，请检查后端路由或代理配置'
    return '接口返回了异常 HTML 页面，请检查后端服务状态'
}

async function extractErrorMessage(error) {
    if (error.code === 'ECONNABORTED' || String(error.message || '').toLowerCase().includes('timeout')) {
        return '请求超时，请稍后重试'
    }

    const response = error.response
    const data = response?.data

    if (typeof Blob !== 'undefined' && data instanceof Blob) {
        try {
            const text = await data.text()
            if (!text) return error.message || '请求失败'
            const htmlMessage = htmlErrorMessage(text, response?.status)
            if (htmlMessage) return htmlMessage
            try {
                const parsed = JSON.parse(text)
                const messages = flattenErrorPayload(parsed)
                return messages.join('；') || text
            } catch {
                return text
            }
        } catch {
            return error.message || '请求失败'
        }
    }

    const htmlMessage = htmlErrorMessage(data, response?.status)
    if (htmlMessage) return htmlMessage

    const messages = flattenErrorPayload(data).filter(Boolean)
    if (messages.length) {
        return messages.join('；')
    }

    if (response?.status) {
        return error.message || `请求失败（HTTP ${response.status}）`
    }
    return error.message || '请求失败'
}

const PUBLIC_PATH_PREFIXES = ['/login', '/product', '/about']

function isPublicPath(pathname) {
    return pathname === '/' || PUBLIC_PATH_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function redirectToLogin() {
    if (window.location.pathname.startsWith('/login')) return
    const redirect = encodeURIComponent(window.location.pathname + window.location.search)
    window.location.href = `/login?redirect=${redirect}`
}

function handleSessionExpired() {
    // 先清 Pinia 再清 localStorage：否则页面仍认为自己是已登录状态。
    try {
        useAuthStore(pinia).clearSession()
    } catch {
        // Pinia 未就绪时退回直接清理存储。
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(USER_KEY)
    }

    // 公开页面（产品介绍 / 网站说明）不需要登录；残留的过期 token 不应把访客强制踢到登录页。
    if (isPublicPath(window.location.pathname)) return
    if (isHandlingSessionExpired) return
    isHandlingSessionExpired = true
    ElMessage.error('登录状态已过期，请重新登录')
    window.setTimeout(() => {
        redirectToLogin()
        isHandlingSessionExpired = false
    }, 700)
}

request.interceptors.request.use((config) => {
    const method = String(config.method || 'get').toUpperCase()
    const url = new URL(request.getUri(config), window.location.origin)
    if (url.origin !== window.location.origin || url.username || url.password) {
        const error = new Error('平台 API 仅允许请求本站地址')
        error.code = 'UNSAFE_API_ORIGIN'
        error.config = config
        return Promise.reject(error)
    }
    const path = url.pathname.replace(/^\/api(?=\/)/, '')
    const rebuildsHistory = path === '/observability/system-posture/history/' && ['refresh', 'backfill'].some(key =>
        ['1', 'true', 'yes'].includes(String(config.params?.[key] ?? url.searchParams.get(key) ?? '').toLowerCase())
    )
    let user = null
    try { user = JSON.parse(localStorage.getItem(USER_KEY) || 'null') } catch { /* Profile refresh repairs invalid cache. */ }
    if (user?.is_preview && (rebuildsHistory || (!['GET', 'HEAD', 'OPTIONS'].includes(method)
        && !(method === 'POST' && PREVIEW_POST_PATHS.some(pattern => pattern.test(path)))))) {
        const error = new Error(PREVIEW_MESSAGE)
        error.code = 'PREVIEW_READ_ONLY'
        error.config = config
        error.response = { status: 403, data: { detail: PREVIEW_MESSAGE } }
        return Promise.reject(error)
    }
    const token = localStorage.getItem(TOKEN_KEY)
    if (token) {
        config.headers = config.headers || {}
        config.headers.Authorization = `Token ${token}`
    }
    return config
})

request.interceptors.response.use(
    (response) => response.data,
    async (error) => {
        // 主动取消的请求（切换主机/关闭日志弹窗等）不是错误，不要弹出 “canceled”。
        if (axios.isCancel(error) || error?.code === 'ERR_CANCELED') {
            return Promise.reject(error)
        }
        const status = error.response?.status
        const requestUrl = String(error.config?.url || '')
        const isProfileRequest = requestUrl.includes('/auth/me/')
        const skipErrorMessage = Boolean(
            error.config?.skipErrorMessage || error.config?.suppressErrorMessage
        )
        const msg = await extractErrorMessage(error)

        if (status === 401 && !isProfileRequest) {
            handleSessionExpired()
        } else if (status === 403 && /权限|permission/i.test(msg)) {
            // 权限刚被调整过：静默刷新一次档案，避免界面继续按旧权限渲染。
            try {
                await useAuthStore(pinia).reloadProfile({ silent: true })
            } catch {
                // 刷新失败时保留原错误提示。
            }
            if (!skipErrorMessage) ElMessage.error(msg)
        } else if (!(status === 401 && isProfileRequest) && !skipErrorMessage) {
            ElMessage.error(msg)
        }

        return Promise.reject(error)
    }
)

export default request
