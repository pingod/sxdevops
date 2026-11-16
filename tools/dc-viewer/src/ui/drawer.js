/**
 * 工具抽屉：右侧分区面板（rail 76px + panel 356px），任务互斥、记忆滚动位置，
 * Esc/× 收起，打开后焦点落到当前生效控件。
 */
import { TOOL_TASKS } from './rail.js';

export function createDrawer(opts = {}) {
  const onClose = opts.onClose || (() => {});
  const el = document.createElement('div');
  el.className = 'view-drawer task-drawer';
  el.id = 'view-drawer';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'false');
  el.setAttribute('aria-labelledby', 'view-drawer-title');
  el.setAttribute('aria-describedby', 'view-drawer-sub view-drawer-foot');
  el.innerHTML = `<div class="vd-head">
      <div class="vd-heading">
        <span class="vd-title" id="view-drawer-title"></span>
        <span class="vd-sub" id="view-drawer-sub"></span>
      </div>
      <button type="button" class="vd-close" title="收起工具面板（Esc）" aria-label="收起工具面板" aria-keyshortcuts="Escape">×</button>
    </div>
    <div class="vd-panels"></div>
    <div class="vd-foot" id="view-drawer-foot">可边调整边旋转预览 · Esc 或 × 收起面板</div>`;
  document.body.appendChild(el);
  const titleEl = el.querySelector('.vd-title');
  const subEl = el.querySelector('.vd-sub');
  const closeBtn = el.querySelector('.vd-close');
  const panelsWrap = el.querySelector('.vd-panels');
  const panels = new Map();
  const scrolls = new Map();
  let current = null;
  let wantOpen = false;
  let suspended = false;

  closeBtn.addEventListener('click', () => onClose());

  function register(task, node) {
    const wrap = document.createElement('div');
    wrap.className = 'tool-panel';
    wrap.id = 'tool-panel-' + task;
    wrap.dataset.panel = task;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', (TOOL_TASKS.find(t => t.id === task) || {}).label || task);
    wrap.hidden = true;
    wrap.appendChild(node);
    panelsWrap.appendChild(wrap);
    panels.set(task, { wrap, node });
  }

  function select(task) {
    if (!panels.has(task)) return false;
    if (current && current !== task && panels.get(current)) scrolls.set(current, panels.get(current).wrap.scrollTop || 0);
    current = task;
    for (const [id, p] of panels) p.wrap.hidden = id !== task;
    el.dataset.task = task;
    const t = TOOL_TASKS.find(x => x.id === task);
    if (t) {
      titleEl.textContent = t.label;
      subEl.textContent = t.hint;
    }
    const p = panels.get(task);
    if (p) p.wrap.scrollTop = scrolls.get(task) || 0;
    return true;
  }

  function open(task) {
    wantOpen = true;
    select(task);
    el.hidden = false;
    document.body.classList.add('dc-tools-open');
    return true;
  }

  function close() {
    wantOpen = false;
    if (el.hidden) return false;
    if (document.activeElement && el.contains(document.activeElement)) document.activeElement.blur();
    el.hidden = true;
    document.body.classList.remove('dc-tools-open');
    return true;
  }

  function focusCurrent() {
    const p = panels.get(current);
    if (!p) return;
    const target = p.wrap.querySelector('[aria-pressed="true"]:not(:disabled)')
      || p.wrap.querySelector('button:not(:disabled), input:not(:disabled)')
      || closeBtn;
    if (target) target.focus({ preventScroll: true });
  }

  function panelEl(task) {
    const p = panels.get(task);
    return p ? p.wrap : null;
  }

  function setBadge(task, busy) {
    const t = panels.get(task);
    if (t) t.wrap.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  return {
    el,
    register,
    select,
    open,
    close,
    panelEl,
    focusCurrent,
    setBadge,
    get current() {
      return current;
    },
    get isOpen() {
      return !el.hidden;
    },
    get wanted() {
      return wantOpen;
    },
    setSuspended(v) {
      suspended = !!v;
    },
    get suspended() {
      return suspended;
    },
    setTitle(task) {
      const t = TOOL_TASKS.find(x => x.id === task);
      if (t && current === task) {
        titleEl.textContent = t.label;
        subEl.textContent = t.hint;
      }
    },
    info() {
      return {
        open: !el.hidden,
        task: current,
        wantOpen,
        suspended,
        title: titleEl.textContent,
        sub: subEl.textContent,
      };
    },
  };
}
