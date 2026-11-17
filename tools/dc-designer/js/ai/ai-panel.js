/**
 * AI 建模(试验) 面板（右侧工作区的「AI建模」标签）
 *
 * 职责（见 内部设计文档 §3）：
 *  输入框 / 对话气泡 / 步骤日志（执行结果）/ 破坏性操作确认条 / 撤销本轮 / 停止 / 设置
 *  + 外部 Agent 接入引导（折叠区，复用 /api/agent/* 说明）。
 * 执行方式：**只有自动执行**（无计划模式，也无计划卡）——模型给的指令立即下发；
 * 只有含 destructive 标记的不可逆调用才弹一次确认条（confirm 事件）。
 * 全部判断交给模型（ai-rules.js），面板只渲染与转发；每条指令仍是页内一步撤销。
 * 布局：挂在独立的 #ai-design 中，由 sidebar.js 统一管理显隐和宽度。
 * 切换属性 / 收起只隐藏 DOM，不销毁实例、不停止请求；属性刷新不触碰 AI DOM。
 * 进度提示：指示器（三点跳动/旋转圈 + 阶段文案 + 等待秒数 + 停止）**完全事件驱动**——
 * 编排层每轮模型往返前发 `thinking`（`fix:true` 表示上一轮 JSON 不合规后的纠错重试）、
 * 执行期发 `step.start`；面板只渲染，不自己计时猜阶段（否则会出现「模型已返回但还在闪」的假状态）。
 * 附件：输入框右侧📎按钮上传、`Ctrl+V` 粘贴、直接拖入三种入口共用 ai-attach.js 的
 * prepareAttachment（图片压缩 + 缩略图、文本读取 + 截断）；面板只负责收集/渲染/传护栏，
 * 消息拼装（多模态内容块）与体积释放都在编排层。
 */

import { t, onLocaleChange } from '../i18n.js';
import { apiUrl } from '../api-base.js';
import { state } from '../state.js';
import { icon } from '../icons.js';
import { notifyPanelBusy } from '../panels.js';
import { registerAiView, selectSidebarTab, closeSidebar, isAiVisible, setAiPending } from '../sidebar.js';
import { AiProvider } from './ai-provider.js';
import { AiOrchestrator } from './ai-orchestrator.js';
import { ATTACH_LIMITS, prepareAttachment, formatBytes, attachmentChars } from './ai-attach.js';

// AIOps 代理模式：契约随设计器静态资源发布（/dc-designer-app/api/agent/openapi.json）；
// 独立/本机模式仍走应用基路径下的 /api/agent/openapi.json。
const AIOPS_PROXY = (() => {
  try {
    const p = new URLSearchParams(location.search);
    if (p.get('aiProxy') === '1') return true;
    return p.get('embed') === '1' && p.get('ai') !== '0';
  } catch (e) { return false; }
})();
const CONTRACT_URL = AIOPS_PROXY
  ? new URL('api/agent/openapi.json', document.baseURI).href
  : apiUrl('/api/agent/openapi.json');
const AGENT_STATUS_URL = apiUrl('/api/agent/status');

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** 拖拽事件里是否带文件（拖入文字/选中内容时不接管，交给浏览器默认行为） */
const hasFiles = e => {
  const dt = e && e.dataTransfer;
  if (!dt) return false;
  const types = [...(dt.types || [])];
  return types.includes('Files') || (dt.files && dt.files.length > 0);
};

class AiPanel {
  constructor(deps) {
    this.exec = deps.exec;
    this.undoRound = deps.undoRound;
    this.clientId = deps.clientId || '';
    this.getExecutedCount = deps.getExecutedCount || (() => 0);
    this.provider = new AiProvider();
    this.orch = null;
    this.contract = '';
    this.contractLoaded = false; // 契约（含合法指令名单）是否已到——false 时拦截发送，见 sendCurrent()
    this.built = false;
    this.ready = null;
    this.scrollPending = false;
    this.undoSteps = 0;
    this.atts = [];          // 待发送附件（ai-attach.js 的附件对象：kind/name/size/url|text/thumb）
    this.attWarn = [];       // 附件拒收原因（{code, name}），随附件区一起渲染
    this.attSeq = 0;
    this.routeTimer = null;
    this.thinkingEl = null;
    this.thinkPhase = '';
    this.thinkData = null;
    this.thinkTimer = null;   // 「已等待 N 秒」计时器（仅等待模型时跑）
    this.thinkSince = 0;
  }

