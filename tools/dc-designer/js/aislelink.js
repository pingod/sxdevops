/** 通道宽联动：调整通道带「通道宽」(props.d) 时，机柜位置自动跟随调整。
 * 规则（单侧锚定，dir=+1 默认）：西/南侧排不动，远侧整排平移 Δ（Δ = 新宽 − 旧宽）——
 *  - 通道带自身近侧边锚定：中心平移 Δ/2（仅向远侧伸缩），调整后仍对齐两排实际间距，无需再手动移通道；
 *  - 远侧最近一整排（含排内列间空调）平移 Δ；
 *  - 多排 POD 级联：远侧排之外依附的通道带一并平移 Δ、其远侧排继续联动（其余通道宽度保持不变）；
 *  - 并列通道带（同一物理通道、同一两排之间的其他通道带）宽度同步 ±Δ、中心平移 Δ/2，
 *    避免并列标注与实测间距脱节（也避免格式刷逐条刷并列通道带时重复联动）；
 *  - 移动后按互斥规则推开沿途无关实体（resolveOverlaps 级联）；通道内风口等不随排平移。
 * dir=-1 为镜像规则（拖拽近侧边时）：东/北侧排不动，近侧整排平移 −Δ，通道带中心平移 −Δ/2。
 * 识别纯几何化（rotation 朝向类 + 边缘贴合容差 + 沿排跨度相交），不依赖生成历史，旧项目零迁移。
 * 入口（调用方先完成赋值与 pushUndo，联动与赋值同一撤销单元）：
 *  - 属性面板修改「通道宽」（props.js onChange）
 *  - 格式刷刷通道带（tools.js applyBrush）
 *  - 拖拽通道带两侧边调宽（tools.js resizeAisle，dir 由被拖边决定） */
import { state } from './state.js';
import { resolveOverlaps } from './collision.js';
import { groupRows, rotClass } from './rowops.js';
import { t } from './i18n.js';

/** 边缘贴合容差(mm)：机柜/通道带边缘与目标边缘间隙绝对值 ≤ 该值视为依附（覆盖手工摆放误差） */
const EDGE_TOL = 300;

const KEY = 'idc2d_aisle_link_v1'; // localStorage 全局开关持久化键
let enabledMem = null;             // 运行期显式设置（优先于 localStorage；Node 测试可直接控制）

/** 联动开关（默认开） */
export function aisleLinkEnabled() {
  if (enabledMem !== null) return enabledMem;
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? true : v === '1';
  } catch (e) { return true; } // Node/隐私模式：默认开
}

/** 设置联动开关并持久化 */
export function setAisleLinkEnabled(v) {
  enabledMem = !!v;
  try { localStorage.setItem(KEY, enabledMem ? '1' : '0'); } catch (e) { /* 存储不可用时忽略 */ }
}

/** 通道跨排轴：rotation 类 0（带沿 X 延伸）→ 'y'；类 90（带沿 Y 延伸）→ 'x'；非常规角度 → null */
function crossAxisOf(cls) { return cls === 0 ? 'y' : cls === 90 ? 'x' : null; }

/** 对象沿排方向跨度 [lo, hi]（正交布局下：沿排轴半宽 = props.w，跨排轴半宽 = props.d） */
function spanOf(o, along) { const h = (o.props.w || 0) / 2; return [o[along] - h, o[along] + h]; }

function rowSpan(row, along) {
  let lo = Infinity, hi = -Infinity;
  for (const c of row) { const s = spanOf(c, along); lo = Math.min(lo, s[0]); hi = Math.max(hi, s[1]); }
  return [lo, hi];
}

/** 跨度相交（50mm 容差） */
const spanOverlap = (a, b) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]) >= -50;

/** 对象 o（机柜/通道带）边缘到通道带边缘的间隙：|中心距| − 各自跨排半宽；负值 = 侵入 */
function edgeGap(band, o, axis) {
  return Math.abs(o[axis] - band[axis]) - (band.props.d || 0) / 2 - (o.props.d || 0) / 2;
}

