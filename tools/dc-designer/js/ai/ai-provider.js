/**
 * AI Provider —— OpenAI 兼容 Chat Completions 客户端（零依赖）
 *
 * 配置（API Key / 接口地址 / 模型）**只保存在本机浏览器 localStorage**，服务端不落盘：
 *  - 有本机服务时走无状态转发 POST /api/ai/chat——Key 随请求体带上，服务端仅内存转发
 *    （不写文件、不记日志、不回显），可绕开浏览器 CORS 限制；
 *  - 页面不是由本机服务打开（/api/ai 不可用或本机服务不可达）时，改由浏览器直连第三方
 *    接口，面板顶部显示黄条提示（可能被 CORS 拦截）。
 * 探测本机服务用 GET /api/ai/status（只回 {proxy, timeoutMs}，不含任何凭据信息）。
 *
 * 本地只做网络层的事：超时、429/5xx/网络错误重试 2 次、错误码翻译、用量累计；
 * 不含任何业务判断（见 docs/DeepSeek-文字描述建模-方案.md §7）。
 *
 * 多模态附件的降级：消息里带图片块（user 消息输入框上传/粘贴的图片，见 ai-attach.js）时，
 * 若上游以 400/422 + 图片相关文案拒绝，则判定「该模型不支持视觉」——自动去掉图片块重发一次，
 * 并置 `noVision`（本次会话后续请求同样只发文字），由编排层发 notice 让面板提示用户换模型。
 * 与 jsonMode / noTemp 的自动关闭同一思路：只是网关兼容性兜底，不是业务判断。
 *
 * 测试钩子：若 globalThis.__aiChatMock 是函数，chat() 直接调用它（本地 mock LLM，
 * 不联网、可复现；tests/ai-e2e.cdp.mjs 使用）——mock 拿到的是**未降级**的原始 messages，
 * 测试据此断言图片块确实按多模态格式拼好。
 */

import { hasImageParts, stripImageParts, IMAGE_NOTE } from './ai-attach.js';
import { apiUrl } from '../api-base.js';

export class AiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// 接口路径按应用基路径解析：反代子路径部署（如 /designer/）下自动变为 /designer/api/ai/*
const STATUS_PATH = '/api/ai/status';
const CHAT_PATH = '/api/ai/chat';
const LS_KEY = 'idc2d_ai_key_v1';
const LS_CFG = 'idc2d_ai_cfg_v1';
export const AI_DEFAULT_BASE = 'https://api.deepseek.com';
export const AI_DEFAULT_MODEL = 'deepseek-chat';
const CLIENT_TIMEOUT = 130000;    // 浏览器直连超时（无服务端可参照）
const PROBE_TIMEOUT = 3000;       // 探测本机服务；离线时别拖慢面板首屏
const RETRY_DELAYS = [800, 2000]; // 429/5xx/网络错误重试 2 次

const maskKey = k => (k && k.length > 8 ? k.slice(0, 3) + '****' + k.slice(-4) : (k ? '****' : ''));

function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* 隐私模式 */ } }

/** fetch + 超时 + JSON 解析（不抛业务错误，返回 {status, json, text}） */
async function fetchJson(url, { method = 'GET', body, signal, timeout = CLIENT_TIMEOUT } = {}) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  const timer = setTimeout(() => ctl.abort(), timeout);
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    const r = await fetch(url, {
      method, cache: 'no-store', signal: ctl.signal,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body } : {}),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 响应 */ }
    return { status: r.status, json, text };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const isAbort = e => e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');

export class AiProvider {
  constructor() {
    this.cfg = { configured: false, keyMask: '', baseUrl: AI_DEFAULT_BASE, model: AI_DEFAULT_MODEL, source: 'none' };
    this.direct = false;      // 本机服务不可用：浏览器直连第三方接口
    this.statusUrl = apiUrl(STATUS_PATH); // 面板黄条展示实际探测地址，便于定位反代/子路径问题
    this.timeout = CLIENT_TIMEOUT; // 转发请求超时（探测到服务端超时后取「服务端 + 10s」）
    this.jsonMode = true;     // response_format: json_object（上游不支持时自动关闭并重试）
    this.noTemp = false;      // 部分模型（如 deepseek-reasoner）不接受 temperature：上游拒绝时自动省略
    this.noVision = false;    // 上游拒绝图片内容（模型无视觉能力）：改为只发文字，面板会提示用户
    this.lastModel = '';
  }

