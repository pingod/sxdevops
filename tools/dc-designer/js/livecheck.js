/** 实时布局检查（live check）：编辑落定后自动校验「实体重叠 / 越出房间」两条 error 级布局规则，
 * 问题对象在画布上红框标记，顶栏自检按钮挂计数徽章，状态栏仅做增量提示。
 *
 * 设计决策（与手动合规自检面板互补，不替代）：
 * - 事件驱动防抖而非轮询：挂在 markDirty 的 onDirty 钩子（state.js），连续编辑（拖动/批量/AI 出图）
 *   只触发一次，无编辑零开销；避免 10s 轮询的最差延迟与空转
 * - 只跑 overlap / outRoom：纯几何、误报少、编辑当下反馈价值最高；净距/电力/消防等审计型规则
 *   仍由面板手动运行（阈值与报告语义不变），避免常态性告警常驻屏幕造成告警疲劳
 * - 红框由 render.js drawLiveIssues 绘制（导出 PNG/DXF 自动抑制），与选中琥珀框语义分离
 * - 增量提示：与上一轮结果按指纹 diff，只对「新增问题」「全部解决」发 ui.hint，不重复打扰
 * - 尊重面板规则开关：用户在合规自检面板关闭的规则，实时检查同样跳过
 */
import { state, ui, onDirty } from './state.js';
import { runChecks, CHECK_RULES, loadCheckCfg } from './checks.js';
import { t } from './i18n.js';

const LIVE_RULES = new Set(['overlap', 'outRoom']); // 实时子集：布局 error（其余规则留给手动面板）
const DEBOUNCE_MS = 900;  // 编辑落定判定（与 saveDraft 节流同节奏）

let timer = null;
let badge = null;    // 顶栏 btn-check 的计数徽章 DOM
let prevKeys = null; // 上一轮问题指纹集合（null=尚未运行；首轮只记录不提示，打开旧项目不算“新增”）

/** 问题指纹：规则 + 排序后的涉及对象 id——同一批问题持续存在不重复提示 */
const keyOf = it => `${it.rule}:${[...it.objectIds].sort().join(',')}`;

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(runLive, DEBOUNCE_MS);
}

function runLive() {
  timer = null;
  if (typeof document === 'undefined') return; // Node 单测环境无 DOM（livecheck 仅浏览器端挂载）
  const cfg = loadCheckCfg();
  // 规则并集：面板中被用户关闭的规则 + 非实时规则全部禁用，只留 overlap / outRoom
  const disabled = new Set(cfg.disabled);
  for (const r of CHECK_RULES) if (!LIVE_RULES.has(r.id)) disabled.add(r.id);
  let issues = [];
  try {
    issues = runChecks(state.project, { ...cfg, disabled: [...disabled] })
      .filter(it => it.level === 'error' && LIVE_RULES.has(it.rule));
  } catch (e) { issues = []; } // 引擎已有逐规则兜底，此处再兜底：实时检查永不阻断编辑
  state.liveIssues = issues;
  updateBadge(issues.length);
  // 增量提示：新增 → 计数提示；从有到无 → 解决提示；其余（数量增减但无新增）静默
  const keys = new Set(issues.map(keyOf));
  if (prevKeys !== null) {
    const added = [...keys].filter(k => !prevKeys.has(k)).length;
    if (added > 0) ui.hint(t('live.newIssues', { n: added }));
    else if (prevKeys.size > 0 && keys.size === 0) ui.hint(t('live.cleared'));
  }
  prevKeys = keys;
  ui.render(); // 红框随最新结果刷新（render 不触发 markDirty，无循环）
}

function updateBadge(n) {
  if (!badge) return;
  badge.hidden = n <= 0;
  badge.textContent = n > 99 ? '99+' : String(n);
  const btn = document.getElementById('btn-check');
  if (btn) btn.title = n > 0 ? t('live.badgeTip', { n }) : t('btn.check');
}

/** 启动：注入徽章 + 挂编辑钩子 + 首轮检查（草稿恢复/新项目经由 markDirty 也会触发，防抖去重） */
export function initLivecheck() {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('btn-check');
  if (btn) {
    badge = document.createElement('b');
    badge.className = 'live-badge';
    badge.hidden = true;
    btn.appendChild(badge);
  }
  onDirty(schedule); // 所有编辑（含撤销/重做/打开项目/AI 批量建模）经 markDirty 单点汇入
  schedule();
}

/** 语言切换后刷新徽章 tooltip（main.js onLocaleChange 调用；徽章数字本身无文案） */
export function refreshLivecheck() {
  if (!badge) return;
  const n = state.liveIssues ? state.liveIssues.length : 0;
  const btn = document.getElementById('btn-check');
  if (btn) btn.title = n > 0 ? t('live.badgeTip', { n }) : t('btn.check');
}
