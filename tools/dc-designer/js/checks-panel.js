/** 合规自检面板（左侧，与工勘向导互斥；可与右侧 AI 并存，见 panels.js）
 *
 * 交互：
 * - 顶栏 btn-check 开关；「运行自检」按当前阈值跑 checks.js 规则集，结果按规则顺序列出
 * - 点击问题项：画布选中涉及对象并缩放聚焦（状态栏同步显示问题说明）；不关闭面板，便于逐项核对
 * - 「阈值与规则」折叠区：阈值数字输入即改即存（localStorage，重新运行生效）；规则可单独开关
 * - 导出 CSV / Markdown 校验报告（固定中文，同工程量清单决策）；报告说明见 checks.js DISCLAIMER
 * - 面板 chrome（按钮/级别/类别名）走 i18n；规则名与阈值标签为报告术语，固定中文
 */
import { state, ui, getObj } from './state.js';
import { objOutline } from './geo.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { notifyPanelState, onPanelState } from './panels.js';
import { loadUI, patchUI } from './uistate.js';
import {
  runChecks, summarize, passedRules, CHECK_RULES,
  loadCheckCfg, saveCheckCfg, resetCheckCfg,
  buildCheckCSV, buildCheckMD,
} from './checks.js';

const CK = { visible: false, issues: null, cfg: null, ranAt: 0, justRan: false, running: false }; // issues=null 表示尚未运行

/** 阈值设置项（[cfg键, 中文标签, 单位]；报告术语固定中文） */
const CFG_FIELDS = [
  ['cabFront', '柜前净距 ≥', 'mm'], ['cabRear', '柜后净距 ≥', 'mm'],
  ['cabSideWall', '柜侧与墙 ≥', 'mm'], ['coldAisle', '冷通道宽 ≥', 'mm'],
  ['hotAisle', '热通道宽 ≥', 'mm'], ['acService', '空调检修面 ≥', 'mm'],
  ['trayMinHeight', '桥架距地 ≥', 'mm'], ['trayAboveCab', '桥架高过设备顶 ≥', 'mm'],
  ['upsLoadMaxPct', 'UPS负载率 ≤', '%'], ['coolMinRatio', '冷量/功率 ≥', ''],
  ['densityKW', '高密提示 >', 'kW/柜'], ['densityArea', '面积密度提示 >', 'kW/m²'],
  ['doorMinWidth', '疏散门净宽 ≥', 'mm'], ['twoExitArea', '双出口面积阈值 >', 'm²'],
  ['extRadius', '灭火器保护半径 ≤', 'mm'],
  ['floorLoadWarnPct', '承重预警', '%'],
  ['clearHeightMin', '净高 ≥', 'mm'], ['underfloorMin', '下送风地板高 ≥', 'mm'],
  ['kgPerCabKW', '机柜估重', 'kg/kW'], ['kgPerUpsKVA', 'UPS估重', 'kg/kVA'],
  ['kgPerAhCell', '蓄电池估重', 'kg/(Ah·只)'], ['kgPerAC', '空调估重', 'kg/台'],
  ['kgPerPDU', '列头柜估重', 'kg/台'],
];
const CATS = ['layout', 'clearance', 'power', 'cooling', 'fire', 'load', 'civil'];
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export function initChecks() {
  document.getElementById('btn-check').addEventListener('click', () => toggleChecks());
  // 显式进入 AI 默认收起左栏；用户之后打开自检时，不关闭右侧 AI。
  onPanelState(d => { if (d.open && ['wizard', 'ai-enter'].includes(d.name)) toggleChecks(false); });
  renderPanel();
  if (loadUI().checks.open) toggleChecks(true); // 刷新恢复：上次开着的自检面板继续打开（首次打开自动运行一次）
}

/** 语言切换后重建面板（main.js 的 onLocaleChange 调用） */
export function refreshChecks() { renderPanel(); }

export function toggleChecks(force) {
  const el = document.getElementById('checks');
  const next = force === undefined ? !CK.visible : !!force;
  const changed = next !== CK.visible;
  CK.visible = next;
  el.style.display = CK.visible ? '' : 'none';
  document.getElementById('btn-check').classList.toggle('active', CK.visible);
  ui.resize(); // 画布宽度变化后需重设画布尺寸
  patchUI('checks', { open: CK.visible }); // 开合状态随刷新恢复
  if (changed) notifyPanelState('checks', CK.visible); // 仅向导随之收起
  if (CK.visible && CK.issues === null) run(); // 首次打开自动运行一次
}

