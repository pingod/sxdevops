/** 交互工具：选择/移动、墙体绘制、门窗放置、柱子/机柜放置、格式刷、缩放平移、快捷键 */
import {
  state, runtime, ui, s2w, snapVal, pushUndo, markDirty,
  getObj, autoName, deleteObjects, undo, redo, revertLastUndo, TYPE_NAMES,
  defaultProps, notePropEdit,
} from './state.js';
import { uid, clamp, dist2seg, wallLen, beamEnds, pointInRotRect, segIntersectsRect, isSolid, grilleSnapAC } from './geo.js';
import { resolveOverlaps, createPushSession, springBack } from './collision.js';
import { syncAisleWidth, aisleLinkHint } from './aislelink.js';
import { rotClass } from './rowops.js';
import * as ctxmenu from './ctxmenu.js';
import { parseTemplate, renderTpl, lettersSeq, lettersAt, escRe } from './naming.js';
import { t } from './i18n.js';
import { isDevice } from './device.js';
import { pipeDown, pipeCandidates, pipeVisible, commitTypedPipe } from './pipe-tools.js';
import { normalizePipe, translatePipe, rotatePipe, pipeGeometry, pipeFormat, remapPipePairs } from './pipe-geometry.js';

/** 各工具状态栏提示的 i18n 键（实际文案经 t() 取当前语言） */
const HINTS = {
  select: 'hint.tool.select',
  brush: 'hint.tool.brush',
  wall: 'hint.tool.wall',
  tray: 'hint.tool.tray',
  pipe: 'hint.tool.pipe',
  door: 'hint.tool.door',
  window: 'hint.tool.window',
  grille: 'hint.tool.grille',
  column: 'hint.tool.column',
  beam: 'hint.tool.beam',
  cabinet: 'hint.tool.cabinet',
  pdu: 'hint.tool.pdu',
  dbox: 'hint.tool.dbox',
  ac: 'hint.tool.ac',
  ups: 'hint.tool.ups',
  battery: 'hint.tool.battery',
  extinguisher: 'hint.tool.extinguisher',
  vent: 'hint.tool.vent',
  cabrow: 'hint.tool.cabrow',
  cabpod: 'hint.tool.cabpod',
};

export function setTool(tool) {
  state.tool = tool;
  runtime.drawing = null;
  runtime.hoverOpening = null;
  runtime.rubber = null;
  runtime.brush = null;
  if (tool === 'brush') { // 格式刷：已单选对象时直接作为属性源，否则进入待拾取状态
    const src = getObj(state.selectedId);
    runtime.brush = { sourceId: src ? src.id : null };
    ui.hint(src ? brushPickedHint(src) : t(HINTS.brush));
  } else {
    ui.hint(t(HINTS[tool] || ''));
  }
  ui.syncTool(tool);
  if (tool === 'pipe') state.selectedIds = [];
  ui.props();
  ui.render();
}

/** 语言切换后重发当前工具的提示（main.js 的 onLocaleChange 调用） */
export function rehint() {
  if (state.tool === 'brush' && runtime.brush && runtime.brush.sourceId) {
    const src = getObj(runtime.brush.sourceId);
    if (src) { ui.hint(brushPickedHint(src)); return; }
  }
  ui.hint(t(HINTS[state.tool] || ''));
}

/** 格式刷拾取源后的状态栏提示 */
function brushPickedHint(src) {
  return t('hint.brushPicked', {
    type: TYPE_NAMES[src.type] || src.type,
    name: src.props.name || '',
  });
}

/* ---------- 命中测试 ---------- */
export function hitTest(wx, wy) {
  const tol = 6 / state.view.scale;
  const sel = getObj(state.selectedId);
  // 选中墙体/桥架/框架梁的端点手柄优先（梁端点随附着柱动态求解）
  if (sel && (sel.type === 'wall' || sel.type === 'tray' || sel.type === 'beam' || (sel.type === 'pipe' && pipeVisible(sel) && pipeGeometry(sel).kind !== 'vertical'))) {
    const ends = sel.type === 'beam' ? beamEnds(sel, getObj) : sel;
    for (const end of ['p1', 'p2']) {
      const px = end === 'p1' ? ends.x1 : ends.x2;
      const py = end === 'p1' ? ends.y1 : ends.y2;
      if (Math.hypot(wx - px, wy - py) <= 8 / state.view.scale) {
        return { type: 'handle', obj: sel, end };
      }
    }
  }
  // 单选通道带的边中点手柄优先（拖拽调整通道宽/长）
  if (sel && sel.type === 'aisle') {
    for (const h of aisleHandles(sel)) {
      if (Math.hypot(wx - h.x, wy - h.y) <= 8 / state.view.scale) {
        return { type: 'handle', obj: sel, end: h.end };
      }
    }
  }
  const pipes = pipeCandidates(wx, wy);
  if (pipes.length) return { type: 'obj', obj: pipes.find(o=>o.id===state.selectedId) || pipes[0] };
  const objs = state.project.objects;
  // 自上而下：机柜/柱子 → 门窗 → 墙体
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if ((isDevice(o) || o.type === 'column' || o.type === 'aisle') && pointInRotRect(wx, wy, o)) {
      return { type: 'obj', obj: o };
    }
  }
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o.type !== 'door' && o.type !== 'window' && o.type !== 'grille') continue;
    const w = getObj(o.wallId);
    if (!w) continue;
    const L = wallLen(w);
    if (L < 1) continue;
    const c = o.t * L, half = (o.props.width || 900) / 2;
    const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
    const { d } = dist2seg(wx, wy,
      w.x1 + ux * (c - half), w.y1 + uy * (c - half),
      w.x1 + ux * (c + half), w.y1 + uy * (c + half));
    if (d <= Math.max(tol, (w.props.thickness || 240) / 2)) return { type: 'obj', obj: o };
  }
  for (let i = objs.length - 1; i >= 0; i--) { // 桥架（窄目标，优先于墙体命中）
    const o = objs[i];
    if (o.type !== 'tray') continue;
    const { d } = dist2seg(wx, wy, o.x1, o.y1, o.x2, o.y2);
    if (d <= Math.max(tol, (o.props.width || 300) / 2)) return { type: 'obj', obj: o };
  }
  for (let i = objs.length - 1; i >= 0; i--) { // 框架梁（窄目标，同桥架优先级；端点随附着柱求解）
    const o = objs[i];
    if (o.type !== 'beam') continue;
    const e = beamEnds(o, getObj);
    const { d } = dist2seg(wx, wy, e.x1, e.y1, e.x2, e.y2);
    if (d <= Math.max(tol, (o.props.b || 300) / 2)) return { type: 'obj', obj: o };
  }
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o.type !== 'wall') continue;
    const { d } = dist2seg(wx, wy, o.x1, o.y1, o.x2, o.y2);
    if (d <= Math.max(tol, (o.props.thickness || 240) / 2)) return { type: 'obj', obj: o };
  }
  return null;
}

/** 找最近墙体（用于门窗放置） */
function nearestWall(wx, wy) {
  let best = null;
  for (const o of state.project.objects) {
    if (o.type !== 'wall') continue;
    const { d, t } = dist2seg(wx, wy, o.x1, o.y1, o.x2, o.y2);
    if (!best || d < best.d) best = { wall: o, d, t };
  }
  return best && best.d <= Math.max(400, 14 / state.view.scale) ? best : null;
}

/* ---------- 鼠标事件 ---------- */
export function pointerDown(sx, sy, e) {
  if (e.button === 1 || (e.button === 0 && runtime.spacePan)) { // 平移
    runtime.panning = { sx, sy };
    return;
  }
  if (e.button !== 0) return;
  const { x: wx, y: wy } = s2w(sx, sy);
  switch (state.tool) {
    case 'select': selectDown(wx, wy, e); break;
    case 'brush': brushDown(wx, wy); break;
    case 'wall': case 'tray': lineDown(wx, wy, e); break;
    case 'pipe': pipeDown(wx, wy, e); break;
    case 'beam': beamDown(wx, wy, e); break;
    case 'door': case 'window': case 'grille': openingDown(wx, wy); break;
    case 'column': placeRect(wx, wy, 'column'); break;
    case 'cabinet': placeRect(wx, wy, 'cabinet'); break;
    case 'pdu': placeRect(wx, wy, 'pdu'); break;
    case 'dbox': placeRect(wx, wy, 'dbox'); break;
    case 'ac': placeRect(wx, wy, 'ac'); break;
    case 'ups': placeRect(wx, wy, 'ups'); break;
    case 'battery': placeRect(wx, wy, 'battery'); break;
    case 'extinguisher': placeRect(wx, wy, 'extinguisher'); break;
    case 'vent': placeRect(wx, wy, 'vent'); break;
    case 'cabrow': placeCabRow(wx, wy); break;
    case 'cabpod': placeCabPod(wx, wy); break;
  }
}

