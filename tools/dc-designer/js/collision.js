/** 对象互斥（推挤）求解：新放置/拖动的对象为“固定锚”，与锚重叠的实体对象被推开，级联传播。
 * 被推对象沿重叠分离轴搜索最近空闲网格位（±方向、100mm 步进、上限 3m）——
 * 避免被夹在“两个固定对象”之间时来回震荡；找不到空闲位时退回最小分离向量直接推开（可能残留重叠）。
 * 被推后即视为“已安置”，不再被推回——每对象至多移动一次，必然终止。
 * 性能：空间哈希（1200mm 单元格）将重叠检测限制在局部邻域，千级对象场景每帧毫秒级。
 * 密集区域无处可推时允许残留重叠，由调用方（放置/拖动）提示。
 *
 * 拖拽会话（createPushSession + 第 4 参 session）额外提供两项拖动体验优化：
 * - 停留判定（DWELL_MS）：与锚的冲突需持续重叠 ≥150ms 才推挤——“掠过”路径上的对象不误推；
 * - 回弹（springBack）：被推对象记录拖动前坐标，锚离开后放回原位（仅在原位空出时复位）。
 * 非拖拽调用方（放置/对齐/属性修改等）不传 session，行为与旧版一致：立即推挤、不回弹。 */
import { state } from './state.js';
import { isSolid, rectOverlap } from './geo.js';

/** 最大轮数（级联深度上限，防止极端密集场景拖慢拖动） */
const MAX_ROUNDS = 30;
/** 空闲位搜索步数上限（100mm × 30 = 3m） */
const MAX_STEPS = 30;
/** 空间哈希单元格边长：≥ 最大实体对象单边尺寸（机柜深 1200），
 * 保证任意两个重叠对象的中心必落在同格或相邻格 */
const CELL = 1200;
/** 停留判定阈值：拖动锚与对象持续重叠 ≥150ms 才推挤（快速掠过不推） */
export const DWELL_MS = 150;

/** 创建拖拽推挤会话：跨帧维护“已推开对象”（回弹用）与“重叠持续计时”（停留判定用）。
 * final=true 表示落点结算（松手后的一次性互斥），跳过停留判定、立即推挤 */
export function createPushSession() {
  return { pushed: new Map(), overlap: new Map(), final: false };
}

/** 空间哈希：把实体对象按中心位置分桶（posOf 可选：返回用于分桶的虚拟坐标，回弹判定用） */
function buildGrid(solids, posOf = null) {
  const grid = new Map();
  for (const o of solids) {
    const p = posOf ? posOf(o) : o;
    const k = Math.floor(p.x / CELL) + ',' + Math.floor(p.y / CELL);
    const l = grid.get(k);
    if (l) l.push(o); else grid.set(k, [o]);
  }
  return grid;
}

/** 取 (x,y) 所在格及相邻 8 格内的所有对象 */
function neighborsAt(grid, x, y) {
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  const out = [];
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const l = grid.get((cx + i) + ',' + (cy + j));
      if (l) out.push(...l);
    }
  }
  return out;
}

/** 取与 o 中心同格及相邻 8 格内的所有对象 */
function neighbors(grid, o) { return neighborsAt(grid, o.x, o.y); }

/** 沿方向 (ax,ay) 搜索最近空闲网格位（ax/ay 为 0 或 ±1，屏幕轴对齐）。
 * 候选位 = 当前位置沿轴向 ±k×100mm，与所有固定对象无重叠即视为空闲（+ 方向优先）。
 * 返回位移向量 {x,y}；找不到返回 null */
function nearestFreeOn(o, fixedList, ax, ay) {
  const cur = o.x * ax + o.y * ay; // 当前位置在轴上的投影
  const freeAt = proj => {
    const nx = o.x + (proj - cur) * ax, ny = o.y + (proj - cur) * ay;
    const tmp = { ...o, x: nx, y: ny };
    for (const f of fixedList) if (rectOverlap(f, tmp)) return false;
    return true;
  };
  const p0 = Math.ceil((cur + 100) / 100) * 100; // 正方向第一格（严格越过当前位置）
  const n0 = Math.floor((cur - 100) / 100) * 100; // 反方向第一格
  for (let k = 0; k < MAX_STEPS; k++) {
    const p = p0 + k * 100;
    if (freeAt(p)) return { x: (p - cur) * ax, y: (p - cur) * ay };
    const n = n0 - k * 100;
    if (freeAt(n)) return { x: (n - cur) * ax, y: (n - cur) * ay };
  }
  return null;
}

