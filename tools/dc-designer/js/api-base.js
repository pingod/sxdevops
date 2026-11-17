/**
 * API 基址解析（零依赖）——让前端在「反代子路径」部署下也能找到本机服务。
 *
 * 背景：在线版部署在 部署路径（NGINX 把 /designer/ 转发到本机
 * 3999 端口的 idc-2d-modeler）。若前端把接口写成绝对路径 '/api/...'，浏览器会把请求发到
 * 站点根（https://部署域名/api/...）→ 404 → AI 面板误判「本机服务不可用」，
 * 退化成浏览器直连模型（被 CORS 拦截），并弹出 /api/ai 不可用的黄条提示。
 *
 * 解析优先级：
 *   1. `window.__IDC_APP_BASE__`（部署方显式指定，如 '/designer/' 或 'designer'）
 *   2. `<base href="...">`（部署方在 HTML 里写了 base 标签）
 *   3. 当前页面 URL 推导：去掉末尾文件名后取目录（/designer/index.html → /designer/）；
 *      页面在 /designer（无斜杠）时按目录处理，避免拼出站点根的 /api
 *   4. file:// 直接双击打开、Node 单元测试环境：'/'
 *
 * 只做字符串归一，不访问网络、无副作用；两版后端（main.go / server.js）同时支持
 * IDC_BASE_PATH 显式配置与「首段自动识别」，见 README「子路径反向代理部署」。
 */

/** 归一化：'designer' / '/designer' / '/designer/' → '/designer/'；空/根 → '/' */
function normBase(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s || s === '/') return '/';
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '') + '/';
}

/** 取目录部分：'/designer/index.html' → '/designer/'；'/designer' → '/designer/'；'/' → '/' */
function dirOf(pathname) {
  let p = String(pathname || '/');
  if (!p.startsWith('/')) p = '/' + p;
  if (p.endsWith('/')) return p;
  const i = p.lastIndexOf('/');
  const last = p.slice(i + 1);
  // 末段含点号视为文件名（index.html / main.js），否则视为目录（/designer）
  return last.includes('.') ? (p.slice(0, i + 1) || '/') : p + '/';
}

/** 当前页面的应用基路径（始终以 '/' 开头、以 '/' 结尾，如 '/designer/'） */
export function appBase() {
  try {
    const forced = typeof window !== 'undefined' ? window.__IDC_APP_BASE__ : undefined;
    if (forced !== undefined && forced !== null && String(forced).trim() !== '') return normBase(forced);
  } catch (e) { /* 隐私模式/跨域 iframe：忽略 */ }

  try {
    if (typeof document !== 'undefined' && document.querySelector) {
      const b = document.querySelector('base[href]');
      if (b) return dirOf(new URL(b.getAttribute('href'), document.baseURI || location.href).pathname);
    }
  } catch (e) { /* 无 base 标签或 URL 解析失败：落到页面推导 */ }

  try {
    if (typeof location !== 'undefined' && location && location.pathname &&
        location.protocol !== 'file:') {
      return dirOf(location.pathname);
    }
  } catch (e) { /* Node/离线环境 */ }

  return '/'; // file:// 直接打开、Node 单测：按根路径处理（本机服务不可用时面板会走直连兜底）
}

/** 应用内接口地址：apiUrl('/api/ai/status') → '/designer/api/ai/status'（根部署则原样） */
export function apiUrl(path) {
  return appBase() + String(path == null ? '' : path).replace(/^\/+/, '');
}
