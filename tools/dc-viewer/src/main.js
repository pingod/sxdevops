/**
 * 入口：URL 状态 → 项目加载 → UI 装配 → 键盘/URL 同步。
 * 只读查看器：不接受编辑写入，也不依赖后端。
 */
import './styles/tokens.css';
import './styles/base.css';
import './styles/rail.css';
import './styles/drawer.css';
import './styles/panels.css';
import './styles/hud.css';
import './styles/labels.css';
import './styles/live.css';
import './styles/responsive.css';

import { sanitize } from './data/sanitize.js';
import * as V from './viewer.js';
import { parseViewState, serializeViewState, applyViewState } from './url/state.js';
import { createRail } from './ui/rail.js';
import { createDrawer } from './ui/drawer.js';
import { createViewPanel } from './ui/panels/view.js';
import { createDisplayPanel } from './ui/panels/display.js';
import { createSectionPanel } from './ui/panels/section.js';
import { createLocatePanel } from './ui/panels/locate.js';
import { createRoamPanel } from './ui/panels/roam.js';
import { createExplodePanel } from './ui/panels/explode.js';
import { createSearchPanel } from './ui/search.js';
import { createContextBar } from './ui/contextbar.js';
import { createTourHud } from './ui/tourhud.js';
import { createWalkHud } from './ui/walkhud.js';
import { summarizeLive } from './live/status.js';
import { nextIsolateMode } from './features/isolate.js';
import { HEIGHT_ROTATE } from './ui/contextbar.js';

const msg = document.getElementById('msg');
const msgText = document.getElementById('msg-text');

function showMsg(text, error = false) {
  if (!msg) return;
  msg.hidden = false;
  msg.classList.toggle('error', !!error);
  msg.classList.toggle('loading', !error);
  if (msgText) msgText.textContent = text;
}

function hideMsg() {
  if (msg) msg.hidden = true;
}

function fail(text) {
  showMsg(text, true);
  console.error('[3D]', text);
}

const embedded = window.parent !== window;
const liveLegend = document.getElementById('live-legend');
const liveTime = document.getElementById('live-time');

/** 父页面主题：只换底色与变量，不动几何。 */
function applyTheme(theme) {
  const next = ['light', 'charcoal', 'dark'].includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = next;
  V.setTheme(next);
}

function renderLegend(live) {
  if (!liveLegend) return;
  const cabinets = live?.cabinets || {};
  if (!Object.keys(cabinets).length) {
    liveLegend.hidden = true;
    return;
  }
  liveLegend.hidden = false;
  const { counts } = summarizeLive({ cabinets });
  for (const [status, value] of Object.entries(counts)) {
    const el = liveLegend.querySelector(`[data-count="${status}"]`);
    if (el) el.textContent = String(value);
  }
  const when = live?.generatedAt ? new Date(live.generatedAt) : new Date();
  if (liveTime) {
    liveTime.textContent = `更新于 ${Number.isNaN(when.getTime())
      ? '—'
      : when.toLocaleTimeString('zh-CN', { hour12: false })}`;
  }
}

function applyLive(payload) {
  const result = V.applyLiveStatus(payload);
  renderLegend(result);
  return result;
}

const isTyping = t => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
  || t.tagName === 'SELECT' || t.isContentEditable);

let ui = null;
let params = null;
let projects = { a: null, b: null };
let urlCtl = null;

function busy() {
  const { tour, walk } = V.tourWalk();
  return (tour && tour.active) || (walk && walk.active) || (V.explodeCtl() && V.explodeCtl().animating);
}

