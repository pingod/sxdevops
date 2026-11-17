/**
 * AI 建模输入附件 —— 「上传 / 粘贴 / 拖入」三种入口共用的「文件 → 消息内容块」转换层
 *
 * 支持两类附件（判断只看 MIME 与扩展名，不看内容）：
 *   · 文本类（txt/md/csv/json/log/yaml… 以及任何 MIME 以 text/ 开头的文件）：
 *     读成 UTF-8 文本追加到本轮用户消息之后（带文件名标注，超长按字符截断并标注）。
 *     —— 手记、机柜清单、点位表这类"现场抄下来的文字"直接进上下文，无需手工剪贴。
 *   · 图片（png/jpg/webp/gif/bmp…）：先在浏览器内等比压缩（长边 ≤1568px、JPEG q0.82、
 *     透明区域铺白底）并生成小缩略图，压缩结果按 OpenAI 多模态格式 `{type:'image_url'}` 随消息下发。
 *     —— 图片只在支持视觉的模型上生效；模型不支持时由 ai-provider.js 自动降级（去掉图片重发一次）
 *     并由面板提示用户（见 IMAGE_NOTE.noVisionZh / noVisionEn）。
 *
 * 体积护栏（本地算，不求模型）：单条消息 ≤4 个附件、单个文本文件 ≤2MB（内容超 2 万字截断并标注）、
 * 单张原图 ≤8MB、压缩后 dataURL 总长 ≤6MB；超限即拒收并在面板上说明原因——
 * 与 server.js / main.go 转发体上限（12MB）配套，留足余量。
 *
 * 只做数据搬运与护栏，不含任何业务判断（建模业务逻辑仍在 ai-rules.js 的提示词里）。
 * 纯函数（classifyFile / formatBytes / buildUserContent / hasImageParts / stripImageParts）
 * 不依赖 DOM，可在 Node 里直接单测（tests/ai-attach.test.mjs）。
 */

export const ATTACH_LIMITS = {
  maxFiles: 4,                              // 单条消息最多附件数
  maxTextReadBytes: 2 * 1024 * 1024,        // 文本文件读取上限：超过直接拒收（避免白读几十 MB）
  maxImageBytes: 8 * 1024 * 1024,           // 压缩前的单张原图上限
  maxPayloadChars: 6 * 1024 * 1024,         // 压缩后 dataURL 总长上限（服务端 12MB 之下）
  imageMaxDim: 1568,                        // 压缩长边（视觉模型常用档位，约 1.1M 像素）
  imageQuality: 0.82,
  thumbDim: 96,                             // 面板缩略图长边（小 dataURL，渲染用）
  textChars: 20000,                         // 单个文本附件保留的字符数（超出截断并标注）
};

const TEXT_EXT = /\.(txt|text|md|markdown|csv|tsv|json|jsonl|ndjson|log|xml|ya?ml|ini|conf|cfg|env|srt|vtt|htm|html|sql|py|js|mjs|cjs|ts|css|scss|sh|bat|ps1|go|java|cs|cpp|c|h|table)$/i;
const IMAGE_EXT = /\.(png|jpe?g|jfif|webp|gif|bmp|avif|heic|heif)$/i;

/** 消息里图片块的占位说明（本轮结束释放上下文 / 模型不支持图片时替换掉图片块） */
export const IMAGE_NOTE = {
  zh: '[图片附件：本轮已发送过，为节省上下文不再重复携带；如需再看请让用户重新粘贴]',
  en: '[image attachment: already sent this round; not carried again to save context — ask the user to paste it again if needed]',
  noVisionZh: '[图片附件：当前模型不支持图片输入，已忽略——本轮只发送了文字与文本附件]',
  noVisionEn: '[image attachment: the current model does not accept images, so it was dropped — only text was sent]',
};

/** 文件分类：'image' | 'text' | 'other'（只看类型与扩展名，不做内容嗅探） */
export function classifyFile(file) {
  const mime = String((file && file.type) || '').toLowerCase();
  const name = String((file && file.name) || '');
  if (mime.startsWith('image/') || IMAGE_EXT.test(name)) return 'image';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' ||
      mime === 'application/x-yaml' || TEXT_EXT.test(name)) return 'text';
  return 'other';
}

