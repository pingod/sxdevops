/** 右侧属性面板：单选时显示可编辑属性表单，多选时显示组合统计与批量操作，未选中时显示项目统计与帮助 */
import { state, ui, pushUndo, markDirty, saveDraft, getObj, deleteObjects, TYPE_NAMES, notePropEdit } from './state.js';
import { wallLen, beamEnds, clamp, isSolid, pairClearance } from './geo.js';
import { rotateSelected, setTool } from './tools.js';
import { alignSelection, alignableObjects, ALIGN_MODES } from './align.js';
import { resolveOverlaps } from './collision.js';
import { syncAisleWidth, aisleLinkEnabled, setAisleLinkEnabled, aisleLinkHint } from './aislelink.js';
import { icon } from './icons.js';
import * as ctxmenu from './ctxmenu.js';
import { isRevertible } from './rowops.js';
import { toggleChecks } from './checks-panel.js';
import { normalizeCabColor, CABINET_PRESETS } from './cabinetcolor.js';
import { isDevice, deviceZ } from './device.js';
import { t } from './i18n.js';
import { pipePanelHtml, bindPipePanel } from './pipe-props.js';
import { distributionBoxFields } from './distribution-box.js';
import { pipeGeometry } from './pipe-geometry.js';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const CABINET_SPECS = ['600x1200x2000', '800x1200x2000'];
const SOCKET_TYPES = ['IEC C13', 'IEC C19', '国标10A', '国标16A', '工业连接器16A', '工业连接器32A'];
const SOCKET_LABEL_KEYS = { '国标10A': 'sock.gb10', '国标16A': 'sock.gb16', '工业连接器16A': 'sock.industrial16', '工业连接器32A': 'sock.industrial32' };
/** 接口类型显示名（已知类型翻译，自定义类型原样显示） */
const sockLabel = v => t(SOCKET_LABEL_KEYS[v] || v);

/** 机柜接口配置规范化：新格式 sockets=[{type,count}…]（类型×数量，可多类型并存）；
 * 旧格式 socket+sockets（单类型单数量）迁移为单条列表 */
function sockList(p) {
  if (Array.isArray(p.sockets)) return p.sockets;
  if (typeof p.sockets === 'number') return [{ type: p.socket || 'IEC C13', count: p.sockets }];
  return [{ type: 'IEC C13', count: 16 }, { type: 'IEC C19', count: 6 }];
}

/** 机柜接口配置编辑器：每行 类型下拉 × 数量 × 删除，底部可添加（接口数量与类型一一对应） */
function sockEditorHtml(p) {
  const items = sockList(p).map((s, i) => {
    const types = SOCKET_TYPES.includes(s.type) ? SOCKET_TYPES : [s.type || 'IEC C13', ...SOCKET_TYPES];
    return `<div class="sock-item">
      <select data-sock="${i}" data-k="type">${types.map(t2 =>
        `<option value="${esc(t2)}" ${t2 === s.type ? 'selected' : ''}>${esc(sockLabel(t2))}</option>`).join('')}</select>
      <input type="number" data-sock="${i}" data-k="count" value="${+s.count || 0}" min="0" step="1" title="${t('f.sockCount')}">
      <button data-sock-del="${i}" title="${t('f.sockDel')}">${icon('x')}</button>
    </div>`;
  }).join('');
  return `<div class="sock-box">
    <div class="sock-head">${t('f.sockHead')}<span>${t('f.sockTypeCount')}</span></div>
    ${items}
    <button class="sock-add" data-sock-add title="${t('f.sockAdd')}">${t('f.sockAdd')}</button>
  </div>`;
}