export function pointerMove(sx, sy, e) {
  const { x: wx, y: wy } = s2w(sx, sy);
  runtime.mouse = { sx, sy, wx, wy };
  runtime.shiftKey = !!e.shiftKey;
  runtime.altKey = !!e.altKey;
  ui.coords(wx, wy);

  if (runtime.panning) {
    state.view.ox += sx - runtime.panning.sx;
    state.view.oy += sy - runtime.panning.sy;
    runtime.panning = { sx, sy };
    ui.render();
    return;
  }
  if (runtime.rubber) { // 框选中：更新选框
    runtime.rubber.x1 = wx; runtime.rubber.y1 = wy;
    ui.render();
    return;
  }
  const d = runtime.drag;
  if (d) {
    if (!d.started) {
      if (d.kind === 'copy' && Math.hypot(wx - d.startWX, wy - d.startWY) * state.view.scale < 4) return; // 微小移动=误触，仍视为 Ctrl 单击（加减选）
      d.started = true;
      clearTimeout(runtime.lpTimer); runtime.lpTimer = null; // 拖起即取消长按
      runtime.rulerObj = null; // 长按标尺让位拖动实时标尺
      pushUndo(); // 首次移动才记录撤销（复制模式在快照后克隆，Ctrl+Z 可一步撤销）
      if (d.kind === 'copy') d.items = cloneSelectedForDrag(d); // Ctrl+拖动复制：克隆选中对象后拖动副本
      else if (d.kind === 'resize') d.snap = snapshotGeo(); // 通道调尺寸：联动每帧从快照重放
      if (d.kind === 'move' || d.kind === 'copy') {
        // 停留判定需要“鼠标停住”也能推进：定时轮询碰撞管线（无 move 事件时兜底）
        clearInterval(runtime.dragTick);
        runtime.dragTick = setInterval(dragCollideTick, 100);
      }
    }
    if (d.kind === 'handle') {
      // 端点拉伸：网格捕捉优先，候选对齐线吸附（排除自身后的其他对象线）
      let x = snapVal(wx), y = snapVal(wy);
      const lines = { v: [], h: [] };
      const cand = runtime.guideCand;
      if (cand) {
        const eps = 8 / state.view.scale;
        let bx = null, by = null;
        for (const c of cand.v) if (Math.abs(c - x) <= eps && (bx === null || Math.abs(c - x) < Math.abs(bx - x))) bx = c;
        for (const c of cand.h) if (Math.abs(c - y) <= eps && (by === null || Math.abs(c - y) < Math.abs(by - y))) by = c;
        if (bx !== null) { x = bx; lines.v.push(bx); }
        if (by !== null) { y = by; lines.h.push(by); }
      }
      runtime.guides = (lines.v.length || lines.h.length) ? lines : null;
      if (d.obj.type === 'pipe') {
        const i = d.end === 'p1' ? 1 : 2;
        try { Object.assign(d.obj, normalizePipe({ ...d.obj, ['x'+i]:x, ['y'+i]:y })); }
        catch { return; }
      } else if (d.end === 'p1') { d.obj.x1 = x; d.obj.y1 = y; }
      else { d.obj.x2 = x; d.obj.y2 = y; }
      if (d.obj.type === 'beam') { // 梁端点重挂：落入柱范围即附着到柱心，否则脱离为自由端
        const col = columnAt(x, y);
        if (d.end === 'p1') {
          d.obj.col1 = col ? col.id : null;
          if (col) { d.obj.x1 = col.x; d.obj.y1 = col.y; }
        } else {
          d.obj.col2 = col ? col.id : null;
          if (col) { d.obj.x2 = col.x; d.obj.y2 = col.y; }
        }
      }
    } else if (d.kind === 'resize') {
      resizeAisle(d, wx, wy); // 通道带边拖拽：调宽（联动机柜）/调长
    } else {
      moveObject(d, wx, wy);
      // 对象互斥：拖动中的实体对象为固定锚。停留判定（持续重叠≥150ms 才推，掠过不推）+ 回弹（离开即复位）
      if (d.kind === 'move' || d.kind === 'copy') {
        const anchors = d.items.map(it => it.obj).filter(isSolid);
        // 复制模式：复制源列入免推挤名单——副本刚克隆时与源完全重叠，拖动期间源对象保持原位
        springBack(d.session, anchors);
        resolveOverlaps(anchors, undefined, d.kind === 'copy' ? new Set(d.srcIds) : null, d.session);
      }
    }
    markDirty({ props: false });
    return;
  }
  if (state.tool === 'door' || state.tool === 'window' || state.tool === 'grille') {
    runtime.hoverOpening = nearestWall(wx, wy);
    ui.render();
  } else if (state.tool === 'select') {
    ui.cursor(aisleHandleCursor(wx, wy)); // 悬停通道带手柄：显示调整尺寸光标
  } else {
    ui.render(); // 放置预览 / 橡皮筋
  }
}

export function pointerUp() {
  runtime.panning = null;
  if (runtime.lpTimer) { clearTimeout(runtime.lpTimer); runtime.lpTimer = null; } // 未滿 500ms 松手=普通单击
  if (runtime.rulerObj) { runtime.rulerObj = null; ui.render(); } // 长按标尺松手即隐
  if (runtime.rubber) { // 完成框选（微小拖动视为单击空白）
    const r = runtime.rubber;
    runtime.rubber = null;
    const small = Math.abs(r.x1 - r.x0) * state.view.scale < 4 &&
      Math.abs(r.y1 - r.y0) * state.view.scale < 4;
    if (r.brush) { // 格式刷框选：批量应用到框内全部同类型对象
      if (small) return; // 微小拖动=误触，保持格式刷状态
      const b = runtime.brush;
      const src = b && b.sourceId ? getObj(b.sourceId) : null;
      if (!src) return;
      const targets = boxSelect(r).map(getObj)
        .filter(o => o && o.id !== src.id && o.type === src.type);
      if (!targets.length) {
        ui.hint(t('hint.brushNoTarget', { type: TYPE_NAMES[src.type] || src.type }));
        return;
      }
      applyBrush(src, targets);
      return;
    }
    if (small) {
      if (!r.add && state.selectedIds.length) {
        state.selectedIds = []; ui.props(); ui.render();
      }
      return;
    }
    const ids = boxSelect(r);
    state.selectedIds = r.add ? [...new Set([...state.selectedIds, ...ids])] : ids;
    ui.props(); ui.render();
    ui.hint(ids.length ? t('hint.boxSelN', { n: state.selectedIds.length }) : t('hint.boxSelNone'));
    return;
  }
  if (runtime.drag) {
    const d = runtime.drag;
    const moved = d.started;
    runtime.drag = null;
    runtime.guides = null;
    clearInterval(runtime.dragTick); runtime.dragTick = null;
    if (d.kind === 'copy') {
      if (!moved) { // Ctrl 单击（未拖动）：保持加选/减选语义
        const i = state.selectedIds.indexOf(d.hitObj.id);
        if (i >= 0) state.selectedIds.splice(i, 1); else state.selectedIds.push(d.hitObj.id);
        ui.props(); ui.render();
      } else { // Ctrl+拖动复制完成
        const anchors = d.items.map(it => it.obj).filter(isSolid);
        springBack(d.session, anchors); // 路径上已推开且落点已空出的对象先回弹
        // 落点按常规互斥规则收尾（立即推挤、不做停留判定）：仅当副本最终仍与源重叠时源才被推开一次
        resolveOverlaps(anchors, undefined, null, { ...d.session, final: true });
        const n = d.session.pushed.size; // 最终实际被推开（未回弹）的对象数
        markDirty(); // 结束后刷新属性面板坐标
        ui.hint(t('hint.copied', { n: d.items.length }) +
          (n ? t('hint.pushedN', { n }) : '') +
          t('hint.undoable'));
      }
      return;
    }
    if (moved) {
      markDirty(); // 结束后刷新属性面板坐标
      if (d.kind === 'move') {
        // 松手最后一次回弹：仍被压住的对象保持推开（插入语义）；n=最终实际被推开的对象数
        if (d.session) springBack(d.session, d.items.map(it => it.obj).filter(isSolid));
        const n = d.session ? d.session.pushed.size : 0;
        ui.hint(n > 0 ? t('hint.movePushed', { n }) : t('hint.moveDone'));
      } else if (d.kind === 'resize' && d.lastDelta) { // 通道调尺寸：联动结果提示（含未联动原因）
        ui.hint(d.linkR ? aisleLinkHint(d.linkR) : t('hint.aisleResized'));
      }
    }
  }
}