/** 人类可读体积（1 位小数只在 10KB 以下保留，避免「1234.5 KB」这类噪音） */
export function formatBytes(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

/** 附件总体积（dataURL 字符数 + 文本字符数）：面板据此做「压缩后总量」护栏 */
export function attachmentChars(atts) {
  return (atts || []).reduce((n, a) => n + (a && a.url ? a.url.length : 0) + (a && a.text ? a.text.length : 0), 0);
}

/**
 * 用户消息内容：无图片附件 → 纯文本字符串（与不带附件的旧行为逐字节一致）；
 * 有图片附件 → OpenAI 多模态内容块数组（文本块在前，图片块依次在后）。
 * 文本附件在此拼进正文（模型看到的是一份带文件名的文本，而不是"某个附件"这种抽象）。
 * @param {string} text 用户输入的正文（可含编排层附加的 [画布现状] 前缀）
 * @param {Array<object>} atts 附件对象数组（kind:'text' 用 text 字段，kind:'image' 用 url 字段）
 * @param {boolean} zh 标注语言（与 system prompt 语言一致）
 * @returns {string|Array<object>}
 */
export function buildUserContent(text, atts = [], zh = true) {
  let body = String(text == null ? '' : text);
  let i = 0;
  for (const a of atts || []) {
    if (!a || a.kind !== 'text') continue;
    i++;
    const head = zh
      ? `\n\n[附件 ${i}：${a.name}${a.truncated ? `（超长，仅保留前 ${ATTACH_LIMITS.textChars} 字）` : ''}]`
      : `\n\n[Attachment ${i}: ${a.name}${a.truncated ? ` (truncated to the first ${ATTACH_LIMITS.textChars} chars)` : ''}]`;
    body += head + '\n' + String(a.text || '');
  }
  const imgs = (atts || []).filter(a => a && a.kind === 'image' && a.url);
  if (!imgs.length) return body;
  const parts = [];
  if (body.trim()) parts.push({ type: 'text', text: body });
  for (const a of imgs) parts.push({ type: 'image_url', image_url: { url: a.url } });
  if (!parts.length) parts.push({ type: 'text', text: zh ? '[附件：图片]' : '[attachment: image]' });
  return parts;
}

/** 消息里是否含图片块（多模态 content 数组） */
export function hasImageParts(messages) {
  return (messages || []).some(m => Array.isArray(m && m.content) &&
    m.content.some(p => p && (p.type === 'image_url' || p.image_url)));
}

/** content 数组 → 纯文本：图片块换成一行说明（note），多段文本合并为一个字符串（兼容只收字符串的网关） */
export function flattenContent(content, note = '') {
  if (!Array.isArray(content)) return content;
  const out = [];
  for (const p of content) {
    if (!p) continue;
    if (typeof p === 'string') { out.push(p); continue; }
    if (p.type === 'text' || typeof p.text === 'string') { if (p.text) out.push(String(p.text)); continue; }
    if (note) out.push(note);
  }
  return out.join('\n');
}

/** 复制一份消息数组并去掉其中的图片块（原数组不动：历史仍保留图片，直到本轮结束再释放） */
export function stripImageParts(messages, note = '') {
  return (messages || []).map(m => {
    if (!m || !Array.isArray(m.content)) return m;
    return { ...m, content: flattenContent(m.content, note) };
  });
}

/* ─────────────── 以下为浏览器端（读取 / 压缩）实现 ─────────────── */

/**
 * 把一个 File 转成附件对象（图片压缩、文本截断）。
 * @returns {Promise<{ok:true, att:object}|{ok:false, code:string}>} code 见面板文案表 aip.attach.err.*
 */
export async function prepareAttachment(file) {
  if (!file || typeof file.size !== 'number') return { ok: false, code: 'read' };
  const kind = classifyFile(file);
  if (kind === 'other') return { ok: false, code: 'type' };
  if (kind === 'image') {
    if (file.size > ATTACH_LIMITS.maxImageBytes) return { ok: false, code: 'imageBig' };
    try {
      const img = await compressImage(file);
      return {
        ok: true,
        att: {
          kind: 'image', name: cleanName(file.name, 'image.jpg'), size: img.bytes, mime: 'image/jpeg',
          url: img.url, thumb: img.thumb, w: img.w, h: img.h,
        },
      };
    } catch (e) { return { ok: false, code: 'read' }; }
  }
  if (file.size > ATTACH_LIMITS.maxTextReadBytes) return { ok: false, code: 'textBig' };
  let text = '';
  try { text = await readText(file); } catch (e) { return { ok: false, code: 'read' }; }
  const truncated = text.length > ATTACH_LIMITS.textChars;
  if (truncated) text = text.slice(0, ATTACH_LIMITS.textChars);
  return {
    ok: true,
    att: {
      kind: 'text', name: cleanName(file.name, 'notes.txt'), size: file.size || text.length,
      mime: file.type || 'text/plain', text, truncated,
    },
  };
}

/** 文件名兜底 + 截断（面板只显示缩略后的名称，这里只防超长/空名） */
function cleanName(name, fallback) {
  const n = String(name || '').trim();
  return (n || fallback).slice(0, 120);
}

/** 读文本：优先 Blob.text()，老浏览器退回 FileReader */
function readText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('read failed'));
    fr.readAsText(file);
  });
}

/** 等比例压到长边 ≤imageMaxDim（先铺白底：JPEG 无 alpha，透明图不铺白会变黑块），并生成小缩略图 */
async function compressImage(file) {
  const src = await loadImage(file);
  const sw = src.width || src.naturalWidth || 0;
  const sh = src.height || src.naturalHeight || 0;
  if (!sw || !sh) throw new Error('empty image');
  const scale = Math.min(1, ATTACH_LIMITS.imageMaxDim / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = drawTo(w, h, src, w, h);
  if (typeof src.close === 'function') src.close(); // ImageBitmap 显式释放
  const url = canvas.toDataURL('image/jpeg', ATTACH_LIMITS.imageQuality);
  return { url, thumb: thumbOf(canvas, w, h), w, h, bytes: Math.round(url.length * 3 / 4) };
}

function drawTo(cw, ch, src, dw, dh) {
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(src, 0, 0, dw, dh);
  return c;
}

function thumbOf(src, w, h) {
  const s = Math.min(1, ATTACH_LIMITS.thumbDim / Math.max(w, h));
  return drawTo(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)), src, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)))
    .toDataURL('image/jpeg', 0.7);
}

/** 解码图片：优先 createImageBitmap（可在 worker/主线程零布局开销解码），失败退回 <img> + objectURL */
async function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch (e) { /* 某些格式/浏览器不支持，走 <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('decode failed'));
      im.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}
