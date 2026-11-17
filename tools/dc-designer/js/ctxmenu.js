/** 快速操作菜单（右键）+ 非模态提示条（替换/重排/空位补插的确认闭环）
 * 菜单与提示条共用同一套动作函数；提示条弹出期间画布平移/缩放/Ctrl+Z 照常可用，
 * 按 Esc 或点击画布自动收起（收起 = 保持原编号，之后随时可重排）。 */
import { state, runtime, ui, getObj, deleteObjects, TYPE_NAMES } from './state.js';
import { icon } from './icons.js';
import * as rowops from './rowops.js';
import { alignSelection, alignableObjects, ALIGN_MODES } from './align.js';
import { parseTemplate, lettersSeq } from './naming.js';
import { t } from './i18n.js';

let menuEl = null, barEl = null;
let docBound = false;

/* ---------- 基础：元素与全局关闭 ---------- */

function bindDoc() {
  if (docBound) return;
  docBound = true;
  // 捕获阶段：点到菜单/提示条以外的地方 → 全部收起
  document.addEventListener('pointerdown', e => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
    if (barEl && !barEl.contains(e.target) && e.target.id === 'cv') dismissAll();
  }, true);
  window.addEventListener('resize', dismissAll);
}

function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }

/** 收起菜单与提示条，清除画布上的重排/空位预览（= 保持原编号） */
export function dismissAll() {
  closeMenu();
  if (barEl) { barEl.remove(); barEl = null; }
  if (runtime.rowPreview || runtime.gapPreview) {
    runtime.rowPreview = null; runtime.gapPreview = null;
    ui.render();
  }
}

/* ---------- 动作（菜单与属性面板共用） ---------- */

/** 替换为 ▸ 柱子/列间空调/列头柜：原位同槽转换，随后弹提示条询问是否重排受影响排序号 */
export function doReplace(ids, kind) {
  dismissAll();
  const r = rowops.replaceCabinets(ids, kind);
  if (!r) { ui.hint(t('hint.noCab')); return; }
  const kindName = rowops.REPLACE_KIND_NAMES[kind] || kind;
  const plans = r.affected.map(row => rowops.renumberPlan(row)).filter(p => p && !p.customOnly);
  if (!offerRenumber(t('hint.replaced', { n: r.count, kind: kindName }), plans, r.affected)) {
    ui.hint(t('hint.replacedUndo', { n: r.count, kind: kindName }));
  }
}

/** 替换为机柜：列间空调/列头柜原位同槽转换回机柜，随后弹提示条询问是否重排受影响排序号。
 * 新机柜自动名（机柜-N）不参与排模板投票（避免与排编号平票时误选为排模板），但作为排成员
 * 按位置一并重排（foldExcluded）——点「重排」即顺势把新机柜编入连续序号，其余自定义名仍跳过。 */
export function doRevertToCabinet(ids) {
  dismissAll();
  const r = rowops.revertToCabinets(ids);
  if (!r) { ui.hint(t('hint.noRevertible')); return; }
  const title = t('hint.reverted', { n: r.count });
  const excl = r.added.map(o => o.id);
  const plans = r.affected.map(row => rowops.renumberPlan(row, { voteExclude: excl, foldExcluded: true }))
    .filter(p => p && !p.customOnly);
  if (!offerRenumber(title, plans, r.affected, { voteExclude: excl, foldExcluded: true })) {
    ui.hint(t('hint.revertedUndo', { n: r.count }));
  }
}

/** 重排本排序号（整排，选中子集也按整排处理） */
export function doRenumber(ids) {
  dismissAll();
  const rows = rowops.rowsOfSelection(ids);
  if (!rows.length) {
    ui.hint(t('hint.noRowRecognized'));
    return;
  }
  const plans = rows.map(r => rowops.renumberPlan(r)).filter(p => p && !p.customOnly);
  // 主动重排：always 弹条（编号已连续也可进入改模板）；仅当整排均为自定义名时才落兜底提示
  if (!offerRenumber(plans.length > 1 ? t('hint.renumberTpls', { n: plans.length }) : t('hint.renumberRow'), plans, rows, { always: true })) {
    ui.hint(t('hint.rowAllCustom'));
  }
}

