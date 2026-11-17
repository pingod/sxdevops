/**
 * 工勘建模向导：按机房工勘流程逐步引导（量房间→记机柜→记桥架→核对保存）
 * 左侧步骤面板 + 首次使用欢迎弹窗
 * 测量基准：房间西南角（左下角）为原点 (0,0)，X 向东、Y 向北，坐标/定位单位均为 mm
 */
import { state, ui, pushUndo, markDirty, autoName, loadDraft, notePropEdit } from './state.js';
import { roomWalls } from './geo.js';
import { setTool, nextRowPrefix, nextTpl, placeCabRow, placeCabPod } from './tools.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { notifyPanelState, onPanelState } from './panels.js';
import { loadUI, patchUI } from './uistate.js';

const FACE_ROT = { '北': 0, '东': 90, '南': 180, '西': 270 };

// 向导表单数据（切换步骤不丢失）
const WZ = {
  step: 1, visible: true,
  len: 12000, wid: 9000, th: 240,                    // 第1步 房间
  spec: 600, count: 10, gap: 0, face: '北', prefix: '', sx: 1500, sy: 2100, // 第2步 机柜（gap=0 紧贴）
  aislekind: 'cold', rows: 2, aisleWC: 1200, aisleWH: 900, axis: 'x', // 第2步 通道POD（机柜排数≥2时启用，冷/热通道宽分别记录）
  trayw: 300, traykind: '弱电',                             // 第4步 桥架
};

export function initWizard() {
  // 刷新恢复：开合状态与当前步骤（无记忆时出厂默认：展开 + 第 1 步）
  const saved = loadUI().wizard;
  WZ.step = Math.max(1, Math.min(4, Math.round(+saved.step || 1)));
  WZ.visible = saved.open !== false;
  document.getElementById('btn-wizard').addEventListener('click', () => toggle());
  // 左侧向导与自检互斥；显式进入右侧 AI 时默认收起，但之后允许手动并存。
  onPanelState(d => { if (d.open && ['checks', 'ai-enter'].includes(d.name)) toggle(false); });
  applyVisible(); // 直接按记忆落到 DOM：不走 toggle，避免启动时误广播收起其他面板
  if (!WZ.visible) ui.resize(); // 收起态：画布宽度变化后需重设画布尺寸
  renderPanel();
  maybeWelcome();
}

/** 语言切换后重建面板（main.js 的 onLocaleChange 调用） */
export function refreshPanel() { renderPanel(); }

/** 仅更新面板中的统计数字（不重建表单，避免输入失焦） */
export function updateCounts() {
  const objs = state.project.objects;
  document.querySelectorAll('[data-wcount]').forEach(el => {
    el.textContent = objs.filter(o => o.type === el.dataset.wcount).length;
  });
  const pw = document.querySelector('[data-wpower]');
  if (pw) {
    pw.textContent = objs.filter(o => o.type === 'cabinet')
      .reduce((s, o) => s + (+o.props.power || 0), 0);
  }
}

/** 开合状态落到 DOM（不广播、不重排）：启动恢复与用户点按共用 */
function applyVisible() {
  document.getElementById('wizard').style.display = WZ.visible ? '' : 'none';
  document.getElementById('btn-wizard').classList.toggle('active', WZ.visible);
}

/** 记忆向导开合与当前步骤（刷新页面回到原步骤，见 uistate.js） */
function saveWZ() { patchUI('wizard', { open: WZ.visible, step: WZ.step }); }

function toggle(force) {
  const next = force === undefined ? !WZ.visible : !!force;
  const changed = next !== WZ.visible;
  WZ.visible = next;
  applyVisible();
  ui.resize(); // 画布宽度变化后需重设画布尺寸
  saveWZ();
  if (changed) notifyPanelState('wizard', WZ.visible); // 只协调左侧自检，不关闭右侧 AI
}

function setStep(n) {
  WZ.step = Math.max(1, Math.min(4, n));
  if (WZ.step === 2 && !WZ.prefix) WZ.prefix = nextRowPrefix() + '##'; // 默认编号模板（如 A##）
  saveWZ(); // 步骤随刷新恢复
  renderPanel();
}