  /* ---------- 配置：只存本机浏览器 localStorage（服务端不落盘） ---------- */
  /** 读 localStorage → 生效配置（Key 只以掩码回显，页面内不保留明文） */
  readLocal() {
    const saved = (() => { try { return JSON.parse(lsGet(LS_CFG)) || {}; } catch (e) { return {}; } })();
    const key = lsGet(LS_KEY);
    this.noVision = false; // 配置（可能换了模型）重新读取：视觉能力重新探测，不沿用上一次的结论
    this.cfg = {
      configured: !!key, keyMask: maskKey(key),
      baseUrl: saved.baseUrl || AI_DEFAULT_BASE,
      model: saved.model || AI_DEFAULT_MODEL,
      source: key ? 'page' : 'none',
    };
    return this.cfg;
  }

  /** 载入配置（localStorage）+ 探测本机服务是否可用（不可用则走浏览器直连） */
  async loadConfig() {
    this.readLocal();
    await this.probeProxy();
    return this.cfg;
  }

  /** 探测本机服务的转发端点：只读状态，不涉及凭据；失败即视为直连模式 */
  async probeProxy() {
    try {
      const { status, json } = await fetchJson(this.statusUrl, { timeout: PROBE_TIMEOUT });
      this.direct = !(status === 200 && json && json.ok === true && json.proxy === true);
      if (!this.direct && Number.isFinite(json.timeoutMs) && json.timeoutMs > 0) {
        this.timeout = json.timeoutMs + 10000; // 客户端超时略大于服务端，避免先被客户端掐断
      }
    } catch (e) { this.direct = true; }
    return !this.direct;
  }

  /** 保存配置到 localStorage（key 只覆盖不读取明文；baseUrl/model 缺省沿用当前值） */
  async saveConfig({ key, baseUrl, model } = {}) {
    if (key) lsSet(LS_KEY, String(key).trim());
    const next = {
      baseUrl: String(baseUrl || this.cfg.baseUrl || AI_DEFAULT_BASE).trim().replace(/\/+$/, ''),
      model: String(model || this.cfg.model || AI_DEFAULT_MODEL).trim(),
    };
    lsSet(LS_CFG, JSON.stringify(next));
    return this.readLocal();
  }

  /** 清除 Key（保留接口地址/模型，仅移除凭据） */
  async clearConfig() {
    lsSet(LS_KEY, '');
    return this.readLocal();
  }

  /* ---------- 对话 ---------- */
  /** @returns {Promise<{content:string, usage:object|null, model:string}>} 失败抛 AiError */
  async chat(messages, opts = {}) {
    const mock = globalThis.__aiChatMock;
    if (typeof mock === 'function') {
      const r = await mock(messages, { ...opts, model: this.cfg.model, jsonMode: this.jsonMode });
      return this.normalize(r);
    }
    if (!lsGet(LS_KEY)) throw new AiError('NO_KEY', '未配置 API Key：请在设置中填写（Key 只存本机浏览器）');
    // 已判定该模型不支持图片：后续请求直接把图片块降级为一行说明，不再反复触发 400
    const msgs = this.noVision ? this.withoutImages(messages) : messages;
    return this.direct ? this.chatDirect(msgs, opts) : this.chatProxy(msgs, opts);
  }

  /** 去掉消息里的图片块（保留一行说明，模型仍知道"这里曾有一张图片"） */
  withoutImages(messages) { return stripImageParts(messages, IMAGE_NOTE.noVisionEn); }

  /** 上游 400/422 且消息里带图片 → 判「该模型不支持视觉」：置 noVision 并返回 true，调用方去掉图片重发一次。
   *  只在错误文案提到图片/内容类型时触发，避免把无关的 400（额度、上下文超长）误判成"不支持图片"。 */
  retryWithoutImages(messages, message) {
    if (this.noVision || !hasImageParts(messages)) return false;
    if (!/image|vision|multimodal|content|string|sequence|图片|视觉|多模态/i.test(String(message || ''))) return false;
    this.noVision = true;
    return true;
  }

  normalize(r) {
    if (!r) throw new AiError('UPSTREAM', '模型返回为空');
    const content = r.content != null ? String(r.content)
      : (r.choices && r.choices[0] && r.choices[0].message ? String(r.choices[0].message.content || '') : '');
    if (r.model) this.lastModel = r.model;
    return { content, usage: r.usage || null, model: r.model || this.cfg.model };
  }

