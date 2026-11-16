/**
 * 手动步行 HUD：标题/速度/切自动/起伏/退出 + 提示行、准星、虚拟摇杆（触屏）。
 */
import { walkHint, speedText } from '../features/walk.js';

export function createWalkHud(cb = {}) {
  const el = document.createElement('div');
  el.className = 'walk-hud';
  el.id = 'walk-hud';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', '手动步行');
  el.hidden = true;
  el.innerHTML = `
    <div class="wh-row">
      <span class="wh-dot" aria-hidden="true"></span>
      <span class="wh-title" aria-live="polite">手动步行</span>
      <span class="wh-meta">1.3 m/s</span>
      <span class="wh-btns">
        <button type="button" class="wh-btn wh-tour" data-act="tour" title="切回自动巡检（从最近路线点继续）">切自动</button>
        <button type="button" class="wh-btn wh-bob" data-act="bob" aria-pressed="true" title="开关步行起伏（防眩晕）">起伏开</button>
        <button type="button" class="wh-btn wh-exit" data-act="exit" aria-keyshortcuts="Escape">退出</button>
      </span>
    </div>
    <div class="wh-hint" aria-live="polite">WASD / 方向键移动 · 拖拽画面看向 · 点击设备选中 · Esc 退出</div>`;
  document.body.appendChild(el);

  const cross = document.createElement('div');
  cross.className = 'walk-cross';
  cross.id = 'walk-cross';
  cross.hidden = true;
  cross.setAttribute('aria-hidden', 'true');
  document.body.appendChild(cross);

  const joy = document.createElement('div');
  joy.className = 'walk-joystick';
  joy.id = 'walk-joystick';
  joy.hidden = true;
  joy.setAttribute('role', 'group');
  joy.setAttribute('aria-label', '移动摇杆');
  joy.setAttribute('aria-roledescription', '虚拟摇杆');
  joy.innerHTML = `<i class="wj-knob"></i><span class="wj-arrow" style="top:7px;left:50%;transform:translateX(-50%)">▲</span>
    <span class="wj-arrow" style="bottom:7px;left:50%;transform:translateX(-50%)">▼</span>
    <span class="wj-arrow" style="left:6px;top:50%;transform:translateY(-50%)">◀</span>
    <span class="wj-arrow" style="right:6px;top:50%;transform:translateY(-50%)">▶</span>`;
  for (const a of joy.querySelectorAll('.wj-arrow')) a.setAttribute('aria-hidden', 'true');
  document.body.appendChild(joy);

  const title = el.querySelector('.wh-title');
  const meta = el.querySelector('.wh-meta');
  const hint = el.querySelector('.wh-hint');
  const tourBtn = el.querySelector('[data-act="tour"]');
  const bobBtn = el.querySelector('[data-act="bob"]');
  const exitBtn = el.querySelector('[data-act="exit"]');
  const knob = joy.querySelector('.wj-knob');
  let lastTouch = null;

  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.act === 'tour') return cb.onTour && cb.onTour();
    if (b.dataset.act === 'bob') return cb.onBob && cb.onBob();
    if (b.dataset.act === 'exit') return cb.onExit && cb.onExit();
    return undefined;
  });

  // 摇杆指针
  let joyId = null;
  const joyMove = (cx, cy) => {
    const r = joy.getBoundingClientRect();
    const dx = cx - (r.left + r.width / 2);
    const dy = cy - (r.top + r.height / 2);
    const radius = r.width * 0.31;
    const len = Math.hypot(dx, dy) || 1;
    const cl = Math.min(1, len / radius);
    const nx = (dx / len) * cl;
    const ny = (dy / len) * cl;
    knob.style.transform = `translate(-50%,-50%) translate(${nx * radius}px, ${ny * radius}px)`;
    knob.classList.add('is-active');
    if (cb.onJoystick) cb.onJoystick(nx, ny);
  };
  joy.addEventListener('pointerdown', e => {
    e.preventDefault();
    joyId = e.pointerId;
    try {
      joy.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    joyMove(e.clientX, e.clientY);
  });
  joy.addEventListener('pointermove', e => {
    if (e.pointerId !== joyId) return;
    joyMove(e.clientX, e.clientY);
  });
  const joyEnd = e => {
    if (e.pointerId !== joyId) return;
    joyId = null;
    knob.style.transform = 'translate(-50%,-50%)';
    knob.classList.remove('is-active');
    if (cb.onJoystick) cb.onJoystick(0, 0);
  };
  joy.addEventListener('pointerup', joyEnd);
  joy.addEventListener('pointercancel', joyEnd);
  joy.addEventListener('contextmenu', e => e.preventDefault());

  function refresh(state) {
    const active = !!state.active;
    el.hidden = !active;
    cross.hidden = !active;
    document.body.classList.toggle('is-walking', active);
    document.body.classList.toggle('is-walk-touch', active && !!state.touch);
    joy.hidden = !(active && state.touch);
    if (!active) return;
    title.textContent = state.state === 'enter' ? '进入步行…'
      : state.state === 'exit' ? '退出手动步行…' : '手动步行';
    if (state.state === 'walk') {
      meta.textContent = state.narrow
        ? '窄通道 ' + speedText(state.speed || 1300 * 0.62)
        : speedText(state.speed || 0) + (state.moved > 500 ? ` · ${Math.round(state.moved / 1000)} m` : '');
    } else {
      meta.textContent = state.state === 'exit' ? '正在返回…' : '就位中…';
    }
    bobBtn.textContent = state.bob ? '起伏开' : '起伏关';
    bobBtn.setAttribute('aria-pressed', state.bob ? 'true' : 'false');
    bobBtn.title = state.bob ? '关闭步行起伏（防眩晕）' : '开启步行起伏';
    tourBtn.disabled = !(state.state === 'walk' && state.onTour !== false);
    tourBtn.title = tourBtn.disabled ? '站稳后才能切回自动巡检' : '切回自动巡检（从最近路线点继续）';
    if (lastTouch !== !!state.touch) {
      lastTouch = !!state.touch;
      hint.textContent = walkHint(!!state.touch);
    }
  }

  function info() {
    return {
      visible: !el.hidden,
      title: title.textContent,
      meta: meta.textContent,
      hint: hint.textContent,
      joystick: !joy.hidden,
      cross: !cross.hidden,
    };
  }

  return { el, cross, joy, refresh, info };
}
