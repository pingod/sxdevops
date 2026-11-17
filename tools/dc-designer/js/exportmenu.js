/** 导出快捷入口：顶栏「导出」按钮的下拉菜单（PNG / DXF / CSV 三项合并入口）。
 *
 * 交互：
 *  - 点击「导出」按钮展开，再点（或点菜单项、点菜单外、按 Esc、缩放窗口、滚动工具栏）收起；
 *  - 导出动作本身仍绑定在 #btn-png / #btn-dxf / #btn-csv 上（见 main.js），本模块只负责
 *    展开/收起与定位，因此向导、AI Agent 等直接 .click() 这些按钮的调用路径完全不变。
 * 定位：菜单用 position: fixed（顶栏 .tb 是 overflow 裁剪容器，绝对定位子元素会被裁掉），
 * 展开时按按钮矩形贴在正下方；下方空间不足翻到按钮上方，并夹在视口内；RTL 下与按钮右缘对齐。
 * 授权：license.js 按 features 隐藏菜单项；三项全部未授权时整个导出组（#export-grp）一并隐藏。 */

import { isRTL, onLocaleChange } from './i18n.js';

const BTN_ID = 'btn-export';
const MENU_ID = 'export-menu';

let btn = null;
let menu = null;

/** 展开：先显示再量尺寸（隐藏元素量不到宽高），定位完成后恢复可见 */
function openMenu() {
  menu.hidden = false;
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let x = isRTL() ? r.right - mw : r.left; // RTL：菜单右缘对齐按钮右缘，展开方向跟随书写方向
  x = Math.max(4, Math.min(x, vw - mw - 4));
  let y = r.bottom + 6;
  if (y + mh > vh - 4) y = Math.max(4, r.top - mh - 6); // 下方空间不足 → 翻到按钮上方
  menu.style.left = Math.round(x) + 'px';
  menu.style.top = Math.round(y) + 'px';
  menu.style.visibility = '';
  btn.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
}

/** 收起菜单（未展开时无副作用；页面无合并导出入口时静默跳过） */
export function closeExportMenu() {
  if (!btn || !menu || menu.hidden) return;
  menu.hidden = true;
  btn.classList.remove('open');
  btn.setAttribute('aria-expanded', 'false');
}

/** 绑定展开/收起（main.js 启动时调用一次；旧页面缺元素时静默跳过） */
export function initExportMenu() {
  btn = document.getElementById(BTN_ID);
  menu = document.getElementById(MENU_ID);
  if (!btn || !menu) return;

  btn.addEventListener('click', e => {
    e.stopPropagation(); // 阻止冒泡到下面的“点菜单外收起”，否则同一次点击会立刻收起
    if (menu.hidden) openMenu(); else closeExportMenu();
  });

  // 点任一导出项（main.js 的 onclick 已先触发导出）：收起菜单
  menu.addEventListener('click', () => closeExportMenu());

  // 点菜单/按钮以外任何位置（含画布按下、右键）：收起；window 捕捉阶段监听，
  // 早于一切业务监听（不延迟画布操作，也不受下层 stopPropagation 影响）
  window.addEventListener('pointerdown', e => {
    if (menu.hidden) return;
    if (btn.contains(e.target) || menu.contains(e.target)) return;
    closeExportMenu();
  }, true);

  // Esc 只收菜单（消费事件：不再触发画布取消工具/退出 3D 等下层 Esc 行为）
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || menu.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    closeExportMenu();
  }, true);

  // 顶栏横向滚动 / 窗口缩放：按钮位置变化，先收起避免菜单与按钮错位
  window.addEventListener('resize', closeExportMenu);
  window.addEventListener('scroll', closeExportMenu, true);
  onLocaleChange(closeExportMenu); // 语言切换后文案宽度变化，收起重开更自然
}
