/**
 * 第一视角协同：巡检 ↔ 手动步行原地接管（不瞬移），失败回滚。
 */
export const FP_MODE = Object.freeze({ ORBIT: 'orbit', TOUR: 'tour', WALK: 'walk' });

export const HANDOFF = Object.freeze({
  sec: 1.0,
  lift: 0.45,
});

export function firstPersonMode(tourActive, walkActive) {
  if (tourActive && walkActive) return 'conflict';
  return tourActive ? FP_MODE.TOUR : walkActive ? FP_MODE.WALK : FP_MODE.ORBIT;
}

export function fpTitle(mode, state) {
  if (mode === 'tour') {
    if (state === 'enter') return '进入自动巡检…';
    if (state === 'exit') return '退出自动巡检…';
    return '自动巡检';
  }
  if (mode === 'walk') {
    if (state === 'enter') return '进入手动步行…';
    if (state === 'exit') return '退出手动步行…';
    return '手动步行';
  }
  if (state === 'switch') return '切换路线…';
  return '机房视图';
}

export function handoffInfo(mode, state, ctx = {}) {
  return {
    mode,
    state,
    conflict: mode === 'conflict',
    canTourToWalk: mode === FP_MODE.TOUR && state === 'walk',
    canWalkToTour: mode === FP_MODE.WALK && state === 'walk',
    route: ctx.route || null,
    tourActive: !!ctx.tourActive,
    walkActive: !!ctx.walkActive,
  };
}

export function createCoordinator({ tour, walk, onchange }) {
  const emit = () => {
    if (typeof onchange === 'function') {
      try {
        onchange(info());
      } catch (err) {
        console.warn('[第一视角] onchange 异常：', err);
      }
    }
  };

  function startTour(id = 'all') {
    if (tour.checkTransport && tour.checkTransport()) return false;
    if (walk.active && !walk.walking) return false;
    if (walk.walking) {
      const h = walk.handoffToTour();
      if (!h) return false;
      const ok = tour.start(id, { fromWalk: true, x: h.x, y: h.y, yaw: h.yaw, pitch: h.pitch, s: 0 });
      if (!ok) {
        walk.start({ x: h.x, y: h.y, yaw: h.yaw, pitch: h.pitch, fromTour: true });
        emit();
        return false;
      }
      walk.acceptTourHandoff();
      emit();
      return true;
    }
    const ok = tour.start(id);
    emit();
    return ok;
  }

  function startWalk(opts = {}) {
    if (tour.active && !tour.walking) return false;
    if (tour.walking) {
      const h = tour.handoffToWalk();
      if (!h) return false;
      const ok = walk.start({ ...opts, x: h.x, y: h.y, yaw: h.yaw, pitch: h.pitch, fromTour: true });
      if (!ok) {
        tour.start(h.routeId, { fromWalk: true, x: h.x, y: h.y, yaw: h.yaw, pitch: h.pitch, s: h.s });
        emit();
        return false;
      }
      tour.acceptWalkHandoff();
      emit();
      return true;
    }
    const ok = walk.start(opts);
    emit();
    return ok;
  }

  function exit() {
    if (walk.active) walk.exit();
    if (tour.active) tour.exit();
    emit();
    return true;
  }

  function info() {
    const t = tour.info();
    const w = walk.info();
    const mode = firstPersonMode(t.active, w.active);
    return handoffInfo(mode, t.state === 'idle' ? w.state : t.state, {
      route: t.route,
      tourActive: t.active,
      walkActive: w.active,
    });
  }

  return { startTour, startWalk, exit, info };
}