/* ---------- 面板渲染 ---------- */
const STEP_NAME_KEYS = { 1: 'wz.s1', 2: 'wz.s2', 3: 'wz.s3', 4: 'wz.s4' };
const STEP_NAMES = new Proxy({}, {
  get: (_t, k) => t(STEP_NAME_KEYS[k] || 'wz.s1'),
});

function renderPanel() {
  const el = document.getElementById('wizard');
  el.innerHTML = `
  <div class="wz-head">
    <b>${icon('clipboard')}${t('wz.title')}</b>
    <span class="wz-dots">${[1, 2, 3, 4].map(i =>
      `<i data-step="${i}" class="${i === WZ.step ? 'on' : ''}" title="${t('wz.stepTitle', { i })}">${i}</i>`).join('')}</span>
    <button class="wz-x" data-act="hide" title="${t('wz.collapse')}">×</button>
  </div>
  <div class="wz-body">${stepHtml()}</div>
  <div class="wz-nav">
    <button data-act="prev" title="${t('wz.prev')}" ${WZ.step === 1 ? 'disabled' : ''}>${t('wz.prev')}</button>
    <button data-act="next" title="${t('wz.next')}" ${WZ.step === 4 ? 'disabled' : ''}>${t('wz.next')}</button>
  </div>`;
  el.querySelectorAll('[data-act]').forEach(b =>
    b.addEventListener('click', () => onAct(b.dataset.act)));
  el.querySelectorAll('.wz-dots i').forEach(d =>
    d.addEventListener('click', () => setStep(+d.dataset.step)));
  // 表单值绑定到 WZ（数字自动转型）
  el.querySelectorAll('[data-wz]').forEach(inp => inp.addEventListener('input', () => {
    WZ[inp.dataset.wz] = inp.type === 'number' ? +inp.value : inp.value;
    if (inp.dataset.wz === 'trayw') notePropEdit('tray', 'width', Math.max(100, +inp.value || 300)); // 桥架宽跟随上一次设置
    if (inp.dataset.wz === 'traykind') notePropEdit('tray', 'kind', inp.value || '弱电');
    if (inp.dataset.wz === 'rows') syncRowsUI(); // 机柜排数=1 单排 / ≥2 通道POD，字段即时切换（不重渲染，避免输入失焦）
  }));
  // 第4步：工勘信息绑定到项目
  el.querySelectorAll('[data-meta]').forEach(inp => inp.addEventListener('input', () => {
    const k = inp.dataset.meta;
    if (k === 'name') {
      state.project.name = inp.value;
    } else {
      state.project.meta = state.project.meta || {};
      state.project.meta[k] = inp.value;
    }
    state.dirty = true;
  }));
  updateCounts();
}