/* ---------- 运行 / 定位 / 导出 ---------- */
const RUN_MIN_MS = 320; // 忙碌态最短展示时长：引擎为同步毫秒级计算，过快的“零反馈”会让用户以为没点上
function run() {
  if (CK.running) return;
  CK.running = true;
  const btn = document.querySelector('#checks [data-act="run"]');
  if (btn) { btn.disabled = true; btn.classList.add('busy'); btn.innerHTML = `${icon('rotate')}${t('ck.running')}`; }
  const t0 = Date.now();
  setTimeout(() => {
    CK.cfg = loadCheckCfg();
    CK.issues = runChecks(state.project, CK.cfg);
    CK.ranAt = Date.now();
    CK.justRan = true; CK.running = false;
    renderPanel();
    const s = summarize(CK.issues);
    ui.hint(t('ck.done', { e: s.error, w: s.warn, i: s.info }));
  }, Math.max(0, RUN_MIN_MS - (Date.now() - t0)));
}

/** 点击问题项：选中涉及对象 + 缩放聚焦（多对象取联合包围盒，2.5 倍留白），状态栏显示说明 */
function locate(it) {
  const objs = it.objectIds.map(getObj).filter(Boolean);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (const o of objs.slice(0, 50)) { // 聚焦最多取前 50 个对象的包围盒
    const poly = objOutline(o, getObj);
    if (!poly) continue;
    any = true;
    for (const p of poly) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  if (!any) { minX = it.x - 600; maxX = it.x + 600; minY = it.y - 600; maxY = it.y + 600; }
  const cv = document.getElementById('cv');
  if (cv) {
    const bw = Math.max(1200, maxX - minX) * 2.5, bh = Math.max(1200, maxY - minY) * 2.5;
    const cw = cv.clientWidth || 800, ch = cv.clientHeight || 600;
    const scale = Math.min(cw / bw, ch / bh);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    state.view = { scale, ox: cw / 2 - cx * scale, oy: ch / 2 + cy * scale }; // 屏幕 y = oy - 世界y·scale
    if (ui.zoom) ui.zoom(scale);
  }
  state.selectedIds = it.objectIds.slice(0, 200);
  ui.props();
  ui.render();
  ui.hint(it.msg);
}

function download(content, mime, suffix) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = (state.project.name || t('project.untitled')) + suffix;
  a.click();
  URL.revokeObjectURL(a.href);
  ui.hint(t('ck.exported'));
}
const exportCSV = () => download('\uFEFF' + buildCheckCSV(state.project, CK.issues || []), 'text/csv;charset=utf-8', '-自检报告.csv'); // BOM：Excel 双击中文不乱码
const exportMD = () => download(buildCheckMD(state.project, CK.issues || []), 'text/markdown;charset=utf-8', '-自检报告.md');

/* ---------- 面板渲染 ---------- */
function issueHtml(it, idx) {
  return `<div class="ck-it lv-${it.level}" data-idx="${idx}" title="${esc(it.msg)}">
    <span class="ck-lv">${t('ck.lv.' + it.level)}</span>
    <span class="ck-cat">${t('ck.cat.' + it.cat)}</span>
    <div class="ck-msg">${esc(it.msg)}</div>
    ${it.actual || it.expect ? `<div class="ck-vals">${esc(it.actual)}${it.expect ? ` → ${esc(it.expect)}` : ''}</div>` : ''}
  </div>`;
}

