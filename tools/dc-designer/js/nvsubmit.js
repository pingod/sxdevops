/** 提交到 nVisual Studio —— UI（顶栏「导出」右侧按钮 + 提交对话框）
 *
 * 交互：
 *   ① 点顶栏「提交nVisual Studio」（云朵上传图标，位于「导出」按钮右侧）→ 提交对话框：
 *      平台地址（URL）/ **API Key**（第二位）/ **视图节点 ID（diagramId）** 三项配置
 *      （已保存时掩码回显与回填，配置只存本浏览器 localStorage）；
 *      对话框**不展示提交内容概览与说明文案**，点「开始提交」即上传；
 *   ② 点「开始提交」→ 经本机服务 /api/nvisual 代理把项目 JSON 以 multipart/form-data
 *      上传到 POST {url}/diagramApi/wapi/v1/migration/import_survey?diagramId=…（浏览器不发跨域请求、不会报 CORS 错）；
 *      提交中按钮禁用防重复点击；
 *   ③ 提交成功 → 对话框内显示平台返回的导入结果（机房名/各类创建数量/跳过项/警告），状态栏同步提示；
 *      失败 → 内联红字（地址不可识别 / 节点 ID 非法 / Key 截断 / 平台错误码与文案），可改后重试；
 *      **目标视图非空**（平台防覆盖守卫，如 800119／“there are objects in the current view”）不算接口故障，
 *      单独给黄底说明：「换一个空视图节点」或「清空目标视图后重试」，并自动聚焦视图节点 ID 输入框（全选便于粘贴）。
 *
 * 纯逻辑（配置读写、地址与 JWT 校验、上传 JSON 与文件名组装、代理请求、结果解析）在 nvsubmit_core.js，可 Node 单测。
 */

import { state, ui } from './state.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { closeExportMenu } from './exportmenu.js';
import {
  loadCfg, saveCfg, normalizeUrl, normalizeDiagramId, truncatedJwt,
  buildSurveyPayload, buildSurveyFilename, postDcSync, syncResultStats,
  KIND_NAMES, SUPPORTED_KINDS,
} from './nvsubmit_core.js';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ── API Key 掩码回显（与 FiberMap / AI 面板同款）──
 * 已保存 Key 时输入框全部显示星号（不泄漏前后缀与长度）；聚焦输入新 Key 自动清空并切回密码输入，
 * 失焦留空恢复掩码；读取表单时若仍是掩码（未改动）则沿用已保存 Key。 */
const KEY_MASK_LEN = 23;
const keyMask = () => '*'.repeat(KEY_MASK_LEN);
const keyIsMasked = el => !!(el && el.dataset.masked === '1');

function initKeyMask(el, saved) {
  const hasSaved = !!(saved || '').trim();
  const showMask = () => { el.type = 'text'; el.value = keyMask(); el.dataset.masked = '1'; };
  const clearInput = () => { el.type = 'password'; el.value = ''; delete el.dataset.masked; };
  if (hasSaved) showMask(); else clearInput();
  el.addEventListener('focus', () => { if (keyIsMasked(el)) clearInput(); });
  el.addEventListener('blur', () => { if (!keyIsMasked(el) && !el.value.trim() && hasSaved) showMask(); });
}

const keyValue = (el, saved) => (keyIsMasked(el) ? String(saved || '').trim() : el.value.trim());

/* ── 提交中动效：省略号逐点跳动（三个点依次亮起）──
 * 各语言译文末尾本来就带省略号（如“提交中…”），这里去掉后用 <i> 三点重画，动画不影响按钮宽度。
 * 尊重系统“减少动效”偏好：prefers-reduced-motion 下不跑动画，三点静态常亮。 */
const DOTS = '<span class="nv-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>';
const submittingHtml = () => esc(String(t('nv.submitting') || '').replace(/[\u2026.]+\s*$/, '').trim()) + DOTS;

/** 结果区块（成功后替换表单区；无明细统计时用通用文案）
 *  展示：机房名（节点 ID）/ 机柜台数 / 各类创建数量 / 跳过项与警告（各取前若干条） */