/** 找通道带指定侧（side=+1 远侧=东/北，-1 近侧=西/南）最近的一整排：
 * 同 rotation 类、中心在指定侧、沿排跨度相交、排内有成员边缘贴合。 */
function nearestRowOnSide(band, rows, cls, side, axis, exclude) {
  const along = axis === 'y' ? 'x' : 'y';
  const bs = spanOf(band, along);
  let best = null, bestDist = Infinity;
  for (const row of rows) {
    if (!row.length || (exclude && exclude.has(row))) continue;
    if (rotClass(row[0]) !== cls) continue;
    const rc = row[0][axis]; // 排中心线（聚类保证 ±50mm 共线）
    if (side > 0 ? rc <= band[axis] : rc >= band[axis]) continue;
    if (!spanOverlap(bs, rowSpan(row, along))) continue;
    if (!row.some(c => Math.abs(edgeGap(band, c, axis)) <= EDGE_TOL)) continue;
    const dist = Math.abs(rc - band[axis]);
    if (dist < bestDist) { bestDist = dist; best = row; }
  }
  return best;
}

/** 找依附在排指定侧（dir=+1 远侧=东/北，-1 近侧=西/南）之外的其他通道带：
 * 中心在排该侧、边缘贴合排内成员、沿排跨度相交 */
function bandsBeyondRow(row, cls, axis, excludeIds, dir = 1) {
  const along = axis === 'y' ? 'x' : 'y';
  const rs = rowSpan(row, along);
  const rc = row[0][axis];
  const out = [];
  for (const b of state.project.objects) {
    if (b.type !== 'aisle' || excludeIds.has(b.id) || rotClass(b) !== cls) continue;
    if (dir > 0 ? b[axis] <= rc : b[axis] >= rc) continue;
    if (!spanOverlap(rs, spanOf(b, along))) continue;
    if (!row.some(c => Math.abs(edgeGap(b, c, axis)) <= EDGE_TOL)) continue;
    out.push(b);
  }
  return out;
}

/** 通道宽联动主入口。调用方须已把 aisle.props.d 改为新值并完成 pushUndo（同一撤销单元）。
 * @param {object} aisle 被修改的通道带
 * @param {number} oldD 修改前通道宽(mm)
 * @param {number} [dir=1] 联动方向：+1=近侧（西/南）锚定、远侧整排平移 +Δ；
 *   -1=镜像（远侧锚定、近侧整排平移 −Δ，拖拽近侧边调宽时使用）
 * @returns {object|null} null=未联动（开关关闭 / Δ=0）；
 *   { unsupported:true }=非常规角度；{ noRow:true, delta, dir }=联动侧无机柜排（仅改标注）；
 *   否则 { delta, dir, rows, cabs, followBands, syncBands, pushed, left } */
