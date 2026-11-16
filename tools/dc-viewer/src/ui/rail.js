/**
 * 右侧任务导航（工具轨）：6 个入口按钮，顺序固定，SVG 图标 20×20。
 */
export const TOOL_TASKS = Object.freeze([
  { id: 'view', label: '视角', hint: '总览、工程视角与场景机位', icon: 'view', key: 'V' },
  { id: 'display', label: '显示', hint: '分类显隐、呈现风格与辅助信息', icon: 'display' },
  { id: 'section', label: '剖切', hint: '选择一种方式查看内部，控件按需显示', icon: 'section', key: 'C' },
  { id: 'locate', label: '定位', hint: '搜索设备 → 聚焦 → 隔离查看', icon: 'locate', key: '/' },
  { id: 'roam', label: '漫游', hint: '自动巡视或手动步行，进入后可相互切换', icon: 'roam', key: 'G' },
  { id: 'explode', label: '拆解', hint: '选择位移档位，再展开或拼装复原', icon: 'explode', key: 'E' },
]);

const ICONS = Object.freeze({
  view: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  display: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  section: '<path d="M4 4h16v16H4zM4 15 15 4M9 20 20 9M4 9l5-5M15 20l5-5"/>',
  locate: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M10.5 7v7M7 10.5h7"/>',
  roam: '<path d="M9 18H6a3 3 0 1 1 0-6h12a3 3 0 1 0 0-6h-3"/><circle cx="11" cy="18" r="2"/><path d="m14 3 3 3-3 3"/>',
  explode: '<path d="m12 8 5 3-5 3-5-3 5-3ZM7 11v5l5 3 5-3v-5M12 14v5M12 2v3M3 6l3 2M21 6l-3 2M3 19l3-2M21 19l-3-2"/>',
});

const svg = icon => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" `
  + `stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;

export function createRail(opts = {}) {
  const onSelect = opts.onSelect || (() => {});
  const dock = document.createElement('div');
  dock.className = 'action-dock task-dock';
  dock.id = 'action-dock';
  dock.setAttribute('role', 'group');
  dock.setAttribute('aria-label', '机房查看操作');
  const buttons = new Map();

  for (const t of TOOL_TASKS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool-open';
    b.id = t.id === 'view' ? 'view-open' : 'tool-' + t.id;
    b.dataset.task = t.id;
    b.title = `${t.label} · ${t.hint}${t.key ? `（${t.key}）` : ''}`;
    b.setAttribute('aria-label', `${t.label}工具`);
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-controls', 'view-drawer');
    b.setAttribute('aria-expanded', 'false');
    if (t.key) b.setAttribute('aria-keyshortcuts', t.key);
    b.innerHTML = `${svg(t.icon)}<span>${t.label}</span><i aria-hidden="true"></i>`;
    b.addEventListener('click', () => onSelect(t.id));
    dock.appendChild(b);
    buttons.set(t.id, b);
  }

  // 轨内方向键漫游
  dock.addEventListener('keydown', e => {
    if (!/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End)$/.test(e.key)) return;
    const list = [...buttons.values()].filter(b => !b.hidden && !b.disabled);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    let n = i;
    if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = list.length - 1;
    else n = (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + list.length) % list.length;
    list[n].focus({ preventScroll: true });
    e.preventDefault();
  });

  function sync({ open, visible = true, available = {}, active = {} }) {
    for (const [id, b] of buttons) {
      b.hidden = !visible;
      const ok = available[id] !== false;
      b.disabled = !ok;
      b.classList.toggle('is-open', !!open && open === id);
      b.classList.toggle('has-effect', !!active[id]);
      b.setAttribute('aria-expanded', open === id ? 'true' : 'false');
      if (open === id) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
  }

  return {
    el: dock,
    draw() {
      if (!dock.isConnected) document.body.appendChild(dock);
    },
    trigger(id) {
      return buttons.get(id) || null;
    },
    buttons: () => [...buttons.values()],
    sync,
    destroy() {
      dock.remove();
    },
  };
}