/** 检测空位补插：按剩余机柜几何间距外推缺失槽位，虚线框预览后一键补插 */
export function doGapDetect(ids) {
  dismissAll();
  const rows = rowops.rowsOfSelection(ids);
  if (!rows.length) { ui.hint(t('hint.noRowGap')); return; }
  const allSlots = rows.flatMap(row => rowops.findGaps(row));
  if (!allSlots.length) { ui.hint(t('hint.noGap')); return; }
  const tpl = rowops.renumberPlan(rows[0]).tpl || '';
  runtime.gapPreview = { slots: allSlots };
  ui.render();
  showBar((tpl ? t('hint.gapTpl', { tpl }) : '') + t('hint.gapDetected', { n: allSlots.length }), [
    { label: t('act.fillColumn'), primary: true, fn: () => fillGaps(allSlots, 'column', rows) },
    { label: t('act.fillAcrow'), fn: () => fillGaps(allSlots, 'acrow', rows) },
    { label: t('act.cancel'), fn: dismissAll },
  ]);
}

function fillGaps(slots, kind, rows) {
  const n = rowops.insertGapFillers(slots, kind);
  runtime.gapPreview = null;
  const kindName = rowops.REPLACE_KIND_NAMES[kind] || kind;
  // 补插后同样弹重排提示（编号若有空洞可顺势连续化）
  const plans = rows.map(r => rowops.renumberPlan(r)).filter(p => p && !p.customOnly);
  if (!offerRenumber(t('hint.replaced', { n, kind: kindName }), plans, rows)) {
    ui.hint(t('hint.filled', { n, kind: kindName }));
  }
}

/** 属性 / 改名：选中对象并聚焦属性面板的名称输入框 */
export function doEditProps(id) {
  dismissAll();
  state.selectedId = id;
  ui.props(); ui.render();
  const inp = document.querySelector('#props input[data-path="props.name"]');
  if (inp) { inp.focus(); inp.select(); }
  // 属性面板若被收起则展开
  const main = document.querySelector('main');
  if (main && main.classList.contains('phide')) document.getElementById('props-close').click();
}

/* ---------- 提示条（画布顶部居中，非模态） ---------- */

/**
 * 重排确认提示条：弹出时画布原位显示灰色虚线框+灰字新编号预览（所见即所得），
 * [重排] 应用后转实色；[保持原编号] 或 Esc/点画布收起 = 不动编号。
 * 提示条内置「编号模板」输入框（与工勘向导第二步同一语法，默认填排内推断模板）：
 * 不改动=现状（各排保留推断模板，仅连续化序号）；编辑后实时重算计划与预览——
 * 单排：模板整体生效（可改排号/前缀/后缀/位数，如 A##→C##、101-A###-主）；
 * 多排：全部重置——输入排号=首排排号，各排按几何顺序（先 X 向排南→北，再 Y 向排西→东）
 * 逐排递增（如 C## + 3 排 → C、D、E 排），多排模板缺排号字母判非法（各排会重号）；
 * 排号与受影响排之外的机柜撞名时轻量警示（不阻止）。Enter=重排，Esc=收起。
 * rows 提供且存在跳过的其他格式编号时显示「整排按位置重排」：把其他格式编号/自定义名
 * 也按位置统一编入（includeCustom，供 A01 与 B01 同排等场景强制合并）。
 * opts.voteExclude / opts.foldExcluded 透传 renumberPlan（重算计划时保持同一投票口径）。
 * opts.always=true 时编号已连续也弹条（菜单/面板主动重排：提示条自带模板输入框，
 * 已连续正是改排号/编号方式的入口）；替换/补插后的被动询问不传，避免无变化时打扰。
 * 返回 true=提示条已弹出；false=无可识别排模板，或未变化且非主动重排（调用方兜底提示）。
 */