/* ---------- UI 装配 ---------- */
function mountUI() {
  const rail = createRail({ onSelect: task => toggleDrawer(task) });
  rail.draw();
  const drawer = createDrawer({
    onClose: () => {
      drawer.close();
      rail.sync(railSync());
      refresh();
      const b = rail.trigger(drawer.current);
      if (b) b.focus({ preventScroll: true });
    },
  });

  const search = createSearchPanel({
    getObjects: () => (V.runtime().project ? V.runtime().project.objects : []),
    onLocate: obj => !!V.locate(obj),
    onClose: () => {
      drawer.close();
      refresh();
    },
  });

  const view = createViewPanel({ onPick: id => { if (!V.applyView(id)) refresh(); } });
  const display = createDisplayPanel({
    onTypeToggle: id => V.typeVisCtl().toggle(id),
    onTypePreset: id => V.typeVisCtl().setPreset(id),
    onStyle: style => {
      if (style === 'lineart') V.presentationCtl().setLineart(!V.presentationCtl().lineart);
      else V.presentationCtl().setLineart(false);
    },
    onXray: () => V.xrayFacade.toggle(),
    onLabels: () => V.viewsCtl().setLabelsEnabled(!V.viewsCtl().labelInfo().enabled),
    onCompareSide: side => {
      if (!V.compareCtl()) return;
      V.compareCtl().switchTo(side).catch(err => {
        console.warn('[对比] 切换失败：', err);
        refresh();
      });
      refresh();
    },
  });
  const sectionPanel = createSectionPanel({
    onMode: mode => {
      const s = V.sectionCtl();
      if (s.mode === mode) s.reset();
      else s.setMode(mode);
    },
    onReset: () => V.sectionCtl().reset(),
    onCut: mm => V.sectionCtl().setCut(mm),
    onPreset: id => V.sectionCtl().setPreset(id),
    onSideAxis: axis => V.sectionCtl().setSideAxis(axis),
    onSideFlip: () => V.sectionCtl().toggleSideFlip(),
    onSidePos: mm => V.sectionCtl().setSidePos(mm),
    onClipAxis: axis => V.sectionCtl().setClipAxis(axis),
    onClipFlip: () => V.sectionCtl().toggleClipFlip(),
    onClipPos: mm => V.sectionCtl().setClipPos(mm),
    onBoxPreset: id => V.sectionCtl().setBoxPreset(id),
    onBoxAxis: (axis, mm) => {
      if (axis === 'x') V.sectionCtl().setBoxX(mm);
      else if (axis === 'z') V.sectionCtl().setBoxZ(mm);
      else V.sectionCtl().setBoxHeight(mm);
    },
  });
  const locate = createLocatePanel({
    onFocus: () => {
      const sel = V.selectedObject();
      if (sel) V.focusObject(sel);
    },
    onIsolate: mode => {
      const iso = V.isolateCtl();
      if (mode === 'off') iso.setMode('off');
      else iso.setMode(mode);
    },
  });
  locate.slot.appendChild(search.el);
  const roam = createRoamPanel({
    onTour: () => {
      const { tour, coordinator } = V.tourWalk();
      if (tour.active) tour.exit();
      else coordinator.startTour(tour.routeId || 'all');
    },
    onWalk: () => {
      const { walk } = V.tourWalk();
      if (walk.active) walk.exit();
      else V.tourWalk().coordinator.startWalk({});
    },
    onRoute: id => {
      const { tour } = V.tourWalk();
      if (tour.active) tour.switchRoute(id);
      else tour.start(id);
    },
  });
  const explodePanel = createExplodePanel({
    onProfile: id => V.explodeCtl().setProfile(id),
    onToggle: () => V.explodeCtl().toggle(),
  });

  drawer.register('view', view.el);
  drawer.register('display', display.el);
  drawer.register('section', sectionPanel.el);
  drawer.register('locate', locate.el);
  drawer.register('roam', roam.el);
  drawer.register('explode', explodePanel.el);

  const ctx = createContextBar({
    onFocusIsolate: () => {
      const iso = V.isolateCtl();
      iso.setMode(iso.mode === 'off' ? 'dim' : 'off');
    },
    onNext: () => V.viewsCtl().next(),
    onCorner: () => V.viewsCtl().cycleIso(),
    onMore: kind => {
      const task = ['height', 'side', 'clip', 'box'].includes(kind) ? 'section' : kind === 'xray' ? 'display' : kind === 'focus' || kind === 'isolate' ? 'locate' : 'view';
      toggleDrawer(task);
    },
    onExit: kind => exitCurrent(kind),
    onPreset: () => {
      const s = V.sectionCtl();
      if (kindNow() === 'height') {
        const i = HEIGHT_ROTATE.indexOf(s.preset);
        s.setPreset(HEIGHT_ROTATE[(i + 1) % HEIGHT_ROTATE.length]);
      } else if (kindNow() === 'box') {
        const order = ['corner', 'top', 'half'];
        const i = order.indexOf(s.info().box.preset);
        s.setBoxPreset(order[(i + 1) % order.length]);
      }
    },
    onAxis: () => {
      const s = V.sectionCtl();
      if (kindNow() === 'side') s.setSideAxis(s.info().side.axis === 'x' ? 'z' : 'x');
      if (kindNow() === 'clip') {
        const order = ['y', 'x', 'z'];
        const i = order.indexOf(s.info().clip.axis);
        s.setClipAxis(order[(i + 1) % order.length]);
      }
    },
    onFlip: () => {
      const s = V.sectionCtl();
      if (kindNow() === 'side') s.toggleSideFlip();
      if (kindNow() === 'clip') s.toggleClipFlip();
    },
    onIsolateMode: () => {
      const iso = V.isolateCtl();
      iso.setMode(nextIsolateMode(iso.mode));
    },
    onRange: (kind, mm) => {
      const s = V.sectionCtl();
      if (kind === 'height') s.setCut(mm);
      else if (kind === 'side') s.setSidePos(mm);
      else if (kind === 'clip') s.setClipPos(mm);
      else if (kind === 'box') s.setBoxHeight(mm);
    },
  });

  const tourHud = createTourHud({
    onPause: () => V.tourWalk().tour.togglePause(),
    onSpeed: () => V.tourWalk().tour.cycleSpeed(),
    onWalk: () => V.tourWalk().coordinator.startWalk({}),
    onExit: () => V.tourWalk().tour.exit(),
    onRoute: id => V.tourWalk().tour.switchRoute(id),
  });
  const walkHud = createWalkHud({
    onTour: () => V.tourWalk().coordinator.startTour(V.tourWalk().tour.routeId || 'all'),
    onBob: () => V.tourWalk().walk.toggleBob(),
    onExit: () => V.tourWalk().walk.exit(),
    onJoystick: (x, y) => V.tourWalk().walk.setJoystick(x, y),
  });

  ui = { rail, drawer, view, display, sectionPanel, locate, roam, explodePanel, search, ctx, tourHud, walkHud };

  V.onchange(() => {
    refresh();
    if (urlCtl) urlCtl.sync();
  });
  mountChrome();
  refresh();
}