function stepHtml() {
  const N = `<span class="wz-stepno">${t('wz.stepNo', { n: WZ.step, name: STEP_NAMES[WZ.step] })}</span>`;
  if (WZ.step === 1) return `${N}
    <p class="wz-tip">${t('wz.s1tip')}</p>
    <label>${t('wz.len')}<input type="number" data-wz="len" value="${WZ.len}" step="100" min="1000"></label>
    <label>${t('wz.wid')}<input type="number" data-wz="wid" value="${WZ.wid}" step="100" min="1000"></label>
    <label>${t('wz.th')}<input type="number" data-wz="th" value="${WZ.th}" step="10" min="60"></label>
    <button class="wz-primary" data-act="room">${icon('room')}${t('wz.genRoom')}</button>
    <p class="wz-note">${t('wz.origin')}<br>
    ${t('wz.irregular')}<a data-act="wall">${t('wz.drawWall')}</a></p>`;
  if (WZ.step === 2) return step2Html(N);
  if (WZ.step === 3) return step3Html(N);
  const meta = state.project.meta || {};
  const now = new Date(); // 本地日期：勿用 toISOString（UTC），否则东八区凌晨 0~8 点默认日期差一天
  const p2 = n => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  return `${N}
    <p class="wz-tip">${t('wz.s4tip')}</p>
    <div class="wz-stats">
      ${t('wz.statLine1', {
        n: '<b data-wcount="wall">0</b>', d: '<b data-wcount="door">0</b>',
        w: '<b data-wcount="window">0</b>', g: '<b data-wcount="grille">0</b>',
      })}<br>
      ${t('wz.statLine2', {
        n: '<b data-wcount="column">0</b>', c: '<b data-wcount="cabinet">0</b>',
        t: '<b data-wcount="tray">0</b>',
      })}<br>
      ${t('wz.statLine3', {
        a: '<b data-wcount="aisle">0</b>', c: '<b data-wcount="ac">0</b>',
        u: '<b data-wcount="ups">0</b>', b: '<b data-wcount="battery">0</b>',
        e: '<b data-wcount="extinguisher">0</b>',
        v: '<b data-wcount="vent">0</b>', p: '<b data-wcount="pdu">0</b>',
      })}<br>
      ${t('wz.power', { p: '<b data-wpower>0</b>' })}
    </div>
    <label>${t('wz.name')}<input data-meta="name" value="${escHtml(state.project.name)}"></label>
    <label>${t('wz.site')}<input data-meta="site" value="${escHtml(meta.site || '')}" placeholder=""></label>
    <label>${t('wz.surveyor')}<input data-meta="surveyor" value="${escHtml(meta.surveyor || '')}" placeholder=""></label>
    <label>${t('wz.date')}<input data-meta="date" type="date" value="${escHtml(meta.date || today)}"></label>
    <button class="wz-primary" data-act="save">${icon('save')}${t('wz.save')}</button>
    <div class="wz-btns">
      <button data-act="png">${icon('image')}${t('wz.exportPNG')}</button>
      <button data-act="dxf">${icon('dxf')}${t('wz.exportDXF')}</button>
      <button data-act="csv">${icon('csv')}${t('wz.exportCSV')}</button>
    </div>
    <p class="wz-note">${t('wz.s4note')}</p>
    <button data-act="hide">${t('wz.close')}</button>`;
}

/* ---------- 第2步：记机柜（机柜排数驱动：1=单排 / ≥2=通道POD） ---------- */
const POD_NOTE_KEY = 'wz.podNote';
const ROW_NOTE_KEY = 'wz.rowNote';

