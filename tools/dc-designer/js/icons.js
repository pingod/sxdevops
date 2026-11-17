/**
 * SVG 图标库：全站统一的线性图标（24×24 viewBox，stroke=currentColor，随文字颜色变化）
 * - 通用操作类采用 Lucide/Feather 风格简洁线稿
 * - 建模对象类（墙/门/窗/柱/机柜/桥架）采用平面图制图符号风格，与画布图例一致
 * 用法：静态 HTML 写 <i data-ic="undo"></i>，启动时 hydrateIcons() 注入；
 *       动态 HTML 直接拼接 icon('undo') 返回的 SVG 字符串。
 */

const ICONS = {
  pipe: '<path d="M3 7h9v10h9M3 11h5v10h13"/><path d="M3 5v8M19 15v8"/>',
  /* ---------- 编辑操作 ---------- */
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  bars: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>', // ☰：属性面板收起态的「展开面板」按钮

  /* ---------- 视图 ---------- */
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  grid: '<rect width="18" height="18" x="3" y="3" rx="1"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  magnet: '<path d="M5 3h4v8a3 3 0 0 0 6 0V3h4v8a7 7 0 0 1-14 0Z"/><path d="M5 7h4"/><path d="M15 7h4"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  // 3D 隔离：箭头向下压到地面（其他对象高度归零）
  isolate: '<path d="M12 3v8"/><path d="m8.5 7.5 3.5 3.5 3.5-3.5"/><path d="M3 15h18"/><path d="M6 19h12"/>',
  zoomin: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>',
  zoomout: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>',
  // AI Agent 自然语言设计（机器人线稿）
  ai: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  // 合规自检（盾牌 + 对勾）
  check: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',

  /* ---------- 文件 ---------- */
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  open: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  new: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M12 18v-6"/><path d="M9 15h6"/>',
  // 导出（下载到本地：托盘 + 向下箭头；顶栏合并导出入口图标）
  export: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  // DXF 图纸导出（三角尺 + 基线，CAD 制图意象）
  dxf: '<path d="M2 20h20"/><path d="M19 5 4 20h15V5z"/><path d="M15 13v4h-4"/>',
  // CSV 工程量清单导出（表格：边框 + 分隔线，电子表格意象）
  csv: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18"/><path d="M3 14h18"/><path d="M9 4v16"/>',
  // 提交到 nVisual Studio（云朵 + 上传箭头：与「导出」的本地下载意象区分，一取一交）
  'nvisual-upload': '<path d="M4.4 15.3A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.4 8.3"/><path d="M12 21v-9"/><path d="m8.4 15.6 3.6-3.6 3.6 3.6"/>',

  /* ---------- 建模对象（平面图符号风格） ---------- */
  cursor: '<path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51Z"/><path d="m13 13 6 6"/>',
  wall: '<path d="M2 9h20"/><path d="M2 15h20"/><path d="M2 9v6"/><path d="M22 9v6"/>',
  door: '<path d="M2 12h5"/><path d="M17 12h5"/><path d="M7 12V7"/><path d="M17 12V7"/><path d="M12 12A5 5 0 0 0 7 7"/><path d="M12 12A5 5 0 0 1 17 7"/>',
  window: '<path d="M2 9h20"/><path d="M2 15h20"/><path d="M2 12h20"/><path d="M2 9v6"/><path d="M22 9v6"/>',
  grille: '<path d="M2 9h20"/><path d="M2 15h20"/><path d="M2 9v6"/><path d="M22 9v6"/><path d="m7.5 15 3-6"/><path d="m12 15 3-6"/><path d="m16.5 15 3-6"/>',
  column: '<rect x="5" y="5" width="14" height="14"/><path d="m5 5 14 14"/><path d="m19 5-14 14"/>',
  // 框架梁（两端柱 + 柱间双实线梁，结构平面符号风格）
  beam: '<rect x="2" y="8.5" width="5" height="7"/><rect x="17" y="8.5" width="5" height="7"/><path d="M7 10.2h10"/><path d="M7 13.8h10"/>',
  cabinet: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M5 7h14"/><path d="M9 11h6"/><path d="M9 14h6"/><path d="M9 17h6"/>',
  rows: '<rect x="3" y="6" width="18" height="5"/><rect x="3" y="13" width="18" height="5"/><path d="M9 6v5"/><path d="M15 6v5"/><path d="M9 13v5"/><path d="M15 13v5"/>',
  tray: '<path d="M3 8h18"/><path d="M3 16h18"/><path d="M3 8v8"/><path d="M21 8v8"/><path d="m3 8 6 8"/><path d="m9 8 6 8"/><path d="m15 8 6 8"/><path d="m3 16 6-8"/><path d="m9 16 6-8"/><path d="m15 16 6-8"/>',
  ac: '<rect x="3" y="6" width="18" height="12" rx="1"/><circle cx="9" cy="12" r="3"/><path d="M9 10.2v3.6"/><path d="M7.4 12.9 10.6 11.1"/><path d="M10.6 12.9 7.4 11.1"/><path d="M15 9.5h4"/><path d="M15 12h4"/><path d="M15 14.5h4"/>',
  vent: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9h16"/><path d="M4 12h16"/><path d="M4 15h16"/>',
  // 列头柜（配电柜：机柜外形 + 闪电符号）
  pdu: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M13 6 9 12.5h2.8L10.5 18 15 11.5h-2.8L13 6Z"/>',
  // 配电箱：浅型箱体 + 框内闪电，与列头柜的高柜外形区分
  dbox: '<rect x="3" y="5" width="18" height="14" rx="1"/><rect x="7" y="8" width="10" height="8"/><path d="m13 9-3 3h3l-2 3"/><path d="M19 10v4"/>',
  // UPS（不间断电源：机柜外形 + 电池组符号 + 正极凸起）
  ups: '<rect x="5" y="3" width="14" height="18" rx="1"/><rect x="8.5" y="9" width="7" height="7" rx="1"/><path d="M10.5 9V7.2"/><path d="M13.5 9V7.2"/><path d="M11.6 12.5h2.8"/><path d="M13 11.1v2.8"/>',
  // 蓄电池（机柜外形 + 三并排电池单元 + 正极柱，与 UPS 单电池组区分）
  battery: '<rect x="5" y="3" width="14" height="18" rx="1"/><rect x="7" y="9.5" width="3.2" height="5.5" rx="0.5"/><rect x="10.4" y="9.5" width="3.2" height="5.5" rx="0.5"/><rect x="13.8" y="9.5" width="3.2" height="5.5" rx="0.5"/><path d="M8.6 9.5V8.2"/><path d="M12 9.5V8.2"/><path d="M15.4 9.5V8.2"/>',
  // 灭火器（圆角瓶体 + 顶部压把 + 左侧喷管）
  extinguisher: '<rect x="9" y="9.5" width="7" height="11.5" rx="2.2"/><path d="M12.5 9.5V6.8"/><path d="M9.8 6.8h5.4"/><path d="M9.8 6.8 6.5 5.2"/><circle cx="12.5" cy="4.6" r="0.9"/><path d="M10.5 14.5h4"/>',
  room: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9v3"/><path d="M9 4h3"/>',

  /* ---------- 其他 ---------- */
  // 意见反馈（气泡+问号）
  feedback: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  pencil: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  // 替换（双向箭头）、序号重排（列表+排序箭头）、空位补插（虚线框+加号）
  swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  sortnum: '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h6"/><path d="M18 14v6"/><path d="m15 17 3 3 3-3"/>',
  gap: '<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 3"/><path d="M12 9v6"/><path d="M9 12h6"/>',
  // 多选对齐（基准线 + 两个大小不一的矩形，示意向基准线看齐；居中模式基准线用虚线）
  align: '<path d="M4 5h16"/><path d="M4 12h10"/><path d="M4 19h13"/>',
  'al-left': '<path d="M4 2v20"/><rect x="8" y="5" width="12" height="5" rx="1"/><rect x="8" y="14" width="7" height="5" rx="1"/>',
  'al-hcenter': '<path d="M12 2v20" stroke-dasharray="3 2"/><rect x="5" y="5" width="14" height="5" rx="1"/><rect x="8" y="14" width="8" height="5" rx="1"/>',
  'al-right': '<path d="M20 2v20"/><rect x="4" y="5" width="12" height="5" rx="1"/><rect x="9" y="14" width="7" height="5" rx="1"/>',
  'al-top': '<path d="M2 4h20"/><rect x="6" y="8" width="5" height="12" rx="1"/><rect x="14" y="8" width="5" height="7" rx="1"/>',
  'al-vcenter': '<path d="M2 12h20" stroke-dasharray="3 2"/><rect x="5" y="5" width="5" height="14" rx="1"/><rect x="14" y="8" width="5" height="8" rx="1"/>',
  'al-bottom': '<path d="M2 20h20"/><rect x="6" y="6" width="5" height="12" rx="1"/><rect x="14" y="11" width="5" height="7" rx="1"/>',
  // 格式刷（油漆刷）
  brush: '<path d="m14.622 17.897-10.68-2.913"/><path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z"/><path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15"/>',
  // 对话发送（纸飞机）、对话停止（实心方点，无描边）
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  // 对话附件：回形针（上传/粘贴附件）、文本文件（附件条里替代缩略图）
  attach: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M8 13h8"/><path d="M8 17h5"/>',
};

/**
 * 返回内联 SVG 字符串（class="ic"，样式由 CSS 控制大小，颜色继承 currentColor）
 * @param {string} name 图标名
 * @returns {string} SVG 字符串；未知名称返回空串
 */
export function icon(name) {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** 把 root 下所有 <i data-ic="名称"> 占位元素注入对应 SVG 图标（用于静态 index.html） */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-ic]').forEach(el => { el.innerHTML = icon(el.dataset.ic); });
}
