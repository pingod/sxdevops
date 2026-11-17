/**
 * AI 编排循环 —— 拼消息 → 调模型 → 解析 JSON 计划 → 逐条 exec() → 结果/错误回灌 → 循环
 *
 * 本地只做三件事：转发消息、把模型输出的计划转成 exec() 调用（薄胶水）、把结果回灌
 * （结构化结果原样回传：坐标/越界/重叠都进回灌，模型才能试算落位与自检）。
 * 业务判断（换算/消歧/试算/取舍/破坏性标注/何时停止）全在提示词里（见 ai-rules.js）。
 * 这里只有进程级熔断（单轮最多 N 次模型往返、单轮新增对象上限、可随时停止，§7）。
 *
 * 执行方式：**只有自动执行**（无计划模式）——模型给的 calls 立即逐条下发；
 * 例外：计划里含 destructive 标记的不可逆调用（清空项目/批量删除/覆盖打开）时，
 * 挂起整条计划等用户在面板里点一次确认（`confirmPlan`），其余情况不打断。
 * 回调备注：`onEvent('confirm', plan)` 即该暂停通知；`onEvent('thinking', {phase, fix})`
 * 为进度提示（每轮模型往返都发，`fix:true` 表示上一轮 JSON 不合规后的纠错重试），
 * 面板据此显示「正在思考… / 正在纠错重试…」动效；
 * 执行指令期由 `step.start` 事件驱动同一提示（文案换为「正在执行第 i/N 条」）。
 *
 * 附件（输入框上传/粘贴的图片与文本文件，见 ai-attach.js）：本条用户消息的
 * content 可能是多模态内容块数组；**本轮进行中图片一直随上下文发送**（模型可反复看），
 * 本轮结束（done / 停止 / 出错）时由 releaseImages() 把图片块换成一行说明——
 * 否则 base64 会随每一轮往返重复上传，而后续轮次真正需要看的是新的画布状态。
 * 模型不支持视觉时由 provider 自动降级并置 noVision，这里只负责发一条 notice 提示用户。
 */

import { AiError } from './ai-provider.js';
import { buildUserContent, hasImageParts, stripImageParts, IMAGE_NOTE } from './ai-attach.js';

export const LIMITS = {
  rounds: 40,          // 单个用户请求内最多模型往返次数
  objects: 2000,       // 单轮新增对象上限（防跑飞）
  callsPerRound: 40,   // 单次计划最多执行条数（提示词要求 ≤8）
  history: 60,         // 会话历史上限（条，超出丢弃最早的非 system 消息）
  fbItems: 200,        // 单条回灌里列表字段（objects 等）最多条数，超出截断并标注 truncated
  fbChars: 24000,      // 单条回灌载荷字符上限（体积护栏，防止将来新指令返回巨型结果）
};

/** 执行成功 = 撤销栈恰好多一步的指令（用于「撤销本轮」步数统计）。
 *  与返回 added 无关：obj.delete / obj.update / obj.move 等返回 added:[]，但同样 pushUndo 一次，
 *  漏计会让「撤销本轮」只回滚一部分（删除的对象永远撤不回来）。
 *  project.undo/redo 是弹栈不是压栈、project.new/open 直接清空撤销栈——这四类不计入。 */
const UNDO_STEP = new Set([
  'room.rect', 'wall.add', 'pod.create', 'row.create', 'obj.add', 'opening.add',
  'obj.update', 'obj.updateBatch', 'obj.move', 'obj.delete', 'obj.rotate',
]);

/** 计划里是否有 destructive 标记的不可逆调用（触发一次确认） */
function hasDestructive(calls) { return calls.some(c => c && c.destructive === true); }

/** 回灌时丢弃的结果字段：截图 dataURL / 导出文件正文体积大、模型用不上（其余结构化字段一律原样回传） */
const FB_DROP = new Set(['shot', 'content', 'dataURL']);
/** 已按固定字段回灌的键（避免重复占上下文）。added 不在此列：它走 payload 通道，
 *  与 objects 一样受 fbItems/fbChars 护栏（pod.create 单次可返 300+ 条 brief，绕开护栏会冲破体积上限） */
