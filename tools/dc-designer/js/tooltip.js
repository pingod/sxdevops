/**
 * 即时提示浮层：替换浏览器原生 title 提示（原生延迟约 1 秒，体验太慢）。
 * 鼠标移入带 title 的元素立即显示，移出/点击/滚动时隐藏。
 * 原理：悬停期间临时摘除 title 属性（阻止原生气泡），移出后还原，不影响可访问性。
 */

let tipEl = null;  // 浮层节点
let curEl = null;  // 当前显示提示的元素
let shown = false;

function ensure() {
  if (tipEl) return;
  tipEl = document.createElement('div');
  tipEl.className = 'tip-box';
  document.body.appendChild(tipEl);
}

/** 还原元素的 title（悬停期间被临时摘除） */
function restoreTitle() {
  if (!curEl) return;
  const t = curEl.dataset.title;
  if (t !== undefined) {
    if (t) curEl.setAttribute('title', t);
    delete curEl.dataset.title;
  }
}

function hide() {
  if (!shown) return;
  shown = false;
  tipEl.classList.remove('on');
  restoreTitle();
  curEl = null;
}

/** 显示提示：优先元素上方居中，空间不足翻到下方，并夹在视口内 */
function show(el) {
  const txt = el.getAttribute('title');
  if (!txt) return;
  ensure();
  if (curEl === el && shown) return;
  hide();
  curEl = el;
  // 临时摘除 title，阻止浏览器原生延迟气泡
  el.removeAttribute('title');
  el.dataset.title = txt;

  tipEl.textContent = txt;
  tipEl.classList.add('on');
  shown = true;

  // 先测量再定位（fixed 定位，相对视口）
  tipEl.style.visibility = 'hidden';
  tipEl.style.left = '0';
  tipEl.style.top = '0';
  const r = el.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  let y = r.top - th - 8;
  if (y < 4) y = r.bottom + 8; // 顶部空间不足 → 翻到下方
  x = Math.max(4, Math.min(x, window.innerWidth - tw - 4));
  tipEl.style.visibility = '';
  tipEl.style.left = x + 'px';
  tipEl.style.top = y + 'px';
}

/** 绑定全局提示行为（对文档内所有带 title 的元素生效） */
export function initTooltip(root = document) {
  root.addEventListener('mouseover', e => {
    const el = e.target.closest('[title]');
    if (el) show(el);
  });
  root.addEventListener('mouseout', e => {
    if (!curEl) return;
    // 以当前提示元素为准（悬停期间其 title 被摘除，closest('[title]') 不可靠——语言切换改写
    // title 后旧守卫会失效导致提示卡死）：真正离开该元素（含子节点）才隐藏
    const leaving = e.target === curEl || curEl.contains(e.target);
    const staying = e.relatedTarget && curEl.contains(e.relatedTarget);
    if (leaving && !staying) hide();
  });
  root.addEventListener('click', hide, true);     // 点击任意处隐藏
  root.addEventListener('scroll', hide, true);    // 工具栏横向滚动时隐藏
  window.addEventListener('resize', hide);
  // 键盘可访问性：聚焦时也显示提示
  document.addEventListener('focusin', e => {
    const el = e.target.closest('[title]');
    if (el) show(el);
  });
  document.addEventListener('focusout', hide);
}
