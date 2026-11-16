/** DOM 小工具（各面板共用）。 */
export const h = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

export const group = (title, hint, extra = '') => `<div class="vd-group-head">
  <h2 class="vd-group-title">${title}</h2><span class="vd-group-hint">${hint}</span></div>${extra}`;

export const rangeCard = (cls, label, outId, opts = '') => `<div class="vd-range ${cls}">
  <div class="vd-range-head"><label>${label}</label><output${outId ? ` id="${outId}"` : ''}>关闭</output></div>
  ${opts}
</div>`;

export const setOut = (root, sel, text, on = false) => {
  const o = root.querySelector(sel);
  if (!o) return;
  o.textContent = text;
  o.classList.toggle('on', !!on);
};

export const mm = v => (Number(v) || 0) / 1000;
export const two = v => mm(v).toFixed(2);
export const one = v => mm(v).toFixed(1);

export const clampNum = (v, a, b) => Math.max(a, Math.min(b, v));