const FB_KNOWN = new Set(['hint', 'warnings', 'stats', 'tool', 'ok', 'code', 'message']);

/**
 * 结构化结果 → 回灌载荷：坐标、重叠数、越界数等原样交给模型（模型靠它试算与自检，本地不做业务取舍）。
 * 只做体积护栏：列表字段截断到 limits.fbItems 条，单条载荷超过 limits.fbChars 时从最大字段开始截；
 * 截断时回传 truncated 字段名，模型据此改用更窄的查询（如按 type/name 过滤）。
 */
function feedbackPayload(result, limits) {
  const out = {}, truncated = [];
  for (const [k, v] of Object.entries(result)) {
    if (FB_DROP.has(k) || FB_KNOWN.has(k)) continue;
    if (Array.isArray(v) && v.length > limits.fbItems) { out[k] = v.slice(0, limits.fbItems); truncated.push(k); }
    else out[k] = v;
  }
  for (let guard = 0; guard < 8 && JSON.stringify(out).length > limits.fbChars; guard++) {
    const keys = Object.keys(out).filter(k => k !== 'truncated');
    if (!keys.length) break;
    const k = keys.sort((a, b) => JSON.stringify(out[b]).length - JSON.stringify(out[a]).length)[0];
    if (Array.isArray(out[k]) && out[k].length > 1) out[k] = out[k].slice(0, Math.ceil(out[k].length / 2));
    else delete out[k];
    if (!truncated.includes(k)) truncated.push(k);
  }
  if (truncated.length) out.truncated = truncated.join(',');
  return out;
}

const FIX_HEADER_ZH = '你上一条回复不是合法的 JSON 计划（本地拒绝原因：';
const FIX_HEADER_EN = 'Your last reply was not a valid JSON plan (local rejection reason: ';
const FIX_TAIL_ZH = '）。请严格按协议重新输出**一个** JSON 对象：{"reply":"…","plan":[…],"calls":[…]}，不要 markdown 代码块、不要任何额外文字。';
const FIX_TAIL_EN = '). Reply again with exactly ONE JSON object following the protocol: {"reply":"…","plan":[…],"calls":[…]} — no markdown fence, no extra text.';
const FB_HEADER_ZH = '工具执行结果回灌（本地已按顺序执行，结果如下 JSON）：\n';
const FB_TAIL_ZH = '\n继续：目标已达成则用 reply 汇报并把 calls 置空；有失败项按 code 修正参数或方案后重试（禁止原样重发）；仍需继续的动作放进本次回复的 calls（≤8 条）。';
const FB_HEADER_EN = 'Tool execution results fed back (executed locally in order, JSON below):\n';
const FB_TAIL_EN = '\nContinue: if the goal is met, report in reply and leave calls empty; for failed calls fix parameters or the plan and retry (never resend unchanged); put remaining actions into this reply\'s calls (max 8).';

/**
 * 解析模型回复为计划对象；不符合协议时抛错（由编排循环回灌错误让模型自修，本地不做容错分支）。
 * @returns {{reply:string, plan:string[], calls:{tool:string,args:object,why:string,destructive:boolean}[]}}
 */
export function parsePlan(text) {
  let s = String(text == null ? '' : text).trim();
  if (!s) throw new Error('回复为空');
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim(); // 容忍模型加上代码块
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('未找到 JSON 对象');
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); }
  catch (e) { throw new Error('JSON 解析失败：' + e.message); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('顶层必须是 JSON 对象');
  const calls = [];
  const raw = Array.isArray(obj.calls) ? obj.calls : [];
  for (const c of raw) {
    if (!c || typeof c !== 'object' || typeof c.tool !== 'string' || !c.tool.trim()) throw new Error('calls 元素缺少 tool 字段');
    calls.push({
      tool: c.tool.trim(),
      args: (c.args && typeof c.args === 'object' && !Array.isArray(c.args)) ? c.args : {},
      why: c.why ? String(c.why) : '',
      destructive: c.destructive === true,
    });
  }
  return {
    reply: obj.reply == null ? '' : String(obj.reply),
    plan: Array.isArray(obj.plan) ? obj.plan.map(String) : [],
    calls,
  };
}