/** 回弹：把会话中已推开的对象放回拖动前位置。仅当原始位置与锚（拖动物）、其他仍被推开的
 * 对象（按当前实际位置）及普通对象均不冲突时才复位；“原始位置仍被锚压住”的对象保持推开
 * （插入语义），被其占位的后续对象也随之保持推开，绝不提前复位造成二次重叠。
 * 逐个判定并立即提交（后续对象本轮即按新位置判定），多轮 fixpoint 处理连锁让位。
 * 已复位对象无需再查：各对象拖动前位置两两不重叠（假定拖动前场景无重叠）。
 * 返回复位对象数。 */
export function springBack(session, anchors) {
  const pushed = session.pushed;
  if (!pushed.size) return 0;
  const solids = state.project.objects.filter(isSolid);
  const solidById = new Map(solids.map(o => [o.id, o]));
  const anchorIds = new Set(anchors.map(o => o.id));
  let restored = 0;
  const maxPasses = pushed.size + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    const grid = buildGrid(solids); // 普通对象位置不变，网格本轮内有效；被推对象按实况单独判定
    for (const [id, orig] of pushed) {
      const o = solidById.get(id);
      if (!o) { pushed.delete(id); changed = true; continue; }
      const test = { ...o, x: orig.x, y: orig.y };
      let blocked = anchors.some(a => rectOverlap(a, test));
      if (!blocked) { // 其他仍被推开的对象按当前实际位置判定（挡住原位则不复位）
        for (const [sid] of pushed) {
          if (sid === id) continue;
          const s = solidById.get(sid);
          if (s && rectOverlap(s, test)) { blocked = true; break; }
        }
      }
      if (!blocked) { // 普通对象（含本轮已复位者：按提交后的实况坐标判定）
        for (const s of neighborsAt(grid, orig.x, orig.y)) {
          if (s.id === id || anchorIds.has(s.id) || pushed.has(s.id)) continue;
          if (rectOverlap(s, test)) { blocked = true; break; }
        }
      }
      if (!blocked) { // 立即提交复位
        o.x = orig.x; o.y = orig.y;
        pushed.delete(id);
        restored++;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return restored;
}

/** 停留判定：统计本帧与锚直接重叠的对象并更新持续计时；返回达到阈值（≥DWELL_MS）
 * 的对象 id 集合。已推开的对象（pushed）不再计时——锚再次压到它们时立即再推。 */
function updateDwell(session, anchors, exclude, anchorIds, solids, now) {
  const cur = new Set();
  const grid = buildGrid(solids);
  for (const a of anchors) {
    for (const o of neighbors(grid, a)) {
      if (o.id === a.id || anchorIds.has(o.id)) continue;
      if (session.pushed.has(o.id)) continue;
      if (exclude && exclude.has(o.id)) continue;
      if (rectOverlap(a, o)) cur.add(o.id);
    }
  }
  const ok = new Set();
  for (const id of [...session.overlap.keys()]) {
    if (!cur.has(id)) { session.overlap.delete(id); continue; }
    if (now - session.overlap.get(id) >= DWELL_MS) ok.add(id);
  }
  for (const id of cur) {
    if (!session.overlap.has(id)) session.overlap.set(id, now);
    else if (now - session.overlap.get(id) >= DWELL_MS) ok.add(id);
  }
  return ok;
}

/** 把 anchors（固定对象数组，通常是新放置或正在拖动的对象）周围重叠的实体对象推开。
 * anchors 中的对象自身不会被移动。
 * exclude：可选 Set——这些 id 的对象**绝不参与推挤**（既不被推、也不计入残留重叠），
 * 用于 Ctrl+拖动复制时保护复制源：副本刚克隆时与源完全重叠，拖动期间源对象保持原位。
 * session：可选拖拽会话（createPushSession）——启用停留判定（持续重叠 ≥DWELL_MS 才推，
 * session.final=true 时跳过停留立即推挤）并记录被推对象的拖动前坐标供回弹；null 时行为与旧版一致。
 * 返回 { moved, left }：moved=被推开的对象数；left=涉及本次推挤的残留重叠对数 */
export function resolveOverlaps(anchors, maxRounds = MAX_ROUNDS, exclude = null, session = null) {
  const fixed = new Set(anchors.map(o => o.id));
  const moved = new Set();
  let solids = state.project.objects.filter(isSolid);
  if (!solids.length) return { moved: 0, left: 0 };
  const involved = new Set(fixed); // 锚 + 被推对象（left 统计范围）
  const anchorIds = new Set(fixed);

  // 停留判定（仅拖拽会话且非落点结算时）：与锚的直接冲突需持续重叠 ≥DWELL_MS 才推挤
  const dwellOk = (session && !session.final)
    ? updateDwell(session, anchors, exclude, anchorIds, solids, Date.now()) : null;

  for (let r = 0; r < maxRounds; r++) {
    const grid = buildGrid(solids);
    const fixedList = solids.filter(o => fixed.has(o.id)); // 活列表：本轮新安置的对象会追加，后续对象立即可见
    if (!fixedList.length) break;
    // 冲突对象集合：与任一固定对象重叠的非固定对象（通过空间哈希局部查找）
    const conflicted = new Set();
    for (const f of fixedList) {
      const fIsAnchor = anchorIds.has(f.id);
      for (const o of neighbors(grid, f)) {
        if (!fixed.has(o.id) && !(exclude && exclude.has(o.id))) {
          // 停留判定：尚未推过的对象与锚的冲突需持续停留才推；级联冲突/已推对象立即处理
          if (fIsAnchor && dwellOk && !dwellOk.has(o.id) && !session.pushed.has(o.id)) continue;
          if (rectOverlap(f, o)) conflicted.add(o);
        }
      }
    }
    if (!conflicted.size) break;
    let any = false;
    for (const o of conflicted) {
      // 取与 o 重叠的固定对象中“最小分离向量”的一对，用其方向作为搜索轴
      let best = null, bestLen = Infinity;
      for (const f of fixedList) {
        const p = rectOverlap(f, o);
        if (p) {
          const len = Math.abs(p.x) + Math.abs(p.y);
          if (len < bestLen) { bestLen = len; best = p; }
        }
      }
      if (!best) continue;
      let mv = null;
      const bl = Math.hypot(best.x, best.y) || 1;
      const ax = best.x / bl, ay = best.y / bl;
      if (ax === 0 || ay === 0) { // 轴对齐（常规 90° 旋转）：沿轴向搜索空闲位，垂直方向兜底
        mv = nearestFreeOn(o, fixedList, Math.round(ax), Math.round(ay));
        if (!mv) mv = nearestFreeOn(o, fixedList, Math.round(-ay), Math.round(ax));
      } else {
        mv = { x: best.x, y: best.y }; // 斜向（非常规旋转角）：退回最小分离向量
      }
      if (!mv) mv = best; // 密集兜底：按最小分离向量直接推（可能仍残留）
      if (session && !session.pushed.has(o.id)) session.pushed.set(o.id, { x: o.x, y: o.y }); // 记录拖动前坐标供回弹
      o.x += mv.x; o.y += mv.y;
      moved.add(o.id);
      involved.add(o.id);
      fixed.add(o.id); // 推过即安置：后续轮不再被推回（无震荡）
      fixedList.push(o); // 本轮后续对象的搜索立即看到新安置对象，避免落位重叠
      any = true;
    }
    if (!any) break;
  }

  // 残留重叠统计：仅统计“锚 + 被推对象”涉及的对（空间哈希局部查找）；exclude 对象的重叠不计入
  solids = state.project.objects.filter(isSolid);
  const grid = buildGrid(solids);
  let left = 0;
  const seen = new Set();
  for (const o of solids) {
    if (!involved.has(o.id)) continue;
    for (const nb of neighbors(grid, o)) {
      if (nb === o) continue;
      if (exclude && exclude.has(nb.id)) continue;
      const k = o.id < nb.id ? o.id + '|' + nb.id : nb.id + '|' + o.id;
      if (seen.has(k)) continue;
      if (rectOverlap(o, nb)) { left++; seen.add(k); }
    }
  }
  return { moved: moved.size, left };
}
