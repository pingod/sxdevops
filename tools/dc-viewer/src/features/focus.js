/**
 * 聚焦门面：把视图层与选中状态组合成 focusCtl（active/canStart/focus/exit/toggle/info）。
 */
export function createFocusFacade({ getViews, getSelected, getTour, getWalk, exploder, focus, exit }) {
  return {
    get active() {
      const v = getViews();
      return !!(v && v.focus);
    },
    get canStart() {
      const sel = getSelected();
      const t = getTour ? getTour() : null;
      const w = getWalk ? getWalk() : null;
      return !!sel && !(t && t.active) && !(w && w.active) && (!exploder || exploder.state === 'assembled');
    },
    get label() {
      const v = getViews();
      return v && v.focus ? v.focus.label : '';
    },
    focus(obj) {
      return focus ? focus(obj) : false;
    },
    exit() {
      return exit ? exit() : false;
    },
    toggle() {
      const v = getViews();
      if (v && v.focus) return exit ? exit() : false;
      const sel = getSelected();
      return sel ? (focus ? focus(sel) : false) : false;
    },
    info() {
      const v = getViews();
      const f = v ? v.info().focus : { active: false };
      const sel = getSelected();
      return {
        ...f,
        canStart: this.canStart,
        selected: sel ? { id: sel.id, name: (sel.props && sel.props.name) || null } : null,
      };
    },
  };
}
