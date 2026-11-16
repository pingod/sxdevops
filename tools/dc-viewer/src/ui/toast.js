/** 轻提示（选中/找不到对象）：底部胶囊，1.8s 自动消失。 */
let el = null;
let timer = 0;
let removeTimer = 0;

export function showToast(text) {
  if (typeof document === 'undefined') return;
  if (!el) {
    el = document.createElement('div');
    el.className = 'selection-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = String(text || '');
  clearTimeout(timer);
  clearTimeout(removeTimer);
  el.classList.remove('on');
  // 强制回流后重新加 .on，保证连续提示也能重播动画
  void el.offsetWidth;
  el.classList.add('on');
  timer = setTimeout(() => {
    el.classList.remove('on');
    removeTimer = setTimeout(() => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      el = null;
    }, 220);
  }, 1800);
}
