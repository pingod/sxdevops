/** 机柜编号通用解析与模板工具（纯函数，无状态/UI 依赖）
 * 编号模型：编号 = Head(排标识，可含数字/分隔符，如机房编号 101-、楼层 1F-) + 序号(数字段) + Tail(后缀)。
 * 识别：对名字中每个数字段试切 (Head, Tail) 并整排多数派投票——只有随柜位递增的数字段
 * 两侧文本全排一致才是序号，机房编号/楼层等恒定数字段自然留在 Head 里
 * （101-A01、C01-A01、301-1-01 的序号都是 01，A01 是只有一个数字段的退化特例）。
 * 生成模板：# 连续段 = 序号位（个数 = 最小位数，超出自动扩位）；# 前最近的字母段 = 排号槽
 * （放置后自动递增，A→Z→AA→AB…）；其余文字为字面前缀/后缀，可含数字。
 * 示例模板：A## → A01…；101-A## → 101-A01…；1F-B##-主 → 1F-B01-主… */

/** 名字 → 每个数字段的试切候选 [{head, tail, digits}]；无数字段返回 [] */
export function numCandidates(name) {
  const out = [];
  const re = /\d+/g;
  let m;
  while ((m = re.exec(name))) {
    out.push({
      head: name.slice(0, m.index),
      tail: name.slice(m.index + m[0].length),
      digits: m[0],
    });
  }
  return out;
}

/** (Head, Tail) 大小写不敏感比较键 */
export const tplKey = (head, tail) => head.toLowerCase() + '\u0000' + tail.toLowerCase();

/** 解析编号模板：tpl 如 A## / 101-A## / A01##-主
 * 返回 { ok, err, headPrefix, slot, headAfter, width, tail }
 * slot = head 中最后一个字母段（排号槽，'' = 模板无排号，如 101-##） */
export function parseTemplate(tpl) {
  const s = String(tpl || '').trim().toUpperCase();
  const i = s.indexOf('#');
  if (i < 0) return { ok: false, err: 'err.tpl.needHash' };
  let j = i;
  while (j < s.length && s[j] === '#') j++;
  if (s.indexOf('#', j) >= 0) return { ok: false, err: 'err.tpl.oneBlock' };
  const head = s.slice(0, i), tail = s.slice(j);
  const lm = /([A-Za-z]+)([^A-Za-z]*)$/.exec(head); // head 尾部（最后一个）字母段为排号槽
  return {
    ok: true,
    headPrefix: lm ? head.slice(0, lm.index) : head,
    slot: lm ? lm[1] : '',
    headAfter: lm ? lm[2] : '',
    width: j - i,
    tail,
  };
}

/** 排模板推断：对 names 整排试切投票（每名每数字段投 1 票，(Head,Tail) 多数派为排模板）。
 * 返回 { head, tail, width, key, members }；members = 命中模板的名字下标（按原顺序）。
 * 全部名字都无数字段时返回 null。平票取沿排先出现者（保持确定性）。 */
export function inferRowTemplate(names) {
  const tally = new Map(); // key → { n, order, head, tail, heads, tails, widths }
  const votes = [];        // 每名命中的 key 列表（同 key 去重）
  let order = 0;
  for (const nm of names) {
    const per = [];
    const seen = new Set();
    for (const c of numCandidates(nm || '')) {
      const k = tplKey(c.head, c.tail);
      if (seen.has(k)) continue;
      seen.add(k);
      per.push(k);
      let t = tally.get(k);
      if (!t) {
        t = { n: 0, order: order++, head: c.head, tail: c.tail, heads: new Map(), tails: new Map(), widths: new Map() };
        tally.set(k, t);
      }
      t.n++;
      bump(t.heads, c.head); bump(t.tails, c.tail); bump(t.widths, c.digits.length);
    }
    votes.push(per);
  }
  // 取票：票数多者优先；同票保留 Head/Tail 更长者（避免 101-A01 与 102-A01 均票时
  // 误把两排的“首数字段”投成空 Head 模板）；仍平则取沿排先出现者（确定性）
  let best = null;
  for (const t of tally.values()) {
    if (!best) { best = t; continue; }
    if (t.n > best.n || (t.n === best.n && (
      t.head.length > best.head.length ||
      (t.head.length === best.head.length && (t.tail.length > best.tail.length ||
        (t.tail.length === best.tail.length && t.order < best.order)))))) best = t;
  }
  if (!best) return null;
  const head = maxKey(best.heads), tail = maxKey(best.tails), width = maxKey(best.widths);
  const key = tplKey(head, tail);
  const members = [];
  votes.forEach((per, i) => { if (per.includes(key)) members.push(i); });
  return { head, tail, width, key, members };
}

function bump(map, v) { map.set(v, (map.get(v) || 0) + 1); }
function maxKey(map) { let bestK, bestV = -1; for (const [k, v] of map) if (v > bestV) { bestV = v; bestK = k; } return bestK; }

/* ---------- 排号槽字母（Excel 式 A→Z→AA→AB…） ---------- */

/** 字母串 → 序号值（A=1, Z=26, AA=27…） */
export const lettersVal = s => {
  let v = 0;
  for (const ch of String(s).toUpperCase()) v = v * 26 + (ch.charCodeAt(0) - 64);
  return v;
};
/** 序号值 → 字母串 */
export const lettersAt = v => {
  let s = '';
  while (v > 0) {
    s = String.fromCharCode(65 + (v - 1) % 26) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
};
/** 下一排号（A→B→…→Z→AA→AB…） */
export const nextLetters = s => lettersAt(lettersVal(s) + 1);
/** 从起始排号起连续 n 个排号（POD 逐排用） */
export const lettersSeq = (start, n) => {
  const v0 = lettersVal(start);
  return Array.from({ length: n }, (_, i) => lettersAt(v0 + i));
};

/** 模板渲染：slot 覆盖排号槽（默认用模板自带排号），num 为机柜序号 */
export function renderTpl(tpl, num, slot) {
  const p = parseTemplate(tpl);
  if (!p.ok) return '';
  const s = slot === undefined ? p.slot : slot;
  return p.headPrefix + s + p.headAfter + String(num).padStart(Math.max(p.width, String(num).length), '0') + p.tail;
}

/** 正则转义（模板片段 → 字面匹配用） */
export const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Head 尾部字母（消息展示用，如 101-A- 的 A、A01 的 A；无字母返回 ''） */
export const lastLetters = s => {
  let out = '';
  const re = /[A-Za-z]+/g;
  let m;
  while ((m = re.exec(s))) out = m[0];
  return out;
};