/** 框选命中：墙体/桥架=线段与选框相交；门窗=中心点在选框内；机柜/柱子=包围盒相交 */
function boxSelect(r) {
  const rx0 = Math.min(r.x0, r.x1), rx1 = Math.max(r.x0, r.x1);
  const ry0 = Math.min(r.y0, r.y1), ry1 = Math.max(r.y0, r.y1);
  const ids = [];
  for (const o of state.project.objects) {
    if (o.type === 'pipe') {
      if (!pipeVisible(o)) continue;
      const r = pipeGeometry(o).outerRadius;
      if (segIntersectsRect(o.x1,o.y1,o.x2,o.y2,rx0-r,ry0-r,rx1+r,ry1+r)) ids.push(o.id);
    } else if (o.type === 'wall' || o.type === 'tray') {
      if (segIntersectsRect(o.x1, o.y1, o.x2, o.y2, rx0, ry0, rx1, ry1)) ids.push(o.id);
    } else if (o.type === 'beam') { // 框架梁：端点随附着柱求解后按线段判定
      const e = beamEnds(o, getObj);
      if (segIntersectsRect(e.x1, e.y1, e.x2, e.y2, rx0, ry0, rx1, ry1)) ids.push(o.id);
    } else if (o.type === 'door' || o.type === 'window' || o.type === 'grille') {
      const w = getObj(o.wallId);
      if (!w) continue;
      const L = wallLen(w);
      if (L < 1) continue;
      const cx = w.x1 + (w.x2 - w.x1) * o.t, cy = w.y1 + (w.y2 - w.y1) * o.t;
      if (cx >= rx0 && cx <= rx1 && cy >= ry0 && cy <= ry1) ids.push(o.id);
    } else { // 机柜/柱子：旋转矩形包围盒与选框相交
      const rad = (o.rotation || 0) * Math.PI / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      const hw = (o.props.w || 600) / 2, hd = (o.props.d || 600) / 2;
      let minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
      for (const [lx, ly] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
        const px = o.x + lx * c - ly * s, py = o.y + lx * s + ly * c;
        if (px < minx) minx = px; if (px > maxx) maxx = px;
        if (py < miny) miny = py; if (py > maxy) maxy = py;
      }
      if (minx <= rx1 && maxx >= rx0 && miny <= ry1 && maxy >= ry0) ids.push(o.id);
    }
  }
  return ids;
}

export function dblClick() {
  if ((state.tool === 'wall' || state.tool === 'tray' || state.tool === 'beam' || state.tool === 'pipe') && runtime.drawing) {
    runtime.drawing = null;
    ui.hint(t(HINTS[state.tool]));
    ui.render();
  }
}

export function rightClick(sx, sy) {
  if (runtime.drawing) { // 墙体/桥架绘制中：右键结束绘制
    runtime.drawing = null;
    ui.hint(t(HINTS[state.tool] || ''));
    ui.render();
    return;
  }
  if (state.tool !== 'select') return;
  // 选择工具：右键对象弹出快速操作菜单（属性/改名、替换为、重排、空位补插、删除）
  const { x: wx, y: wy } = s2w(sx, sy);
  const hit = hitTest(wx, wy);
  if (hit && hit.type === 'obj') ctxmenu.openMenu(sx, sy, hit);
}

export function wheel(sx, sy, e) {
  zoomAt(sx, sy, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}

export function zoomAt(sx, sy, factor) {
  const v = state.view;
  const ns = clamp(v.scale * factor, 0.004, 2);
  // 保持鼠标下的世界坐标不动（Y 轴向上）
  const wx = (sx - v.ox) / v.scale, wy = (v.oy - sy) / v.scale;
  v.ox = sx - wx * ns; v.oy = sy + wy * ns; v.scale = ns;
  ui.render();
  ui.zoom(ns);
}

/* ---------- 各工具实现 ---------- */
function selectDown(wx, wy, e) {
  runtime.nudgeRuler = null; // 鼠标接管交互，微调标尺即隐
  const hit = hitTest(wx, wy);
  if (hit && (e.shiftKey || e.ctrlKey || e.metaKey) && hit.type === 'obj') {
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) { // Shift 单击：加选/减选（立即生效）
      const i = state.selectedIds.indexOf(hit.obj.id);
      if (i >= 0) state.selectedIds.splice(i, 1); else state.selectedIds.push(hit.obj.id);
      ui.props(); ui.render();
      return;
    }
    // Ctrl/Meta 按下对象：延迟判定——未拖动=加选/减选；拖动=复制（克隆选中组后拖动副本）
    const inSel = state.selectedIds.includes(hit.obj.id);
    runtime.drag = {
      kind: 'copy', startWX: wx, startWY: wy, started: false,
      hitObj: hit.obj, hitInSel: inSel,
      srcIds: inSel ? [...state.selectedIds] : [hit.obj.id], // 复制源：命中对象在选择内则整组复制，否则只复制它
      items: [],
      session: createPushSession(), // 推挤会话：停留判定 + 回弹
    };
    runtime.guideCand = collectGuides(runtime.drag.srcIds); // 复制源不参与吸附，副本不会被吸回原位
    runtime.guides = null;
    return;
  }
  if (!hit) { // 空白处按下：开始框选（Shift/Ctrl=在现有选择上追加）
    runtime.rubber = { x0: wx, y0: wy, x1: wx, y1: wy, add: e.shiftKey || e.ctrlKey || e.metaKey };
    return;
  }
  if (hit.type === 'handle') { // 单选墙体/桥架的端点拉伸、通道带的边拖拽调尺寸
    runtime.drag = hit.obj.type === 'aisle'
      ? {
        kind: 'resize', obj: hit.obj, edge: hit.end, started: false,
        orig: { x: hit.obj.x, y: hit.obj.y, w: hit.obj.props.w || 0, d: hit.obj.props.d || 0 },
      }
      : { kind: 'handle', obj: hit.obj, end: hit.end, started: false };
    runtime.guideCand = collectGuides([hit.obj.id]);
    runtime.guides = null;
    return;
  }
  // 普通单击（未按 Ctrl/Shift）：单选——未选中的对象替换当前选择，只选中它自己；
  // 点击已选中的对象（含多选中的一员）保持选择不变，便于整体拖动
  if (!state.selectedIds.includes(hit.obj.id)) {
    state.selectedIds = [hit.obj.id];
  }
  ui.props(); ui.render();
  // 拖动整体移动所有选中对象（墙体被选中时其上门窗随墙移动，不再重复处理）
  runtime.drag = {
    kind: 'move', startWX: wx, startWY: wy, started: false,
    items: state.selectedIds.map(getObj).filter(Boolean)
      .filter(o => !((o.type === 'door' || o.type === 'window' || o.type === 'grille') && state.selectedIds.includes(o.wallId)))
      .map(o => ({ obj: o, orig: JSON.parse(JSON.stringify(o)) })),
    session: createPushSession(), // 推挤会话：停留判定 + 回弹
  };
  runtime.guideCand = collectGuides(state.selectedIds); // 缓存其他对象的对齐线（拖动期间不变）
  runtime.guides = null;
  // 长按（≥500ms 未拖动）显示该对象四周墙距标尺；拖动/松手即取消
  if (isSolid(hit.obj)) {
    clearTimeout(runtime.lpTimer);
    runtime.lpTimer = setTimeout(() => {
      runtime.lpTimer = null;
      if (state.tool === 'select' && runtime.drag && !runtime.drag.started) {
        runtime.rulerObj = hit.obj.id;
        ui.render();
      }
    }, 500);
  }
}

/** 方向键微调选中对象位置（↑↓←→ 按一下=1mm，Alt+方向键=10mm 加速档）。
 * 平移规则与拖动一致：墙/桥架整体平移；门窗/格栅沿所属墙滑动（步进向量投影到墙方向），
 * 所属墙同被选中时随墙移动不重复处理；实体对象微调时推开沿途重叠对象（同拖动互斥）。
 * 连续微调（同一选中集且间隔 ≤1s）合并为一步撤销。 */
function nudgeSelected(dx, dy) {
  const items = state.selectedIds.map(getObj).filter(Boolean)
    .filter(o => !((o.type === 'door' || o.type === 'window' || o.type === 'grille') && state.selectedIds.includes(o.wallId)));
  if (!items.length) return;
  const now = Date.now();
  const sig = state.selectedIds.join(',');
  if (runtime.nudgeSig !== sig || now - (runtime.nudgeAt || 0) > 1000) pushUndo(); // 新一轮微调才记撤销
  runtime.nudgeSig = sig; runtime.nudgeAt = now;
  for (const o of items) {
    if(o.type==='pipe'){try{Object.assign(o,translatePipe(o,dx,dy));}catch(e){ui.hint(e.message);}continue;}
    if (o.type === 'wall' || o.type === 'tray') { // 整体平移
      o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
    } else if (o.type === 'door' || o.type === 'window' || o.type === 'grille') { // 沿墙滑动
      const w = getObj(o.wallId);
      if (!w) continue;
      const L = wallLen(w);
      if (L < 1) continue;
      const half = (o.props.width || 900) / 2 / L;
      const proj = (dx * (w.x2 - w.x1) + dy * (w.y2 - w.y1)) / L; // 步进向量沿墙分量(mm)
      o.t = clamp(o.t + proj / L, half, 1 - half);
    } else if (o.type === 'beam') { // 框架梁整体平移：端点固化为当前位置并脱离柱（柱不随梁动）
      const e0 = beamEnds(o, getObj);
      o.col1 = o.col2 = null;
      o.x1 = e0.x1 + dx; o.y1 = e0.y1 + dy; o.x2 = e0.x2 + dx; o.y2 = e0.y2 + dy;
    } else { // 机柜/柱子/空调/风口/列头柜/通道带
      o.x += dx; o.y += dy;
    }
  }
  resolveOverlaps(items.filter(isSolid)); // 与拖动同规则：微调的实体为锚，推开沿途重叠对象（级联）
  // 微调期间显示与拖动相同的标尺（红色最近净距+蓝色墙距），停止按键 1s 后自动隐去
  runtime.nudgeRuler = state.selectedIds.slice();
  clearTimeout(runtime.nudgeRulerTimer);
  runtime.nudgeRulerTimer = setTimeout(() => {
    runtime.nudgeRulerTimer = null;
    runtime.nudgeRuler = null;
    ui.render();
  }, 1000);
  markDirty();
  if (!runtime.nudgeHinted) {
    runtime.nudgeHinted = true;
    ui.hint(t('hint.nudge'));
  }
}