function kindNow() {
  return ui && ui.ctx ? ui.ctx.info().kind : null;
}

function railSync() {
  const { tour, walk } = V.tourWalk();
  const views = V.viewsCtl();
  const sec = V.sectionCtl();
  const tv = V.typeVisCtl();
  const iso = V.isolateCtl();
  const x = V.xrayFacade;
  const pres = V.presentationCtl();
  const ex = V.explodeCtl();
  const fp = !!(tour && tour.active) || !!(walk && walk.active);
  const b = busy();
  const available = {};
  for (const id of ['view', 'display', 'section', 'locate', 'roam', 'explode']) available[id] = !fp && (!b || id === 'explode') && (ex.state === 'assembled' || id === 'explode');
  return {
    open: ui.drawer.isOpen ? ui.drawer.current : null,
    visible: true,
    available,
    active: {
      view: views.activeId !== 'orbit' && views.activeId !== 'focus',
      display: x.enabled || tv.info().active || pres.lineart || pres.wire,
      section: sec.active,
      locate: V.focusController().active || iso.active,
      roam: false,
      explode: ex.state !== 'assembled',
    },
  };
}

/* ---------- 状态刷新 ---------- */
function refresh() {
  if (!ui) return;
  const views = V.viewsCtl();
  const sec = V.sectionCtl();
  const tv = V.typeVisCtl();
  const iso = V.isolateCtl();
  const ex = V.explodeCtl();
  const pres = V.presentationCtl();
  const { tour, walk, coordinator } = V.tourWalk();
  const sel = V.selectedObject();
  const b = busy();
  const fp = (tour && tour.active) || (walk && walk.active);

  if (ui.drawer.suspended !== !!fp) ui.drawer.setSuspended(!!fp);
  ui.rail.sync(railSync());

  ui.view.refresh({ activeId: views.activeId, viewpoints: views.viewpoints || [], busy: b });
  ui.display.refresh({
    busy: b,
    types: tv.info(),
    style: pres.info(),
    xray: V.xrayFacade.info(),
    labels: views.labelInfo(),
    compare: V.compareCtl() ? V.compareCtl().info() : { enabled: false },
  });
  ui.sectionPanel.refresh(sec.info(), b);
  ui.locate.refresh({
    busy: b,
    selected: sel ? { id: sel.id, label: (sel.props && sel.props.name) || sel.id } : null,
    focus: { ...V.focusController().info() },
    isolate: iso.info(),
    tourActive: !!(tour && tour.active),
    walkActive: !!(walk && walk.active),
  });
  const routes = tour ? tour.listRoutes() : [];
  ui.roam.refresh({
    busy: b,
    canTour: !!tour && (tour.routeId ? tour.canStartRoute(tour.routeId) : true),
    canWalk: !!walk && (!walk.grid || walk.grid.free > 0),
    walkActive: !!(walk && walk.active),
    tourActive: !!(tour && tour.active),
    routes,
    route: tour ? tour.routeId : 'all',
    routeLabel: tour ? tour.routeLabel : '全场环线',
    summary: `当前路线：${tour ? tour.routeLabel : '全场环线'}`,
    routeHintText: `点击路线立即巡视 · ${routes.length} 条可用`,
  });
  ui.explodePanel.refresh({ busy: b, explode: ex.info(), tourActive: !!(tour && tour.active), walkActive: !!(walk && walk.active) });
  ui.search.setBusy(b);

  ui.ctx.refresh({
    chromeVisible: !document.body.classList.contains('dc-ui-hidden'),
    drawerOpen: ui.drawer.isOpen,
    selected: sel ? { id: sel.id, label: (sel.props && sel.props.name) || sel.id } : null,
    views: {
      activeId: views.activeId,
      corner: views.corner,
      viewpoint: views.vp,
      viewpointLabel: views.vp ? (views.viewpoints.find(v => v.id === views.vp) || {}).label || '' : '',
      viewpointHint: views.vp ? (views.viewpoints.find(v => v.id === views.vp) || {}).hint || '' : '',
      viewpointKind: views.vp ? (views.viewpoints.find(v => v.id === views.vp) || {}).kind || '' : '',
    },
    focus: V.focusController().info(),
    isolate: iso.info(),
    section: sec.info(),
    xray: V.xrayFacade.info(),
  });

  ui.tourHud.refresh({
    active: !!(tour && tour.active),
    state: tour ? tour.state : 'idle',
    paused: tour ? tour.paused : false,
    speed: tour ? tour.speed : 1,
    progress: tour ? tour.info().progress : 0,
    route: tour ? tour.routeId : 'all',
    routeLabel: tour ? tour.routeLabel : '全场环线',
    routeHint: tour ? tour.routeHint : '',
    pendingRoute: tour ? tour.pendingRoute : null,
    routes: tour ? tour.listRoutes() : [],
    onWalk: !!(tour && tour.walking),
  });
  ui.walkHud.refresh({
    ...walk.info(),
    active: !!(walk && walk.active),
    onTour: !!(tour && tour.canStartRoute(tour.routeId || 'all')),
  });
  if (coordinator) {
    if (!(tour && tour.active)) ui.tourHud.setNotice('');
    else {
      const fpInfo = coordinator.info();
      ui.tourHud.setNotice(fpInfo.canTourToWalk ? '' : (walk.active ? '切自动需先站稳' : ''));
    }
  }
  layoutChrome();
}