export function offerRenumber(title, plans, rows, opts = {}) {
  runtime.gapPreview = null;
  const recognized = (plans || []).filter(p => p && !p.customOnly);
  const live0 = recognized.filter(p => p.changes && p.changes.length);
  if (!recognized.length || (!live0.length && !opts.always)) { ui.render(); return false; }
  const src = rowops.sortRowsGeo(rows || []); // 多排模板重置按几何序分配排号
  const multi = src.length > 1;
  const baseOpts = { voteExclude: opts.voteExclude, foldExcluded: opts.foldExcluded };
  const rowIds = new Set(src.flatMap(r => r.map(o => o.id)));
  let dirty = false; // 用户编辑过模板输入框才启用显式模板（默认值=各排推断模板，行为同现状）

  const tplVal = () => (dirty && bar.input ? bar.input.value.trim().toUpperCase() : '');
  /** 重算计划：无输入=各排保留推断模板；有输入=显式模板（单排整体生效，多排逐排重置） */
  const buildPlans = includeCustom => {
    const tpl = tplVal();
    if (!tpl) return src.map(r => rowops.renumberPlan(r, { ...baseOpts, includeCustom }));
    const tpls = rowops.tplsForRows(src, tpl);
    if (!tpls) return null;
    return src.map((r, i) => rowops.renumberPlan(r, { ...baseOpts, includeCustom, tpl: tpls[i] }));
  };
  const liveOf = ps => (ps || []).filter(p => p && !p.customOnly && p.changes && p.changes.length);
  const partsOf = ps => ps.map(p => {
    const first = p.head + String(1).padStart(p.width, '0') + p.tail;
    const last = p.head + String(p.count).padStart(p.width, '0') + p.tail;
    return t('planTpl', { tpl: p.tpl || first, c: p.count, f: first, l: last });
  }).join('；');

  const onPrimary = () => {
    if (cur.err) return;
    if (!cur.primary.length) { // 编号已连续：点击 = 收起提示条（不产生空撤销步）
      dismissAll();
      ui.hint(t('hint.alreadySeq'));
      return;
    }
    const n = rowops.applyRenumber(cur.primary);
    dismissAll();
    ui.hint(t('hint.renumbered', { n }));
  };
  const onForce = () => {
    if (!cur.forced.length) { dismissAll(); ui.hint(t('hint.noNeedForce')); return; }
    const n = rowops.applyRenumber(cur.forced);
    dismissAll();
    ui.hint(t('hint.renumberedForce', { n }));
  };

  const cur = { primary: live0, forced: [], skipped: 0, err: '' };
  const bar = showBar('', [
    { label: t('act.renumber'), primary: true, fn: onPrimary },
    { label: t('act.renumberForce'), fn: onForce },
    { label: t('act.keep'), fn: dismissAll },
  ], {
    label: t('wz.tpl'), value: (live0[0] || recognized[0]).tpl || '', placeholder: t('wz.tplPh'),
    helpHtml: t('hint.renumberTplNote'),
    onInput: () => { dirty = true; refresh(); },
  });
  bar.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !bar.btns[0].disabled) { e.preventDefault(); onPrimary(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismissAll(); }
  });

  function refresh() {
    const tpl = tplVal();
    cur.err = '';
    if (tpl) {
      const pt = parseTemplate(tpl);
      if (!pt.ok) cur.err = t(pt.err) + t('hint.tplExample');
      else if (multi && !pt.slot) cur.err = t('hint.rowTplNeedLetter');
    }
    if (cur.err) {
      cur.primary = []; cur.forced = []; cur.skipped = 0;
      bar.msg.textContent = title + '：' + cur.err;
    } else {
      cur.primary = liveOf(buildPlans(false));
      cur.forced = liveOf(buildPlans(true));
      cur.skipped = cur.primary.reduce((s, p) => s + (p.skipped || 0), 0);
      let text = cur.primary.length
        ? t('hint.renumberAsk', { title, parts: partsOf(cur.primary) }) +
          (cur.skipped ? t('hint.skipOthers', { n: cur.skipped }) : '')
        : title + '：' + t(tpl ? 'hint.alreadySeq' : 'hint.seqOkCanTpl');
      if (tpl) { // 排号撞名轻量警示（不阻止，与逐台改名策略一致）
        const pt = parseTemplate(tpl);
        const letters = multi ? lettersSeq(pt.slot, src.length) : (pt.slot ? [pt.slot] : []);
        const hit = rowops.slotConflicts(tpl, letters, rowIds);
        if (hit.length) text += t('hint.tplSlotUsed', { letters: hit.join('、') });
      }
      bar.msg.textContent = text;
    }
    bar.input.classList.toggle('err', !!cur.err);
    bar.btns[0].disabled = !!cur.err; // 仅模板非法才置灰；无变化时可点击（=收起，见 onPrimary）
    bar.btns[1].style.display = cur.skipped ? '' : 'none';
    bar.btns[1].disabled = !!cur.err;
    runtime.rowPreview = cur.primary.length ? { items: cur.primary.flatMap(p => p.changes) } : null;
    ui.render();
  }
  refresh();
  return true;
}

