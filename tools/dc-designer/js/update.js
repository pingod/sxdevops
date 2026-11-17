/** 新版本发布自动提醒（纯前端实现，Go/Node 双后端零改动）
 *
 * 原理：页面加载后延迟数秒，同源读取 version.json 得当前版本；再用 <script>
 * 标签跨域加载发布清单 latest.js —— script 标签不受同源策略（CORS）限制，
 * 静态托管零配置即可用。清单合法且版本更新时弹窗提醒（复用欢迎弹窗的
 * .wz-overlay/.wz-modal 骨架），「下载更新」按钮固定打开下载页 DOWNLOAD_URL。
 *
 * 清单格式（latest.js，手动维护并上传至公司网站）：
 * window.IDC2D_LATEST = {
 *   "latest": "1.1.0",
 *   "date": "2026-09-04",
 *   "notes": "纯文本更新说明，\n 分行"
 * };
 *
 * 任何失败（离线/超时/清单损坏）一律静默，绝不打扰现场作业。
 * 不做忽略记忆：只要发现有新版本，每次启动都会提醒（“稍后再说”仅关闭本次弹窗）。
 *
 * 调试 / 迁移托管点（免重新构建，浏览器控制台执行后刷新即可）：
 *   localStorage.setItem('idc2d_update_url', 'https://.../latest.js')
 */

import { t } from './i18n.js';

// 发布清单地址（手动维护并上传至公司网站；也可用上面的 localStorage 临时覆盖调试）
const DEFAULT_MANIFEST_URL = 'https://www.nvisual.com/downloadfile/latest.js';
// 「下载更新」按钮跳转的下载页
const DOWNLOAD_URL = 'https://www.nvisual.com/download/';

const URL_KEY = 'idc2d_update_url'; // localStorage：清单地址覆盖（调试/迁移托管点用）

/** 版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0（逐段数值比较，支持 1.10.0 > 1.9.2） */
export function compareVersion(a, b) {
  const pa = String(a).split('.'), pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10) || 0, nb = parseInt(pb[i], 10) || 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

/** 由清单对象生成更新信息；清单无效返回 null（纯函数，Node 可测） */
export function buildUpdateInfo(m, current) {
  if (!m || typeof m.latest !== 'string' || !m.latest) return null;
  return {
    current, latest: m.latest,
    date: typeof m.date === 'string' ? m.date : '',
    notes: typeof m.notes === 'string' ? m.notes : '',
    hasUpdate: compareVersion(m.latest, current) > 0,
  };
}

/* ---------- 以下为浏览器端（Node 单元测试不触发） ---------- */

/** 用 <script> 标签加载清单（script 标签不受 CORS 限制）；成功 resolve 清单对象，任何失败 resolve null */
function loadManifest(url, timeoutMs = 4000) {
  return new Promise(resolve => {
    const s = document.createElement('script');
    const finish = m => {
      clearTimeout(timer);
      s.remove();
      try { delete window.IDC2D_LATEST; } catch (e) { window.IDC2D_LATEST = undefined; }
      resolve(m);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    s.onload = () => finish(window.IDC2D_LATEST || null); // 清单语法错误：onload 仍触发但全局变量不存在 → null
    s.onerror = () => finish(null);                      // 离线/404/被 nosniff 拦截 → null
    s.async = true;
    s.src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(); // 防 CDN/浏览器缓存旧清单
    document.head.appendChild(s);
  });
}

function manifestUrl() {
  try { return localStorage.getItem(URL_KEY) || DEFAULT_MANIFEST_URL; } catch (e) { return DEFAULT_MANIFEST_URL; }
}
async function currentVersion() {
  try {
    const res = await fetch('version.json', { cache: 'no-cache' });
    const j = await res.json();
    return typeof j.version === 'string' && j.version ? j.version : '0.0.0';
  } catch (e) { return '0.0.0'; }
}

function showUpdateModal(info) {
  const ov = document.createElement('div');
  ov.className = 'wz-overlay';
  const modal = document.createElement('div');
  modal.className = 'wz-modal upd-modal'; // upd-modal：比欢迎弹窗宽 1.5 倍（380→570px）

  const h2 = document.createElement('h2');
  h2.textContent = t('upd.title', { v: info.latest });
  const meta = document.createElement('p');
  meta.className = 'upd-meta';
  meta.textContent = t('upd.meta', { c: info.current, d: info.date });
  modal.append(h2, meta);

  if (info.notes) {
    const notes = document.createElement('div');
    notes.className = 'upd-notes';
    notes.textContent = info.notes; // textContent 防注入，换行由 CSS pre-wrap 呈现
    modal.appendChild(notes);
  }
  const tip = document.createElement('p');
  tip.className = 'upd-tip';
  tip.textContent = t('upd.tip');

  const actions = document.createElement('div');
  actions.className = 'upd-actions';
  const btnDl = document.createElement('button');
  btnDl.className = 'wz-primary';
  btnDl.textContent = t('upd.download', { v: info.latest });
  const btnLater = document.createElement('button');
  btnLater.textContent = t('upd.later');
  actions.append(btnDl, btnLater);
  modal.append(tip, actions);
  ov.appendChild(modal);

  btnDl.addEventListener('click', () => { window.open(DOWNLOAD_URL, '_blank'); ov.remove(); });
  btnLater.addEventListener('click', () => ov.remove()); // 仅关闭本次弹窗，下次启动仍会提醒
  document.body.appendChild(ov);
}

// 与欢迎弹窗同为 .wz-overlay 遮罩，避免叠在一起：等它关闭后再弹，重试两次仍被占用则放弃本次提醒
function showWhenIdle(info, retries = 2) {
  if (!document.querySelector('.wz-overlay')) { showUpdateModal(info); return; }
  if (retries > 0) setTimeout(() => showWhenIdle(info, retries - 1), 15000);
}

/** 入口：页面加载后延迟检查一次（每次启动仅一次，不频繁打扰） */
export function initUpdateCheck(delayMs = 3000) {
  setTimeout(async () => {
    try {
      const current = await currentVersion();
      const m = await loadManifest(manifestUrl());
      const info = m && buildUpdateInfo(m, current);
      if (!info || !info.hasUpdate) return;
      showWhenIdle(info);
    } catch (e) { /* 静默 */ }
  }, delayMs);
}
