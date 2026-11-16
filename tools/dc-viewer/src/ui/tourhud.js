/**
 * 自动巡检 HUD：标题/路线按钮/进度条/暂停/调速/切手动/退出 + 路线浮层。
 */
export function createTourHud(cb = {}) {
  const el = document.createElement('div');
  el.className = 'tour-hud';
  el.id = 'tour-hud';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', '自动巡检');
  el.hidden = true;
  el.innerHTML = `
    <div class="th-row">
      <span class="th-dot" aria-hidden="true"></span>
      <span class="th-title" aria-live="polite">自动巡检</span>
      <button type="button" class="th-route" data-act="routes" aria-haspopup="true"
        aria-expanded="false" aria-controls="tour-routes" title="切换巡视路线">全场环线 ▾</button>
      <span class="th-pct">0%</span>
    </div>
    <div class="th-bar" role="progressbar" aria-label="巡检进度" aria-valuemin="0"
      aria-valuemax="100" aria-valuenow="0"><i></i></div>
    <div class="th-row th-row2">
      <span class="th-hint" aria-live="polite">沿通道自动巡检 · 空格暂停 / Esc 退出</span>
      <span class="th-btns">
        <button type="button" class="th-btn" data-act="pause">暂停</button>
        <button type="button" class="th-btn th-speed" data-act="speed" title="切换巡检速度">1×</button>
        <button type="button" class="th-btn th-walk" data-act="walk" title="从当前位置切到手动步行（T22）">切手动</button>
        <button type="button" class="th-btn th-exit" data-act="exit">退出</button>
      </span>
    </div>
    <div id="tour-routes" class="th-routes" hidden role="group" aria-label="选择巡视路线"></div>`;
  document.body.appendChild(el);

  const title = el.querySelector('.th-title');
  const routeBtn = el.querySelector('.th-route');
  const pct = el.querySelector('.th-pct');
  const bar = el.querySelector('.th-bar');
  const fill = bar.querySelector('i');
  const hint = el.querySelector('.th-hint');
  const pauseBtn = el.querySelector('[data-act="pause"]');
  const speedBtn = el.querySelector('[data-act="speed"]');
  const walkBtn = el.querySelector('[data-act="walk"]');
  const exitBtn = el.querySelector('[data-act="exit"]');
  const routesEl = el.querySelector('.th-routes');
  let lastPct = -1;
  let routesKey = '';
  let routeNotice = '';

  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'routes') return toggleRoutes();
    if (act === 'rbtn') {
      closeRoutes();
      return cb.onRoute && cb.onRoute(b.dataset.route);
    }
    if (act === 'pause') return cb.onPause && cb.onPause();
    if (act === 'speed') return cb.onSpeed && cb.onSpeed();
    if (act === 'walk') return cb.onWalk && cb.onWalk();
    if (act === 'exit') return cb.onExit && cb.onExit();
    return undefined;
  });

  function toggleRoutes() {
    if (!routesEl.hidden) {
      closeRoutes();
      return false;
    }
    routesEl.hidden = false;
    routeBtn.setAttribute('aria-expanded', 'true');
    const active = routesEl.querySelector('.is-active:not(:disabled), .th-rbtn');
    if (active) active.focus({ preventScroll: true });
    return true;
  }

  function closeRoutes() {
    if (routesEl.hidden) return false;
    routesEl.hidden = true;
    routeBtn.setAttribute('aria-expanded', 'false');
    return true;
  }

  function setNotice(text) {
    routeNotice = text || '';
    syncHint(lastState);
  }

  let lastState = null;

  function syncHint(state) {
    if (!state) return;
    if (routeNotice) hint.textContent = routeNotice;
    else if (state.pendingRoute) hint.textContent = `正在切换路线：${state.routeLabel || ''}…`;
    else if (state.routeHint) hint.textContent = `${state.routeHint} · 切手动可自由走动 / Esc 退出`;
    else hint.textContent = '沿通道自动巡检 · 切手动可自由走动 / Esc 退出';
  }

  function refresh(state) {
    lastState = state;
    const active = !!state.active;
    el.hidden = !active;
    if (!active) {
      closeRoutes();
      return;
    }
    el.classList.toggle('paused', !!state.paused);
    title.textContent = state.pendingRoute ? '切换路线…'
      : state.paused ? '已暂停'
        : state.state === 'enter' ? '进入自动巡检…'
          : state.state === 'exit' ? '退出自动巡检…' : '自动巡检';
    routeBtn.textContent = `${state.routeLabel || '全场环线'} ▾`;
    routeBtn.title = `切换巡视路线 · 当前 ${state.routeLabel || '全场环线'}`;
    const routes = state.routes || [];
    routeBtn.disabled = routes.length <= 1;
    const p = Math.round((state.progress || 0) * 100);
    if (p !== lastPct) {
      lastPct = p;
      pct.textContent = p + '%';
      fill.style.width = p + '%';
      bar.setAttribute('aria-valuenow', String(p));
      bar.setAttribute('aria-valuetext', `巡检进度 ${p}%`);
    }
    pauseBtn.textContent = state.paused ? '继续' : '暂停';
    speedBtn.textContent = `${state.speed || 1}×`;
    walkBtn.disabled = !(state.state === 'walk' && state.onWalk !== false);
    walkBtn.title = walkBtn.disabled ? '进入通道后才能切手动步行' : '从当前位置切到手动步行';
    exitBtn.disabled = false;
    syncHint(state);
    const key = routes.map(r => `${r.id}:${r.label}:${r.available === false ? 0 : 1}`).join('|');
    if (key !== routesKey) {
      routesKey = key;
      routesEl.innerHTML = routes.map(r => `<button type="button" class="th-rbtn${r.id === state.route ? ' is-active' : ''}" data-act="rbtn"
        data-route="${r.id}" title="${r.hint || ''}"${r.available === false ? ' disabled' : ''}>${r.label}</button>`).join('');
    }
    for (const b of routesEl.querySelectorAll('.th-rbtn')) {
      b.classList.toggle('is-active', b.dataset.route === state.route);
    }
  }

  function info() {
    return {
      visible: !el.hidden,
      title: title.textContent,
      pct: pct.textContent,
      hint: hint.textContent,
      routesOpen: !routesEl.hidden,
      route: routeBtn.textContent,
    };
  }

  return { el, refresh, toggleRoutes, closeRoutes, setNotice, info, get routesOpen() { return !routesEl.hidden; } };
}