function step2Html(N) {
  const pod = WZ.rows >= 2;                      // 机柜排数≥2 按通道POD成组，=1 记单排
  const hidP = pod ? '' : 'style="display:none"'; // 仅通道POD显示的字段
  const hidR = pod ? 'style="display:none"' : ''; // 仅单排显示的字段
  return `${N}
    <p class="wz-tip">${t('wz.s2tip')}</p>
    <label>${t('wz.rows')}<input type="number" data-wz="rows" value="${WZ.rows}" min="1" max="26"></label>
    <label data-pod ${hidP}>${t('wz.aislekind')}
      <select data-wz="aislekind">
        <option value="cold" ${WZ.aislekind === 'cold' ? 'selected' : ''}>${t('wz.aisleCold')}</option>
        <option value="hot" ${WZ.aislekind === 'hot' ? 'selected' : ''}>${t('wz.aisleHot')}</option>
      </select></label>
    <label>${t('wz.count')}<input type="number" data-wz="count" value="${WZ.count}" min="1" max="100"></label>
    <label data-pod ${hidP}>${t('wz.aisleWC')}<input type="number" data-wz="aisleWC" value="${WZ.aisleWC}" step="50" min="600"></label>
    <label data-pod ${hidP}>${t('wz.aisleWH')}<input type="number" data-wz="aisleWH" value="${WZ.aisleWH}" step="50" min="600"></label>
    <label data-pod ${hidP}>${t('wz.axis')}
      <select data-wz="axis">
        <option value="x" ${WZ.axis === 'x' ? 'selected' : ''}>${t('wz.axisX')}</option>
        <option value="y" ${WZ.axis === 'y' ? 'selected' : ''}>${t('wz.axisY')}</option>
      </select></label>
    <label>${t('wz.spec')}
      <select data-wz="spec" dir="ltr"> <!-- 数字规格：RTL 下强制 LTR，防 bidi 反转 -->
        <option value="600" ${WZ.spec == 600 ? 'selected' : ''}>600×1200×2000</option>
        <option value="800" ${WZ.spec == 800 ? 'selected' : ''}>800×1200×2000</option>
      </select></label>
    <label>${t('wz.gap')}<input type="number" data-wz="gap" value="${WZ.gap}" step="50" min="0"></label>
    <p class="wz-note">${t('wz.gapNote')}</p>
    <label data-row ${hidR}>${t('wz.face')}
      <select data-wz="face">${['北', '南', '东', '西'].map(f =>
        `<option ${WZ.face === f ? 'selected' : ''} value="${f}">${t('dir.' + { 北: 'n', 南: 's', 东: 'e', 西: 'w' }[f])}</option>`).join('')}</select></label>
    <label>${t('wz.tpl')}<input data-wz="prefix" dir="ltr" value="${WZ.prefix}" placeholder="${t('wz.tplPh')}"></label> <!-- 编号模板为拉丁技术串：RTL 下强制 LTR，防 bidi 反转（AR-01） -->
    <p class="wz-note">${t('wz.tplNote')}</p>
    <label>${t('wz.sx')}<input type="number" data-wz="sx" value="${WZ.sx}" step="100"></label>
    <label>${t('wz.sy')}<input type="number" data-wz="sy" value="${WZ.sy}" step="100"></label>
    <button class="wz-primary" data-act="cabs-xy" title="${t('wz.genXYTitle')}">${icon('rows')}${t('wz.genXY')}</button>
    <button data-act="cabs" title="${t('wz.genXYTitle')}">${icon('rows')}${t('wz.genClick')}</button>
    <p class="wz-note">${t('wz.doneCabs', { n: '<b data-wcount="cabinet">0</b>', a: '<b data-wcount="aisle">0</b>' })}<br>
    <span data-rows-note>${t(pod ? POD_NOTE_KEY : ROW_NOTE_KEY)}</span></p>
    <p class="wz-note">${t('wz.s2note2')}</p>`;
}

/** 机柜排数变化时即时切换 通道POD/单排 专属字段与说明（不重渲染整个面板，避免输入失焦） */
function syncRowsUI() {
  const pod = WZ.rows >= 2;
  const wz = document.getElementById('wizard');
  wz.querySelectorAll('[data-pod]').forEach(el => { el.style.display = pod ? '' : 'none'; });
  wz.querySelectorAll('[data-row]').forEach(el => { el.style.display = pod ? 'none' : ''; });
  const note = wz.querySelector('[data-rows-note]');
  if (note) note.textContent = t(pod ? POD_NOTE_KEY : ROW_NOTE_KEY);
}