export class AiOrchestrator {
  /**
   * @param {object} o
   * @param {import('./ai-provider.js').AiProvider} o.provider
   * @param {(cmd:{tool:string,args:object}) => Promise<object>} o.exec 页内指令执行器（agent.js）
   * @param {string} o.systemPrompt 提示词（含契约原文）
   * @param {() => string} [o.scene] 每次发送时附上的一行画布现状（保持提示词前缀稳定以命中缓存）
   * @param {(event:string, data:object) => void} [o.onEvent] 事件回调（面板渲染）
   * @param {boolean} [o.zh] 回灌文案用中文（否则英文）
   * @param {object} [o.limits]
   */
  constructor({ provider, exec, systemPrompt, scene, onEvent, zh = true, limits = {} }) {
    this.provider = provider;
    this.exec = exec;
    this.systemPrompt = systemPrompt || '';
    this.scene = scene;
    this.onEvent = onEvent || (() => {});
    this.zh = zh !== false;
    this.limits = { ...LIMITS, ...limits };
    this.history = [];
    this.pending = null;               // 已挂起、等用户点一次确认的破坏性计划
    this.rounds = 0;
    this.stopped = false;
    this.busy = false;
    this.abort = null;
    this.retryFix = false;             // 上一轮 JSON 不合规 → 本轮为「纠错重试」（面板文案据此切换）
    this.visionNotified = false;       // 本轮是否已提示过「模型不支持图片」（每轮最多提示一次）
  }

  emit(event, data) { try { this.onEvent(event, data || {}); } catch (e) { /* 渲染失败不影响循环 */ } }

  /** 停止当前请求（中断在途的模型调用并结束循环） */
  stop() { this.stopped = true; if (this.abort) this.abort.abort(); }

  /** 清空会话（保留 system 提示词在每次调用时重新拼） */
  reset() { this.history = []; this.pending = null; this.rounds = 0; this.retryFix = false; }

  /** 取消挂起的破坏性计划（用户点「取消」或发来新消息）。
   *  历史里已留有该计划的 assistant 消息，必须补一条「全部未执行」的回灌——
   *  否则模型会误以为那些破坏性调用已生效（如以为项目已被清空），在错误前提上继续规划。 */
  cancelPlan() {
    if (!this.pending) return;
    this.pending = null;
    this.history.push({
      role: 'user',
      content: this.zh
        ? '本地提示：上一条含破坏性调用的计划已被用户取消，其中所有 calls 均未执行，画布保持原样。请按画布实际状态重新规划，不要假设那些调用已生效。'
        : 'Local notice: the previous plan containing destructive calls was cancelled by the user. None of its calls were executed and the canvas is unchanged. Re-plan from the actual canvas state; do not assume any of those calls took effect.',
    });
  }

  historyCount() { return this.history.length; }

  messages() {
    const h = this.history.length > this.limits.history ? this.history.slice(-this.limits.history) : this.history;
    return [{ role: 'system', content: this.systemPrompt }, ...h];
  }

  /** 发送一条用户消息并开始循环（自动执行；仅破坏性计划会挂起等一次确认）
   *  @param {string} text 用户输入正文
   *  @param {Array<object>} [atts] 附件（ai-attach.js 的附件对象；图片进多模态内容块数组，文本拼进正文） */
  async send(text, atts = []) {
    if (this.busy) return;
    const scene = this.scene ? String(this.scene() || '').trim() : '';
    const head = scene ? `[画布现状] ${scene}\n` : '';
    this.history.push({ role: 'user', content: buildUserContent(head + text, atts, this.zh) });
    // 面板气泡只用轻量元信息 + 小缩略图（完整 base64 只在 messages 里，不进 DOM 事件）
    this.emit('user', {
      text,
      attachments: (atts || []).map(a => ({ kind: a.kind, name: a.name, size: a.size, thumb: a.thumb || '' })),
    });
    this.rounds = 0;
    this.stopped = false;
    this.visionNotified = false;
    return this.advance();
  }