/* ---------- Ctrl+拖动复制（克隆选中对象，拖动副本） ---------- */

/** 深拷贝 d.srcIds 对应的对象（新 id；名称去尾号后自动递增避免重名），返回 { obj, orig } 拖动项并选中副本 */
function cloneSelectedForDrag(d) {
  const taken = new Set(state.project.objects.map(o => o.props && o.props.name));
  const used = new Map(); // 基础名 → 本次已分配的最大序号
  const idMap = new Map(); // 原 id → 副本 id（门窗随墙复制时重挂到副本墙）
  const items = [];
  for (const id of d.srcIds) {
    const src = getObj(id);
    if (!src) continue;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid();
    idMap.set(src.id, copy.id);
    if (copy.props && copy.props.name) {
      const base = copy.props.name.replace(/-\d+$/, '');
      let k = (used.get(base) || 0) + 1;
      let cand = base + '-' + k;
      while (taken.has(cand)) { k++; cand = base + '-' + k; }
      used.set(base, k);
      taken.add(cand);
      copy.props.name = cand;
    }
    state.project.objects.push(copy);
    items.push({ obj: copy, orig: JSON.parse(JSON.stringify(copy)) });
  }
  for (const it of items) { // 门窗副本：源墙也一起复制时改挂副本墙，拖动时随墙走
    const o = it.obj;
    if ((o.type === 'door' || o.type === 'window' || o.type === 'grille') && idMap.has(o.wallId)) {
      o.wallId = idMap.get(o.wallId);
    }
  }
  remapPipePairs(items.map(it => it.obj), uid);
  for (const it of items) it.orig = JSON.parse(JSON.stringify(it.obj));
  state.selectedIds = items.map(it => it.obj.id); // 选中副本：松手后可继续整体拖动/旋转/删除
  markDirty();
  return items;
}

/* ---------- 格式刷（把源对象的属性复制到一个/多个同类型对象） ---------- */

/** 格式刷按下：未拾取源→单击对象拾取；已拾取→单击同类型对象应用；空白处按下→框选批量应用 */
function brushDown(wx, wy) {
  const b = runtime.brush;
  if (!b) return;
  const hit = hitTest(wx, wy);
  // handle 命中的 obj 即所选墙体/桥架本身，同样视为对象命中（避免选中源墙后端点手柄区域无法点击）
  const hitObj = hit && (hit.type === 'obj' || hit.type === 'handle') ? hit.obj : null;
  if (b.sourceId && !getObj(b.sourceId)) b.sourceId = null; // 源对象已被删除/撤销 → 重新拾取
  if (!b.sourceId) { // 第一步：拾取属性源
  if (!hitObj) { ui.hint(t('hint.brushPickFirst')); return; }
    b.sourceId = hitObj.id;
    state.selectedId = hitObj.id; // 选中源对象：画布高亮 + 属性面板可对照
    ui.props(); ui.render();
    ui.hint(brushPickedHint(hitObj));
    return;
  }
  const src = getObj(b.sourceId);
  if (hitObj) { // 第二步：单击应用（类型必须一致，源对象本身跳过）
    if (hitObj.id === src.id) { ui.hint(t('hint.brushSourceIsThis')); return; }
    if (hitObj.type !== src.type) {
      ui.hint(t('hint.brushTypeMismatch', {
        src: TYPE_NAMES[src.type] || src.type,
        dst: TYPE_NAMES[hitObj.type] || hitObj.type,
      }));
      return;
    }
    applyBrush(src, [hitObj]);
    return;
  }
  // 空白处按下：开始框选，松手后批量应用到框内全部同类型对象
  runtime.rubber = { x0: wx, y0: wy, x1: wx, y1: wy, add: false, brush: true };
}

/** 格式刷应用：把源对象 props（除名称/编号外）深拷贝到全部目标对象；一次应用 = 一步撤销。
 * 位置（坐标/沿墙定位）、旋转朝向与名称不复制，避免对象错位或重号 */
function applyBrush(src, targets) {
  if (!targets.length) return;
  const sp = src.type === 'pipe' ? pipeFormat(src) : JSON.parse(JSON.stringify(src.props));
  const pipeUpdates=new Map();
  try{if(src.type==='pipe')for(const o of targets)pipeUpdates.set(o,normalizePipe({...o,props:{...o.props,...sp}}));}
  catch(e){ui.hint(e.message);return;}
  pushUndo();
  delete sp.name; // 名称/编号不复制，保持唯一
  if (isDevice(src)) sp.color = src.props.color || ''; // 默认色也要覆盖目标原有自定义颜色
  let linked = 0, linkedCabs = 0, linkLeft = 0; // 通道宽联动统计
  for (const o of targets) {
    if(pipeUpdates.has(o)){Object.assign(o,pipeUpdates.get(o));continue;}
    const oldAisleD = o.type === 'aisle' ? (o.props.d || 0) : 0; // 联动依据：刷前通道宽（逐个读取，并列通道带已被前一条同步调宽时 Δ=0 不重复联动）
    o.props = { ...o.props, ...JSON.parse(JSON.stringify(sp)) }; // sockets 等数组独立深拷贝，不共享引用
    // 门窗/格栅：宽度变化后重新约束在所属墙范围内
    if (o.type === 'door' || o.type === 'window' || o.type === 'grille') {
      const w = getObj(o.wallId);
      if (w) {
        const L = wallLen(w);
        if (L > 0) o.t = clamp(o.t, (o.props.width || 900) / 2 / L, 1 - (o.props.width || 900) / 2 / L);
      }
    }
    if (o.type === 'aisle') { // 通道宽被刷变化 → 远侧整排联动（Δ=0/开关关闭时自动跳过）
      const lr = syncAisleWidth(o, oldAisleD);
      if (lr && !lr.unsupported && !lr.noRow) { linked++; linkedCabs += lr.cabs; linkLeft += lr.left; }
    }
  }
  const solids = targets.filter(isSolid);
  if (solids.length) resolveOverlaps(solids); // 尺寸变大压到邻居时推开（互斥）
  state.selectedIds = targets.map(o => o.id); // 选中目标便于检查结果
  markDirty();
  ui.hint(t('hint.brushApplied', {
    name: src.props.name || '', n: targets.length, type: TYPE_NAMES[src.type] || src.type,
  }) +
    (linked ? t('hint.brushLinked', { n: linked, c: linkedCabs }) : '') +
    (linkLeft ? t('hint.brushLeft', { n: linkLeft }) : '') +
    t('hint.brushContinue'));
}

/* ---------- 智能对齐（拖动时吸附其他对象边缘/中线并显示红色参考线） ---------- */