export function syncAisleWidth(aisle, oldD, dir = 1) {
  if (!aisleLinkEnabled()) return null;
  const delta = (aisle.props.d || 0) - oldD;
  if (!delta) return null;
  const cls = rotClass(aisle);
  const axis = crossAxisOf(cls);
  if (!axis) return { unsupported: true };
  const along = axis === 'y' ? 'x' : 'y';
  const rows = groupRows();
  // 依附识别基于“修改前”几何：通道带半宽取旧值（一次改宽超过 2×容差时新宽度会把排推出识别范围）
  const band0 = { ...aisle, props: { ...aisle.props, d: oldD } };

  // ① 收集级联（全部基于移动前几何，统一平移 dir·Δ）：联动侧整排 → 排外依附通道带 → 其外侧整排 → …
  const moveRows = [], moveBands = [];
  const seenRow = new Set(), seenBand = new Set([aisle.id]);
  const firstFar = nearestRowOnSide(band0, rows, cls, dir, axis, null);
  if (!firstFar) return { noRow: true, delta, dir };
  const queue = [firstFar];
  while (queue.length) {
    const row = queue.pop();
    if (seenRow.has(row)) continue;
    seenRow.add(row); moveRows.push(row);
    for (const b of bandsBeyondRow(row, cls, axis, seenBand, dir)) {
      seenBand.add(b.id); moveBands.push(b);
      const r2 = nearestRowOnSide(b, rows, cls, dir, axis, seenRow);
      if (r2) queue.push(r2);
    }
  }

  // ② 并列通道带：同一两排之间、与所调通道沿排跨度相交的其他通道带，宽度同步 Δ、中心平移 dir·Δ/2
  const syncBands = [];
  const anchor = nearestRowOnSide(band0, rows, cls, -dir, axis, null);
  if (anchor) {
    const lo = anchor[0][axis], hi = firstFar[0][axis];
    const as = spanOf(aisle, along);
    for (const b of state.project.objects) {
      if (b.type !== 'aisle' || seenBand.has(b.id) || rotClass(b) !== cls) continue;
      if (b[axis] <= lo || b[axis] >= hi) continue; // 须位于同一两排之间
      if (!spanOverlap(as, spanOf(b, along))) continue;
      if (!anchor.some(c => Math.abs(edgeGap(b, c, axis)) <= EDGE_TOL)) continue;
      if (!firstFar.some(c => Math.abs(edgeGap(b, c, axis)) <= EDGE_TOL)) continue;
      syncBands.push(b);
    }
  }

  // ③ 应用平移：通道带自身锚定侧边不动（中心平移 dir·Δ/2，对齐两排实际间距）；
  //    联动侧机柜整排 + 排内列间空调平移 dir·Δ；依附通道带平移 dir·Δ；并列通道带调宽 Δ + 移心 dir·Δ/2
  aisle[axis] += dir * delta / 2;
  const moved = [], movedIds = new Set();
  for (const row of moveRows) {
    const rc = row[0][axis]; // 原中心线（移动前取）
    for (const c of row) { c[axis] += dir * delta; moved.push(c); movedIds.add(c.id); }
    for (const o of state.project.objects) { // 列间空调在排内，随行平移
      if (o.type === 'ac' && o.props && o.props.kind === 'row' && !movedIds.has(o.id) &&
          rotClass(o) === cls && Math.abs(o[axis] - rc) <= 50) {
        o[axis] += dir * delta; moved.push(o); movedIds.add(o.id);
      }
    }
  }
  for (const b of moveBands) b[axis] += dir * delta;
  for (const b of syncBands) { b.props.d = Math.max(100, (b.props.d || 0) + delta); b[axis] += dir * delta / 2; }

  // ④ 移动后互斥：以移动对象为锚，推开沿途重叠的无关实体（相邻 POD/柱子/风口等）
  const r = resolveOverlaps(moved);
  return {
    delta, dir, rows: moveRows.length,
    cabs: moved.filter(o => o.type === 'cabinet').length,
    followBands: moveBands.length, syncBands: syncBands.length,
    pushed: r.moved, left: r.left,
  };
}

/** 联动结果提示文案（属性面板 / 格式刷共用） */
export function aisleLinkHint(r) {
  if (!r) return '';
  if (r.unsupported) return t('hint.linkUnsupported');
  if (r.noRow) return t('hint.linkNoRow');
  let s = t('hint.linkWiden', {
    dir: t(r.delta > 0 ? 'dir.widen' : 'dir.narrow'),
    side: t((r.dir || 1) > 0 ? 'dir.far' : 'dir.near'),
    d: Math.abs(r.delta), r: r.rows, c: r.cabs,
  });
  if (r.followBands) s += t('hint.linkFollow', { n: r.followBands });
  if (r.syncBands) s += t('hint.linkSync', { n: r.syncBands });
  if (r.pushed) s += t('hint.linkPushed', { n: r.pushed });
  if (r.left) s += t('hint.linkLeft', { n: r.left });
  return s;
}
