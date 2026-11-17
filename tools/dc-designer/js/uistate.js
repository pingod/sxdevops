/**
 * 工作现场记忆：刷新页面（F5 / Ctrl+R）后保持原有界面状态
 *
 * 记忆内容（单个 JSON，键 idc2d_uistate_v1）：
 *   - wizard: { open, step }      工勘向导开合状态与当前步骤
 *   - checks: { open }            合规自检面板开合状态
 *   - propsHidden: bool           右侧工作区收起 / 展开（沿用旧键）
 *   - sidebarTab: 'props' | 'ai'  右侧工作区当前标签（不持久化对话内容）
 *   - view2d: { scale, cx, cy }   2D 视图缩放与视野中心（世界坐标 mm）
 *   - mode3d: bool                是否处于 3D 查看视图
 *   - cam3d: { r, t, p, tx, ty, tz } 3D 相机（距离 / 方位角 / 俯仰角 / 观察目标点）
 *
 * 为什么用 sessionStorage 而不是 localStorage：
 *   以上都是「本次工作现场」的状态（跟标签页走）——刷新 / 重载原样恢复（含刷新前正在编辑的视角与面板），
 *   新开标签页、关掉重开则回到默认布局，上一次的临时缩放 / 视角不会莫名影响新窗口。
 *   用户偏好与项目数据仍走 localStorage，两者互不影响：语言 idc2d_locale_v1、
 *   属性面板宽度 idc2d_props_w_v1、默认值注册表 idc2d_lastprops_v1、项目草稿 idc2d_draft_v1。
 *
 * 写盘策略：patchUI 合并后节流 800ms（与草稿同一策略，密集拖动视角不反复写盘）；
 * 页面隐藏 / 刷新 / 关闭前由 main.js 调用 flushUI() 立即落盘。
 * 存储不可用（隐私模式、Node 环境）时全部退化为空操作，不影响编辑与渲染。
 *
 * 取值入口：loadUI() 返回**内部缓存对象**（勿修改其字段，写入一律走 patchUI）。
 */
const KEY = 'idc2d_uistate_v1';
const SAVE_MS = 800; // 节流写盘间隔（同 state.js 的草稿写盘策略）

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const numOr = (v, d) => { const n = +v; return Number.isFinite(n) ? n : d; };
const copy = v => (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;

/** 会话存储句柄：隐私模式 / Node 环境下为 null（此时记忆功能整体关闭） */
const store = (() => {
  try {
    const s = globalThis.sessionStorage;
    if (!s) return null;
    const probe = '__idc2d_probe';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch (e) { return null; }
})();

/** 出厂默认（无记忆时的形态）：向导展开停在第 1 步、自检面板收起、属性面板展开、视图交给启动逻辑自适合 */
function defaults() {
  return {
    wizard: { open: true, step: 1 },
    checks: { open: false },
    propsHidden: false,
    sidebarTab: 'props',
    view2d: null,
    mode3d: false,
    cam3d: null,
  };
}

/** 读到的数据一律按白名单清洗：外部可手改 / 记忆可能来自旧版本，脏值不能让界面错乱 */
function normalize(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const wz = (o.wizard && typeof o.wizard === 'object') ? o.wizard : {};
  const ck = (o.checks && typeof o.checks === 'object') ? o.checks : {};
  const v2 = (o.view2d && typeof o.view2d === 'object') ? o.view2d : null;
  const c3 = (o.cam3d && typeof o.cam3d === 'object') ? o.cam3d : null;
  const v2s = numOr(v2 && v2.scale, 0);
  return {
    wizard: {
      open: wz.open !== false,
      step: Math.round(clamp(numOr(wz.step, 1), 1, 4)), // 向导共 4 步
    },
    checks: { open: ck.open === true },
    propsHidden: o.propsHidden === true,
    sidebarTab: o.sidebarTab === 'ai' ? 'ai' : 'props',
    view2d: (v2 && v2s > 0)
      ? { scale: clamp(v2s, 0.004, 2), cx: numOr(v2.cx, 0), cy: numOr(v2.cy, 0) } // 缩放范围同 tools.zoomAt
      : null,
    mode3d: o.mode3d === true,
    cam3d: c3
      ? {
        r: clamp(numOr(c3.r, 20), 0.3, 800),           // 范围同 orbit3d 滚轮缩放
        t: numOr(c3.t, Math.PI / 4),
        p: clamp(numOr(c3.p, 1.02), 0.08, 1.52),       // 范围同 orbit3d 俯仰钳制
        tx: numOr(c3.tx, 0), ty: numOr(c3.ty, 0), tz: numOr(c3.tz, 0),
      }
      : null,
  };
}

let cache = null;   // 当前记忆（首次访问时读取）
let timer = 0;      // 节流写盘定时器
let savedAt = 0;    // 上次落盘时间

/** 立即写盘 */
function writeNow() {
  clearTimeout(timer); timer = 0;
  savedAt = Date.now();
  if (!store) return;
  try { store.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* 存储满 / 被禁用：忽略 */ }
}

/** 读取记忆（首次调用时从 sessionStorage 载入并清洗；无记忆返回出厂默认） */
export function loadUI() {
  if (!cache) {
    let raw = null;
    if (store) { try { raw = JSON.parse(store.getItem(KEY) || 'null'); } catch (e) { raw = null; } }
    cache = normalize(raw);
  }
  return cache;
}

/** 更新一个字段（值相等时跳过写盘）；对象值深拷贝，外部后续修改不会影响缓存 */
export function patchUI(key, value) {
  const cur = loadUI();
  if (!(key in cur)) return;
  const next = copy(value);
  if (JSON.stringify(cur[key]) === JSON.stringify(next)) return;
  cur[key] = next;
  const now = Date.now();
  if (now - savedAt >= SAVE_MS) { writeNow(); return; }
  clearTimeout(timer);
  timer = setTimeout(writeNow, SAVE_MS - (now - savedAt));
}

/** 立即落盘（页面隐藏 / 刷新 / 关闭前由 main.js 调用：节流中未落盘的变化不丢） */
export function flushUI() {
  if (cache) writeNow();
}