  /** 本机服务无状态转发（默认路径；Key 随请求体带上，服务端不落盘） */
  async chatProxy(messages, { signal } = {}) {
    const key = lsGet(LS_KEY);
    if (!key) throw new AiError('NO_KEY', '未配置 API Key：请在设置中填写（Key 只存本机浏览器）');
    const payload = {
      key,
      baseUrl: this.cfg.baseUrl || AI_DEFAULT_BASE,
      messages, model: this.cfg.model || AI_DEFAULT_MODEL,
      max_tokens: 8192,
      ...(this.noTemp ? {} : { temperature: 0.2 }),
      ...(this.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
    for (let attempt = 0; ; attempt++) {
      let out;
      try { out = await fetchJson(apiUrl(CHAT_PATH), { method: 'POST', body: JSON.stringify(payload), signal, timeout: this.timeout }); }
      catch (e) {
        if (isAbort(e)) throw new AiError(signal && signal.aborted ? 'STOPPED' : 'TIMEOUT', '请求已中断');
        if (attempt < RETRY_DELAYS.length) { await sleep(RETRY_DELAYS[attempt]); continue; }
        // 重试后仍不可达：本机服务可能已停 → 切直连兜底（面板黄条同步切到直连态）
        this.direct = true;
        return this.chatDirect(messages, { signal });
      }
      const { status, json } = out;
      if (status === 404 && !json) { this.direct = true; return this.chatDirect(messages, { signal }); } // 服务端无转发端点：降级直连
      if (json && json.ok === false) {
        const code = String(json.code || 'UPSTREAM');
        // 上游不认 response_format / temperature：关掉相应字段重试一次（网关兼容性，非业务判断）
        if (code === 'BAD_REQUEST' && this.jsonMode && /response_format|json_object/i.test(json.message || '')) {
          this.jsonMode = false;
          return this.chatProxy(messages, { signal });
        }
        if (code === 'BAD_REQUEST' && !this.noTemp && /temperature|top_p|max_tokens|not support/i.test(json.message || '')) {
          this.noTemp = true;
          return this.chatProxy(messages, { signal });
        }
        // 模型不支持图片（多模态）：去掉图片块重发一次（只在本次会话内生效，换模型后重新探测）
        if (code === 'BAD_REQUEST' && this.retryWithoutImages(messages, json.message)) {
          return this.chatProxy(this.withoutImages(messages), { signal });
        }
        if ((code === 'RATE_LIMIT' || code === 'UPSTREAM' || code === 'NETWORK') && attempt < RETRY_DELAYS.length) {
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        throw new AiError(code, json.message || '模型服务返回错误');
      }
      if (json && json.ok === true) {
        const choice = (json.choices || [])[0] || {};
        if (!choice.message) throw new AiError('UPSTREAM', '模型未返回 message 内容');
        return this.normalize({ content: choice.message.content, usage: json.usage, model: json.model });
      }
      if (attempt < RETRY_DELAYS.length && status >= 500) { await sleep(RETRY_DELAYS[attempt]); continue; }
      throw new AiError('UPSTREAM', `HTTP ${status}：${String(out.text || '').slice(0, 200)}`);
    }
  }

  /** 浏览器直连（无本机服务时；可能被 CORS 拦截） */
  async chatDirect(messages, { signal } = {}) {
    const key = lsGet(LS_KEY);
    if (!key) throw new AiError('NO_KEY', '未配置 API Key：请在设置中填写（Key 只存本机浏览器）');
    const url = (this.cfg.baseUrl || AI_DEFAULT_BASE).replace(/\/+$/, '') + '/chat/completions';
    const payload = {
      model: this.cfg.model || AI_DEFAULT_MODEL, messages,
      max_tokens: 8192,
      ...(this.noTemp ? {} : { temperature: 0.2 }),
      ...(this.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
    try {
      const r = await fetch(url, {
        method: 'POST', signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
      if (!r.ok) {
        const msg = (json && json.error && json.error.message) || text.slice(0, 200);
        const code = r.status === 401 || r.status === 403 ? 'UNAUTHORIZED' : r.status === 429 ? 'RATE_LIMIT'
          : r.status === 400 || r.status === 422 ? 'BAD_REQUEST' : 'UPSTREAM';
        if (code === 'BAD_REQUEST' && this.retryWithoutImages(messages, msg)) {
          return this.chatDirect(this.withoutImages(messages), { signal });
        }
        throw new AiError(code, msg || ('HTTP ' + r.status));
      }
      const choice = (json && json.choices && json.choices[0]) || {};
      return this.normalize({ content: choice.message ? choice.message.content : '', usage: json && json.usage, model: (json && json.model) || payload.model });
    } catch (e) {
      if (e instanceof AiError) throw e;
      if (isAbort(e)) throw new AiError(signal && signal.aborted ? 'STOPPED' : 'TIMEOUT', '请求已中断');
      throw new AiError('NETWORK', (e && e.message) || '浏览器直连失败（可能是 CORS 或网络问题）');
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