export function refreshProps() {
  const panel = document.getElementById('props');
  panel.classList.remove('pipe-panel');
  const sel = state.selectedIds.map(getObj).filter(Boolean);
  if(state.tool==='pipe'&&sel.length>1){panel.innerHTML=pipePanelHtml(null);bindPipePanel(panel,null,setTool);return;}
  if (sel.length > 1) { // 多选：组合统计 + 批量操作
    panel.innerHTML = multiHtml(sel);
    panel.querySelector('[data-mrot]').addEventListener('click', rotateSelected);
    panel.querySelector('[data-mdel]').addEventListener('click', () => {
      const n = state.selectedIds.length;
      deleteObjects(state.selectedIds);
      ui.hint(t('hint.deletedN', { n }));
    });
    // 机柜批量：替换为柱子/列间空调/列头柜、重排选中排、空位补插（与右键菜单同一套动作）
    const cabIds = sel.filter(o => o.type === 'cabinet').map(o => o.id);
    panel.querySelectorAll('[data-rep]').forEach(el =>
      el.addEventListener('click', () => ctxmenu.doReplace(cabIds, el.dataset.rep)));
    const rerow = panel.querySelector('[data-rerow]');
    if (rerow) rerow.addEventListener('click', () => ctxmenu.doRenumber(cabIds));
    const gapBtn = panel.querySelector('[data-gap]');
    if (gapBtn) gapBtn.addEventListener('click', () => ctxmenu.doGapDetect(cabIds));
    // 列间空调/列头柜批量：替换回机柜（与右键菜单同一动作）
    const revIds = sel.filter(isRevertible).map(o => o.id);
    panel.querySelectorAll('[data-rev]').forEach(el =>
      el.addEventListener('click', () => ctxmenu.doRevertToCabinet(revIds)));
    // 多选对齐：以选区整体外沿为基准的 6 向对齐（挂墙门窗不参与）
    panel.querySelectorAll('[data-align]').forEach(el =>
      el.addEventListener('click', () => alignSelection(el.dataset.align)));
    return;
  }
  const o = sel[0] || null;
  if (o?.type === 'pipe' || (!o && state.tool === 'pipe')) {
    panel.innerHTML = pipePanelHtml(o);
    bindPipePanel(panel, o, setTool); return;
  }
  panel.innerHTML = o ? objForm(o) : summaryHtml();
  if (!o) { // 未选中：机房整体信息字段（写入 project.name / project.meta，随项目保存）
    panel.querySelectorAll('[data-meta]').forEach(el =>
      el.addEventListener('input', () => {
        const k = el.dataset.meta;
        const v = el.dataset.num !== undefined ? (parseFloat(el.value) || 0) : el.value;
        if (k === 'name') state.project.name = v;
        else { state.project.meta = state.project.meta || {}; state.project.meta[k] = v; }
        state.dirty = true;
        saveDraft(); // 缓存草稿；不重建面板以免打断输入
      }));
    const ckBtn = panel.querySelector('[data-check]'); // 合规自检：展开左侧自检面板并运行
    if (ckBtn) ckBtn.addEventListener('click', () => toggleChecks(true));
    return;
  }
  // 普通属性字段
  panel.querySelectorAll('[data-path]').forEach(el =>
    el.addEventListener('change', () => onChange(o, el)));
  // 通道：宽联动机柜全局开关（开启时改“通道宽”自动移动远侧整排）
  const linkEl = panel.querySelector('[data-aislelink]');
  if (linkEl) linkEl.addEventListener('change', () => {
    setAisleLinkEnabled(linkEl.checked);
    ui.hint(linkEl.checked ? t('hint.aisleLinkOn') : t('hint.aisleLinkOff'));
  });
  // 格式刷：以当前对象为源，刷到其他同类型对象
  const brushBtn = panel.querySelector('[data-brush]');
  if (brushBtn) brushBtn.addEventListener('click', () => setTool('brush'));
  // 机柜：替换为柱子/列间空调/列头柜、重排本排、检测空位补插（与右键菜单同一套动作）
  panel.querySelectorAll('[data-rep]').forEach(el =>
    el.addEventListener('click', () => ctxmenu.doReplace([o.id], el.dataset.rep)));
  const rerow = panel.querySelector('[data-rerow]');
  if (rerow) rerow.addEventListener('click', () => ctxmenu.doRenumber([o.id]));
  const gapBtn = panel.querySelector('[data-gap]');
  if (gapBtn) gapBtn.addEventListener('click', () => ctxmenu.doGapDetect([o.id]));
  // 列间空调/列头柜：替换回机柜（与右键菜单同一动作）
  panel.querySelectorAll('[data-rev]').forEach(el =>
    el.addEventListener('click', () => ctxmenu.doRevertToCabinet([o.id])));
  // 门窗定位：距墙起点实测距离（mm）
  const distEl = panel.querySelector('[data-dist]');
  if (distEl) distEl.addEventListener('change', () => {
    const w = getObj(o.wallId);
    if (!w) return;
    const L = wallLen(w);
    if (L < 1) return;
    pushUndo();
    const d = parseFloat(distEl.value) || 0;
    o.t = clamp(d / L, (o.props.width || 900) / 2 / L, 1 - (o.props.width || 900) / 2 / L);
    markDirty();
  });
  // 机柜规格快捷选择
  const spec = panel.querySelector('[data-spec]');
  if (spec) spec.addEventListener('change', () => {
    const [w, d, h] = spec.value.split('x').map(Number);
    if (!w) return;
    pushUndo();
    o.props.w = w; o.props.d = d; o.props.h = h;
    notePropEdit('cabinet', 'w', w); // 规格整体跟随为后续默认（w 联动 cabWidth 兼容底值）
    notePropEdit('cabinet', 'd', d);
    notePropEdit('cabinet', 'h', h);
    resolveOverlaps([o]); // 尺寸变大压到邻居时推开（互斥）
    markDirty();
  });
  // 设备颜色（取色器 / 快捷色板 / 还原默认）：
  // 取色器拖动时 input 连续触发——只记第一步撤销、只重绘 2D（props:false 不重建面板，否则取色器被打断）；
  // 松手（change）再整体刷新（markDirty 会调用 ui.render3d，下次进 3D 即按新颜色重建场景）。
  const colEl = panel.querySelector('[data-cabcolor]');
  if (colEl) {
    const hexEl = panel.querySelector('[data-cabcolor-hex]');
    const clrEl = panel.querySelector('[data-cabcolor-clear]');
    let open = false; // 本次取色会话是否已记撤销（按下→松手 = 一步撤销）
    const paint = (v, commit) => {
      if (!open && v === (o.props.color || '')) return; // 颜色未变（重复点同一色块 / 取色后按取消）：不记撤销、不重绘
      if (!open) { pushUndo(); open = true; }
      o.props.color = v;
      if (hexEl) { hexEl.textContent = v || t('f.colorAuto'); hexEl.classList.toggle('auto', !v); }
      if (clrEl) clrEl.disabled = !v;
      notePropEdit(o.type, 'color', v); // 各设备类型分别记忆颜色，Z 作为位置不跟随
      if (commit) { open = false; markDirty(); } else markDirty({ props: false });
    };
    colEl.addEventListener('input', () => paint(normalizeCabColor(colEl.value), false));
    colEl.addEventListener('change', () => paint(normalizeCabColor(colEl.value), true));
    panel.querySelectorAll('[data-cabcolor-set]').forEach(el =>
      el.addEventListener('click', () => {
        colEl.value = el.dataset.cabcolorSet;
        paint(el.dataset.cabcolorSet, true);
      }));
    if (clrEl) clrEl.addEventListener('click', () => {
      colEl.value = CABINET_PRESETS[3]; // 取色器无空值：回到起点色（云白），实际颜色由「默认」表达
      paint('', true);
    });
  }
  // 机柜接口配置（类型×数量列表；旧格式 socket+sockets 在首次编辑时自动迁移为数组）
  const normSocks = () => {
    if (!Array.isArray(o.props.sockets)) {
      o.props.sockets = sockList(o.props).map(s => ({ ...s }));
      delete o.props.socket;
    }
    return o.props.sockets;
  };
  panel.querySelectorAll('[data-sock]').forEach(el =>
    el.addEventListener('change', () => {
      pushUndo();
      const it = normSocks()[+el.dataset.sock];
      if (!it) return;
      it[el.dataset.k] = el.dataset.k === 'count' ? Math.max(0, parseInt(el.value, 10) || 0) : el.value;
      notePropEdit('cabinet', 'sockets', o.props.sockets); // 接口配置跟随上一次设置
      markDirty();
    }));
  panel.querySelectorAll('[data-sock-del]').forEach(el =>
    el.addEventListener('click', () => {
      pushUndo();
      normSocks().splice(+el.dataset.sockDel, 1);
      notePropEdit('cabinet', 'sockets', o.props.sockets);
      markDirty();
    }));
  const addSock = panel.querySelector('[data-sock-add]');
  if (addSock) addSock.addEventListener('click', () => {
    pushUndo();
    normSocks().push({ type: 'IEC C19', count: 4 });
    notePropEdit('cabinet', 'sockets', o.props.sockets);
    markDirty();
  });
}