function layoutChrome() {
  const { tour, walk } = V.tourWalk();
  const fp = (tour && tour.active) || (walk && walk.active);
  document.body.classList.toggle('dc-tools-visible', !fp);
  document.body.classList.toggle('is-walking', !!(walk && walk.active));
  ui.rail.el.hidden = !!fp;
  ui.rail.el.classList.toggle('is-touring', !!(tour && tour.active));
  ui.rail.el.classList.toggle('is-walking', !!(walk && walk.active));
  if (fp) ui.drawer.close();
}

function mountChrome() {
  document.body.classList.remove('dc-ui-hidden');
}

/* ---------- 抽屉开合 ---------- */
function toggleDrawer(task) {
  if (!ui) return;
  const d = ui.drawer;
  if (d.isOpen && d.current === task) {
    d.close();
    refresh();
    return;
  }
  if (!railSync().available[task]) return;
  d.open(task);
  d.focusCurrent();
  refresh();
  if (V.resize) V.resize();
}

function exitCurrent(kind) {
  const views = V.viewsCtl();
  const sec = V.sectionCtl();
  const iso = V.isolateCtl();
  if (['focus', 'top', 'iso', 'viewpoint', 'elevation'].includes(kind)) {
    views.exit();
    return;
  }
  if (kind === 'isolate') {
    iso.setMode('off');
    return;
  }
  if (kind === 'xray') {
    V.xrayFacade.setEnabled(false);
    return;
  }
  if (['height', 'side', 'clip', 'box'].includes(kind)) {
    sec.reset();
  }
}