/** 单个对象的对齐线：矩形对象=旋转后包围盒的4边+2中线；线段对象=两端点+中点；门窗=沿墙中心 */
function objGuideLines(o) {
  if (o.type === 'wall' || o.type === 'tray' || o.type === 'pipe') {
    return {
      v: [o.x1, (o.x1 + o.x2) / 2, o.x2],
      h: [o.y1, (o.y1 + o.y2) / 2, o.y2],
    };
  }
  if (o.type === 'beam') { // 框架梁：端点随附着柱动态求解
    const e = beamEnds(o, getObj);
    return {
      v: [e.x1, (e.x1 + e.x2) / 2, e.x2],
      h: [e.y1, (e.y1 + e.y2) / 2, e.y2],
    };
  }
  if (o.type === 'door' || o.type === 'window' || o.type === 'grille') {
    const w = getObj(o.wallId);
    if (!w) return null;
    return { v: [w.x1 + (w.x2 - w.x1) * o.t], h: [w.y1 + (w.y2 - w.y1) * o.t] };
  }
  const rad = (o.rotation || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const hw = (o.props.w || 600) / 2, hd = (o.props.d || 600) / 2;
  let minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
  for (const [lx, ly] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
    const px = o.x + lx * c - ly * s, py = o.y + lx * s + ly * c;
    if (px < minx) minx = px; if (px > maxx) maxx = px;
    if (py < miny) miny = py; if (py > maxy) maxy = py;
  }
  return {
    v: [minx, (minx + maxx) / 2, maxx],
    h: [miny, (miny + maxy) / 2, maxy],
  };
}

/** 收集候选对齐线（排除选中组），拖动开始时调用一次，避免每帧重复遍历 */
function collectGuides(excludeIds) {
  const v = new Set(), h = new Set();
  const ex = new Set(excludeIds || []);
  for (const o of state.project.objects) {
    if (ex.has(o.id)) continue;
    const L = objGuideLines(o);
    if (!L) continue;
    for (const x of L.v) v.add(x);
    for (const y of L.h) h.add(y);
  }
  return { v: [...v], h: [...h] };
}

/** 吸附判定：目标对象 6 条线（左右中/上下中）与候选线比对，阈值 eps 内取最近；
 * 返回 { ox, oy, lines }——ox/oy 为相对当前拖动位置的修正量（null=该方向未命中） */
function matchGuide(cur, cand, eps) {
  if (!cand || (!cand.v.length && !cand.h.length)) return null;
  const T = objGuideLines(cur);
  let bx = null, by = null;
  for (const t of T.v) {
    for (const c of cand.v) {
      const dd = Math.abs(c - t);
      if (dd <= eps && (!bx || dd < bx.dd)) bx = { dd, delta: c - t, line: c };
    }
  }
  for (const t of T.h) {
    for (const c of cand.h) {
      const dd = Math.abs(c - t);
      if (dd <= eps && (!by || dd < by.dd)) by = { dd, delta: c - t, line: c };
    }
  }
  if (!bx && !by) return null;
  return {
    ox: bx ? bx.delta : null, oy: by ? by.delta : null,
    lines: { v: bx ? [bx.line] : [], h: by ? [by.line] : [] },
  };
}

/** 拖动中的定时碰撞轮询：鼠标停住不再产生 move 事件时，仍推进停留计时/推挤/回弹并刷新画面 */
function dragCollideTick() {
  const d = runtime.drag;
  if (!d || !d.started || (d.kind !== 'move' && d.kind !== 'copy')) return;
  const anchors = d.items.map(it => it.obj).filter(isSolid);
  const restored = springBack(d.session, anchors);
  const r = resolveOverlaps(anchors, undefined, d.kind === 'copy' ? new Set(d.srcIds) : null, d.session);
  if (restored || r.moved) markDirty({ props: false });
}

/** 拖动移动（支持多选）：以第一个非门窗对象为基准做对齐吸附，未命中方向回退 100mm 网格捕捉，其余跟随 */
function moveObject(d, wx, wy) {
  const dx = wx - d.startWX, dy = wy - d.startWY;
  let ox = 0, oy = 0;
  const base = d.items.find(it => it.obj.type !== 'door' && it.obj.type !== 'window');
  if (base) {
    const r = base.orig;
    const isLine = ['wall','tray','pipe'].includes(base.obj.type);
    // 拖动后的临时位置（未捕捉），用于与候选对齐线比对
    const cur = { ...base.obj,
      ...(isLine ? { x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy }
                 : { x: r.x + dx, y: r.y + dy }) };
    // 网格捕捉回退值
    const gx = isLine ? snapVal(r.x1 + dx) - (r.x1 + dx) : snapVal(r.x + dx) - (r.x + dx);
    const gy = isLine ? snapVal(r.y1 + dy) - (r.y1 + dy) : snapVal(r.y + dy) - (r.y + dy);
    const g = matchGuide(cur, runtime.guideCand, 8 / state.view.scale);
    ox = g ? (g.ox !== null ? g.ox : gx) : gx;
    oy = g ? (g.oy !== null ? g.oy : gy) : gy;
    runtime.guides = g ? g.lines : null;
  } else {
    runtime.guides = null;
  }
  for (const it of d.items) {
    const o = it.obj, r = it.orig;
    if(o.type==='pipe'){try{Object.assign(o,translatePipe(r,dx+ox,dy+oy));}catch(e){ui.hint(e.message);}continue;}
    if (o.type === 'wall' || o.type === 'tray') { // 整体平移
      o.x1 = r.x1 + dx + ox; o.y1 = r.y1 + dy + oy;
      o.x2 = r.x2 + dx + ox; o.y2 = r.y2 + dy + oy;
    } else if (o.type === 'beam') { // 框架梁整体平移：附着柱同组拖动时保持附着（端点随柱），否则固化脱离
      const e0 = beamEnds(r, getObj);
      const inG = id => !!id && d.items.some(it2 => it2.obj.id === id);
      if (!inG(o.col1)) { o.col1 = null; o.x1 = e0.x1 + dx + ox; o.y1 = e0.y1 + dy + oy; }
      if (!inG(o.col2)) { o.col2 = null; o.x2 = e0.x2 + dx + ox; o.y2 = e0.y2 + dy + oy; }
    } else if (o.type === 'door' || o.type === 'window' || o.type === 'grille') { // 沿墙滑动
      const w = getObj(o.wallId);
      if (!w) continue;
      const L = wallLen(w);
      if (L < 1) continue;
      const half = (o.props.width || 900) / 2 / L;
      if (d.items.some(it2 => it2.obj === w)) { // 所属墙同被拖动（Ctrl+复制墙+门窗）：随墙平移，t 不变
        o.t = clamp(r.t, half, 1 - half);
      } else if (d.items.length === 1) { // 单拖门窗：跟随鼠标投影（沿墙滑动手感）
        o.t = clamp(dist2seg(wx, wy, w.x1, w.y1, w.x2, w.y2).t, half, 1 - half);
      } else { // 多对象整体拖动：随组平移（组平移向量沿墙分量），不跳鼠标投影
        const proj = ((dx + ox) * (w.x2 - w.x1) + (dy + oy) * (w.y2 - w.y1)) / L;
        o.t = clamp(r.t + proj / L, half, 1 - half);
      }
    } else { // 机柜/柱子/空调等实体
      o.x = r.x + dx + ox;
      o.y = r.y + dy + oy;
      // 空调→格栅磁吸贴合（单拖时）：吸到格栅正前方、后缘贴墙面，不允许叠加在格栅上
      if (o.type === 'ac' && d.items.length === 1) {
        const g = grilleSnapAC(state.project.objects, o.x, o.y,
          o.props.w || 0, o.props.d || 0, o.rotation, 24 / state.view.scale);
        if (g) { o.x = g.x; o.y = g.y; runtime.guides = null; } // 磁吸优先于智能对齐线
      }
    }
  }
}

/* ---------- 通道带拖拽调整尺寸（单选时四边中点手柄） ---------- */

/** 通道带 4 个边中点手柄（世界坐标）：e/w=两端短边（调通道长 w），n/s=两侧长边（调通道宽 d） */
function aisleHandles(o) {
  const rad = (o.rotation || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const hw = (o.props.w || 0) / 2, hd = (o.props.d || 0) / 2;
  const pt = (lx, ly) => ({ x: o.x + lx * c - ly * s, y: o.y + lx * s + ly * c });
  return [
    { end: 'e', ...pt(hw, 0) }, { end: 'w', ...pt(-hw, 0) },
    { end: 'n', ...pt(0, hd) }, { end: 's', ...pt(0, -hd) },
  ];
}

/** 悬停通道带边中点手柄时的 resize 光标（按拖拽轴的屏幕角度选 ew/ns/nwse/nesw） */
function aisleHandleCursor(wx, wy) {
  const sel = getObj(state.selectedId);
  if (!sel || sel.type !== 'aisle') return 'default';
  for (const h of aisleHandles(sel)) {
    if (Math.hypot(wx - h.x, wy - h.y) <= 8 / state.view.scale) {
      const horiz = h.end === 'e' || h.end === 'w';
      // 拖拽方向 = 局部 x（e/w）或局部 y（n/s）轴；屏幕 y 向下 → 角度取负
      let a = -((sel.rotation || 0) + (horiz ? 0 : 90)) * Math.PI / 180;
      a = ((a % Math.PI) + Math.PI) % Math.PI; // 归一到 [0, π)
      const deg = a * 180 / Math.PI;
      if (deg < 22.5 || deg >= 157.5) return 'ew-resize';
      if (deg >= 67.5 && deg < 112.5) return 'ns-resize';
      return deg < 67.5 ? 'nwse-resize' : 'nesw-resize';
    }
  }
  return 'default';
}

/** 快照全部对象的可动几何（通道宽联动会平移整排/推开邻居，拖拽中每帧从快照重放） */
function snapshotGeo() {
  return state.project.objects.map(o => ({
    o,
    x: 'x' in o ? o.x : null, y: 'y' in o ? o.y : null,
    w: o.props && 'w' in o.props ? o.props.w : null,
    d: o.props && 'd' in o.props ? o.props.d : null,
  }));
}
function restoreGeo(snap) {
  for (const s of snap) {
    if (s.x !== null) s.o.x = s.x;
    if (s.y !== null) s.o.y = s.y;
    if (s.w !== null) s.o.props.w = s.w;
    if (s.d !== null) s.o.props.d = s.d;
  }
}

/** 通道带边拖拽调尺寸：对侧边锚定，100mm 捕捉（Alt 关闭），≥100mm 夹紧。
 * 拖两侧长边（n/s）调通道宽 d——联动开启时整排机柜实时跟随（拖哪侧哪侧排平移，规则同 syncAisleWidth）；
 * 联动关闭/非常规角度/联动侧无排时仅调整标注。拖两端短边（e/w）调通道长 w（纯标注，无机柜联动）。 */
function resizeAisle(d, wx, wy) {
  const o = d.obj, g = d.orig;
  restoreGeo(d.snap); // 每帧从拖拽前状态重放（联动识别依赖原始几何）
  const rad = (o.rotation || 0) * Math.PI / 180;
  const co = Math.cos(rad), si = Math.sin(rad);
  // 鼠标世界坐标 → 通道带局部坐标（局部 x=沿排方向/长，y=跨排方向/宽）
  const dx = wx - g.x, dy = wy - g.y;
  const lx = dx * co + dy * si, ly = -dx * si + dy * co;
  const horiz = d.edge === 'e' || d.edge === 'w'; // 两端短边 → 调长
  const sgn = (d.edge === 'e' || d.edge === 'n') ? 1 : -1; // 被拖边相对中心的方向
  const half0 = (horiz ? g.w : g.d) / 2;
  const anchor = -sgn * half0;                    // 对侧边（锚定）局部坐标
  const raw = sgn * ((horiz ? lx : ly) - anchor); // 新尺寸（未捕捉）
  const size = Math.max(100, snapVal(raw));
  const delta = size - (horiz ? g.w : g.d);
  d.lastDelta = delta;
  // 新中心 = 锚定边 + 方向 × 新尺寸/2（局部），转回世界
  const lc = anchor + sgn * size / 2;
  const wx2 = horiz ? lc : 0, wy2 = horiz ? 0 : lc;
  const cx = g.x + wx2 * co - wy2 * si, cy = g.y + wx2 * si + wy2 * co;
  d.linkR = null;
  if (horiz) {
    o.props.w = size;
    o.x = cx; o.y = cy;
  } else {
    o.props.d = size;
    const cls = rotClass(o);
    const axis = cls === 0 ? 'y' : cls === 90 ? 'x' : null;
    if (delta && axis) {
      // 被拖边在“世界远侧（东/北）”→ dir=+1，否则镜像联动近侧排（dir=-1）。
      // 局部 +y 方向在世界跨排轴上的投影符号即该边的远/近侧归属（兼容 180°/270° 翻转的通道带）
      const farSgn = (cls === 0 ? Math.sign(co) : Math.sign(-si)) || 1;
      const dir = sgn * farSgn;
      // syncAisleWidth 内部按 dir 完成“锚定侧不动”的移心 dir·Δ/2 与整排平移（与属性面板改宽同一语义）
      const r = syncAisleWidth(o, g.d, dir);
      if (!r || r.unsupported || r.noRow) { o.x = cx; o.y = cy; } // 未联动：恢复手算的锚定几何
      d.linkR = r;
    } else {
      o.x = cx; o.y = cy;
    }
  }
}

/** 梁端点吸附：找包含（或容差内贴近）指定点的柱子（自上而下取最上层），命中返回柱对象 */
function columnAt(wx, wy) {
  const tol = 8 / state.view.scale;
  const objs = state.project.objects;
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o.type !== 'column') continue;
    const r = -(o.rotation || 0) * Math.PI / 180;
    const c = Math.cos(r), s = Math.sin(r);
    const lx = (wx - o.x) * c - (wy - o.y) * s;
    const ly = (wx - o.x) * s + (wy - o.y) * c;
    if (Math.abs(lx) <= (o.props.w || 600) / 2 + tol &&
        Math.abs(ly) <= (o.props.d || 600) / 2 + tol) return o;
  }
  return null;
}