function onChange(o, el) {
  pushUndo();
  const path = el.dataset.path.split('.');
  let v = el.type === 'checkbox' ? el.checked
    : el.dataset.num !== undefined ? (parseFloat(el.value) || 0) : el.value;
  // 下限约束（负功率/负尺寸等）：HTML min 不拦截手动输入，change 时强制夹紧并回写、给出警告
  if (el.dataset.num !== undefined && el.min !== '' && v < +el.min) {
    v = +el.min;
    el.value = el.min;
    ui.hint(t('hint.numClamped', { min: el.min }));
  }
  const oldAisleD = o.type === 'aisle' && el.dataset.path === 'props.d' ? (o.props.d || 0) : 0; // 联动依据：改前通道宽
  let tgt = o; // 变量名避开 i18n.t：本函数上方夹紧分支要调用 t() 翻译，原名会 TDZ 报错中断整个 onChange
  for (let i = 0; i < path.length - 1; i++) tgt = tgt[path[i]];
  tgt[path[path.length - 1]] = v;
  if (o.type === 'beam' && path.length === 1) { // 手改梁端点坐标：脱离该端柱附着（否则随柱回弹）
    if (path[0] === 'x1' || path[0] === 'y1') o.col1 = null;
    if (path[0] === 'x2' || path[0] === 'y2') o.col2 = null;
  }
  if (path.length === 2 && path[0] === 'props') notePropEdit(o.type, path[1], v); // 默认值跟随上一次设置（夹紧后的合法值）
  // 门窗/格栅位置约束在墙体内
  if ((o.type === 'door' || o.type === 'window' || o.type === 'grille')) {
    const w = getObj(o.wallId);
    if (w) {
      const L = wallLen(w);
      if (L > 0) o.t = clamp(o.t, (o.props.width || 900) / 2 / L, 1 - (o.props.width || 900) / 2 / L);
    }
  }
  if (isSolid(o) && ['x', 'y', 'props.w', 'props.d', 'rotation'].includes(el.dataset.path)) resolveOverlaps([o]); // 只在平面几何变化时推挤，修改 Z 不移动其他设备
  if (o.type === 'aisle' && el.dataset.path === 'props.d') { // 通道宽联动：西/南侧排锚定，远侧整排平移
    if (o.props.d < 100) { o.props.d = 100; el.value = 100; } // 防止零/负宽度导致几何退化
    const r = syncAisleWidth(o, oldAisleD);
    if (r) ui.hint(aisleLinkHint(r));
  }
  markDirty();
}

/* ---------- 表单构造 ---------- */
const row = (label, inner) => `<label class="pr"><span>${label}</span>${inner}</label>`;
const num = (path, val, step = 100, min, title) => // min：非负物理量（尺寸/功率/制冷量等）传 0，坐标/旋转/温度等可负字段不传
  `<input type="number" data-path="${path}" data-num step="${step}"${min !== undefined ? ` min="${min}"` : ''}${title ? ` title="${esc(title)}"` : ''} value="${esc(val)}">`; // esc：sanitize 之外的兜底，值原样拼属性必须转义