function resultHtml(st) {
  if (!st) return `<div class="nv-done">${icon('check')}<p>${t('nv.ok.generic')}</p></div>`;
  const rows = [];
  if (st.roomName) rows.push([t('nv.r.room'), st.roomName + (st.roomId ? ` (${st.roomId})` : '')]);
  if (st.racks) rows.push([t('nv.r.racks'), t('nv.r.count', { n: st.racks })]);
  const counts = Object.entries(st.counts || {})
    .filter(([k, n]) => +n > 0)
    .map(([k, n]) => `${KIND_NAMES[k] || (SUPPORTED_KINDS.has(k) ? k : k)} ${n}`)
    .join(' · ');
  if (counts) rows.push([t('nv.r.counts'), counts]);
  const skipped = st.skipped.length
    ? `<div class="nv-skip"><b>${esc(t('nv.r.skipped', { n: st.skipped.length }))}</b>${
        st.skipped.slice(0, 5).map(s => `<div>${esc((KIND_NAMES[s.type] || s.type || '?') + (s.name ? ' ' + s.name : '') + '：' + (s.reason || ''))}</div>`).join('')
      }${st.skipped.length > 5 ? `<div>…</div>` : ''}</div>`
    : '';
  const warnings = st.warnings.length
    ? `<div class="nv-skip"><b>${esc(t('nv.r.warnings', { n: st.warnings.length }))}</b>${
        st.warnings.slice(0, 3).map(w => `<div>${esc(w)}</div>`).join('')
      }${st.warnings.length > 3 ? `<div>…</div>` : ''}</div>`
    : '';
  return `<div class="nv-done">${icon('check')}
    <p>${t('nv.r.done')}</p>
    ${rows.map(([k, v]) => `<div class="nv-srow"><span>${esc(k)}</span><i>${esc(v)}</i></div>`).join('')}
    ${skipped}${warnings}
  </div>`;
}

/** 目标视图非空（平台防覆盖守卫）提示：可操作的两条办法 + 平台原文（去 HTTP 前缀），不当成接口故障 */
function viewBusyHtml(e) {
  const raw = String((e && e.message) || '').replace(/^HTTP \d+[：:]\s*/, '').trim();
  return `<div class="nv-busy">
    <b>${t('nv.busy.title')}</b>
    <p>${t('nv.busy.tip')}</p>
    ${raw ? `<div class="nv-busy-raw">${esc(t('nv.busy.raw', { msg: raw }))}</div>` : ''}
  </div>`;
}

