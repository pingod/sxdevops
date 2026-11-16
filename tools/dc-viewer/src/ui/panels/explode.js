/** 拆解面板：两档展开幅度 + 展开/拼装按钮 + 说明。 */
import { group } from '../dom.js';

export function createExplodePanel(cb = {}) {
  const el = document.createElement('div');
  el.innerHTML = `
    <section class="vd-group" data-group="explode">
      ${group('展开幅度', '评审看构件，演示看层次')}
      <div class="vd-items vd-items-2">
        <button type="button" class="vd-item" data-explode-profile="presentation" aria-pressed="false"
          title="演示档 · 大幅外扩 · 分层夸张"><span class="vd-ico" aria-hidden="true">✥</span>
          <span class="vd-txt"><b>演示档</b><small>大幅外扩 · 分层夸张</small></span></button>
        <button type="button" class="vd-item" data-explode-profile="review" aria-pressed="false"
          title="评审档 · 小幅外扩 · 构件可辨"><span class="vd-ico" aria-hidden="true">⤢</span>
          <span class="vd-txt"><b>评审档</b><small>小幅外扩 · 构件可辨</small></span></button>
      </div>
    </section>
    <div class="explode-action">
      <button type="button" class="explode-toggle" id="explode-toggle" aria-keyshortcuts="E"
        title="爆炸展开机房构件（快捷键 E）"><span class="ex-ico" aria-hidden="true">✥</span>
        <span class="ex-txt">展开构件</span></button>
    </div>
    <p class="tool-note">展开后仍可切换档位；点击「拼装复原」回到原布局。快捷键 E。</p>`;

  const btn = el.querySelector('#explode-toggle');

  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.explodeProfile) return cb.onProfile && cb.onProfile(b.dataset.explodeProfile);
    if (b.id === 'explode-toggle') return cb.onToggle && cb.onToggle();
    return undefined;
  });

  function refresh(state) {
    const ex = state.explode || {};
    const busy = !!state.busy;
    btn.disabled = busy || !ex.canStart;
    btn.dataset.state = ex.state || 'assembled';
    btn.dataset.profile = ex.profile || 'presentation';
    btn.setAttribute('aria-busy', ex.animating ? 'true' : 'false');
    btn.setAttribute('aria-pressed', ex.state === 'exploded' || ex.state === 'exploding' ? 'true' : 'false');
    const review = ex.profile === 'review';
    let icon = '✥';
    let label = '展开构件';
    let title = '爆炸展开机房构件（快捷键 E）';
    if (ex.state === 'exploding') {
      icon = '✥';
      label = '展开中…';
      title = '正在展开构件';
    } else if (ex.state === 'assembling') {
      icon = '⤡';
      label = '拼装中…';
      title = '正在拼装回原位';
    } else if (ex.state === 'exploded') {
      icon = '⤡';
      label = '拼装复原';
      title = '按反序拼装回原位（快捷键 E）';
    }
    btn.title = title + ' · 当前' + (review ? '评审档（小幅位移）' : '演示档（大幅位移）');
    btn.innerHTML = `<span class="ex-ico" aria-hidden="true">${icon}</span><span class="ex-txt">${label}</span>`
      + (review ? '<span class="ex-badge" aria-hidden="true">评审</span>' : '');
    for (const b of el.querySelectorAll('[data-explode-profile]')) {
      const on = (ex.profile || 'presentation') === b.dataset.explodeProfile;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-active', on);
      b.disabled = busy || !!state.tourActive || !!state.walkActive || !!ex.animating;
    }
  }

  return { el, refresh, btn };
}