/* ---------- URL ---------- */
function capture() {
  const views = V.viewsCtl();
  const sec = V.sectionCtl();
  const tv = V.typeVisCtl();
  const iso = V.isolateCtl();
  const { tour } = V.tourWalk();
  const ex = V.explodeCtl();
  const pres = V.presentationCtl();
  const selInfo = V.selectionInfo();
  const sel = selInfo.selected ? { token: selInfo.token } : null;
  const activeView = views.focus ? 'orbit' : views.activeId;
  // 聚焦是瞬态相机：view 记为 orbit，focus 用选中标识复现（与参考站一致）
  const focus = sel ? sel.token : null;
  const info = sec.info();
  const s = {
    src: currentSrc,
    src2: projects.b ? currentSrc2 : null,
    ab: projects.b && V.compareCtl() && V.compareCtl().side === 'b' ? 'b' : 'a',
    view: activeView,
    focus,
    cut: info.mode === 'height' && info.cut > 0 ? info.cut : 'off',
    section: info.active ? info.mode : 'off',
    side: info.side.axis,
    sidePos: info.mode === 'side' ? Math.round(info.side.pos) : null,
    sideFlip: info.mode === 'side' ? info.side.flip : false,
    clip: info.clip.axis,
    clipPos: info.mode === 'clip' ? Math.round(info.clip.pos) : null,
    clipFlip: info.mode === 'clip' ? info.clip.flip : false,
    box: info.box.preset,
    boxX: info.mode === 'box' ? Math.round(info.box.x) : null,
    boxZ: info.mode === 'box' ? Math.round(info.box.z) : null,
    boxH: info.mode === 'box' ? Math.round(info.box.h) : null,
    route: tour && tour.active ? tour.routeId : null,
    xray: V.xrayFacade.enabled,
    hide: tv.info().hidden,
    ui: !document.body.classList.contains('dc-ui-hidden'),
    debug: pres.wire ? 'wire' : null,
    style: pres.lineart ? 'lineart' : 'real',
    explode: ex.profile === 'review' ? 'review' : 'presentation',
  };
  return s;
}