/** 梁端点求解：落在柱上→柱心并记柱引用（预览/放置共用）；否则 100mm 网格捕捉自由点 */
function beamEndAt(wx, wy) {
  const col = columnAt(wx, wy);
  if (col) return { x: col.x, y: col.y, col };
  return { x: snapVal(wx), y: snapVal(wy), col: null };
}

/** 框架梁逐跨绘制：单击起点柱（或自由点）→ 单击终点柱，可连续绘制（终点即下一跨起点，
 * 形成连续梁）；Shift 正交；右键/Esc/双击结束。端点附着柱子（col1/col2 记柱 id），
 * 柱移动/被推挤时梁端自动跟随；梁顶标高默认取两附着柱较高者（无附着柱时取默认值）。 */
function beamDown(wx, wy, e) {
  const dr = runtime.drawing;
  if (!dr) { // 第一击：定起点（优先吸附柱心）
    runtime.drawing = { last: beamEndAt(wx, wy) };
    ui.hint(t('hint.beamNext'));
    ui.render();
    return;
  }
  const last = dr.last;
  let pt = beamEndAt(wx, wy);
  if (e.shiftKey) { // Shift 正交（对自由点/柱心统一约束后再重判柱吸附）
    if (Math.abs(pt.x - last.x) >= Math.abs(pt.y - last.y)) pt = { ...pt, y: last.y };
    else pt = { ...pt, x: last.x };
    const col = columnAt(pt.x, pt.y);
    pt = col ? { x: col.x, y: col.y, col } : pt;
  }
  if (Math.hypot(pt.x - last.x, pt.y - last.y) < 1) return; // 忽略重复点
  pushUndo();
  const dp = defaultProps('beam'); // 梁宽/梁高/混凝土等默认值跟随上一次设置
  // 梁顶标高：注册表有用户设定值则跟随；否则取两附着柱较高者（跨柱梁默认与柱顶齐平）
  const regTop = +(state.lastProps.beam && state.lastProps.beam.top) || 0;
  const colTop = Math.max(last.col ? (+last.col.props.h || 0) : 0, pt.col ? (+pt.col.props.h || 0) : 0);
  const top = regTop > 0 ? regTop : (colTop > 0 ? colTop : (+dp.top || 3000));
  const o = {
    id: uid(), type: 'beam',
    x1: last.x, y1: last.y, x2: pt.x, y2: pt.y,
    col1: last.col ? last.col.id : null, col2: pt.col ? pt.col.id : null,
    props: { name: autoName(t('auto.beam')), ...dp, top },
  };
  state.project.objects.push(o);
  state.selectedId = o.id;
  dr.last = { x: pt.x, y: pt.y, col: pt.col }; // 连续梁：终点作为下一跨起点
  markDirty({ props: false });
  const L = Math.round(Math.hypot(pt.x - o.x1, pt.y - o.y1));
  ui.hint(t('hint.beamDone', { name: o.props.name, len: L }));
}

/** 墙体/桥架逐段绘制（共享链式绘制状态） */
function lineDown(wx, wy, e) {
  let x = snapVal(wx), y = snapVal(wy);
  const dr = runtime.drawing;
  if (!dr) {
    runtime.drawing = { last: { x, y }, typed: '' };
    ui.hint(t('hint.lineNext'));
    ui.render();
    return;
  }
  dr.typed = '';
  const last = dr.last;
  if (e.shiftKey) {
    if (Math.abs(x - last.x) >= Math.abs(y - last.y)) y = last.y; else x = last.x;
  }
  if (Math.hypot(x - last.x, y - last.y) < 1) return; // 忽略重复点
  pushUndo();
  const lt = state.tool === 'tray' ? 'tray' : 'wall';
  state.project.objects.push({ // 属性默认值跟随上一次设置（defaultProps：出厂默认 ⊕ 注册表）
    id: uid(), type: lt, x1: last.x, y1: last.y, x2: x, y2: y,
    props: { name: autoName(t('auto.' + lt)), ...defaultProps(lt) },
  });
  dr.last = { x, y };
  markDirty({ props: false });
}

function openingDown(wx, wy) {
  const type = state.tool;
  const near = nearestWall(wx, wy);
  if (!near) { ui.hint(t('hint.noWallNear')); return; }
  const w = near.wall, L = wallLen(w);
  const dp = defaultProps(type); // 门/窗/格栅默认值跟随上一次设置
  const width = dp.width || 900;
  if (L < width + 100) { ui.hint(t('hint.wallTooShort')); return; }
  pushUndo();
  const o = {
    id: uid(), type, wallId: w.id,
    t: clamp(near.t, width / 2 / L, 1 - width / 2 / L),
    props: { name: autoName(t('auto.' + type)), ...dp, width },
  };
  state.project.objects.push(o);
  state.selectedId = o.id;
  markDirty();
  ui.hint(t('hint.placed', { name: o.props.name }));
}

/** 机柜排批量放置（工勘按排记录）。exact=true 时按精确坐标（来自向导输入）。
 * cfg.tpl = 编号模板：#=序号位（个数=最小位数、超量自动扩位）；# 前最近的字母段=排号，
 * 放置后自动递增下一排（如 A## → B##；101-A## → 101-B##） */