/* ---------- 第3步：记桥架 ---------- */
function step3Html(N) {
  return `${N}
    <p class="wz-tip">${t('wz.s3tip')}</p>
    <label>${t('wz.trayw')}<input type="number" data-wz="trayw" value="${WZ.trayw}" step="50" min="100"></label>
    <label>${t('wz.traykind')}
      <select data-wz="traykind">${['弱电', '强电', '光纤'].map(k =>
        `<option ${WZ.traykind === k ? 'selected' : ''} value="${k}">${t('f.' + { 弱电: 'weakCurrent', 强电: 'strongCurrent', 光纤: 'fiber' }[k])}</option>`).join('')}</select></label>
    <button class="wz-primary" data-act="tray">${icon('tray')}${t('wz.recordTray')}</button>
    <p class="wz-note">${t('wz.s3note', { n: '<b data-wcount="tray">0</b>' })}</p>`;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/* ---------- 动作 ---------- */
function onAct(act) {
  switch (act) {
    case 'hide': toggle(false); break;
    case 'prev': setStep(WZ.step - 1); break;
    case 'next': setStep(WZ.step + 1); break;
    case 'wall': case 'tray':
      setTool(act); break;
    case 'room': genRoom(); break;
    case 'cabs': // 机柜排数≥2 按通道POD，=1 按单排
      if (WZ.rows >= 2) { setPodCfg(); setTool('cabpod'); }
      else { setRowCfg(); setTool('cabrow'); }
      break;
    case 'cabs-xy':
      if (WZ.rows >= 2) { setPodCfg(); placeCabPod(WZ.sx, WZ.sy, true); }
      else { setRowCfg(); placeCabRow(WZ.sx, WZ.sy, true); }
      WZ.prefix = nextTpl(WZ.prefix || (nextRowPrefix() + '##')); renderPanel(); break; // 排号递增并刷新显示
    case 'save': ui.save(); break;
    case 'png': ui.exportPNG(); break;
    case 'dxf': ui.exportDXF(); break;
    case 'csv': ui.exportCSV(); break;
  }
}

function clampN(v) { return Math.max(1, Math.min(100, +v || 1)); }

function setRowCfg() {
  state.rowCfg = {
    w: +WZ.spec || 600, d: 1200,
    count: clampN(WZ.count), gap: Math.max(0, +WZ.gap || 0),
    rotation: FACE_ROT[WZ.face] || 0,
    tpl: (WZ.prefix || (nextRowPrefix() + '##')).toUpperCase(), // 编号模板（如 A##、101-A##）
  };
}

/** 第2步：通道POD批量生成配置（冷=面对面 / 热=背对背，两排一组） */
function setPodCfg() {
  state.podCfg = {
    kind: WZ.aislekind === 'hot' ? 'hot' : 'cold',
    w: +WZ.spec || 600, d: 1200,
    rows: Math.max(2, Math.min(26, +WZ.rows || 2)), // 上限26：排号逐排 A、B… 自动递增
    count: clampN(WZ.count),
    gap: Math.max(0, +WZ.gap || 0),
    aisleWC: Math.max(600, +WZ.aisleWC || 1200),
    aisleWH: Math.max(600, +WZ.aisleWH || 900),
    axis: WZ.axis === 'y' ? 'y' : 'x',
    tpl: (WZ.prefix || (nextRowPrefix() + '##')).toUpperCase(), // 编号模板（排号逐排替换，如 101-A##）
  };
}

/** 第1步：按实测内空尺寸生成矩形房间（西南角内表面为原点 0,0，X 向东 Y 向北）。
 * 墙中心线向外偏移半墙厚，保证内空尺寸 = 输入尺寸（如 12000×9000 墙厚 240，
 * 双选对向墙的净距标尺显示 12000 / 9000，而非 11760 / 8760）。 */
function genRoom() {
  const L = +WZ.len, Wd = +WZ.wid, th = Math.max(60, +WZ.th || 240);
  if (!(L >= 1000 && Wd >= 1000)) { ui.hint(t('hint.roomTooSmall')); return; }
  pushUndo();
  for (const w of roomWalls(L, Wd, th)) {
    w.props.name = autoName(t('auto.wall'));
    state.project.objects.push(w);
  }
  markDirty();
  ui.fit();
  setStep(2);
  ui.hint(t('hint.roomDone', { l: L, w: Wd }));
}

/* ---------- 首次使用欢迎弹窗 ---------- */
function maybeWelcome() {
  try {
    if (localStorage.getItem('idc2d_no_welcome') === '1' || loadDraft()) return; // 已有草稿=老用户，不再弹欢迎
  } catch (e) { /* ignore */ }
  const ov = document.createElement('div');
  ov.className = 'wz-overlay';
  ov.innerHTML = `<div class="wz-modal">
    <h2>${t('wz.welcomeTitle')}</h2>
    <p>${t('wz.welcomeP')}</p>
    <button class="wz-primary" data-m="wizard">${icon('clipboard')}${t('wz.start')}</button>
    <button data-m="blank">${icon('pencil')}${t('wz.blank')}</button>
    <label class="wz-again"><input type="checkbox" id="wz-nomore"> ${t('wz.noAgain')}</label>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('[data-m]'); // 点到按钮内图标也能命中
    const m = btn && btn.dataset.m;
    if (!m) return;
    if (document.getElementById('wz-nomore').checked) {
      try { localStorage.setItem('idc2d_no_welcome', '1'); } catch (err) { /* ignore */ }
    }
    ov.remove();
    if (m === 'wizard') { toggle(true); setStep(1); }
    else toggle(false);
  });
}