function syncUrl() {
  const next = serializeViewState(capture(), {});
  const url = location.pathname + (next ? '?' + next : '') + location.hash;
  const cur = location.pathname + location.search + location.hash;
  if (url === cur) return false;
  try {
    history.replaceState(history.state, '', url);
    return true;
  } catch {
    return false;
  }
}

/* ---------- 键盘 ---------- */
function installKeys() {
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const { tour, walk, coordinator } = V.tourWalk();
    const views = V.viewsCtl();
    const sec = V.sectionCtl();
    const b = busy();
    const key = e.key;
    const typing = isTyping(e.target);
    const chrome = !document.body.classList.contains('dc-ui-hidden');

    if (key === 'Escape') {
      // 1) 步行退出
      if (walk && walk.active) {
        e.preventDefault();
        e.stopImmediatePropagation();
        walk.exit();
        return;
      }
      // 2) 抽屉 / 搜索
      if (ui && ui.drawer.isOpen) {
        if (ui.drawer.current === 'locate' && ui.search.handleEscape()) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        ui.drawer.close();
        refresh();
        return;
      }
      // 3) 当前效果（最后一个生效的先退）
      const kind = kindNow();
      if (kind && ['height', 'side', 'clip', 'box', 'isolate', 'xray'].includes(kind)) {
        e.preventDefault();
        exitCurrent(kind);
        return;
      }
      // 4) 视图 / 聚焦
      if (views.activeId !== 'orbit') {
        e.preventDefault();
        views.exit();
        return;
      }
      // 5) 自动巡检
      if (tour && tour.active) {
        e.preventDefault();
        if (ui.tourHud.routesOpen) ui.tourHud.closeRoutes();
        else tour.exit();
        return;
      }
      // 6) 选中
      if (V.selectedObject()) {
        e.preventDefault();
        V.clearSelected();
      }
      return;
    }

    if (typing) return;
    if (key === ' ') {
      if (tour && tour.active) {
        e.preventDefault();
        if (ui.tourHud.routesOpen) ui.tourHud.closeRoutes();
        else tour.togglePause();
      }
      return;
    }
    if (key === 'v' || key === 'V') {
      if (!chrome || b) return;
      e.preventDefault();
      toggleDrawer('view');
      return;
    }
    if (key === '/') {
      if (!chrome || b) return;
      e.preventDefault();
      if (!ui.drawer.isOpen || ui.drawer.current !== 'locate') toggleDrawer('locate');
      ui.search.focus();
      return;
    }
    if (key === 'c' || key === 'C') {
      if (!chrome || b) return;
      e.preventDefault();
      if (sec.active) sec.reset();
      else {
        const order = ['clip', 'height', 'side', 'box'];
        const started = order.some(m => sec.setMode(m));
        if (!started) sec.setMode('height');
      }
      return;
    }
    if (key === 'x' || key === 'X') {
      if (!chrome || b) return;
      e.preventDefault();
      V.xrayFacade.toggle();
      return;
    }
    if (key === 'f' || key === 'F') {
      if (!chrome || b) return;
      e.preventDefault();
      V.focusController().toggle();
      return;
    }
    if (key === 'l' || key === 'L') {
      if (!chrome || b) return;
      e.preventDefault();
      views.setLabelsEnabled(!views.labelInfo().enabled);
      return;
    }
    if (key === 't' || key === 'T') {
      e.preventDefault();
      views.toggle('top');
      return;
    }
    if (key === 'i' || key === 'I') {
      e.preventDefault();
      if (views.active === 'iso') views.cycleIso();
      else views.enterIso('se');
      return;
    }
    if (key === '[') {
      e.preventDefault();
      views.prev();
      return;
    }
    if (key === ']') {
      e.preventDefault();
      views.next();
      return;
    }
    if (key === 'e' || key === 'E') {
      if (b) return;
      e.preventDefault();
      V.explodeCtl().toggle();
      return;
    }
    if (key === 'k' || key === 'K') {
      e.preventDefault();
      V.presentationCtl().setLineart(!V.presentationCtl().lineart);
      return;
    }
    if (key === 'g' || key === 'G') {
      if (walk && walk.active) return;
      if (document.body.classList.contains('dc-ui-hidden')) return;
      if (b || !coordinator) return;
      e.preventDefault();
      coordinator.startWalk({});
    }
  }, true);
}