  /** 本轮结束（done / 停止 / 出错）：把历史里的图片块换成一行说明。
   *  目的：base64 体积大且会被每一轮往返重复上传；后续问题应以画布状态与文本为主，
   *  真需要再看图时可让用户重新粘贴（占位说明会让模型知道上一轮确实收到过图）。 */
  releaseImages() {
    if (!hasImageParts(this.history)) return;
    this.history = stripImageParts(this.history, this.zh ? IMAGE_NOTE.zh : IMAGE_NOTE.en);
  }

  /** 用户在确认条上点了确认后调用：执行 → 回灌 → 继续循环 */
  async confirmPlan(calls) {
    if (this.busy || !this.pending) return;
    this.pending = null;
    const stop = await this.runCalls(calls);
    if (stop) { this.emit('done', { reason: stop }); return; }
    return this.advance();
  }

  /** 循环主体：一次模型往返 → 计划/回复/执行（破坏性计划挂起）。
   *  busy 标记在 finally 里先落地，再发 confirm/done 事件——面板收到事件时不会
   *  因 busy=true 而拒绝「确认执行/发送」操作（避免竞态）。 */
  async advance() {
    this.busy = true;
    let planReady = false, reason = null;
    try {
      for (;;) {
        if (this.stopped) { reason = 'stopped'; return; }
        if (this.rounds >= this.limits.rounds) {
          this.emit('notice', { kind: 'limit.rounds', n: this.limits.rounds });
          reason = 'limit.rounds';
          return;
        }
        this.rounds++;
        this.abort = new AbortController();
        // 每轮模型往返都先通知面板（多轮时第 2..N 轮同样要有「正在思考」提示，
        // 而不仅靠面板在发送时一次性开启）——面板只渲染，不自己猜状态。
        // fix=true 时本轮是上一轮 JSON 不合规后的重试，文案换为「正在纠错重试…」：
        // 只能放在这里，若在发现不合规的当轮立即切换，会在同一个 tick 里被下一轮覆盖（用户根本看不到）。
        this.emit('thinking', { phase: 'model', round: this.rounds, fix: this.retryFix });
        this.retryFix = false;
        let res;
        try {
          res = await this.provider.chat(this.messages(), { signal: this.abort.signal });
        } catch (e) {
          if (this.stopped || (e instanceof AiError && e.code === 'STOPPED')) { reason = 'stopped'; return; }
          this.emit('error', { code: (e && e.code) || 'UPSTREAM', message: (e && e.message) || String(e) });
          reason = 'error';
          return;
        } finally { this.abort = null; }
        // 模型不支持图片：provider 已自动去掉图片重发（本轮仍算成功），这里提示一次用户换模型
        if (this.provider.noVision && !this.visionNotified) {
          this.visionNotified = true;
          this.emit('notice', { kind: 'attach.noVision' });
        }
        if (this.stopped) { reason = 'stopped'; return; }

        const raw = String(res.content == null ? '' : res.content).trim();
        let plan;
        try { plan = parsePlan(raw); }
        catch (e) {
          // 协议不合规：把错误原文与协议片段回灌，让模型自己修（不在本地写容错分支）
          this.history.push({ role: 'assistant', content: raw.slice(0, 4000) });
          this.history.push({
            role: 'user',
            content: this.zh
              ? FIX_HEADER_ZH + e.message + FIX_TAIL_ZH
              : FIX_HEADER_EN + e.message + FIX_TAIL_EN,
          });
          this.emit('notice', { kind: 'retry.json', message: e.message });
          this.retryFix = true; // 下一轮模型往返的提示文案 = 正在纠错重试（在此处切会被下一轮立刻覆盖）
          continue;
        }

        this.history.push({ role: 'assistant', content: raw });
        this.emit('assistant', { ...plan, usage: res.usage, model: res.model });

        if (!plan.calls.length) { reason = 'reply'; return; }
        // 不可逆操作（清空项目/批量删除/覆盖打开）：整条计划挂起，等用户点一次确认
        if (hasDestructive(plan.calls)) { this.pending = plan; planReady = true; return; }

        const stop = await this.runCalls(plan.calls);
        if (stop) { reason = stop; return; }
      }
    } finally {
      this.busy = false;
      if (planReady) {
        this.emit('confirm', this.pending);
        this.emit('done', { reason: 'confirm' }); // 已挂起等确认：面板解除 busy（输入框可继续用）
      } else {
        // 本轮真的结束了：释放历史里的图片块（挂起等确认的情况不释放——用户点确认后还要接着用这轮上下文）
        this.releaseImages();
        if (reason) this.emit('done', { reason });
      }
    }
  }