  /* ---------- 构建 ---------- */
  async build() {
    const root = el('div', 'aip-drawer');
    root.hidden = true;
    root.innerHTML = `
      <div class="aip-head">
        <b class="aip-title"></b>
        <span class="aip-ring" aria-hidden="true"></span>
        <button class="aip-icon aip-set-btn" title=""></button>
      </div>
      <div class="aip-warn" hidden></div>
      <div class="aip-msgs">
        <div class="aip-welcome"></div>
        <div class="aip-settings" hidden>
          <label class="aip-field"><span class="aip-l-key"></span><input type="password" class="aip-key" autocomplete="off"></label>
          <label class="aip-field"><span class="aip-l-base"></span><input type="text" class="aip-base" spellcheck="false"></label>
          <label class="aip-field"><span class="aip-l-model"></span><input type="text" class="aip-model" spellcheck="false"></label>
          <div class="aip-cfg-actions">
            <button class="aip-cfg-save"></button>
            <button class="aip-cfg-clear"></button>
          </div>
          <div class="aip-cfg-status"></div>
          <div class="aip-privacy"></div>
        </div>
      </div>
      <div class="aip-inputrow">
        <div class="aip-composer">
          <div class="aip-atts" hidden>
            <ul class="aip-att-list"></ul>
            <div class="aip-att-hint" hidden></div>
            <div class="aip-att-warn" hidden></div>
          </div>
          <div class="aip-editor">
            <textarea class="aip-input" rows="2" spellcheck="false"></textarea>
            <div class="aip-btns">
              <button class="aip-att-btn" type="button"></button>
              <input class="aip-file" type="file" multiple hidden>
              <button class="aip-send" type="button"></button>
              <button class="aip-stop" type="button" hidden></button>
            </div>
          </div>
        </div>
      </div>
      <div class="aip-foot" hidden>
        <button class="aip-undo" hidden></button>
      </div>
      <details class="aip-guide">
        <summary></summary>
        <div class="aip-guide-body">
          <p class="aip-guide-text"></p>
          <div class="ai-urlrow"><input class="ai-url" readonly><button class="ai-copy"></button></div>
          <p class="ai-status"></p>
        </div>
      </details>`;
    document.getElementById('ai-design').appendChild(root);
    this.el = {
      root,
      head: root.querySelector('.aip-head'),
      title: root.querySelector('.aip-title'),
      setBtn: root.querySelector('.aip-set-btn'),
      warn: root.querySelector('.aip-warn'),
      msgs: root.querySelector('.aip-msgs'),
      welcome: root.querySelector('.aip-welcome'),
      settings: root.querySelector('.aip-settings'),
      key: root.querySelector('.aip-key'),
      base: root.querySelector('.aip-base'),
      model: root.querySelector('.aip-model'),
      lKey: root.querySelector('.aip-l-key'),
      lBase: root.querySelector('.aip-l-base'),
      lModel: root.querySelector('.aip-l-model'),
      cfgSave: root.querySelector('.aip-cfg-save'),
      cfgClear: root.querySelector('.aip-cfg-clear'),
      cfgStatus: root.querySelector('.aip-cfg-status'),
      privacy: root.querySelector('.aip-privacy'),
      input: root.querySelector('.aip-input'),
      composer: root.querySelector('.aip-composer'),
      attBox: root.querySelector('.aip-atts'),
      attList: root.querySelector('.aip-att-list'),
      attHint: root.querySelector('.aip-att-hint'),
      attWarn: root.querySelector('.aip-att-warn'),
      attBtn: root.querySelector('.aip-att-btn'),
      file: root.querySelector('.aip-file'),
      send: root.querySelector('.aip-send'),
      stop: root.querySelector('.aip-stop'),
      undo: root.querySelector('.aip-undo'),
      foot: root.querySelector('.aip-foot'),
      guide: root.querySelector('.aip-guide'),
      guideSummary: root.querySelector('.aip-guide summary'),
      guideText: root.querySelector('.aip-guide-text'),
      url: root.querySelector('.ai-url'),
      copy: root.querySelector('.ai-copy'),
      route: root.querySelector('.ai-status'),
    };
    this.built = true;

    this.el.setBtn.addEventListener('click', () => this.toggleSettings());
    this.el.send.addEventListener('click', () => this.sendCurrent());
    this.el.stop.addEventListener('click', () => this.stop());
    this.el.undo.addEventListener('click', () => this.undoLastRound());
    this.el.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendCurrent(); }
    });
    this.el.input.addEventListener('input', () => this.autoGrow());
    // 附件三入口：📎上传 / Ctrl+V 粘贴 / 拖入输入区（都走同一个 addFiles）
    this.el.attBtn.addEventListener('click', () => this.pickFiles());
    this.el.file.addEventListener('change', () => {
      const files = [...this.el.file.files]; // 先抄一份：下面的 value='' 会把同一个 FileList 清空（不抄就丢文件）
      this.el.file.value = ''; // 清空：同一文件连选两次也要能触发 change
      this.addFiles(files);
    });
    this.el.input.addEventListener('paste', e => this.onPaste(e));
    this.el.composer.addEventListener('dragover', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.el.composer.classList.add('aip-drop');
    });
    this.el.composer.addEventListener('dragleave', () => this.el.composer.classList.remove('aip-drop'));
    this.el.composer.addEventListener('drop', e => {
      this.el.composer.classList.remove('aip-drop');
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.addFiles(e.dataTransfer && e.dataTransfer.files);
    });
    this.el.cfgSave.addEventListener('click', () => this.saveConfig());
    this.el.cfgClear.addEventListener('click', () => this.clearConfig());
    this.el.url.value = /^https?:/.test(CONTRACT_URL) ? CONTRACT_URL : location.origin + CONTRACT_URL;
    this.el.guide.hidden = AIOPS_PROXY;
    this.el.copy.addEventListener('click', () => this.copyUrl());
    this.el.guide.addEventListener('toggle', () => { if (this.el.guide.open) this.refreshRoute(); });
    this.syncTexts();
    // 共用右栏宽度变化（拖拽 / 断点 / RTL）时重测输入，隐藏态不测量。
    this.resizeObserver = new ResizeObserver(() => {
      if (isAiVisible() && !root.hidden) this.autoGrow();
    });
    this.resizeObserver.observe(root);

    await this.loadConfig();
    await this.loadContract();
    return this;
  }

  /* ---------- 文案（语言切换时重建） ---------- */
  syncTexts() {
    if (!this.built) return;
    const e = this.el;
    e.title.textContent = t('aip.title');
    e.setBtn.textContent = '⚙';
    e.setBtn.title = t('aip.settings');
    this.syncSettingsState();
    e.welcome.textContent = t('aip.welcome');
    e.lKey.textContent = t('aip.key');
    e.key.placeholder = t('aip.key.ph');
    e.lBase.textContent = t('aip.baseUrl');
    e.lModel.textContent = t('aip.model');
    e.cfgSave.textContent = t('aip.save');
    e.cfgClear.textContent = t('aip.clear');
    e.privacy.textContent = t('aip.privacy');
    e.input.placeholder = t('aip.placeholder');
    e.attBtn.innerHTML = icon('attach');
    e.attHint.textContent = t('aip.attach.hint');
    this.renderAtts(); // 附件区（按钮 tooltip / 拒收原因）随语言刷新
    // 发送/停止为图标按钮：可视文字换成图标，语义（title / aria-label）仍跟随语言
    e.send.innerHTML = icon('send');
    e.send.title = t('aip.send');
    e.send.setAttribute('aria-label', t('aip.send'));
    e.stop.innerHTML = icon('stop');
    e.stop.title = t('aip.stop');
    e.stop.setAttribute('aria-label', t('aip.stop'));
    e.undo.textContent = t('aip.undo');
    if (this.thinkStop) this.thinkStop.textContent = t('aip.stop'); // 指示器内的停止入口（若正显示）
    if (this.thinkingEl) this.renderThink(); // 等待/执行中文案随语言切换刷新
    e.guideSummary.textContent = t('aip.guide');
    e.guideText.textContent = t('ai.step1') + ' / ' + t('ai.step2');
    e.copy.textContent = t('ai.copy');
    e.warn.textContent = t('aip.direct', { url: this.provider.statusUrl || apiUrl('/api/ai/status') });
    e.warn.hidden = this.provider.aiProxy || !this.provider.direct;
    this.applyProxyMode();
    if (!this.el.root.hidden) this.autoGrow(); // 提示文案随语言变化：重算高度，长提示（en/es）不被裁切
    this.refreshRoute();
  }

  /* ---------- 开合由统一右栏协调 ---------- */
  setVisible(on, focus = false) {
    document.getElementById('ai-design').hidden = !on;
    if (on && !this.built) this.ready = this.build(); // DOM 同步构建，网络配置异步加载
    if (!this.built) return;
    this.el.root.hidden = !on;
    clearInterval(this.routeTimer);
    this.routeTimer = null;
    if (!on) return; // 只隐藏，不重置会话、附件或中止编排器
    this.autoGrow();
    if (focus) this.el.input.focus();
    if (this.scrollPending) this.scroll();
    this.syncSettingsState();
    this.refreshRoute();
    this.routeTimer = setInterval(() => this.refreshRoute(), 5000);
  }

  /* ---------- 设置区开合 ---------- */
  /** 设置按钮按下态：开着设置时按钮高亮（.active + aria-pressed），
   * 否则「开/关」外观一样、看不出当前是开是关。 */
  syncSettingsState() {
    if (!this.built) return;
    const open = !this.el.settings.hidden;
    this.el.setBtn.classList.toggle('active', open);
    this.el.setBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
  }

  /** 开合设置区（force 缺省=切换）。设置区在消息流顶部，展开后滚动到可视区，
   * 长对话下点设置不会“看着像没反应”。 */
  toggleSettings(force) {
    const open = force == null ? this.el.settings.hidden : !!force;
    this.el.settings.hidden = !open;
    this.syncSettingsState();
    if (open) this.el.settings.scrollIntoView({ block: 'nearest' });
  }

  async toggle() { return isAiVisible() ? this.close() : this.open(); }

  async open() {
    selectSidebarTab('ai', { focus: true });
    if (this.ready) await this.ready;
    return this;
  }

  close() { if (isAiVisible()) closeSidebar(); }

  /* ---------- 配置 ---------- */
  async loadConfig() {
    try { await this.provider.loadConfig(); } catch (e) { /* 配置读取失败不阻塞对话 */ }
    this.refreshConfigStatus();
    this.el.warn.hidden = this.provider.aiProxy || !this.provider.direct;
    this.applyProxyMode();
  }

  /** AIOps 代理模式：模型/Key/地址由平台统一管理，设置区只保留只读说明。 */
  applyProxyMode() {
    if (!this.built || !this.provider.aiProxy) return;
    this.el.root.classList.add('ai-proxy');
    this.el.settings.querySelectorAll('.aip-field, .aip-cfg-actions').forEach((el) => { el.hidden = true; });
    this.el.privacy.hidden = true;
    this.el.cfgStatus.textContent = t('aip.proxyNote');
  }

  refreshConfigStatus() {
    const c = this.provider.cfg;
    if (this.provider.aiProxy) {
      this.el.cfgStatus.textContent = t('aip.proxyNote');
      return;
    }
    const srcKey = 'aip.source.' + (c.source || 'none');
    const src = t(srcKey) === srcKey ? (c.source || 'none') : t(srcKey);
    this.el.key.value = '';
    this.el.key.placeholder = c.configured ? '•••• ' + (c.keyMask || '') : t('aip.key.ph');
    this.el.base.value = c.baseUrl || '';
    this.el.model.value = c.model || '';
    this.el.cfgStatus.textContent = t('aip.source', { src }) + (c.keyMask ? ' · ' + t('aip.key.current', { mask: c.keyMask }) : '');
  }

  async saveConfig() {
    try {
      await this.provider.saveConfig({
        key: this.el.key.value.trim(), baseUrl: this.el.base.value.trim(), model: this.el.model.value.trim(),
      });
      this.el.cfgStatus.textContent = t('aip.saved');
      this.refreshConfigStatus();
    } catch (e) { this.el.cfgStatus.textContent = this.errText(e); }
  }

  async clearConfig() {
    try {
      await this.provider.clearConfig();
      this.el.cfgStatus.textContent = t('aip.cleared');
      this.refreshConfigStatus();
    } catch (e) { this.el.cfgStatus.textContent = this.errText(e); }
  }

  copyUrl() {
    const done = () => { this.el.copy.textContent = t('ai.copied'); setTimeout(() => { if (this.built) this.el.copy.textContent = t('ai.copy'); }, 1500); };
    const url = this.el.url.value;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, done);
    else { this.el.url.select(); try { document.execCommand('copy'); } catch (e) { /* ignore */ } done(); }
  }

  async refreshRoute() {
    if (!this.built || this.el.root.hidden || AIOPS_PROXY) return;
    try {
      const r = await fetch(AGENT_STATUS_URL, { cache: 'no-store' });
      const s = await r.json();
      const active = (s.clients || []).find(c => c.active);
      const route = (active && active.id === this.clientId)
        ? t('ai.route.self') + (s.pinned ? t('ai.route.pinned') : '')
        : (active ? t('ai.route.other', { id: String(active.id).slice(0, 8) }) : t('ai.route.none')) + ' ' + t('ai.route.hint');
      this.el.route.textContent = t('ai.status') + '：' + route + ' · ' + t('ai.executed', { n: this.getExecutedCount() });
    } catch (e) { this.el.route.textContent = t('ai.status') + '：' + t('ai.route.none'); }
  }

  /* ---------- 提示词（裁剪契约 + 机械提取的指令名单 + 一行画布现状） ---------- */
  /** 拉取 /api/agent/openapi.json 并重建 system 提示词。
   *  **失败不能静默**：契约是模型唯一的指令名来源，取不到时它只能编名字（曾出现 ac.create 这类
   *  UNKNOWN_TOOL）。这里只把结果记到 this.contractLoaded，由 sendCurrent 拦截发送并提示用户。
   *  @returns {Promise<boolean>} 是否拿到可用契约（含合法指令名单） */
  async loadContract() {
    this.contract = '';
    try {
      const r = await fetch(CONTRACT_URL, { cache: 'no-store' });
      if (r.ok) this.contract = await r.text();
    } catch (e) { /* 离线/被拦截：下方置 contractLoaded=false，发送时拦截 */ }
    // 契约变化（或首次取到）后重建编排器，保证 system 前缀逐字节稳定以命中上下文缓存
    const zh = String(document.documentElement.lang || 'zh').toLowerCase().startsWith('zh');
    const { buildSystemPrompt, toolNamesFromContract } = await import('./ai-rules.js');
    this.contractLoaded = toolNamesFromContract(this.contract).length > 0;
    this.systemPrompt = buildSystemPrompt({ locale: document.documentElement.lang || 'zh-CN', contract: this.contract });
    if (this.orch) {
      this.orch.systemPrompt = this.systemPrompt;
      this.orch.zh = zh;
    }
    return this.contractLoaded;
  }

  getOrchestrator() {
    if (!this.orch) {
      const zh = String(document.documentElement.lang || 'zh').toLowerCase().startsWith('zh');
      this.orch = new AiOrchestrator({
        provider: this.provider,
        exec: this.exec,
        systemPrompt: this.systemPrompt || '',
        zh,
        scene: () => `项目「${state.project.name}」，现有对象 ${state.project.objects.length} 个`,
        onEvent: (ev, data) => this.onEvent(ev, data),
      });
    }
    return this.orch;
  }

  /* ---------- 附件（上传 / 粘贴 / 拖入 → 随消息发出的内容块） ---------- */
  /** 📎 打开系统文件选择器（可多选） */
  pickFiles() {
    if (!this.built || this.isBusy()) return;
    this.el.file.value = '';
    this.el.file.click();
  }

  /** 粘贴：只接管"剪贴板里有文件"的情况（截图、复制的图片文件）；
   *  纯文字粘贴仍交给 textarea 默认行为（用户可能只是想粘一段手记）。 */
  onPaste(e) {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...(dt.files || [])];
    if (!files.length) {
      for (const it of [...(dt.items || [])]) {
        if (!it || it.kind !== 'file') continue;
        const f = it.getAsFile && it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault(); // 有附件：别让浏览器把文件名/位图当文本塞进输入框
    this.addFiles(files);
  }

  /** 依次读取文件（图片压缩、文本截断），逐条按护栏校验后加入待发送列表；
   *  被拒的文件只在输入区上方列一行原因，不打断对话流。 */
  async addFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length || this.isBusy()) return;
    const warn = [];
    for (const f of files) {
      if (this.atts.length >= ATTACH_LIMITS.maxFiles) { warn.push({ code: 'tooMany' }); break; }
      const r = await prepareAttachment(f);
      if (!r.ok) { warn.push({ code: r.code, name: f.name || '' }); continue; }
      if (attachmentChars([...this.atts, r.att]) > ATTACH_LIMITS.maxPayloadChars) { warn.push({ code: 'payloadBig' }); continue; }
      r.att.id = 'att' + (++this.attSeq);
      this.atts.push(r.att);
    }
    this.attWarn = warn;
    this.renderAtts();
    this.autoGrow(); // 附件条占高后输入框位置变化，避免面板底部抖动
  }

  removeAtt(id) {
    this.atts = this.atts.filter(a => a.id !== id);
    this.attWarn = [];
    this.renderAtts();
    this.autoGrow();
  }

  clearAtts() {
    this.atts = [];
    this.attWarn = [];
    this.renderAtts();
  }

  attWarnText(w) {
    const map = {
      tooMany: 'aip.attach.err.tooMany', type: 'aip.attach.err.type', imageBig: 'aip.attach.err.imageBig',
      textBig: 'aip.attach.err.textBig', payloadBig: 'aip.attach.err.payloadBig', read: 'aip.attach.err.read',
    };
    const size = w.code === 'imageBig' ? ATTACH_LIMITS.maxImageBytes
      : w.code === 'payloadBig' ? ATTACH_LIMITS.maxPayloadChars : ATTACH_LIMITS.maxTextReadBytes;
    return t(map[w.code] || map.read, { name: w.name || '', n: ATTACH_LIMITS.maxFiles, size: formatBytes(size) });
  }

  /** 重绘附件条：缩略图/文件名/体积/移除按钮 + 图片视觉提示 + 拒收原因；无附件且无原因时整块隐藏 */
  renderAtts() {
    if (!this.built) return;
    const e = this.el, warn = this.attWarn || [];
    e.attList.textContent = '';
    for (const a of this.atts) {
      const li = el('li', 'aip-att');
      if (a.kind === 'image') {
        const im = el('img', 'aip-att-thumb');
        im.src = a.thumb || a.url;
        im.alt = '';
        li.appendChild(im);
      } else {
        const ic = el('span', 'aip-att-ic');
        ic.innerHTML = icon('file');
        li.appendChild(ic);
      }
      const nm = el('span', 'aip-att-name', a.name);
      nm.title = a.name;
      li.appendChild(nm);
      li.appendChild(el('span', 'aip-att-size', a.truncated ? t('aip.attach.truncated') : formatBytes(a.size)));
      const x = el('button', 'aip-att-x', '✕');
      x.type = 'button';
      x.title = t('aip.attach.remove') + '：' + a.name;
      x.addEventListener('click', () => this.removeAtt(a.id));
      li.appendChild(x);
      e.attList.appendChild(li);
    }
    const hasImg = this.atts.some(a => a.kind === 'image');
    e.attHint.hidden = !hasImg;
    e.attBox.hidden = !this.atts.length && !warn.length;
    e.attWarn.hidden = !warn.length;
    e.attWarn.textContent = warn.map(w => this.attWarnText(w)).join(' ');
    // 📎 按钮：有附件时点亮（与设置齿轮的按下态同一强调色），tooltip 常驻说明支持的来源
    e.attBtn.classList.toggle('active', this.atts.length > 0);
    e.attBtn.title = t('aip.attach.title');
    e.attBtn.setAttribute('aria-label', this.atts.length
      ? t('aip.attach.title') + ' (' + t('aip.attach.count', { n: this.atts.length }) + ')'
      : t('aip.attach.title'));
  }

  /* ---------- 对话 ---------- */
  async sendCurrent() {
    const text = this.el.input.value.trim();
    if ((!text && !this.atts.length) || this.isBusy()) return; // 只有附件也能发（"照这张图建机房"）
    // 契约没加载 → 模型不知道任何合法指令名（只会编 ac.create 这类名字）：先重试一次，仍失败则拦截发送，
    // 输入内容原样保留（用户修好页面/网络后直接重发即可）。
    if (!this.contractLoaded && !(await this.loadContract())) {
      this.appendNotice({ kind: 'contract.missing' });
      return;
    }
    const atts = this.atts.slice();
    this.el.input.value = '';
    this.clearAtts(); // 立刻清空：附件已进入本轮消息，避免下次误重发
    this.autoGrow();
    this.el.welcome.hidden = true;
    // 新消息发出后，上一轮未确认的破坏性操作作废（避免之后误点确认执行旧指令）
    this.el.msgs.querySelectorAll('.aip-confirm:not(.aip-confirm-done)').forEach(card => {
      card.classList.add('aip-confirm-done');
      card.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const h = card.querySelector('.aip-confirm-head');
      if (h) h.textContent = t('aip.confirm.done');
    });
    this.getOrchestrator();
    this.orch.cancelPlan();
    setAiPending(false);
    this.setBusy(true);
    await this.orch.send(text, atts);
  }

  /** 停止：编排层会中断在途请求（abort）并补发 done，指示器随 done 收起 */
  stop() { if (this.orch) this.orch.stop(); }

  /** 输入框随内容长高（通体输入框：固定 2 行高起，最多 132px 后内部滚动）。
   * 文字**垂直居中**：内容比最小高度矮（空值/单行）时，把差额的一半补进上内边距，
   * 下内边距恒为 5px——单行文字正好落在 2 行高输入框的中线上，与内嵌圆形按钮同轴。
   * 测量前先把高度归零：否则 rows=2 会把 scrollHeight 顶到 2 行高，量不出真实内容高度。 */
  autoGrow() {
    if (!isAiVisible() || this.el.root.hidden) return;
    const ta = this.el.input;
    const PAD = 5;   // 上下内边距，与 CSS .aip-input 的 padding: 5px 0 保持一致
    const MAX = 132; // 约 6 行封顶，之后框内滚动
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 19.5;
    const min = lh * 2 + PAD * 2; // 2 行最小高度：空值时占位提示两行完整可见，输入时不跳高
    ta.style.paddingTop = PAD + 'px'; // 先复位补白，再量真实内容（含占位提示的换行高度）
    ta.style.height = '0px';
    const content = ta.scrollHeight;
    const box = Math.min(Math.max(content, min), MAX);
    ta.style.height = box + 'px';
    ta.style.paddingTop = (PAD + Math.max(0, box - content) / 2) + 'px';
    ta.style.overflowY = content > MAX ? 'auto' : 'hidden';
  }

  isBusy() { return !!(this.orch && this.orch.busy); }

  setBusy(on) {
    this.el.send.disabled = on;
    this.el.input.disabled = on;
    this.el.attBtn.disabled = on;   // 忙时不许再挂附件（本轮参数已定）
    this.el.stop.hidden = !on;
    this.el.head.classList.toggle('busy', on); // 页头右侧旋转圈：长对话滚上去也能看到「在忙」
    notifyPanelBusy('ai', on);                 // 顶栏 AI 按钮持续呼吸（agent.js 订阅）
    if (on) this.showThinking(true, 'model');
    else this.showThinking(false);
  }

  /* ---------- 「正在处理」指示器（三点跳动 / 旋转圈 + 阶段文案 + 等待秒数 + 停止） ----------
   * 状态来源：setBusy（开始/结束）+ thinking 事件（每轮模型往返/自修）+ step.start（执行指令），
   * 面板不自己推算阶段——避免出现「请求已结束但还在闪」的假提示。 */
  showThinking(on, phase = 'model', data = {}) {
    if (!on) { this.hideThinking(); return; }
    if (!this.thinkingEl) this.buildThinking();
    this.thinkPhase = phase;
    this.thinkData = data;
    if (phase !== 'exec') this.thinkSince = Date.now(); // 每次等待重新计时（exec 瞬时，不显秒数）
    this.el.msgs.appendChild(this.thinkingEl); // 已在末尾时 appendChild 是空操作（不移动）
    this.renderThink();
    this.tickThinkWait();
    clearInterval(this.thinkTimer);
    this.thinkTimer = phase === 'exec' ? null : setInterval(() => this.tickThinkWait(), 1000);
    this.scroll();
  }

  /** 构建指示器 DOM（只建一次；内容由 renderThink 按阶段写） */
  buildThinking() {
    const box = el('div', 'aip-msg aip-thinking');
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    const mark = el('span', 'aip-mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = '<span class="aip-dots"><i></i><i></i><i></i></span><span class="aip-spin"></span>';
    this.thinkText = el('span', 'aip-think-text');
    this.thinkWait = el('span', 'aip-think-wait');
    this.thinkWait.setAttribute('aria-live', 'off'); // 秒数每秒变一次，不重复报读
    this.thinkStop = el('button', 'aip-think-stop', t('aip.stop'));
    this.thinkStop.type = 'button';
    this.thinkStop.addEventListener('click', () => this.stop());
    box.append(mark, this.thinkText, this.thinkWait, this.thinkStop);
    this.thinkingEl = box;
  }

  /** 按当前阶段写文案与样式（等待模型 / 纠错重试 / 正在执行第 i/N 条） */
  renderThink() {
    if (!this.thinkingEl) return;
    const p = this.thinkPhase, d = this.thinkData || {};
    const exec = p === 'exec';
    this.thinkingEl.classList.toggle('phase-exec', exec);
    this.thinkText.textContent = exec
      ? t('aip.thinking.exec', { i: (+d.i || 0) + 1, n: +d.n || 0, tool: d.tool || '' })
      : (d.fix ? t('aip.thinking.fix') : t('aip.thinking'));
  }

  /** 等待秒数：等待模型/自修时显示（≥3 秒才出现，短请求不闪数字） */
  tickThinkWait() {
    if (!this.thinkWait) return;
    if (this.thinkPhase === 'exec') { this.thinkWait.textContent = ''; return; }
    const s = Math.floor((Date.now() - this.thinkSince) / 1000);
    this.thinkWait.textContent = s >= 3 ? t('aip.thinking.wait', { s }) : '';
  }

  hideThinking() {
    clearInterval(this.thinkTimer);
    this.thinkTimer = null;
    this.thinkPhase = '';
    this.thinkData = null;
    if (this.thinkingEl) { this.thinkingEl.remove(); this.thinkingEl = null; }
    this.thinkText = this.thinkWait = this.thinkStop = null; // 连同断开的引用一起清掉，语言切换不再去改已移除的节点
  }

  /* ---------- 事件渲染 ---------- */
  onEvent(ev, data) {
    if (ev === 'assistant' || ev === 'done' || ev === 'error') this.showThinking(false);
    if (ev === 'thinking') this.showThinking(true, data.phase || 'model', data); // 每轮模型往返/回灌自修
    if (ev === 'step.start') this.showThinking(true, 'exec', data);              // 执行指令：显示「正在执行第 i/N 条」
    if (ev === 'user') this.appendUserMsg(data);
    if (ev === 'assistant') {
      const parts = [];
      if (data.reply) parts.push(data.reply);
      if (!data.calls.length) parts.push(t('aip.noCalls'));
      this.appendMsg('aip-msg aip-ai', parts.join('\n'));
    }
    if (ev === 'confirm') this.appendConfirmCard(data);
    if (ev === 'steps') this.appendBatch(data);
    if (ev === 'notice') this.appendNotice(data);
    if (ev === 'error') this.appendMsg('aip-msg aip-err', this.errText(data));
    if (ev === 'done') this.setBusy(false);
  }

  errText(data) {
    const key = 'aip.err.' + (data.code || 'UPSTREAM');
    const s = t(key, { msg: data.message || '', s: 120 });
    return s === key ? (data.message || data.code || '') : s;
  }

  appendMsg(cls, text) {
    const d = el('div', cls, String(text == null ? '' : text));
    this.el.msgs.appendChild(d);
    this.scroll();
    return d;
  }

  /** 用户气泡：附件缩略图/文件名在上，正文在下（缩略图用小 dataURL，完整 base64 不进 DOM） */
  appendUserMsg(data) {
    const box = el('div', 'aip-msg aip-user');
    const atts = Array.isArray(data.attachments) ? data.attachments : [];
    if (atts.length) {
      const row = el('div', 'aip-user-atts');
      for (const a of atts) {
        if (a.kind === 'image' && a.thumb) {
          const im = el('img');
          im.src = a.thumb;
          im.alt = a.name || '';
          im.title = a.name || '';
          row.appendChild(im);
        } else {
          row.appendChild(el('span', 'aip-user-file', '📄 ' + (a.name || '')));
        }
      }
      box.appendChild(row);
    }
    if (data.text) box.appendChild(el('span', 'aip-user-text', data.text));
    this.el.msgs.appendChild(box);
    this.scroll();
    return box;
  }

  appendNotice(data) {
    const map = { 'limit.rounds': 'aip.limit.rounds', 'limit.objects': 'aip.limit.objects', 'attach.noVision': 'aip.attach.noVision', 'contract.missing': 'aip.msg.contract' };
    if (data.kind === 'retry.json') { this.appendMsg('aip-msg aip-note', t('aip.err.PARSE') + '，' + t('aip.confirm.retry')); return; }
    this.appendMsg('aip-msg aip-note', t(map[data.kind] || data.kind, { n: data.n }));
  }

  scroll() {
    this.scrollPending = !isAiVisible();
    if (!this.scrollPending) this.el.msgs.scrollTop = this.el.msgs.scrollHeight;
  }

  /* ---------- 破坏性操作确认条 ---------- */
  /** 仅当模型把调用标为 destructive（清空项目/批量删除/覆盖打开）时才出现：
   *  一行警示 + 调用清单 + 「确认执行 / 取消」两个按钮；其余指令一行不拦。 */
  appendConfirmCard(plan) {
    setAiPending(true);
    const card = el('div', 'aip-confirm');
    const head = el('div', 'aip-confirm-head', t('aip.confirm.head'));
    card.appendChild(head);
    card.appendChild(el('div', 'aip-confirm-hint', t('aip.confirm.hint')));

    const list = el('ul', 'aip-confirm-list');
    plan.calls.forEach((c, i) => {
      const li = el('li', c.destructive ? 'aip-danger' : '');
      li.appendChild(el('span', 'aip-step-text', (plan.plan[i] || c.why || c.tool) + ' '));
      li.appendChild(el('code', 'aip-tool', c.tool));
      if (c.destructive) li.appendChild(el('span', 'aip-badge', t('aip.confirm.badge')));
      list.appendChild(li);
    });
    card.appendChild(list);

    const actions = el('div', 'aip-confirm-actions');
    const runBtn = el('button', 'wz-primary aip-confirm-run', t('aip.confirm.run'));
    const cancelBtn = el('button', 'aip-confirm-cancel', t('aip.confirm.cancel'));
    actions.appendChild(runBtn); actions.appendChild(cancelBtn);
    card.appendChild(actions);

    let handled = false;
    const close = done => {
      setAiPending(false);
      handled = true;
      card.classList.add('aip-confirm-done');
      runBtn.disabled = true; cancelBtn.disabled = true;
      head.textContent = done;
    };
    runBtn.addEventListener('click', async () => {
      if (handled) return;
      close(t('aip.confirm.done'));
      this.setBusy(true);
      await this.getOrchestrator().confirmPlan(plan.calls);
    });
    cancelBtn.addEventListener('click', () => {
      if (handled) return;
      close(t('aip.confirm.done'));
      if (this.orch) this.orch.cancelPlan();
    });

    this.el.msgs.appendChild(card);
    this.scroll();
  }

  /* ---------- 步骤日志 / 撤销本轮 ---------- */
  appendBatch(data) {
    const det = document.createElement('details');
    det.className = 'aip-batch';
    det.open = data.rows.some(r => !r.ok);
    const sum = document.createElement('summary');
    sum.textContent = t('aip.batch.title', { n: data.rows.length });
    det.appendChild(sum);
    for (const r of data.rows) {
      const row = el('div', 'aip-step-row ' + (r.ok ? 'ok' : 'fail'));
      row.appendChild(el('span', 'aip-step-ic', r.ok ? '✓' : '✗'));
      row.appendChild(el('code', 'aip-tool', r.tool));
      row.appendChild(el('span', 'aip-step-text', r.ok ? (r.hint || '') : (r.message || r.code || '')));
      det.appendChild(row);
    }
    this.el.msgs.appendChild(det);
    this.undoSteps = data.mutating || 0;
    this.el.undo.hidden = this.undoSteps <= 0;
    this.el.foot.hidden = this.undoSteps <= 0;
    this.scroll();
  }

  undoLastRound() {
    if (!this.undoSteps) { this.appendMsg('aip-msg aip-note', t('aip.undo.none')); return; }
    const n = this.undoRound(this.undoSteps);
    this.undoSteps = 0;
    this.el.undo.hidden = true;
    this.el.foot.hidden = true;
    this.appendMsg('aip-msg aip-note', n ? t('aip.undo.done', { n }) : t('aip.undo.none'));
  }
}

/** 创建面板（agent.js 在启动时调用一次，点击顶栏 AI 按钮时懒构建 DOM） */
export function initAiPanel(deps) {
  const panel = new AiPanel(deps);
  registerAiView({ setVisible: (on, focus) => panel.setVisible(on, focus) });
  onLocaleChange(() => { if (panel.built) { panel.syncTexts(); panel.loadContract(); } });
  return {
    open: () => panel.open(),
    close: () => panel.close(),
    toggle: () => panel.toggle(),
    isOpen: () => isAiVisible(),
    _panel: panel, // 测试用
  };
}