/** 非模态提示条：文本 + 可选输入框（inputCfg: {label,value,placeholder,helpHtml,onInput}）+ 按钮。
 * helpHtml 提供时输入框旁追加「?」图标，点击切换语法说明气泡（不挂输入框悬停 title，
 * 避免鼠标移入输入即被长提示打扰）。
 * 返回 { msg, input, btns } 供调用方动态更新文案/按钮态（doGapDetect 不传 inputCfg，行为不变） */
function showBar(text, buttons, inputCfg) {
  if (barEl) barEl.remove();
  bindDoc();
  barEl = document.createElement('div');
  barEl.className = 'act-bar';
  const span = document.createElement('span');
  span.className = 'act-msg';
  span.textContent = text;
  barEl.appendChild(span);
  let input = null;
  if (inputCfg) {
    const lab = document.createElement('label');
    lab.className = 'act-tpl';
    const labTxt = document.createElement('span');
    labTxt.textContent = inputCfg.label;
    input = document.createElement('input');
    input.type = 'text';
    input.dir = 'ltr'; // 编号模板为拉丁技术串：RTL 下强制 LTR（同向导 AR-01）
    input.spellcheck = false;
    input.value = inputCfg.value || '';
    input.placeholder = inputCfg.placeholder || '';
    input.addEventListener('input', () => inputCfg.onInput(input.value));
    lab.appendChild(labTxt);
    lab.appendChild(input);
    if (inputCfg.helpHtml) { // 「?」语法帮助：点击切换气泡，随提示条一并收起
      const q = document.createElement('span');
      q.className = 'act-tpl-q';
      q.textContent = '?';
      const help = document.createElement('div');
      help.className = 'act-tpl-help';
      help.innerHTML = inputCfg.helpHtml;
      help.style.display = 'none';
      q.addEventListener('click', e => {
        e.stopPropagation();
        help.style.display = help.style.display === 'none' ? '' : 'none';
      });
      lab.appendChild(q);
      lab.appendChild(help);
    }
    barEl.appendChild(lab);
  }
  const btns = [];
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (b.primary) btn.className = 'act-primary';
    btn.addEventListener('click', b.fn);
    barEl.appendChild(btn);
    btns.push(btn);
  }
  document.getElementById('view-wrap').appendChild(barEl);
  return { msg: span, input, btns };
}

/* ---------- 右键快速操作菜单 ---------- */

/**
 * 在 (sx,sy)（画布内像素坐标）弹出快速操作菜单。
 * hit 为 tools.hitTest 结果；命中机柜给完整替换/重排/空位菜单，
 * 选中含列间空调/列头柜时追加「替换为机柜」，其他对象给通用菜单。
 */