/** 打开「提交到 nVisual Studio」对话框（项目为空时提示，不打开） */
export function openNvSubmitDialog() {
  const project = state.project;
  if (!project || !Array.isArray(project.objects) || !project.objects.length) {
    ui.hint(t('nv.empty'));
    return;
  }
  const cfg = loadCfg();
  const payload = buildSurveyPayload(project);   // 上传内容 = 项目 JSON（与保存同格式）
  const filename = buildSurveyFilename(project);

  const ov = document.createElement('div');
  ov.className = 'wz-overlay';
  ov.innerHTML = `<div class="wz-modal nv-modal">
    <h2>${icon('nvisual-upload')}${t('nv.title')}</h2>
    <div class="nv-form">
      <label><span>${t('nv.url')}</span>
        <input type="text" id="nv-url" placeholder="${esc(t('nv.url.ph'))}" value="${esc(cfg.url)}" maxlength="500" spellcheck="false" autocomplete="off">
      </label>
      <label><span>${t('nv.key')}</span>
        <input type="text" id="nv-key" placeholder="${esc(t('nv.key.ph'))}" value="" maxlength="4096" spellcheck="false" autocomplete="off">
      </label>
      <label><span>${t('nv.diagram')}</span>
        <input type="text" id="nv-diagram" placeholder="${esc(t('nv.diagram.ph'))}" value="${esc(cfg.diagramId)}" maxlength="20" spellcheck="false" autocomplete="off" inputmode="numeric">
      </label>
    </div>
    <div class="nv-body">${project.objects.some(o=>o.type==='pipe')?`<div class="nv-skip">${esc(t('pipe.platformWarning'))}</div>`:''}</div>
    <div class="nv-err" id="nv-err" hidden></div>
    <div class="nv-actions">
      <button class="nv-ghost" id="nv-cancel">${t('nv.cancel')}</button>
      <button class="nv-primary" id="nv-go">${t('nv.go')}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);

  const $ = id => ov.querySelector(id);
  const err = $('#nv-err');
  const showErr = msg => { err.hidden = !msg; err.textContent = msg || ''; err.classList.remove('nv-err-busy'); };
  const showBusyErr = e => { err.hidden = false; err.innerHTML = viewBusyHtml(e); err.classList.add('nv-err-busy'); };
  initKeyMask($('#nv-key'), cfg.apiKey);

  let busy = false;
  const close = () => {
    if (busy) return; // 提交中不允许关闭（请求仍在跑，防止丢结果）
    ov.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }; // 消费 Esc，不触发画布取消工具等下层行为
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('pointerdown', e => { if (e.target === ov) close(); }); // 点遮罩空白处关闭

  const readForm = () => ({
    url: $('#nv-url').value.trim(),
    diagramId: $('#nv-diagram').value.trim(),
    apiKey: keyValue($('#nv-key'), cfg.apiKey),
  });

  /** 校验（失败返回 null 并已内联提示） */
  const validate = c => {
    if (!c.url) { showErr(t('nv.err.url')); $('#nv-url').focus(); return null; }
    const url = normalizeUrl(c.url);
    if (!url) { showErr(t('nv.err.urlBad')); $('#nv-url').focus(); return null; }
    if (!c.diagramId) { showErr(t('nv.err.diagram')); $('#nv-diagram').focus(); return null; }
    const diagramId = normalizeDiagramId(c.diagramId);
    if (!diagramId) { showErr(t('nv.err.diagramBad')); $('#nv-diagram').focus(); return null; }
    if (!c.apiKey) { showErr(t('nv.err.key')); $('#nv-key').focus(); return null; }
    const bad = truncatedJwt(c.apiKey);
    if (bad) {
      showErr(t('nv.err.keyCut', { len: bad.sigLen, need: bad.need, alg: bad.alg }));
      $('#nv-key').focus();
      return null;
    }
    return { url, diagramId, apiKey: c.apiKey };
  };

  $('#nv-cancel').addEventListener('click', close);

  $('#nv-go').addEventListener('click', async () => {
    const c = validate(readForm());
    if (!c) return;
    saveCfg(c);
    busy = true;
    const go = $('#nv-go');
    go.disabled = true;
    go.setAttribute('aria-busy', 'true');
    go.innerHTML = submittingHtml();
    showErr('');
    try {
      const res = await postDcSync(c, payload, filename);
      const st = syncResultStats(res);
      busy = false;
      ov.querySelector('.nv-form').remove();
      ov.querySelector('.nv-body').innerHTML = resultHtml(st);
      go.remove();
      const cancel = $('#nv-cancel');
      cancel.textContent = t('nv.close');
      ui.hint(st ? t('nv.hint.ok', {
        room: st.roomName || '—',
        racks: st.racks,
        counts: Object.values(st.counts || {}).reduce((a, n) => a + (+n || 0), 0),
        skipped: st.skipped.length,
      }) : t('nv.hint.okGeneric'));
    } catch (e) {
      busy = false;
      go.disabled = false;
      go.removeAttribute('aria-busy');
      go.textContent = t('nv.go');
      if (e && e.kind === 'viewBusy') {
        showBusyErr(e);
        const idEl = $('#nv-diagram');
        idEl.focus();
        if (idEl.select) idEl.select(); // 全选旧 ID：可直接粘贴平台里新建的空视图节点 ID
      } else {
        showErr(t('nv.err.fail', { msg: (e && e.message) || String(e) }));
      }
    }
  });

  $('#nv-url').focus();
  return ov;
}

/** 绑定顶栏「提交nVisual Studio」按钮（main.js 启动时调用一次；旧页面缺元素时静默跳过） */
export function initNvSubmit() {
  const btn = document.getElementById('btn-sync-nvisual');
  if (!btn) return;
  btn.addEventListener('click', () => {
    closeExportMenu(); // 导出下拉菜单若展开着，先收起（同一次点击不会又展开）
    openNvSubmitDialog();
  });
}