/* ---------- 启动 ---------- */
let currentSrc = '';
let currentSrc2 = null;

async function fetchProject(src) {
  const res = await fetch(src, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return sanitize(await res.json());
}

async function boot() {
  params = parseViewState(location.search);
  currentSrc = params.src || '';
  if (!currentSrc) {
    fail('缺少项目地址：请通过 ?src=<项目 JSON 地址> 打开本页面');
    return;
  }
  if (params.ui === false) document.body.classList.add('dc-ui-hidden');
  showMsg('正在加载项目…');
  try {
    const canvas = document.getElementById('cv3d');
    await V.ensureScene(canvas);
    const a = await fetchProject(currentSrc);
    let b = null;
    if (params.src2 && params.src2 !== currentSrc) {
      try {
        b = await fetchProject(params.src2);
        currentSrc2 = params.src2;
      } catch (err) {
        console.warn('[对比] 方案 B 加载失败，已关闭对比：', err);
      }
    }
    projects = { a, b };
    V.loadProject(params.ab === 'b' && b ? b : a, {});
    if (b) {
      V.setCompare(a, b, {
        src: currentSrc,
        src2: currentSrc2,
        side: params.ab === 'b' ? 'b' : 'a',
        onSwitch: async (side, project) => {
          showMsg(`正在切换到方案 ${side.toUpperCase()}…`);
          V.loadProject(project, { preserveCamera: true, preserveView: true });
          hideMsg();
        },
      });
    }
    mountUI();
    applyInitialView(params);
    installKeys();
    document.title = `${V.runtime().project.name || ''} · DCDesigner 3D`;
    hideMsg();
    urlCtl = { sync: syncUrl, current: capture };
    window.__dcxd = makeDebugApi();
    // 握手：父页面收到 ready 后补发主题与最近一次实时状态。
    if (embedded) window.parent.postMessage({ source: 'dc-viewer', type: 'ready' }, '*');
  } catch (err) {
    console.error(err);
    if (!V.is3DReady()) {
      fail(`三维初始化失败：${err.message}（请开启硬件加速或使用 Chrome/Edge）`);
    } else {
      fail(`项目加载失败：${err.message}（本地文件请通过任意静态服务器打开页面）`);
    }
  }
}

function applyInitialView(p) {
  applyViewState(p, {
    setChromeVisible: on => {
      document.body.classList.toggle('dc-ui-hidden', !on);
      if (!on && ui) {
        ui.drawer.close();
        ui.rail.el.hidden = true;
      }
    },
    views: V.viewsCtl(),
    applyFocus: q => !!V.setSelected(q) && !!V.focusObject(V.selectedObject()),
    applyCut: mm => V.sectionCtl().setCut(mm),
    applySide: s => V.sectionCtl().setSide(s),
    applyClip: c => V.sectionCtl().setClip(c),
    applyBox: b => V.sectionCtl().setBox(b),
    applySection: () => false,
    applyHide: hidden => V.typeVisCtl().setHidden(hidden),
    applyXray: () => V.xrayFacade.setEnabled(true),
    applyDebug: d => V.presentationCtl().setWire(!!d),
    applyStyle: () => V.presentationCtl().setLineart(true),
    applyExplode: () => V.explodeCtl().setProfile('review'),
    tour: V.tourWalk().tour,
  });
  refresh();
  syncUrl();
}

/* ---------- 调试 API（与参考站 __dc3d 同形） ---------- */
function makeDebugApi() {
  const { tour, walk } = V.tourWalk();
  return {
    runtime: V.runtime,
    state: { get project() { return V.runtime().project; } },
    info: () => ({ ...V.viewerInfo(), url: capture() }),
    liveInfo: () => V.liveInfo(),
    applyLive: payload => {
      const live = applyLive(payload);
      return live ? { ...live, legend: liveLegend ? !liveLegend.hidden : false } : null;
    },
    clearLive: () => {
      V.clearLiveStatus();
      renderLegend(null);
      return true;
    },
    setTheme: theme => applyTheme(theme),
    theme: () => V.themeName(),
    isReady: V.is3DReady,
    hovered: () => V.hoveredObject(),
    tour: () => tour,
    walk: () => walk,
    walkInfo: () => walk.info(),
    startTour: id => V.tourWalk().coordinator.startTour(id || 'all'),
    startWalk: opts => V.tourWalk().coordinator.startWalk(opts || {}),
    firstPerson: () => V.tourWalk().coordinator.info(),
    routes: () => tour.listRoutes(),
    routePlan: id => tour.routeInfo(id),
    explode: () => V.explodeCtl(),
    camera: V.camera,
    setCameraMode: mode => V.camera().setMode(mode),
    views: V.viewsCtl,
    viewUI: () => ({
      open: ui.drawer.open,
      close: ui.drawer.close,
      toggle: toggleDrawer,
      info: () => ({ ...ui.drawer.info(), rail: railSync() }),
    }),
    section: V.sectionCtl,
    typeVis: V.typeVisCtl,
    compare: V.compareCtl,
    xray: V.xrayFacade,
    wire: {
      get enabled() { return V.presentationCtl().wire; },
      setEnabled: on => V.presentationCtl().setWire(on),
      toggle: () => V.presentationCtl().toggleWire(),
      info: () => V.presentationCtl().info().wire,
    },
    lineart: {
      get enabled() { return V.presentationCtl().lineart; },
      setEnabled: on => V.presentationCtl().setLineart(on),
      toggle: () => V.presentationCtl().toggleLineart(),
      info: () => V.presentationCtl().info().lineart,
    },
    perf: () => V.perfCtl().info(),
    bench: opts => V.perfCtl().bench_run(opts || {}),
    perfCtl: V.perfCtl,
    compass: () => V.compassCtl().info(),
    isolate: V.isolateCtl,
    focus: obj => V.focusObject(obj && obj.id ? obj : V.selectedObject()),
    focusCtl: V.focusController,
    focusObject: obj => V.focusObject(obj),
    locate: obj => V.locate(obj),
    exitFocus: V.exitFocus,
    focusInfo: V.focusInfo,
    selected: V.selectedObject,
    selection: V.selectionInfo,
    setSelected: q => V.setSelected(q),
    clearSelected: V.clearSelected,
    clip: V.clipState,
    viewpointList: V.viewpointList,
    setView: V.applyView,
    projectPoint: (x, y, z) => V.projectPoint(x, y, z),
    setChromeVisible: on => {
      document.body.classList.toggle('dc-ui-hidden', !on);
      if (ui) {
        if (!on) {
          ui.drawer.close();
          ui.rail.el.hidden = true;
        }
        refresh();
      }
      syncUrl();
    },
    url: {
      parse: parseViewState,
      info: () => capture(),
      sync: syncUrl,
      set: () => false,
    },
  };
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const data = event.data || {};
  if (data.type === 'twin-live') applyLive(data.payload);
  else if (data.type === 'theme') applyTheme(data.theme);
});

boot();