function bodyHtml() {
  if (CK.issues === null) return `<div class="ck-hint">${t('ck.hintRun')}</div>`;
  const s = summarize(CK.issues);
  const pass = passedRules(CK.issues).length;
  const anim = CK.justRan ? ' ck-anim' : ''; // 本次运行后结果区入场动画 + 徽章闪烁
  const p = v => String(v).padStart(2, '0');
  const d = new Date(CK.ranAt);
  const timeTxt = CK.ranAt ? `<span class="ck-time">${t('ck.ranAt', { t: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` })}</span>` : '';
  const list = CK.issues.length
    ? CK.issues.map(issueHtml).join('')
    : `<div class="ck-empty">${icon('check')}${t('ck.empty')}</div>`;
  return `
  <div class="ck-sum${anim}">
    <span class="ck-badge lv-error">${t('ck.lv.error')} ${s.error}</span>
    <span class="ck-badge lv-warn">${t('ck.lv.warn')} ${s.warn}</span>
    <span class="ck-badge lv-info">${t('ck.lv.info')} ${s.info}</span>
    <span class="ck-pass">${t('ck.pass', { ok: pass, total: CHECK_RULES.length })}</span>
    ${timeTxt}
  </div>
  <div class="ck-list${anim}">${list}</div>`;
}

function cfgHtml() {
  const cfg = CK.cfg || loadCheckCfg();
  const disabled = new Set(cfg.disabled);
  const num = ([k, label, unit]) =>
    `<label class="ck-field"><span>${label}${unit ? ` (${unit})` : ''}</span>
      <input type="number" data-cfg="${k}" value="${cfg[k]}" step="any"></label>`;
  const rules = CATS.map(cat => {
    const items = CHECK_RULES.filter(r => r.cat === cat).map(r =>
      `<label class="ck-rule"><input type="checkbox" data-rule="${r.id}" ${disabled.has(r.id) ? '' : 'checked'}><span>${r.name}</span></label>`).join('');
    return `<div class="ck-rulecat"><b>${t('ck.cat.' + cat)}</b>${items}</div>`;
  }).join('');
  return `<details class="ck-cfg">
    <summary>${t('ck.settings')}</summary>
    <div class="ck-cfgsec"><b>${t('ck.thresholds')}</b>${CFG_FIELDS.map(num).join('')}</div>
    <div class="ck-cfgsec"><b>${t('ck.rules')}</b>${rules}</div>
    <button class="ck-reset" data-act="resetCfg">${t('ck.reset')}</button>
  </details>`;
}

function renderPanel() {
  const el = document.getElementById('checks');
  if (!el) return;
  el.innerHTML = `
  <div class="wz-head">
    <b>${icon('check')}${t('ck.title')}</b>
    <button class="wz-x" data-act="hide" title="${t('wz.collapse')}">×</button>
  </div>
  <div class="ck-body">
    <div class="ck-actions">
      <button class="ck-run" data-act="run">${icon('rotate')}${t('ck.run')}</button>
      <button data-act="csv" ${CK.issues === null ? 'disabled' : ''}>${t('ck.exportCSV')}</button>
      <button data-act="md" ${CK.issues === null ? 'disabled' : ''}>${t('ck.exportMD')}</button>
    </div>
    ${bodyHtml()}
    ${cfgHtml()}
    <div class="ck-note">${t('ck.disclaimer')}</div>
  </div>`;
  if (CK.justRan) { CK.justRan = false; el.scrollTop = 0; } // 重跑后回到顶部看概览
  el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'hide') toggleChecks(false);
    else if (act === 'run') run();
    else if (act === 'csv') exportCSV();
    else if (act === 'md') exportMD();
    else if (act === 'resetCfg') { resetCheckCfg(); CK.cfg = loadCheckCfg(); if (CK.issues !== null) run(); else renderPanel(); }
  }));
  el.querySelectorAll('.ck-it').forEach(row => row.addEventListener('click', () => {
    const it = CK.issues && CK.issues[+row.dataset.idx];
    if (it) locate(it);
  }));
  // 阈值输入：即改即存（重新运行生效）
  el.querySelectorAll('[data-cfg]').forEach(inp => inp.addEventListener('change', () => {
    const cfg = CK.cfg || loadCheckCfg();
    const v = parseFloat(inp.value);
    if (Number.isFinite(v)) { cfg[inp.dataset.cfg] = v; CK.cfg = cfg; saveCheckCfg(cfg); }
    else inp.value = cfg[inp.dataset.cfg];
  }));
  // 规则开关：即改即存
  el.querySelectorAll('[data-rule]').forEach(cb => cb.addEventListener('change', () => {
    const cfg = CK.cfg || loadCheckCfg();
    const set = new Set(cfg.disabled);
    if (cb.checked) set.delete(cb.dataset.rule); else set.add(cb.dataset.rule);
    cfg.disabled = [...set];
    CK.cfg = cfg; saveCheckCfg(cfg);
  }));
}
