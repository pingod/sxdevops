/**
 * 指北针与比例尺 HUD：仅在正交、非过渡、非第一视角时显示。
 * 北向角由相机基向量求得；比例尺取 1/2/5×10ⁿ 米档。
 */
import { COMPASS, compassPlan, summarizeCompass } from './compassplan.js';

export function createCompass(deps = {}) {
  const rig = deps.rig;
  const controls = deps.controls;
  const getActiveId = deps.getActiveId || (() => 'orbit');
  const getCorner = deps.getCorner || (() => null);
  const getViewpointLabel = deps.getViewpointLabel || (() => '');
  const isSuppressed = deps.isSuppressed || (() => false);
  const getViewport = deps.getViewport || (() => ({ w: window.innerWidth, h: window.innerHeight }));

  let el = null;
  let titleEl = null;
  let subEl = null;
  let roseEl = null;
  let rotEl = null;
  let northEl = null;
  let scaleEl = null;
  let barEl = null;
  let barFillEl = null;
  let labelEl = null;
  let last = '';
  let lastPlan = null;

  function ensure() {
    if (el && el.isConnected) return;
    el = document.createElement('div');
    el.className = 'compass-hud';
    el.id = 'compass-hud';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<div class="cmp-head"><span class="cmp-title"></span><span class="cmp-sub"></span></div>
      <div class="cmp-body">
        <div class="cmp-rose" aria-hidden="true"><span class="cmp-ring"></span>
          <span class="cmp-rot"><span class="cmp-n">N</span><span class="cmp-needle"></span></span></div>
        <div class="cmp-scale" aria-hidden="true"><div class="cmp-bar"><i></i></div><span class="cmp-label"></span></div>
      </div>`;
    document.body.appendChild(el);
    titleEl = el.querySelector('.cmp-title');
    subEl = el.querySelector('.cmp-sub');
    roseEl = el.querySelector('.cmp-rose');
    rotEl = el.querySelector('.cmp-rot');
    northEl = el.querySelector('.cmp-n');
    scaleEl = el.querySelector('.cmp-scale');
    barEl = el.querySelector('.cmp-bar');
    barFillEl = el.querySelector('.cmp-bar i');
    labelEl = el.querySelector('.cmp-label');
  }

  function update() {
    if (!rig) return null;
    const vp = getViewport();
    const mode = rig.mode === 'ortho' && !rig.transitioning ? 'ortho' : 'perspective';
    const cam = rig.camera;
    const e = cam.matrixWorld.elements;
    const right = { x: e[0], y: e[1], z: e[2] };
    const up = { x: e[4], y: e[5], z: e[6] };
    const plan = compassPlan({
      activeId: getActiveId(),
      cameraMode: mode,
      right,
      up,
      worldPerPixel: rig.worldPerPixel(vp.h, controls.cur.r),
      viewportWidth: vp.w,
      corner: getCorner(),
      viewpointLabel: getViewpointLabel(),
      suppressed: isSuppressed(),
    });
    lastPlan = plan;
    ensure();
    if (!plan.show) {
      if (el && !el.hidden) el.hidden = true;
      if (el) el.setAttribute('aria-hidden', 'true');
      last = '';
      return summarizeCompass(plan);
    }
    const sig = [plan.title, plan.sub, plan.northAngle == null ? '' : plan.northAngle.toFixed(1),
      plan.scale ? plan.scale.label : '', plan.scale ? plan.scale.px : ''].join('|');
    if (sig === last && !el.hidden) return summarizeCompass(plan);
    last = sig;
    el.hidden = false;
    el.removeAttribute('aria-hidden');
    el.title = plan.aria;
    el.setAttribute('aria-label', plan.aria);
    titleEl.textContent = plan.title;
    subEl.textContent = plan.sub;
    if (plan.showNorth) {
      const a = Math.round(plan.northAngle * 10) / 10;
      roseEl.hidden = false;
      el.classList.remove('is-compact');
      rotEl.style.transform = `rotate(${a}deg)`;
      northEl.style.transform = `translateX(-50%) rotate(${-a}deg)`;
      el.dataset.north = String(a);
    } else {
      roseEl.hidden = true;
      el.classList.add('is-compact');
      delete el.dataset.north;
    }
    if (plan.scale) {
      scaleEl.hidden = false;
      barFillEl.style.width = plan.scale.px + 'px';
      barEl.style.width = plan.scale.px + 'px';
      labelEl.textContent = plan.scale.label;
      el.dataset.scale = plan.scale.label;
    } else {
      scaleEl.hidden = true;
      delete el.dataset.scale;
    }
    return summarizeCompass(plan);
  }

  function destroy() {
    if (el) el.remove();
    el = null;
  }

  function info() {
    return { ...(summarizeCompass(planOn() || lastPlan)), visible: !!(el && !el.hidden) };
  }

  function planOn() {
    if (!lastPlan) return null;
    return lastPlan;
  }

  return { update, info, destroy, get el() { return el; }, get plan() { return lastPlan; } };
}

export { COMPASS };
