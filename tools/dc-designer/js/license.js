/** 授权状态展示与功能开关（配合 internal/secure 的 /api/license）。
 *
 * 发布形态（后端返回的 mode）：
 *   dev      —— 开发构建（public/ 明文内嵌），无此接口 → 本模块静默退出；
 *   secure   —— 资源加密发布、密钥内置：只显示「加密发布」徽标，不做功能限制；
 *   licensed —— 资源加密 + 离线许可证：显示授权对象/到期日，并按 features 隐藏未授权功能。
 *
 * 说明：功能开关属于**商业交付层面的软约束**（纯离线软件的任何前端开关都能被绕过），
 * 真正的强约束是「没有许可证就解不开加密资源」，见 docs/加密与授权方案.md。
 * 水印同时挂在 window.IDC2D_LICENSE 上，导出模块可读取后写入落款用于溯源。 */

import { t } from './i18n.js';
import { apiUrl } from './api-base.js';

/** 功能名 → 对应的界面按钮（未授权时隐藏并给出提示） */
const FEATURE_BUTTONS = {
  '3d': ['btn-3d'],
  ai: ['btn-ai'],
  dxf: ['btn-dxf'],
  csv: ['btn-csv'],
  png: ['btn-png'],
  check: ['btn-check'],
};

/** 合并导出入口（#export-grp，含 PNG/DXF/CSV 三项的下拉菜单）：
 *  三项全部未授权时整个导出组一并隐藏，避免只剩一个空菜单的按钮。 */
const EXPORT_FEATURES = ['png', 'dxf', 'csv'];

/** 拉取授权状态：任何失败（dev 构建 404 / 离线）都静默忽略，绝不影响正常使用 */
async function fetchStatus(timeoutMs = 3000) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(apiUrl('/api/license'), { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!r.ok) return null;
    const st = await r.json();
    return st && st.mode ? st : null;
  } catch (e) {
    return null; // 单文件/离线打开、旧后端：无授权接口
  }
}

/** 状态 → 徽标文案与提示（Node 可测：纯函数） */
export function badgeOf(st, tr) {
  if (!st || st.mode === 'dev') return null;
  const tips = [];
  if (st.subject) tips.push(`${tr('lic.subject')}: ${st.subject}`);
  if (st.mode === 'licensed') tips.push(`${tr('lic.expires')}: ${st.expires || tr('lic.perpetual')}`);
  if (st.watermark) tips.push(`${tr('lic.watermark')}: ${st.watermark}`);
  if (st.machineId) tips.push(`${tr('lic.machine')}: ${st.machineId}`);
  if (!st.licensed && st.reason) tips.push(st.reason);
  if (st.mode === 'licensed' && Array.isArray(st.features) && st.features.length) {
    tips.push(`${tr('lic.features')}: ${st.features.join(', ')}`);
  }
  // 文案按构建形态决定：授权构建看是否已授权；加密发布构建固定显示「加密发布」
  const text = st.mode === 'licensed'
    ? (st.licensed ? tr('lic.badge.licensed') : tr('lic.badge.unlicensed'))
    : tr('lic.badge.secure');
  const cls = st.mode === 'licensed' ? (st.licensed ? 'ok' : 'warn') : 'secure';
  return { text, cls, tips };
}

/** 按授权功能隐藏对应按钮（features 为空/缺失 = 全开） */
export function applyFeatures(st, doc = document) {
  if (!st || !Array.isArray(st.features) || st.features.length === 0) return [];
  const missing = Object.keys(FEATURE_BUTTONS).filter(f => !st.features.includes(f));
  for (const f of missing) {
    for (const id of FEATURE_BUTTONS[f]) {
      const el = doc.getElementById(id);
      if (!el) continue;
      el.style.display = 'none';
      el.title = t('lic.off', { f });
    }
  }
  if (EXPORT_FEATURES.every(f => missing.includes(f))) {
    const grp = doc.getElementById('export-grp');
    if (grp) grp.style.display = 'none'; // 导出三项全未授权：整组（按钮 + 下拉菜单）隐藏
  }
  return missing;
}

/* ---------- 浏览器端 ---------- */
if (typeof document !== 'undefined') {
  const init = async () => {
    const st = await fetchStatus();
    if (!st || st.mode === 'dev') return;
    window.IDC2D_LICENSE = st; // 供其它模块（导出落款水印等）读取
    applyFeatures(st);
    const badge = badgeOf(st, t);
    const el = document.getElementById('st-license');
    if (!badge || !el) return;
    el.textContent = badge.text;
    el.className = `lic ${badge.cls}`;
    el.title = badge.tips.join('\n');
    el.hidden = false;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