const text = (path, val) => `<input type="text" data-path="${path}" value="${esc(val)}">`;
const sel = (path, val, opts, isNum, title) =>
  `<select data-path="${path}"${isNum ? ' data-num' : ''}${title ? ` title="${esc(title)}"` : ''}>${opts.map(([v, l]) =>
    `<option value="${v}" ${(isNum ? +v === +val : v === val) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
const readonly = val => `<input value="${esc(val)}" readonly>`;

/** 设备共用颜色编辑器（整行）：取色器 + 色值 + 快捷色板 + 「还原默认」图标按钮。
 *  用 div 而非 row() 的 <label>：<label> 会把内部按钮的点击转发给取色器，
 *  点快捷色块/还原也会弹出系统取色器；且 <label> 内不允许块级内容。
 *  未设色时取色器停在内置起点色，实际状态由色值（“默认色”）与按钮禁用态表达。
 *  还原按钮只放图标（↺）：四语言下“默认 / Default / Predeterminado / افتراضي”宽度差异大，
 *  带文字会把窄面板（280px）的这行挤爆；文案走 title/aria-label 即时提示。 */
function cabColorField(val) {
  const hex = normalizeCabColor(val);
  const cur = hex || CABINET_PRESETS[3];
  const sw = CABINET_PRESETS.map(c =>
    `<button type="button" data-cabcolor-set="${c}" title="${c}" style="background:${c}"></button>`).join('');
  return `<div class="pr"><span>${t('f.color')}</span><div class="color-box">
    <div class="color-row">
      <input type="color" data-cabcolor value="${cur}" title="${esc(t('f.colorT'))}">
      <code data-cabcolor-hex class="${hex ? '' : 'auto'}">${hex || esc(t('f.colorAuto'))}</code>
      <button type="button" data-cabcolor-clear${hex ? '' : ' disabled'} title="${esc(t('f.colorResetT'))}" aria-label="${esc(t('f.colorReset'))}">${icon('rotate')}</button>
    </div>
    <div class="color-presets">${sw}</div>
  </div></div>`;
}

function objForm(o) {
  const p = o.props;
  let body = '';
  if (o.type === 'wall') {
    const L = wallLen(o);
    body =
      row(t('f.name'), text('props.name', p.name)) +
      row(t('f.thickness'), num('props.thickness', p.thickness, 10, 0)) +
      row(t('f.height'), num('props.height', p.height, 100, 0)) +
      row(t('f.material'), sel('props.material', p.material,
        [['砖墙', t('mat.brick')], ['混凝土', t('mat.concrete')], ['轻钢龙骨', t('mat.stud')], ['玻璃隔断', t('mat.glass')]])) +
      row(t('f.x1'), num('x1', o.x1)) + row(t('f.y1'), num('y1', o.y1)) +
      row(t('f.x2'), num('x2', o.x2)) + row(t('f.y2'), num('y2', o.y2)) +
      row(t('f.len'), readonly(`${Math.round(L)} mm`));
  } else if (o.type === 'door' || o.type === 'window' || o.type === 'grille') {
    const w = getObj(o.wallId);
    const L = w ? wallLen(w) : 0;
    body =
      row(t('f.name'), text('props.name', p.name)) +
      row(t('f.width'), num('props.width', p.width, 50, 0)) +
      row(t('f.height'), num('props.height', p.height, 100, 0));
    if (o.type === 'door') {
      body += row(t('f.leaf'), sel('props.leaf', p.leaf || 'single',
        [['single', t('f.leafSingle')], ['double', t('f.leafDouble')]]));
      body += row(t('f.side'), sel('props.side', p.side || 'out',
        [['in', t('f.sideIn')], ['out', t('f.sideOut')]]));
      if ((p.leaf || 'single') === 'single') { // 开启方向仅单开门有效（双开门两端铰链对称开启）
        body += row(t('f.swing'), sel('props.swing', p.swing, [['left', t('f.swingLeft')], ['right', t('f.swingRight')]]));
      }
    } else if (o.type === 'grille') {
      body += row(t('f.sill'), num('props.sill', p.sill ?? 0, 50, 0)) +
        row(t('f.kind'), sel('props.kind', p.kind || '送风',
          [['送风', t('f.kindSupply')], ['回风', t('f.kindReturn')]]));
    } else {
      body += row(t('f.sillWindow'), num('props.sill', p.sill, 50, 0));
    }
    body +=
      row(t('f.dist'), `<input type="number" data-dist step="50" min="0" ${w ? '' : 'disabled'} value="${Math.round(o.t * L)}">`) +
      row(t('f.hostWall'), readonly(w ? `${w.props.name || w.id}（${t('f.fullLen')}${Math.round(L)}）` : t('f.wallLost'))) +
      (o.type === 'grille'
        ? `<div class="tip"><p>${t('tip.grille')}</p></div>`
        : o.type === 'door'
          ? `<div class="tip"><p>${t('tip.door')}</p></div>`
          : `<div class="tip"><p>${t('tip.window')}</p></div>`);
  } else if (o.type === 'tray') {
    const L = wallLen(o);
    body =
      row(t('f.name'), text('props.name', p.name)) +
      row(t('f.width'), num('props.width', p.width, 50, 0)) +
      row(t('f.trayBodyH'), num('props.bodyH', p.bodyH ?? 100, 50, 0)) +
      row(t('f.mountH'), num('props.height', p.height, 100, 0)) +
      row(t('f.kind'), sel('props.kind', p.kind || '弱电',
        [['强电', t('f.strongCurrent')], ['弱电', t('f.weakCurrent')], ['光纤', t('f.fiber')]])) +
      row(t('f.trayStruct'), sel('props.structure', p.structure || '',
        [['', t('f.unset')], ['ABS光纤槽', t('f.structAbs')], ['网格桥架', t('f.structMesh')],
          ['梯架', t('f.structLadder')], ['金属线槽', t('f.structTrunk')]])) +
      row(t('f.x1'), num('x1', o.x1)) + row(t('f.y1'), num('y1', o.y1)) +
      row(t('f.x2'), num('x2', o.x2)) + row(t('f.y2'), num('y2', o.y2)) +
      row(t('f.len'), readonly(`${Math.round(L)} mm`)) +
      `<div class="tip"><p>${t('tip.tray')}</p></div>`;
  } else if (o.type === 'column') {
    body =
      row(t('f.name'), text('props.name', p.name)) +
      row(t('f.w'), num('props.w', p.w, 50, 0)) +
      row(t('f.d'), num('props.d', p.d, 50, 0)) +
      row(t('f.h'), num('props.h', p.h, 100, 0)) +
      row(t('f.cx'), num('x', o.x)) + row(t('f.cy'), num('y', o.y)) +
      row(t('f.rot'), num('rotation', o.rotation || 0, 15));
  } else if (o.type === 'beam') {
    const e = beamEnds(o, getObj); // 端点随附着柱动态求解（手改坐标后脱离该端附着）
    const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    body =
      row(t('f.nameNum'), text('props.name', p.name)) +
      row(t('f.beamKind'), sel('props.kind', p.kind || '框架梁',
        [['框架梁', t('f.kindFrame')], ['次梁', t('f.kindSecondary')], ['悬挑梁', t('f.kindCantilever')]])) +
      row(t('f.beamB'), num('props.b', p.b, 50, 0)) +
      row(t('f.beamH'), num('props.h', p.h, 50, 0)) +
      row(t('f.beamTop'), num('props.top', p.top, 100, 0)) +
      row(t('f.beamConcrete'), sel('props.concrete', p.concrete || 'C30',
        [['C25', 'C25'], ['C30', 'C30'], ['C35', 'C35'], ['C40', 'C40'], ['C45', 'C45'], ['C50', 'C50']])) +
      row(t('f.span'), readonly(`${Math.round(L)} mm`)) +
      row(t('f.x1'), num('x1', e.x1)) + row(t('f.y1'), num('y1', e.y1)) +
      row(t('f.x2'), num('x2', e.x2)) + row(t('f.y2'), num('y2', e.y2)) +
      row(t('f.remark'), text('props.remark', p.remark)) +
      `<div class="tip"><p>${t('tip.beam')}</p></div>`;
  } else if (o.type === 'aisle') {
    body =
      row(t('f.name'), text('props.name', p.name)) +
      row(t('f.kind'), sel('props.kind', p.kind || 'cold',
        [['cold', t('f.coldAisle')], ['hot', t('f.hotAisle')]])) +
      row(t('f.enclosed'), `<input type="checkbox" data-path="props.enclosed" ${p.enclosed !== false ? 'checked' : ''} title="${t('f.enclosedTitle')}">`) +
      (p.enclosed !== false ? // 封闭通道端门：两端/单端（局部起点端，旋转180°换端）/无 × 推拉/双开/单开；门洞宽 0=全宽
        row(t('f.endDoors'), sel('props.endDoors', p.endDoors || 'both',
          [['both', t('f.endBoth')], ['one', t('f.endOne')], ['none', t('f.endNone')]], false, t('f.endDoorsTitle'))) +
        row(t('f.doorType'), sel('props.doorType', p.doorType || 'sliding',
          [['sliding', t('f.doorSliding')], ['double', t('f.doorDouble')], ['single', t('f.doorSingle')]], false, t('f.doorTypeTitle'))) +
        row(t('f.doorW'), num('props.doorW', p.doorW || 0, 50, 0, t('f.doorWTitle'))) : '') +
      row(t('f.aisleW'), num('props.d', p.d || 1200, 50, 0)) +
      row(t('f.aisleL'), num('props.w', p.w || 1000, 100, 0)) +
      row(t('f.aisleH'), num('props.h', p.h || 2000, 100, 0)) + // 通道高：封闭通道封顶/端门高度（3D），留空或≤0 时取最高机柜高
      row(t('f.cx'), num('x', o.x)) + row(t('f.cy'), num('y', o.y)) +
      row(t('f.rot'), num('rotation', o.rotation || 0, 15)) +
      row(t('f.linkCabs'), `<input type="checkbox" data-aislelink ${aisleLinkEnabled() ? 'checked' : ''} title="${t('f.linkCabsTitle')}">`) +
      `<div class="tip"><p>${t('tip.aisle')}</p></div>`;
  } else if (o.type === 'ac') {
    body =
      row(t('f.nameNum'), text('props.name', p.name)) +
      row(t('f.w'), num('props.w', p.w, 50, 0)) +
      row(t('f.d'), num('props.d', p.d, 50, 0)) +
      row(t('f.h'), num('props.h', p.h, 100, 0)) +
      row(t('f.cool'), num('props.cool', p.cool, 5, 0)) +
      row(t('f.air'), num('props.air', p.air, 100, 0)) +
      row(t('f.temp'), num('props.temp', p.temp, 0.5)) +
      row(t('f.supply'), sel('props.supply', p.supply || '水平送风',
        [['水平送风', t('f.supplyH')], ['下送风', t('f.supplyD')], ['上送风', t('f.supplyU')], ['侧送风', t('f.supplyS')]])) +
      row(t('f.acType'), sel('props.acType', p.acType || '',
        [['', t('f.unset')], ['房间级精密空调', t('f.acTypeRoom')], ['行级（列间）空调', t('f.acTypeRow')],
          ['机柜级（背板）空调', t('f.acTypeRack')], ['远端风墙空调', t('f.acTypeWallFar')],
          ['近端风墙空调', t('f.acTypeWallNear')], ['其他', t('f.acTypeOther')]])) +
      row(t('f.redundancy'), sel('props.redundancy', p.redundancy || '',
        [['', t('f.unset')], ['N+0', 'N+0'], ['N+1', 'N+1'], ['N+2', 'N+2']])) +
      row(t('f.ctrlMode'), sel('props.ctrlMode', p.ctrlMode || '',
        [['', t('f.unset')], ['送风控制', t('f.ctrlSupply')], ['回风控制', t('f.ctrlReturn')]])) +
      row(t('f.supplyRh'), num('props.supplyRh', p.supplyRh ?? '', 1, 0)) +
      row(t('f.returnTemp'), num('props.returnTemp', p.returnTemp ?? '', 0.5)) +
      row(t('f.cx'), num('x', o.x)) + row(t('f.cy'), num('y', o.y)) +
      row(t('f.rot'), num('rotation', o.rotation || 0, 15)) +
      row(t('f.remark'), text('props.remark', p.remark)) +
      (p.kind === 'row' // 仅列间空调可替换回机柜（精密空调不提供）
        ? `<div class="pbtns"><button data-rev title="${t('f.revertCabT')}">${icon('swap')}${t('f.revertCab')}</button></div>` : '') +
      `<div class="tip"><p>${t('tip.ac', { rowTip: p.kind === 'row' ? t('tip.acRow') : '' })}</p></div>`;
  } else if (o.type === 'ups') {
    body =
      row(t('f.nameNum'), text('props.name', p.name)) +
      row(t('f.w'), num('props.w', p.w, 50, 0)) +
      row(t('f.d'), num('props.d', p.d, 50, 0)) +
      row(t('f.h'), num('props.h', p.h, 100, 0)) +
      row(t('f.kva'), num('props.kva', p.kva, 10, 0)) +
      row(t('f.power'), num('props.power', p.power, 5, 0)) + // 输出功率（容量×功率因数）
      row(t('f.voltage'), sel('props.voltage', p.voltage ?? 380,
        [['220', t('f.voltage220')], ['380', t('f.voltage380')]], true)) +
      row(t('f.current'), sel('props.current', p.current ?? 400,
        [['63', '63'], ['100', '100'], ['160', '160'], ['250', '250'], ['400', '400'], ['630', '630']], true)) +
      row(t('f.backup'), num('props.backup', p.backup, 5, 0)) +
      row(t('f.upsType'), sel('props.upsType', p.upsType || '',
        [['', t('f.unset')], ['工频机', t('f.upsFreq')], ['高频机', t('f.upsHigh')],
          ['模块化', t('f.upsModular')], ['机架式', t('f.upsRack')], ['其他', t('f.acTypeOther')]])) +
      row(t('f.redundancy'), sel('props.redundancy', p.redundancy || '',
        [['', t('f.unset')], ['N+0', 'N+0'], ['N+1', 'N+1'], ['N+2', 'N+2']])) +
      row(t('f.cx'), num('x', o.x)) + row(t('f.cy'), num('y', o.y)) +
      row(t('f.rot'), num('rotation', o.rotation || 0, 15)) +
      row(t('f.remark'), text('props.remark', p.remark)) +
      `<div class="tip"><p>${t('tip.ups')}</p></div>`;
  } else if (o.type === 'battery') {
    body =
      row(t('f.nameNum'), text('props.name', p.name)) +
      row(t('f.w'), num('props.w', p.w, 50, 0)) +
      row(t('f.d'), num('props.d', p.d, 50, 0)) +
      row(t('f.h'), num('props.h', p.h, 100, 0)) +
      row(t('f.batType'), sel('props.batType', p.batType || '',
        [['', t('f.unset')], ['阀控铅酸', t('f.batVrla')], ['胶体', t('f.batGel')],
          ['磷酸铁锂', t('f.batLithium')], ['其他', t('f.acTypeOther')]])) +
      row(t('f.ah'), num('props.ah', p.ah, 10, 0)) +
      row(t('f.cells'), num('props.cells', p.cells, 1, 0)) +
      row(t('f.batVoltage'), num('props.voltage', p.voltage, 12, 0)) +
      row(t('f.cx'), num('x', o.x)) + row(t('f.cy'), num('y', o.y)) +
      row(t('f.rot'), num('rotation', o.rotation || 0, 15)) +
      row(t('f.remark'), text('props.remark', p.remark)) +
      `<div class="tip"><p>${t('tip.battery')}</p></div>`;
  } else if (o.type === 'extinguisher') {
    body =
      row(t('f.nameNum'), text('props.name', p.name)) +
      row(t('f.w'), num('props.w', p.w, 50, 0)) +
      row(t('f.d'), num('props.d', p.d, 50, 0)) +
      row(t('f.h'), num('props.h', p.h, 100, 0)) +
      row(t('f.extType'), sel('props.extType', p.extType || '',
        [['', t('f.unset')], ['手提式干粉', t('f.extDry')], ['手提式二氧化碳', t('f.extCo2')],
          ['推车式干粉', t('f.extCart')], ['悬挂式气体', t('f.extHang')], ['其他', t('f.acTypeOther')]])) +
      row(t('f.extKg'), num('props.kg', p.kg, 1, 0)) +
      row(t('f.cx'), num('x', o.x)) + row(t('f.cy'), num('y', o.y)) +
      row(t('f.rot'), num('rotation', o.rotation || 0, 15)) +
      row(t('f.remark'), text('props.remark', p.remark)) +
      `<div class="tip"><p>${t('tip.extinguisher')}</p></div>`;
  } else if (o.type === 'vent') {
    body =
      row(t('f.name'), text('props.name', p.name)) +
      row(t('f.w'), num('props.w', p.w, 50, 0)) +
      row(t('f.d'), num('props.d', p.d, 50, 0)) +
      row(t('f.kind'), sel('props.kind', p.kind || '格栅',
        [['格栅', t('f.ventGrille')], ['孔板', t('f.ventPerf')]])) +
      row(t('f.air'), num('props.air', p.air ?? 0, 100, 0)) +
      row(t('f.cx'), num('x', o.x)) + row(t('f.cy'), num('y', o.y)) +
      row(t('f.rot'), num('rotation', o.rotation || 0, 15)) +
      row(t('f.remark'), text('props.remark', p.remark)) +
      `<div class="tip"><p>${t('tip.vent')}</p></div>`;
  } else if (o.type === 'dbox') {
    body = distributionBoxFields(o, { row, text, num, sel });
  } else if (o.type === 'pdu') {
    body =
      row(t('f.nameNum'), text('props.name', p.name)) +
      row(t('f.w'), num('props.w', p.w, 10, 0)) +
      row(t('f.d'), num('props.d', p.d, 10, 0)) +
      row(t('f.h'), num('props.h', p.h, 100, 0)) +
      row(t('f.voltage'), sel('props.voltage', p.voltage ?? 380,
        [['220', t('f.voltage220')], ['380', t('f.voltage380')]], true)) +
      row(t('f.current'), sel('props.current', p.current ?? 250,
        [['63', '63'], ['100', '100'], ['160', '160'], ['250', '250'], ['400', '400'], ['630', '630']], true)) +
      row(t('f.outCircuits'), `<input type="text" data-path="props.outCircuits" value="${esc(p.outCircuits || '')}" placeholder="${esc(t('f.outCircuitsPh'))}">`) +
      row(t('f.cx'), num('x', o.x)) + row(t('f.cy'), num('y', o.y)) +
      row(t('f.rot'), num('rotation', o.rotation || 0, 15)) +
      row(t('f.remark'), text('props.remark', p.remark)) +
      `<div class="pbtns"><button data-rev title="${t('f.revertCabT')}">${icon('swap')}${t('f.revertCab')}</button></div>
      <div class="tip"><p>${t('tip.pdu')}</p></div>`;
  } else if (o.type === 'cabinet') {
    const cur = `${p.w}x${p.d}x${p.h}`;
    const specs = CABINET_SPECS.includes(cur) ? CABINET_SPECS : [cur, ...CABINET_SPECS];
    body =
      row(t('f.nameNum'), text('props.name', p.name)) +
      row(t('f.spec'), `<select data-spec dir="ltr" title="${t('f.specTitle')}">${specs.map(s =>
        `<option value="${esc(s)}" ${s === cur ? 'selected' : ''}>${esc(s).replace(/x/g, '×')}</option>`).join('')}</select>`) +
      row(t('f.w'), num('props.w', p.w, 10, 0)) +
      row(t('f.d'), num('props.d', p.d, 10, 0)) +
      row(t('f.h'), num('props.h', p.h, 100, 0)) +
      row(t('f.capacity'), num('props.u', p.u, 1, 0)) +
      row(t('f.power'), num('props.power', p.power, 0.5, 0)) +
      row(t('f.rpdu'), num('props.rpdu', p.rpdu ?? 2, 1, 0)) +
      row(t('f.voltage'), sel('props.voltage', p.voltage ?? 220,
        [['220', t('f.voltage220')], ['380', t('f.voltage380')]], true)) +
      row(t('f.current'), sel('props.current', p.current ?? 32,
        [['16', '16'], ['32', '32'], ['63', '63']], true)) +
      row(t('f.wireSize'), `<input type="text" data-path="props.wireSize" value="${esc(p.wireSize || '')}" placeholder="${esc(t('f.wireSizePh'))}">`) +
      sockEditorHtml(p) +
      row(t('f.cx'), num('x', o.x)) + row(t('f.cy'), num('y', o.y)) +
      row(t('f.rot'), num('rotation', o.rotation || 0, 15)) +
      row(t('f.remark'), text('props.remark', p.remark)) +
      `<div class="pbtns">
        <button data-rep="column" title="${t('f.repColumnT')}">${icon('swap')}${t('f.repColumn')}</button>
        <button data-rep="acrow" title="${t('f.repAcrowT')}">${icon('swap')}${t('f.repAcrow')}</button>
        <button data-rep="pdu" title="${t('f.repPduT')}">${icon('swap')}${t('f.repPdu')}</button>
      </div>
      <div class="pbtns">
        <button data-rerow title="${t('f.rerowT')}">${icon('sortnum')}${t('f.rerow')}</button>
        <button data-gap title="${t('f.gapT')}">${icon('gap')}${t('f.gap')}</button>
      </div>
      <div class="tip"><p>${t('tip.cabinetElec')}</p><p>${t('tip.cabinetColor')}</p></div>`;
  }
  if (isDevice(o)) {
    // 共用外观紧跟标题；Z 与 X/Y 相邻，不把底部标高误当作高度/尺寸。
    body = cabColorField(p.color) + body;
    const xy = row(t('f.cy'), num('y', o.y));
    body = body.replace(xy, xy + row(t('f.cz'), num('z', deviceZ(o), 50, undefined, t('f.czT'))));
  }
  // 阿语格式刷按钮按类型名词阴阳性选 آخر/أخرى（AR-05）：阳性类型用 f.brushBtnM，阴性沿用 f.brushBtn；
  // zh/en/es 两个 key 文案相同，不受影响
  const brushKey = ['wall', 'door', 'column', 'tray', 'aisle', 'ac', 'ups', 'vent'].includes(o.type) ? 'f.brushBtnM' : 'f.brushBtn';
  return `<h3>${t('props.title', { type: TYPE_NAMES[o.type] || o.type })}</h3>${body}
    <div class="pbtns"><button data-brush title="${t('f.brushBtnT')}">${icon('brush')}${t(brushKey, { type: TYPE_NAMES[o.type] || o.type })}</button></div>
    <div class="tip"><p>${t('tip.footer')}</p></div>`;
}

/** 双选面板块：两对象正交净距（与画布垂足正交标尺联动） */
function pairHtml(a, b) {
  const pc = pairClearance(a, b, getObj);
  if (!pc) return '';
  const fmtD = d => Math.round(d) + ' mm'; // 与画布标尺一致，统一 mm
  const line = (label, dim) => dim
    ? `<p>${label}：<b>${fmtD(dim.gap)}</b></p>`
    : `<p>${label}：—<small>${t('pair.overlap')}</small></p>`;
  const nm = o => `${esc(o.props && o.props.name || o.id)}<small> ${TYPE_NAMES[o.type] || o.type}</small>`;
  return `<div class="stat pairdim">
    <p class="pairdim-t">${nm(a)} ↔ ${nm(b)}</p>
    ${line(t('pair.xGap'), pc.h)}
    ${line(t('pair.yGap'), pc.v)}
    <p>${t('pair.center')}：<b>${fmtD(pc.center.d)}</b></p>
    <p class="pairdim-note">${t('pair.note')}</p>
  </div>`;
}

/** 多选面板：数量统计 + 批量旋转/删除 */
function multiHtml(objs) {
  const c = type => objs.filter(o => o.type === type).length;
  const power = objs.filter(o => o.type === 'cabinet')
    .reduce((s, o) => s + (+o.props.power || 0), 0);
  const cool = objs.filter(o => o.type === 'ac')
    .reduce((s, o) => s + (+o.props.cool || 0), 0);
  const kva = objs.filter(o => o.type === 'ups')
    .reduce((s, o) => s + (+o.props.kva || 0), 0);
  const rows = [['wall', TYPE_NAMES.wall, 'unit.seg'], ['door', TYPE_NAMES.door, 'unit.pc'], ['window', TYPE_NAMES.window, 'unit.pc'], ['grille', TYPE_NAMES.grille, 'unit.pc'],
    ['column', TYPE_NAMES.column, 'unit.gen'], ['beam', TYPE_NAMES.beam, 'unit.gen'], ['cabinet', TYPE_NAMES.cabinet, 'unit.tai'], ['aisle', TYPE_NAMES.aisle, 'unit.pc'], ['tray', TYPE_NAMES.tray, 'unit.seg'], ['pipe', TYPE_NAMES.pipe, 'unit.seg'], ['ac', TYPE_NAMES.ac, 'unit.tai'], ['ups', TYPE_NAMES.ups, 'unit.tai'], ['battery', TYPE_NAMES.battery, 'unit.tai'], ['extinguisher', TYPE_NAMES.extinguisher, 'unit.ju'], ['vent', TYPE_NAMES.vent, 'unit.pc'], ['pdu', TYPE_NAMES.pdu, 'unit.tai'], ['dbox', TYPE_NAMES.dbox, 'unit.tai']]
    .filter(([ty]) => c(ty))
    .map(([ty, n, u]) => `<p>${n}：<b>${c(ty)}</b> ${t(u)}</p>`).join('');
  const cabBtns = c('cabinet') ? `
  <div class="pbtns">
    <button data-rep="column" title="${t('multi.repColumnT', { n: c('cabinet') })}">${icon('swap')}${t('multi.cabToColumn')}</button>
    <button data-rep="acrow" title="${t('multi.repAcrowT', { n: c('cabinet') })}">${icon('swap')}${t('multi.cabToAcrow')}</button>
    <button data-rep="pdu" title="${t('multi.repPduT', { n: c('cabinet') })}">${icon('swap')}${t('multi.cabToPdu')}</button>
  </div>
  <div class="pbtns">
    <button data-rerow title="${t('multi.rerowSelT')}">${icon('sortnum')}${t('multi.rerowSel')}</button>
    <button data-gap title="${t('multi.gapFillT')}">${icon('gap')}${t('multi.gapFill')}</button>
  </div>` : '';
  // 列间空调/列头柜批量替换回机柜（选中集中含可替换对象时出现）
  const revN = objs.filter(isRevertible).length;
  const revBtns = revN ? `
  <div class="pbtns">
    <button data-rev title="${t('multi.revertCabT', { n: revN })}">${icon('swap')}${t('multi.revToCab')}</button>
  </div>` : '';
  // 多选对齐按钮（≥2 个可参与对象时出现；挂墙门窗不参与对齐）
  const alignBtns = alignableObjects(objs).length >= 2 ? `
  <div class="pbtns pbtns-align">
    ${ALIGN_MODES.map(m => `<button data-align="${m}" title="${t('align.tip', { mode: t('align.' + m) })}">${icon('al-' + m)}</button>`).join('')}
  </div>` : '';
  return `<h3>${t('multi.title', { n: objs.length })}</h3>
  ${objs.length === 2 ? pairHtml(objs[0], objs[1]) : ''}
  <div class="stat">${rows}${c('cabinet') ? `<p>${t('multi.cabPower', { p: power })}</p>` : ''}${c('ac') ? `<p>${t('multi.acCool', { c: cool })}</p>` : ''}${c('ups') ? `<p>${t('multi.upsKva', { k: kva })}</p>` : ''}</div>
  ${cabBtns}
  ${revBtns}
  ${alignBtns}
  <div class="pbtns">
    <button data-mrot title="${t('multi.rotateT')}">${icon('rotate')}${t('multi.rotate')}</button>
    <button data-mdel title="${t('multi.delT')}">${icon('trash')}${t('multi.del')}</button>
  </div>
  <div class="tip"><p>${t('multi.tip')}</p></div>`;
}

function summaryHtml() {
  const objs = state.project.objects;
  const c = type => objs.filter(o => o.type === type).length;
  const power = objs.filter(o => o.type === 'cabinet')
    .reduce((s, o) => s + (+o.props.power || 0), 0);
  const cool = objs.filter(o => o.type === 'ac')
    .reduce((s, o) => s + (+o.props.cool || 0), 0);
  const kva = objs.filter(o => o.type === 'ups')
    .reduce((s, o) => s + (+o.props.kva || 0), 0);
  const batCells = objs.filter(o => o.type === 'battery')
    .reduce((s, o) => s + (+o.props.cells || 0), 0);
  const m = state.project.meta || {};
  const mtext = (k, v, ph = '') =>
    `<input type="text" data-meta="${k}" value="${esc(v ?? '')}" placeholder="${ph}">`;
  const mnum = (k, v, step = 100) =>
    `<input type="number" data-meta="${k}" data-num step="${step}" value="${v ?? ''}" min="0">`;
  const tierOpts = [['', t('sum.tier0')], ['A', t('sum.tierA')], ['B', t('sum.tierB')], ['C', t('sum.tierC')]];
  const archOpts = [['', t('sum.tier0')], ['风冷直膨', t('sum.coolArchDx')], ['冷冻水', t('sum.coolArchCw')],
    ['双冷源', t('sum.coolArchDual')], ['其他', t('sum.coolArchOther')]];
  return `<h3>${t('sum.title')}</h3>
  ${row(t('f.name'), mtext('name', state.project.name))}
  ${row(t('sum.site'), mtext('site', m.site))}
  ${row(t('sum.height'), mnum('roomHeight', m.roomHeight))}
  ${row(t('sum.ceil'), mnum('ceilHeight', m.ceilHeight))}
  ${row(t('sum.floor'), mnum('floorHeight', m.floorHeight, 50))}
  ${row(t('sum.tier'), `<select data-meta="tier" title="${t('sum.tier')}">${tierOpts.map(([v, l]) =>
    `<option value="${v}" ${v === (m.tier || '') ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
  ${row(t('sum.powerCap'), mnum('powerCap', m.powerCap, 10))}
  ${row(t('sum.coolArch'), `<select data-meta="coolArch" title="${t('sum.coolArch')}">${archOpts.map(([v, l]) =>
    `<option value="${esc(v)}" ${v === (m.coolArch || '') ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
  ${row(t('sum.powerModule'), mnum('powerModule', m.powerModule, 10))}
  ${row(t('sum.floorLoad'), mnum('floorLoad', m.floorLoad, 50))}
  ${row(t('sum.climate'), mtext('climate', m.climate, t('sum.climatePh')))}
  ${row(t('f.remark'), mtext('remark', m.remark))}
  <div class="tip"><p>${t('sum.ceilTip')}</p></div>
  <div class="pbtns">
    <button data-check title="${t('btn.check')}">${icon('check')}${t('ck.title')}</button>
  </div>
  <h3>${t('sum.statTitle')}</h3>
  <div class="stat">
    <p>${t('sum.project', { name: esc(state.project.name) })}${state.dirty ? ` <span style="color:#e67e22">${t('sum.unsaved')}</span>` : ''}</p>
    <p>${t('sum.wall', { n: c('wall') })}</p>
    <p>${t('sum.doorWin', { d: c('door'), w: c('window'), g: c('grille') })}</p>
    <p>${t('sum.colTray', { c: c('column'), t: c('tray') })}</p>
    <p>${t('type.pipe')}：${c('pipe')} · ${t('pipe.length')} ${(objs.filter(o=>o.type==='pipe').reduce((sum,o)=>sum+pipeGeometry(o).length,0)/1000).toFixed(3)} m</p>
    <p>${t('sum.beam', { n: c('beam') })}</p>
    <p>${t('sum.aisleVent', { a: c('aisle'), v: c('vent') })}</p>
    <p>${t('sum.cab', { n: c('cabinet'), p: power })}</p>
    <p>${t('sum.up', { u: c('ups'), k: kva })}</p>
    <p>${t('sum.bat', { n: c('battery'), c: batCells })}</p>
    <p>${t('sum.ext', { n: c('extinguisher') })}</p>
    <p>${t('sum.ac', { n: c('ac'), c: cool, p: c('pdu') })}</p>
    <p>${t('type.dbox')}：${c('dbox')} ${t('unit.tai')}</p>
  </div>
  <h3>${t('sum.helpTitle')}</h3>
  <div class="tip">
    <p>${t('sum.help')}</p>
  </div>`;
}