export function openMenu(sx, sy, hit) {
  dismissAll();
  bindDoc();
  let target = hit && hit.type === 'obj' ? hit.obj : null;
  if (target && !state.selectedIds.includes(target.id)) {
    // 右键未选中的对象 → 先把它单选（与主流 CAD/绘图软件一致）
    state.selectedIds = [target.id];
    ui.props(); ui.render();
  }
  const cabs = state.selectedIds.map(getObj).filter(o => o && o.type === 'cabinet');
  const isCab = target && target.type === 'cabinet';
  const revs = state.selectedIds.map(getObj).filter(o => rowops.isRevertible(o)); // 列间空调/列头柜（可替换回机柜）

  menuEl = document.createElement('div');
  menuEl.className = 'ctx-menu';

  // 头部：对象名 + 多选数量
  const head = document.createElement('div');
  head.className = 'ctx-head';
  head.textContent = target
    ? `${TYPE_NAMES[target.type] || target.type} ${target.props.name || ''}` +
      (state.selectedIds.length > 1 ? t('ctx.selOf', { n: state.selectedIds.length }) : '')
    : t('ctx.selN', { n: state.selectedIds.length });
  menuEl.appendChild(head);

  const addItem = (ic, label, fn, sub) => {
    const it = document.createElement('div');
    it.className = 'ctx-item' + (sub ? ' ctx-hassub' : '');
    it.innerHTML = `${icon(ic)}<span>${label}</span>${sub ? '<b>▸</b>' : ''}`;
    if (fn) it.addEventListener('click', fn);
    if (sub) it.appendChild(sub);
    menuEl.appendChild(it);
    return it;
  };

  if (target) addItem('pencil', t('ctx.propRename'), () => doEditProps(target.id));

  if (isCab || cabs.length) {
    // 替换为 ▸（子菜单：柱子 / 列间空调 / 列头柜）
    const sub = document.createElement('div');
    sub.className = 'ctx-sub';
    for (const [kind, label, ic] of [['column', t('type.column'), 'column'], ['acrow', t('rep.acrow'), 'ac'], ['pdu', t('type.pdu'), 'pdu']]) {
      const si = document.createElement('div');
      si.className = 'ctx-item';
      si.innerHTML = `${icon(ic)}<span>${label}</span>`;
      si.addEventListener('click', () => doReplace(cabs.map(o => o.id), kind));
      sub.appendChild(si);
    }
    addItem('swap', cabs.length > 1 ? t('ctx.replaceN', { n: cabs.length }) : t('ctx.replace'), null, sub);
    addItem('sortnum', cabs.length > 1 ? t('ctx.rerowSel') : t('ctx.rerow'),
      () => doRenumber(cabs.map(o => o.id)));
    addItem('gap', t('ctx.gapDetect'), () => doGapDetect(cabs.map(o => o.id)));
  }

  if (revs.length) {
    // 替换为机柜（列间空调/列头柜原位转回机柜；与机柜替换项可同时出现，各作用于自己的子集）
    addItem('swap', revs.length > 1 ? t('ctx.revertN', { n: revs.length }) : t('ctx.revert'),
      () => doRevertToCabinet(revs.map(o => o.id)));
  }

  // 对齐 ▸（≥2 个可参与对象时提供；挂墙门窗不参与，子菜单 6 向）
  if (alignableObjects(state.selectedIds.map(getObj)).length >= 2) {
    const asub = document.createElement('div');
    asub.className = 'ctx-sub';
    for (const m of ALIGN_MODES) {
      const si = document.createElement('div');
      si.className = 'ctx-item';
      si.innerHTML = `${icon('al-' + m)}<span>${t('align.' + m)}</span>`;
      si.addEventListener('click', () => { dismissAll(); alignSelection(m); });
      asub.appendChild(si);
    }
    addItem('align', t('ctx.align'), null, asub);
  }

  if (state.selectedIds.length) {
    addItem('trash', state.selectedIds.length > 1 ? t('ctx.delN', { n: state.selectedIds.length }) : t('ctx.del'), () => {
      const n = state.selectedIds.length;
      dismissAll();
      deleteObjects(state.selectedIds);
      ui.hint(n > 1 ? t('hint.deletedN', { n }) : t('hint.deleted'));
    });
  }

  if (!menuEl.querySelector('.ctx-item')) { closeMenu(); return; }
  document.body.appendChild(menuEl);

  // 定位：fixed，相对视口；保持完整可见
  const r = document.getElementById('cv').getBoundingClientRect();
  let x = r.left + sx + 2, y = r.top + sy + 2;
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  x = Math.max(4, Math.min(x, window.innerWidth - mw - 4));
  y = Math.max(4, Math.min(y, window.innerHeight - mh - 4));
  menuEl.style.left = x + 'px';
  menuEl.style.top = y + 'px';
}