  /**
   * 顺序执行计划里的调用，逐条 exec，收集结果并回灌给模型。
   * 回灌内容 = 固定字段（tool/ok/hint|code+message/warnings/stats）+ 结构化结果原样透传
   * （added、query.objects 的 objects、obj.get 的 object、query.status 的 overlaps/outOfRoom…，一体受体积护栏）。
   * @returns {Promise<string|null>} 触发熔断时返回原因（'limit.objects' 等），正常返回 null
   */
  async runCalls(calls) {
    const list = calls.slice(0, this.limits.callsPerRound);
    const rows = [];
    let totalBefore = null, addedCount = 0, lastStats = null, mutating = 0, failed = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (this.stopped) break;
      this.emit('step.start', { i, n: list.length, tool: c.tool });
      let r;
      try { r = await this.exec({ tool: c.tool, args: c.args || {} }); }
      catch (e) { r = { ok: false, code: 'EXEC_ERROR', message: (e && e.message) || String(e) }; }
      const result = r && r.result ? r.result : {};
      const addedRaw = Array.isArray(result.added) ? result.added : [];
      const payload = feedbackPayload(result, this.limits); // 结构化结果（含坐标/越界/重叠 + added 截断版）：只进回灌，不进面板事件
      const added = Array.isArray(payload.added) ? payload.added : [];
      const row = {
        tool: c.tool, ok: !!(r && r.ok),
        code: r && r.code, message: r && r.message,
        hint: result.hint || '',
        warnings: Array.isArray(result.warnings) ? result.warnings : null,
        added,
      };
      rows.push({ ...row, payload });
      if (row.ok) { if (UNDO_STEP.has(c.tool)) mutating++; } else failed++;
      addedCount += addedRaw.length; // 新增对象熔断统计用原始条数（回灌截断不能削弱防跑飞）
      if (result.stats) {
        lastStats = result.stats;
        if (totalBefore == null) totalBefore = result.stats.total - addedCount;
      }
      this.emit('step.done', { i, n: list.length, ...row });
    }
    const newObjects = lastStats && totalBefore != null ? Math.max(0, lastStats.total - totalBefore) : 0;

    const fb = {
      results: rows.map(r => ({
        tool: r.tool, ok: r.ok,
        ...(r.ok ? { hint: r.hint } : { code: r.code || 'EXEC_ERROR', message: r.message || '' }),
        ...(r.warnings ? { warnings: r.warnings } : {}),
        ...r.payload, // 结构化结果原样给模型：added/objects/object/overlaps/outOfRoom/truncated…（added 与 objects 同受体积护栏）
      })),
      ...(lastStats ? { stats: { total: lastStats.total, byType: lastStats.byType } } : {}),
    };
    this.history.push({
      role: 'user',
      content: (this.zh ? FB_HEADER_ZH : FB_HEADER_EN) + JSON.stringify(fb) + (this.zh ? FB_TAIL_ZH : FB_TAIL_EN),
    });
    this.emit('steps', { rows: rows.map(({ payload, ...light }) => light), newObjects, mutating });

    if (this.stopped) return 'stopped';
    if (newObjects > this.limits.objects) {
      this.emit('notice', { kind: 'limit.objects', n: this.limits.objects });
      return 'limit.objects';
    }
    return null;
  }
}