export function placeCabRow(wx, wy, exact) {
  const cfg = state.rowCfg;
  if (!cfg) { ui.hint(t('hint.cabrowNoCfg')); return; }
  const tpl = (cfg.tpl || nextRowPrefix() + '##').toUpperCase();
  const pt = parseTemplate(tpl);
  if (!pt.ok) { ui.hint(t(pt.err) + t('hint.tplExample')); return; }
  const x0 = exact ? wx : snapVal(wx), y0 = exact ? wy : snapVal(wy);
  const pitch = cfg.w + cfg.gap;
  const axisX = cfg.rotation % 180 === 0; // 正面朝北/南 → 沿横向排开
  const added = [];
  pushUndo();
  for (let i = 0; i < cfg.count; i++) {
    added.push({
      id: uid(), type: 'cabinet', z: 0,
      x: axisX ? x0 + i * pitch : x0,
      y: axisX ? y0 : y0 + i * pitch,
      rotation: cfg.rotation,
      props: { // 电气参数/高度/U数等跟随上一次设置；向导显式参数（宽/深/编号）优先
        ...defaultProps('cabinet'),
        name: renderTpl(tpl, i + 1),
        w: cfg.w, d: cfg.d || 1200,
      },
    });
  }
  state.project.objects.push(...added);
  const r = resolveOverlaps(added); // 新排为固定锚，推开沿途重叠的旧对象（级联）
  markDirty();
  cfg.tpl = nextTpl(tpl); // 下一排自动递增（模板无排号字母时保持不变）
  const last = cfg.tpl === tpl;
  ui.hint(t('hint.recRowDone', { tpl, n: cfg.count, x: x0, y: y0 }) +
    (r.moved ? t('hint.pushedN', { n: r.moved }) : '') +
    (r.left ? t('hint.leftN', { n: r.left }) : '') +
    (last ? t('hint.noRowLetter') : t('hint.nextRow', { tpl: cfg.tpl })) +
    t('hint.escExit'));
}

/* ---------- 通道POD（按通道成组，两排一组） ---------- */

/** 通道POD几何布局：冷通道=两排正面相对（面对面）、热通道=两排背面相对（背对背）。
 * cfg: { kind:'cold'|'hot', w, d, rows, count, gap, aisleWC, aisleWH, axis:'x'|'y' }
 * kind 为首个通道（第1、2排之间）的类型；POD 内冷/热通道始终交替存在，
 * 宽度分别取 aisleWC（冷）/ aisleWH（热），排间距随通道类型逐排累计。
 * x0,y0 = 首排第一台机柜中心。axis='x'：排沿X排开、排间沿Y堆叠；axis='y' 反之。
 * 返回 { rows:[{r,rotation,x,y}], bands:[{x,y,w,d,rotation,kind,enclosed}], horiz, pitch }。
 * enclosed：仅向导所选「首个通道类型」（cfg.kind）的通道带封闭（=true），另一类不封闭（=false） */
export function podGeometry(cfg, x0, y0) {
  const { w, d, rows, count, gap, kind, axis } = cfg;
  const wc = +cfg.aisleWC || +cfg.aisleW || 1200; // 冷通道宽（兼容旧 cfg.aisleW）
  const wh = +cfg.aisleWH || +cfg.aisleW || 900;  // 热通道宽
  const pitch = w + gap;               // 排内柜间距
  const horiz = axis !== 'y';          // 排沿X方向排开（排间沿Y堆叠）
  const len = count * w + (count - 1) * gap; // 排长（沿排布方向总长）
  // 面向规则：冷通道相邻排正面相对（面对面），热通道相邻排背面相对（背对背）
  const rotPair = horiz
    ? (kind === 'cold' ? [0, 180] : [180, 0])    // 沿Y堆叠：0=正面朝北 180=正面朝南
    : (kind === 'cold' ? [90, 270] : [270, 90]); // 沿X堆叠：90=正面朝东 270=正面朝西
  // 第 r 个通道带（第 r、r+1 排之间）的类型：首个为 cfg.kind，此后冷/热交替
  const bandKind = r => (r % 2 === 0 ? kind : (kind === 'cold' ? 'hot' : 'cold'));
  const bandW = r => (bandKind(r) === 'cold' ? wc : wh);
  const rowsArr = [], bands = [];
  let pos = 0; // 当前排相对首排的堆叠方向偏移（逐排累计：柜深 + 前一通道宽）
  for (let r = 0; r < rows; r++) {
    rowsArr.push({
      r,
      rotation: rotPair[r % 2],
      x: horiz ? x0 : x0 + pos,
      y: horiz ? y0 + pos : y0,
    });
    if (r < rows - 1) { // 相邻两排之间的通道带（冷/热交替，宽度各自独立）
      const bw = bandW(r), bk = bandKind(r);
      const off = pos + d / 2 + bw / 2;
      bands.push({
        ...(horiz
          ? { x: x0 + (len - w) / 2, y: y0 + off, rotation: 0 }
          : { x: x0 + off, y: y0 + (len - w) / 2, rotation: 90 }),
        w: len, d: bw, kind: bk,
        enclosed: bk === kind, // 封闭类型 = 向导所选首个通道类型（选冷仅冷通道封闭，选热仅热通道封闭）
      });
      pos += d + bw;
    }
  }
  return { rows: rowsArr, bands, horiz, pitch };
}

/** 通道POD批量放置（工勘按通道记录：两排一组，冷=面对面 / 热=背对背）。
 * exact=true 时按精确坐标（来自向导输入），否则按 100mm 捕捉 */
export function placeCabPod(wx, wy, exact) {
  const cfg = state.podCfg;
  if (!cfg) { ui.hint(t('hint.cabpodNoCfg')); return; }
  if (cfg.rows < 2 || cfg.rows > 26) { ui.hint(t('hint.cabpodRows')); return; }
  const tpl = (cfg.tpl || nextRowPrefix() + '##').toUpperCase();
  const pt = parseTemplate(tpl);
  if (!pt.ok) { ui.hint(t(pt.err) + t('hint.tplExample')); return; }
  if (!pt.slot) { ui.hint(t('hint.podNeedLetter')); return; }
  const rowLetters = lettersSeq(pt.slot, cfg.rows); // 每排一个排号（A~F…，超 Z 自动 AA~）
  const x0 = exact ? wx : snapVal(wx), y0 = exact ? wy : snapVal(wy);
  const geo = podGeometry(cfg, x0, y0);
  const kindName = t(cfg.kind === 'cold' ? 'aisle.cold' : 'aisle.hot');
  const added = [];
  pushUndo();
  for (const row of geo.rows) {
    for (let i = 0; i < cfg.count; i++) {
      added.push({
        id: uid(), type: 'cabinet', z: 0,
        x: geo.horiz ? x0 + i * geo.pitch : row.x,
        y: geo.horiz ? row.y : y0 + i * geo.pitch,
        rotation: row.rotation,
        props: { // 同 placeCabRow：跟随上一次设置，向导显式参数优先
          ...defaultProps('cabinet'),
          name: renderTpl(tpl, i + 1, rowLetters[row.r]),
          w: cfg.w, d: cfg.d,
        },
      });
    }
  }
  for (const b of geo.bands) { // 通道带（冷/热通道区域标注，冷热交替、各自宽度；几何来自 POD 配置，高度等跟随上一次设置）
    added.push({
      id: uid(), type: 'aisle', x: b.x, y: b.y, rotation: b.rotation,
      props: { ...defaultProps('aisle'), name: autoName(t(b.kind === 'cold' ? 'auto.aisleCold' : 'auto.aisleHot')), kind: b.kind, w: b.w, d: b.d, enclosed: b.enclosed },
    });
  }
  state.project.objects.push(...added);
  const r = resolveOverlaps(added); // 新 POD 为固定锚，推开沿途重叠的旧对象（级联）
  markDirty();
  const lastLetter = rowLetters[rowLetters.length - 1];
  ui.hint(t('hint.podDone', { kind: kindName, tpl, a: rowLetters[0], b: lastLetter, n: cfg.rows * cfg.count, x: x0, y: y0 }) +
    (r.moved ? t('hint.pushedN', { n: r.moved }) : '') +
    (r.left ? t('hint.leftN', { n: r.left }) : '') +
    t('hint.nextPod', { tpl: nextTpl(tpl) }) + t('hint.escExit'));
  cfg.tpl = nextTpl(tpl); // 下一组排号自动递增，避免重号
}

/** 推荐下一个排编号（A、B、C…），供向导默认模板起首字母用 */
export function nextRowPrefix() {
  const used = new Set();
  for (const o of state.project.objects) {
    const m = o.type === 'cabinet' && /^([A-Za-z])\d+/.exec(o.props.name || '');
    if (m) used.add(m[1].toUpperCase());
  }
  for (let c = 65; c <= 90; c++) {
    if (!used.has(String.fromCharCode(c))) return String.fromCharCode(c);
  }
  return 'R';
}

/** 同模板已用排号：扫描画布内与本模板同结构（字面前缀/后缀相同）的机柜编号 */
function usedSlotsOf(tpl) {
  const p = parseTemplate(tpl);
  if (!p.ok || !p.slot) return new Set();
  const re = new RegExp('^' + escRe(p.headPrefix) + '([A-Za-z]+)' + escRe(p.headAfter) + '\\d+' + escRe(p.tail) + '$', 'i');
  const used = new Set();
  for (const o of state.project.objects) {
    if (o.type !== 'cabinet') continue;
    const m = re.exec(o.props.name || '');
    if (m) used.add(m[1].toUpperCase());
  }
  return used;
}

/** 下一可用编号模板：同模板排号从 A 起取首个未用（A→Z→AA…）；模板无排号字母时原样返回 */
export function nextTpl(tpl) {
  const p = parseTemplate(tpl);
  if (!p.ok || !p.slot) return tpl;
  const used = usedSlotsOf(tpl);
  let v = 1;
  while (used.has(lettersAt(v))) v++;
  return p.headPrefix + lettersAt(v) + p.headAfter + '#'.repeat(p.width) + p.tail;
}

/** 画墙时的直接长度输入：按当前鼠标方向绘制指定长度（工勘实测录入） */
function commitTypedWall() {
  const dr = runtime.drawing;
  const len = parseFloat(dr.typed);
  dr.typed = '';
  if (!len || len <= 0) { ui.hint(t('hint.lenInvalid')); ui.render(); return; }
  const m = runtime.mouse;
  let dx = snapVal(m.wx) - dr.last.x, dy = snapVal(m.wy) - dr.last.y;
  if (runtime.shiftKey) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0;
  }
  const d = Math.hypot(dx, dy);
  if (d < 1) { ui.hint(t('hint.moveFirst')); ui.render(); return; }
  const x = Math.round(dr.last.x + dx / d * len), y = Math.round(dr.last.y + dy / d * len);
  pushUndo();
  const lt = state.tool === 'tray' ? 'tray' : 'wall';
  state.project.objects.push({ // 同 lineDown：默认值跟随上一次设置
    id: uid(), type: lt, x1: dr.last.x, y1: dr.last.y, x2: x, y2: y,
    props: { name: autoName(t('auto.' + lt)), ...defaultProps(lt) },
  });
  dr.last = { x, y };
  markDirty({ props: false });
  ui.hint(t('hint.segDone', { len, what: t(state.tool === 'tray' ? 'hint.segTray' : 'hint.segWall') }));
}

function placeRect(wx, wy, type) {
  pushUndo();
  let x = snapVal(wx), y = snapVal(wy);
  const dp = defaultProps(type);
  // 空调→格栅磁吸贴合：靠近格栅放置时吸到格栅正前方、后缘贴墙面（不叠加在格栅上）
  if (type === 'ac') {
    const g = grilleSnapAC(state.project.objects, x, y, dp.w || 2500, dp.d || 1300, 0, 24 / state.view.scale);
    if (g) { x = g.x; y = g.y; }
  }
  // 柱子/机柜/列头柜/空调/风口：属性默认值跟随上一次设置（defaultProps：出厂默认 ⊕ 注册表）。
  // 机柜宽兼容底值仍取 state.defaults.cabWidth（G、B 快捷键经 notePropEdit 同步）
  const o = {
    id: uid(), type, x, y, rotation: 0, ...(isDevice({ type }) ? { z: 0 } : {}),
    props: { name: autoName(t('auto.' + type)), ...dp },
  };
  state.project.objects.push(o);
  const r = resolveOverlaps([o]); // 新对象为固定锚，推开重叠的旧对象（级联）
  state.selectedId = o.id;
  markDirty();
  if (r.left > 0) {
    ui.hint(t('hint.placedOverlap', { name: o.props.name, n: r.left }));
  } else if (r.moved > 0) {
    ui.hint(t('hint.placedPushed', { name: o.props.name, n: r.moved }));
  } else {
    ui.hint(t('hint.placedOk', { name: o.props.name }));
  }
}

/* ---------- 键盘 ---------- */
/** 旋转选中对象 90°（支持多选，仅机柜/柱子/空调/UPS/蓄电池/灭火器/风口/列头柜） */
export function rotateSelected() {
  const targets = state.selectedIds.map(getObj)
    .filter(o => o && (isDevice(o) || o.type === 'column' || o.type === 'pipe'));
  if (!targets.length) {
    ui.hint(t('hint.rotateOnly'));
    return;
  }
  const pipePlans=new Map();
  try{for(const o of targets)if(o.type==='pipe')pipePlans.set(o,rotatePipe(o));}catch(e){ui.hint(e.message);return;}
  pushUndo();
  for (const o of targets) {
    if (o.type === 'pipe') Object.assign(o,pipePlans.get(o));
    else o.rotation = ((o.rotation || 0) + 90) % 360;
  }
  const r = resolveOverlaps(targets); // 旋转后外形变化，推开重叠的邻居
  markDirty();
  if (r.left > 0) ui.hint(t('hint.rotatedOverlap'));
  else if (targets.length > 1) ui.hint(t('hint.rotatedN', { n: targets.length }));
}

export function keyDown(e) {
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'Alt') { // Alt：临时关闭网格捕捉（精细微调），并阻止浏览器菜单聚焦
    runtime.altKey = true;
    e.preventDefault();
    if (!runtime.altHinted) {
      runtime.altHinted = true;
      ui.hint(t('hint.altHold'));
    }
    return;
  }
  if (e.key === 'Tab') {
    const list=pipeCandidates(runtime.mouse.wx,runtime.mouse.wy);
    if(list.length){e.preventDefault();const i=list.findIndex(o=>o.id===state.selectedId);state.selectedId=list[(i+1)%list.length].id;ui.props();ui.render();return;}
  }
  if (e.code === 'Space') { runtime.spacePan = true; e.preventDefault(); return; }
  // 墙体/桥架绘制中的直接长度输入（工勘实测：鼠标定方向，键盘输长度，回车绘制）
  if ((state.tool === 'wall' || state.tool === 'tray' || state.tool === 'pipe') && runtime.drawing) {
    if (/^[0-9.]$/.test(e.key)) {
      runtime.drawing.typed = (runtime.drawing.typed || '') + e.key;
      ui.render();
      return;
    }
    if (e.key === 'Backspace' && runtime.drawing.typed) {
      runtime.drawing.typed = runtime.drawing.typed.slice(0, -1);
      ui.render();
      return;
    }
    if (e.key === 'Enter' && runtime.drawing.typed) { e.preventDefault(); if(state.tool==='pipe')commitTypedPipe();else commitTypedWall(); return; }
  }
  if (e.ctrlKey || e.metaKey) {
    const k = (e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    return;
  }
  switch (e.key) {
    case 'Escape': { // 结束绘制/框选、取消选择/取消进行中的拖动，并回到选择状态
      ctxmenu.dismissAll(); // 收起右键菜单/重排提示条（保持原编号）
      runtime.rubber = null;
      const d = runtime.drag;
      if (d) { // 取消进行中的拖动：还原到拖动前状态（含被推开的邻居、复制出的副本一并消失）
        runtime.drag = null;
        runtime.guides = null;
        clearTimeout(runtime.lpTimer); runtime.lpTimer = null;
        clearInterval(runtime.dragTick); runtime.dragTick = null;
        if (d.started && revertLastUndo()) { // 拖动开始时的撤销快照=拖动前状态
          markDirty({ dirty: false }); // 状态已还原回拖动前，不额外标脏
          ui.hint(t('hint.cancelDrag'));
        }
      }
      state.selectedIds = [];
      setTool('select');
      ui.props();
      break;
    }
    case 'Delete': case 'Backspace':
      if (state.selectedIds.length) {
        const n = state.selectedIds.length;
        deleteObjects(state.selectedIds);
        ui.hint(n > 1 ? t('hint.deletedN', { n }) : t('hint.deleted'));
      }
      break;
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': { // 方向键微调选中对象
      e.preventDefault(); // 阻止页面滚动
      const s = e.altKey ? 10 : 1; // 步进：按一下 1mm / Alt 加速档 10mm
      const v = { ArrowUp: [0, s], ArrowDown: [0, -s], ArrowLeft: [-s, 0], ArrowRight: [s, 0] }[e.key];
      nudgeSelected(v[0], v[1]); // Y 向北为正：↑=+Y
      break;
    }
    case 'r': case 'R': rotateSelected(); break;
    case 'm': case 'M': setTool('brush'); break; // 格式刷
    case 'v': case 'V': setTool('select'); break;
    case 'w': case 'W': setTool('wall'); break;
    case 'd': case 'D': setTool('door'); break;
    case 'n': case 'N': setTool('window'); break;
    case 'l': case 'L': setTool('grille'); break;
    case 'c': case 'C': setTool('column'); break;
    case 'k': case 'K': setTool('beam'); break;
    case 'i': case 'I': setTool('pipe'); break;
    case 't': case 'T': setTool('tray'); break;
    case 'g': case 'G': notePropEdit('cabinet', 'w', 600); setTool('cabinet'); break; // G=600 规格（跟随为后续默认）
    case 'b': case 'B': notePropEdit('cabinet', 'w', 800); setTool('cabinet'); break; // B=800 规格（跟随为后续默认）
    case 'a': case 'A': setTool('ac'); break;
    case 'u': case 'U': setTool('ups'); break;
    case 'x': case 'X': setTool('battery'); break;
    case 'e': case 'E': setTool('extinguisher'); break;
    case 'f': case 'F': setTool('vent'); break;
    case 'p': case 'P': setTool('pdu'); break;
  }
}

export function keyUp(e) {
  if (e.key === 'Alt') runtime.altKey = false;
  if (e.code === 'Space') runtime.spacePan = false;
}
