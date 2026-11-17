/** DXF 图纸导出：把当前项目平面图导出为 CAD DXF 文件（AC1009 / R12，毫米单位 1:1）
 *
 * 设计要点：
 * - 采用 AC1009（AutoCAD R12）最简结构：HEADER + TABLES(LTYPE/LAYER/STYLE) + ENTITIES，
 *   实体只用 LINE / ARC / CIRCLE / TEXT / SOLID——1992 年以来的各代 CAD
 *   （AutoCAD/中望/浩辰/BricsCAD/LibreCAD 及各类看图软件）均可直接打开，兼容性最好
 * - 中文等非 ASCII 字符全部转义为 DXF 标准 Unicode 序列 \U+XXXX，导出文件为纯 ASCII，
 *   不依赖代码页（DWGCODEPAGE），跨语言环境打开不乱码
 * - 图层名用英文（R12 图层名不支持中文），按对象类型分层、ACI 索引色；
 *   文字样式 STANDARD 指定 simsun.ttf（宋体），保证中文在 CAD 中正常显示
 * - 世界坐标与画布一致（毫米、原点在房间西南角、Y 轴向北），导出即 1:1 真实尺寸图 */
import { state, ui } from './state.js';
import { wallLen, beamEnds, roomInwardSign, objOutline, trayDiamonds } from './geo.js';
import { t } from './i18n.js';
import { distributionBoxToDXF } from './distribution-box.js';
import { pipeToDXF } from './pipe-export.js';

/* ---------- 图层定义（[名称, ACI 颜色]；1=红 3=绿 4=青 5=蓝 7=白/黑 8=灰 30=铜橙） ---------- */
const LAYERS = [
  ['IDC-WALL', 7],    // 墙体
  ['IDC-DOOR', 8],    // 门（门扇 + 开启弧）
  ['IDC-WINDOW', 4],  // 窗
  ['IDC-GRILLE', 5],  // 格栅（百叶风口；回风用实体色 3 绿）
  ['IDC-COLUMN', 8],  // 柱子
  ['IDC-BEAM', 8],    // 框架梁（混凝土族灰，中线 DASHED 点划）
  ['IDC-CABINET', 7], // 机柜
  ['IDC-PDU', 30],    // 列头柜（铜橙，与桥架同族）
  ['IDC-DBOX', 30],   // 配电箱（独立浅型箱体）
  ['IDC-AC', 5],      // 空调
  ['IDC-UPS', 40],    // UPS（不间断电源，铜金电气族）
  ['IDC-BATTERY', 30],// 蓄电池（电池柜，铜橙电气族同列头柜）
  ['IDC-EXT', 1],     // 灭火器（消防红）
  ['IDC-VENT', 4],    // 地板出风口
  ['IDC-AISLE', 5],   // 通道带（冷=层色蓝；热=实体色 1 红；DASHED 虚线）
  ['IDC-PIPE-SUPPLY', 5],
  ['IDC-PIPE-RETURN', 1],
  ['IDC-TRAY', 30],   // 桥架（铜橙）
  ['IDC-DIM', 8],     // 尺寸标注（墙长）
  ['IDC-TEXT', 7],    // 工勘落款
];

/* ---------- 基础工具 ---------- */
const f = v => String(Math.round(v * 100) / 100); // 坐标数值：0.01mm 精度
const rad2deg = r => r * 180 / Math.PI;
const norm360 = d => ((d % 360) + 360) % 360;
/** 文字可读角度：归一化到 (-90, 90]，避免倒置文字 */
function textAng(deg) {
  let a = norm360(deg);
  if (a > 90 && a <= 270) a -= 180;
  else if (a > 270) a -= 360;
  return a;
}

/** 非 ASCII 字符转义为 \U+XXXX（DXF 标准 Unicode 序列）；\ → \\，% → %%%（字面百分号） */
function escText(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const cp = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '%') out += '%%%';
    else if (cp < 32 || cp === 127) { /* 控制字符丢弃 */ }
    else if (cp > 126) out += cp > 0xFFFF ? '?' : '\\U+' + cp.toString(16).toUpperCase().padStart(4, '0');
    else out += ch;
  }
  return out;
}

/* ---------- 实体输出（E 为 DXF 行数组） ---------- */
function line(E, x1, y1, x2, y2, layer, color, ltype) {
  E.push('0', 'LINE', '8', layer, '10', f(x1), '20', f(y1), '30', '0.0',
    '11', f(x2), '21', f(y2), '31', '0.0');
  if (color) E.push('62', String(color));
  if (ltype) E.push('6', ltype);
}
function circle(E, x, y, r, layer, color, ltype) {
  E.push('0', 'CIRCLE', '8', layer, '10', f(x), '20', f(y), '30', '0.0', '40', f(r));
  if (color) E.push('62',String(color));
  if (ltype) E.push('6',ltype);
}
/** 圆弧：a1/a2 为度，DXF 弧恒为逆时针（调用方保证取所需那一侧） */
function arc(E, x, y, r, a1, a2, layer, color) {
  E.push('0', 'ARC', '8', layer, '10', f(x), '20', f(y), '30', '0.0',
    '40', f(r), '50', f(a1), '51', f(a2));
  if (color) E.push('62', String(color));
}
/** 文字：align='center'(正中)/'right'(右下基线)，居中用第二对齐点精确定位 */
function text(E, str, x, y, h, rotDeg, layer, align = 'center') {
  if (!str) return;
  E.push('0', 'TEXT', '8', layer, '10', f(x), '20', f(y), '30', '0.0',
    '40', f(h), '1', escText(str), '7', 'STANDARD', '50', f(rotDeg));
  if (align === 'center') E.push('72', '1', '73', '2', '11', f(x), '21', f(y), '31', '0.0');
  else if (align === 'right') E.push('72', '2', '73', '0', '11', f(x), '21', f(y), '31', '0.0');
}
/** 实心填充四边形（SOLID：10/11=第一条边，12=与 11 对角，13=与 10 对角） */
function solid(E, a, b, c, d, layer, color) {
  E.push('0', 'SOLID', '8', layer,
    '10', f(a.x), '20', f(a.y), '30', '0.0',
    '11', f(b.x), '21', f(b.y), '31', '0.0',
    '12', f(c.x), '22', f(c.y), '32', '0.0',
    '13', f(d.x), '23', f(d.y), '33', '0.0');
  if (color) E.push('62', String(color));
}

/* ---------- 对象局部坐标 ---------- */
/** 局部坐标 → 世界坐标（与画布 render.js 同约定：正面/送风 = 局部 -y 边，rotation 为自北顺时针方位角：
 * 0=朝北 90=朝东 180=朝南 270=朝西）。画布在屏幕系（Y 向下）里按 rotation 旋转对象，而本图世界坐标
 * Y 向北，二者互为镜像——先按 rotation 作标准旋转、再对 Y 取反，不能直接照搬右手旋转公式
 * （geo.js rotCorners 仅用于对称外形的碰撞/包围盒，无朝向语义，故不受此镜像影响） */
function localPt(o, lx, ly) {
  const r = (o.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: o.x + lx * c - ly * s, y: o.y - lx * s - ly * c };
}
/** 旋转矩形 4 角连线（w×d 居中，正面 = -y 边） */
function rectLines(E, o, w, d, layer, color, ltype) {
  const hw = w / 2, hd = d / 2;
  const cs = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => localPt(o, x, y));
  for (let i = 0; i < 4; i++) {
    const p = cs[i], q = cs[(i + 1) % 4];
    line(E, p.x, p.y, q.x, q.y, layer, color, ltype);
  }
}
/** 正面填充条：正面边（-y）向内 120mm 实心条（画布为固定 6px 深灰条，120mm 为整图观感等效） */
function frontStrip(E, o, w, d, layer, color) {
  const dep = Math.min(120, d / 2);
  const A = localPt(o, -w / 2, -d / 2), B = localPt(o, w / 2, -d / 2);
  const D = localPt(o, -w / 2, -d / 2 + dep), C = localPt(o, w / 2, -d / 2 + dep);
  solid(E, A, B, D, C, layer, color);
}

/* ---------- 墙体（含门窗/格栅开洞与符号、沿墙长度标注） ---------- */
function wallToDxf(E, w, ops, walls) {
  const L = wallLen(w);
  if (L < 1) return;
  const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
  const nx = -uy, ny = ux;
  const th = w.props.thickness || 240, h = th / 2;
  // 开洞区间（沿墙 0~1），重叠合并——与 render.js drawWall 同规则
  const ivs = ops.map(o => {
    const half = (o.props.width || 900) / 2, c = o.t * L;
    return { a: Math.max(0, (c - half) / L), b: Math.min(1, (c + half) / L), o };
  }).sort((p, q) => p.a - q.a);
  const merged = [];
  for (const iv of ivs) {
    const last = merged[merged.length - 1];
    if (last && iv.a <= last.b) { last.b = Math.max(last.b, iv.b); last.list.push(iv.o); }
    else merged.push({ a: iv.a, b: iv.b, list: [iv.o] });
  }
  // 墙体实体段：每段画闭合矩形轮廓（双边界线 + 端头封口；洞口封口即门垛线）
  let cur = 0;
  const segs = [];
  for (const m of merged) { if (m.a > cur) segs.push([cur, m.a]); cur = Math.max(cur, m.b); }
  if (cur < 1) segs.push([cur, 1]);
  for (const [a, b] of segs) {
    const x1 = w.x1 + ux * L * a, y1 = w.y1 + uy * L * a;
    const x2 = w.x1 + ux * L * b, y2 = w.y1 + uy * L * b;
    line(E, x1 + nx * h, y1 + ny * h, x2 + nx * h, y2 + ny * h, 'IDC-WALL');
    line(E, x1 - nx * h, y1 - ny * h, x2 - nx * h, y2 - ny * h, 'IDC-WALL');
    line(E, x1 + nx * h, y1 + ny * h, x1 - nx * h, y1 - ny * h, 'IDC-WALL');
    line(E, x2 + nx * h, y2 + ny * h, x2 - nx * h, y2 - ny * h, 'IDC-WALL');
  }
  // 门窗/格栅符号
  for (const m of merged) for (const o of m.list) openingToDxf(E, w, ux, uy, L, o, th, walls);
  // 墙长标注（右法线侧 = 房间外，与画布一致）
  text(E, Math.round(L) + ' mm',
    (w.x1 + w.x2) / 2 - nx * (h + 300), (w.y1 + w.y2) / 2 - ny * (h + 300),
    250, textAng(rad2deg(Math.atan2(uy, ux))), 'IDC-DIM');
}

/** 门窗/格栅平面符号（与画布符号一致；世界坐标 Y 向上） */
function openingToDxf(E, w, ux, uy, L, o, th, walls) {
  const wd = o.props.width || 900, c = o.t * L, half = wd / 2;
  const a = { x: w.x1 + ux * (c - half), y: w.y1 + uy * (c - half) };
  const b = { x: w.x1 + ux * (c + half), y: w.y1 + uy * (c + half) };
  const nx = -uy, ny = ux;
  if (o.type === 'door') {
    // 门扇 90° 全开（垂直墙面）+ 1/4 开启弧；开门朝向 side + 房间内部自动识别（同画布）
    const rawSide = o.props.side || 'out';
    const inward = roomInwardSign(w, walls);
    const s = (rawSide === 'in' || rawSide === 'right' ? -1 : 1) * (inward ?? 1);
    const thW = Math.atan2(uy, ux);      // 墙方向 a→b（世界角）
    const openA = thW - s * Math.PI / 2; // 门扇全开方向（由画布屏幕角换算到世界角）
    const leaf = (hp, closedA, r) => {
      line(E, hp.x, hp.y, hp.x + Math.cos(openA) * r, hp.y + Math.sin(openA) * r, 'IDC-DOOR');
      let a1 = norm360(rad2deg(closedA)), a2 = norm360(rad2deg(openA));
      if ((a2 - a1 + 360) % 360 > 180) [a1, a2] = [a2, a1]; // 取 90° 短弧那一侧
      arc(E, hp.x, hp.y, r, a1, a2, 'IDC-DOOR');
    };
    if (o.props.leaf === 'double') { // 双开门：两端铰链，各半宽对称开启
      leaf(a, thW, wd / 2);
      leaf(b, thW + Math.PI, wd / 2);
    } else if (o.props.swing === 'right') leaf(b, thW + Math.PI, wd); // 单开右铰链
    else leaf(a, thW, wd);                                            // 单开左铰链
    return;
  }
  // 窗：洞口内两条平行线；格栅：两条边框线 + 45° 斜向百叶片（送风蓝/回风绿）
  const layer = o.type === 'window' ? 'IDC-WINDOW' : 'IDC-GRILLE';
  const color = o.type === 'grille' && (o.props.kind || '送风') === '回风' ? 3 : 0;
  for (const off of [-th / 4, th / 4]) {
    line(E, a.x + nx * off, a.y + ny * off, b.x + nx * off, b.y + ny * off, layer, color);
  }
  if (o.type === 'grille') {
    for (let d = 0; d < wd; d += 200) { // 百叶片间距 200mm
      const d2 = Math.min(d + th / 2, wd);
      line(E, a.x + ux * d - nx * th / 4, a.y + uy * d - ny * th / 4,
        a.x + ux * d2 + nx * th / 4, a.y + uy * d2 + ny * th / 4, layer, color);
    }
  }
}

/* ---------- 柱子：矩形 + 叉筋 + 名称 ---------- */
function columnToDxf(E, o) {
  const w = o.props.w || 600, d = o.props.d || 600;
  rectLines(E, o, w, d, 'IDC-COLUMN');
  const p1 = localPt(o, -w / 2, -d / 2), p2 = localPt(o, w / 2, d / 2);
  const p3 = localPt(o, w / 2, -d / 2), p4 = localPt(o, -w / 2, d / 2);
  line(E, p1.x, p1.y, p2.x, p2.y, 'IDC-COLUMN');
  line(E, p3.x, p3.y, p4.x, p4.y, 'IDC-COLUMN');
  if (o.props.name) text(E, o.props.name, o.x, o.y, 200, 0, 'IDC-COLUMN');
}

/* ---------- 机柜：矩形 + 正面填充条（标识朝向）+ 编号 ---------- */
function cabinetToDxf(E, o) {
  const w = o.props.w || 600, d = o.props.d || 1200;
  rectLines(E, o, w, d, 'IDC-CABINET');
  frontStrip(E, o, w, d, 'IDC-CABINET', 8); // 正面深灰条
  if (o.props.name) text(E, o.props.name, o.x, o.y, 200, 0, 'IDC-CABINET');
}

/* ---------- 列头柜：矩形 + 正面铜金条 + 闪电配电标识 + 名称与输入电压/电流 ---------- */
function pduToDxf(E, o) {
  const w = o.props.w || 600, d = o.props.d || 1200;
  rectLines(E, o, w, d, 'IDC-PDU');
  frontStrip(E, o, w, d, 'IDC-PDU', 0); // 正面铜金色条（BYLAYER）
  const k = Math.min(w, d) * 0.32, by = -d * 0.22; // 闪电符号（居中偏正面侧）
  if (k >= 50) {
    const pts = [[0.15, -1], [-0.5, 0.2], [0, 0.2], [-0.15, 1], [0.5, -0.2], [0, -0.2]]
      .map(([px, py]) => localPt(o, px * k, by + py * k));
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      line(E, p.x, p.y, q.x, q.y, 'IDC-PDU');
    }
  }
  if (o.props.name) text(E, o.props.name, o.x, o.y - d * 0.12, 180, 0, 'IDC-PDU');
  text(E, `${+o.props.voltage || 0}V / ${+o.props.current || 0}A`, o.x, o.y - d * 0.12 - 220, 150, 0, 'IDC-PDU');
}

/* ---------- 空调：矩形 + 风扇圆三叶片 + 送风方向箭头 + 制冷量 ---------- */
function acToDxf(E, o) {
  const w = o.props.w || 2500, d = o.props.d || 1300;
  rectLines(E, o, w, d, 'IDC-AC');
  const r = Math.min(w, d) * 0.28;
  circle(E, o.x, o.y, r, 'IDC-AC');
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + i * Math.PI * 2 / 3; // 起始角与画布 drawAC 一致（局部 -y=正面侧），保证叶片方位相同
    const p = localPt(o, Math.cos(a) * r, Math.sin(a) * r);
    line(E, o.x, o.y, p.x, p.y, 'IDC-AC');
  }
  // 送风方向箭头：正面（-y 边）向外
  const AL = Math.max(150, d * 0.18);
  const base = localPt(o, 0, -d / 2), tip = localPt(o, 0, -d / 2 - AL);
  const w1 = localPt(o, -120, -d / 2 - AL + 180), w2 = localPt(o, 120, -d / 2 - AL + 180);
  line(E, base.x, base.y, tip.x, tip.y, 'IDC-AC');
  line(E, tip.x, tip.y, w1.x, w1.y, 'IDC-AC');
  line(E, tip.x, tip.y, w2.x, w2.y, 'IDC-AC');
  text(E, (+o.props.cool || 0) + ' kW', o.x, o.y, 200, 0, 'IDC-AC');
}

/* ---------- UPS：矩形 + 正面铜金条 + 电池组符号 + 名称与容量 ---------- */
function upsToDxf(E, o) {
  const w = o.props.w || 800, d = o.props.d || 800;
  rectLines(E, o, w, d, 'IDC-UPS');
  frontStrip(E, o, w, d, 'IDC-UPS', 0); // 正面铜金色条（BYLAYER）
  // 电池组符号（居中偏正面侧）：壳体（四边）+ 两个正极柱 + 内部“+”
  const k = Math.min(w, d) * 0.32, by = -d * 0.2;
  if (k >= 50) {
    const bw = k * 0.75, bh = k * 0.4;
    const box = [[-bw, by - bh], [bw, by - bh], [bw, by + bh], [-bw, by + bh]]
      .map(([px, py]) => localPt(o, px, py));
    for (let i = 0; i < box.length; i++) {
      const p = box[i], q = box[(i + 1) % box.length];
      line(E, p.x, p.y, q.x, q.y, 'IDC-UPS');
    }
    for (const px of [-k * 0.25, k * 0.25]) { // 正极柱（壳顶两柱）
      const a = localPt(o, px, by - bh), b = localPt(o, px, by - bh - k * 0.22);
      line(E, a.x, a.y, b.x, b.y, 'IDC-UPS');
    }
    const hp = [localPt(o, -k * 0.2, by), localPt(o, k * 0.2, by)]; // 内部“+”（横竖两笔）
    line(E, hp[0].x, hp[0].y, hp[1].x, hp[1].y, 'IDC-UPS');
    const vp = [localPt(o, 0, by - k * 0.2), localPt(o, 0, by + k * 0.2)];
    line(E, vp[0].x, vp[0].y, vp[1].x, vp[1].y, 'IDC-UPS');
  }
  if (o.props.name) text(E, o.props.name, o.x, o.y + d * 0.14, 180, 0, 'IDC-UPS');
  text(E, `${+o.props.kva || 0} kVA`, o.x, o.y + d * 0.14 - 220, 150, 0, 'IDC-UPS');
}

/* ---------- 蓄电池：矩形 + 正面条 + 三个并排电池单元符号 + 名称与规格 ---------- */
function batteryToDxf(E, o) {
  const w = o.props.w || 800, d = o.props.d || 800;
  rectLines(E, o, w, d, 'IDC-BATTERY');
  frontStrip(E, o, w, d, 'IDC-BATTERY', 0); // 正面色条（BYLAYER）
  // 三个并排电池单元（居中偏正面侧）：每个=小矩形壳体 + 顶部正极柱
  const k = Math.min(w, d) * 0.26, by = -d * 0.2;
  if (k >= 40) {
    for (let i = -1; i <= 1; i++) {
      const cx = i * k * 1.05, bw = k * 0.42, bh = k * 0.38;
      const box = [[cx - bw, by - bh], [cx + bw, by - bh], [cx + bw, by + bh], [cx - bw, by + bh]]
        .map(([px, py]) => localPt(o, px, py));
      for (let j = 0; j < box.length; j++) {
        const p = box[j], q = box[(j + 1) % box.length];
        line(E, p.x, p.y, q.x, q.y, 'IDC-BATTERY');
      }
      for (const [a, b] of [[[cx - k * 0.12, by - bh], [cx - k * 0.12, by - bh - k * 0.2]], // 正极柱（┐形三线）
        [[cx - k * 0.12, by - bh - k * 0.2], [cx + k * 0.12, by - bh - k * 0.2]],
        [[cx + k * 0.12, by - bh - k * 0.2], [cx + k * 0.12, by - bh]]]) {
        const p = localPt(o, a[0], a[1]), q = localPt(o, b[0], b[1]);
        line(E, p.x, p.y, q.x, q.y, 'IDC-BATTERY');
      }
    }
  }
  if (o.props.name) text(E, o.props.name, o.x, o.y + d * 0.14, 180, 0, 'IDC-BATTERY');
  const cells = +o.props.cells || 0;
  text(E, (cells > 0 ? cells + 'x' : '') + `${+o.props.ah || 0} Ah`, o.x, o.y + d * 0.14 - 220, 150, 0, 'IDC-BATTERY');
}

/* ---------- 灭火器：矩形 + 灭火器符号（瓶体 + 压把/喷管）+ 名称与充装量 ---------- */
function extinguisherToDxf(E, o) {
  const w = o.props.w || 400, d = o.props.d || 400;
  rectLines(E, o, w, d, 'IDC-EXT');
  const k = Math.min(w, d) * 0.34, by = -d * 0.08;
  if (k >= 30) {
    // 瓶体（圆角矩形按四边直线近似）
    const bw = k * 0.3, bh = k * 0.42;
    const box = [[-bw, by - bh], [bw, by - bh], [bw, by + bh], [-bw, by + bh]]
      .map(([px, py]) => localPt(o, px, py));
    for (let i = 0; i < box.length; i++) {
      const p = box[i], q = box[(i + 1) % box.length];
      line(E, p.x, p.y, q.x, q.y, 'IDC-EXT');
    }
    // 压把（瓶顶横杆 + 中心立杆）
    const hb = [localPt(o, -k * 0.32, by - k * 0.56), localPt(o, k * 0.32, by - k * 0.56)];
    line(E, hb[0].x, hb[0].y, hb[1].x, hb[1].y, 'IDC-EXT');
    const st = [localPt(o, 0, by - k * 0.56), localPt(o, 0, by - k * 0.42)];
    line(E, st[0].x, st[0].y, st[1].x, st[1].y, 'IDC-EXT');
    // 喷管（自压把左端向下两段折线近似弯管）
    const h1 = localPt(o, -k * 0.32, by - k * 0.56), h2 = localPt(o, -k * 0.6, by - k * 0.5), h3 = localPt(o, -k * 0.64, by - k * 0.26);
    line(E, h1.x, h1.y, h2.x, h2.y, 'IDC-EXT');
    line(E, h2.x, h2.y, h3.x, h3.y, 'IDC-EXT');
  }
  if (o.props.name) text(E, o.props.name, o.x, o.y + d * 0.22, 150, 0, 'IDC-EXT');
  text(E, `${+o.props.kg || 0} kg`, o.x, o.y + d * 0.22 - 180, 120, 0, 'IDC-EXT');
}

/* ---------- 地板出风口：矩形 + 圆点阵（冲孔通风板）+ 名称/风量 ---------- */
function ventToDxf(E, o) {
  const w = o.props.w || 600, d = o.props.d || 600;
  rectLines(E, o, w, d, 'IDC-VENT');
  const step = 75, r = 18; // 孔距 75mm、孔半径 18mm（与画布一致）
  const nx = Math.max(1, Math.floor((w - 50) / step)), ny = Math.max(1, Math.floor((d - 50) / step));
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const p = localPt(o, (ix - (nx - 1) / 2) * step, (iy - (ny - 1) / 2) * step);
      circle(E, p.x, p.y, r, 'IDC-VENT');
    }
  }
  if (o.props.name) text(E, o.props.name, o.x, o.y + 80, 160, 0, 'IDC-VENT');
  if (+o.props.air > 0) text(E, +o.props.air + ' m³/h', o.x, o.y - 100, 130, 0, 'IDC-VENT');
}

/* ---------- 通道带：虚线长边 + 端部符号（封闭=端门/封板，不封闭=两端开口）+ 名称标注 ---------- */
function aisleToDxf(E, o) {
  const w = o.props.w || 0, d = o.props.d || 0;
  if (w <= 0 || d <= 0) return;
  const cold = (o.props.kind || 'cold') === 'cold';
  const enclosed = o.props.enclosed !== false; // 旧数据无字段按封闭
  const color = cold ? 0 : 1; // 冷=层色蓝，热=红
  const seg = (lx1, lz1, lx2, lz2, ltype) => { // 局部坐标线段（虚线=通道结构线，实线=门符号）
    const p = localPt(o, lx1, lz1), q = localPt(o, lx2, lz2);
    line(E, p.x, p.y, q.x, q.y, 'IDC-AISLE', color, ltype);
  };
  // 两侧长边（封闭/不封闭均画）
  seg(-w / 2, -d / 2, w / 2, -d / 2, 'DASHED');
  seg(-w / 2, d / 2, w / 2, d / 2, 'DASHED');
  if (enclosed) { // 封闭通道两端：端门符号（与画布一致）/ 封板端线；旧数据无端门字段按两端推拉门
    const rot = o.rotation || 0;
    const ed = o.props.endDoors || 'both';          // both=两端门 / one=仅局部起点端(-x) / none=两端封板
    const dtype = o.props.doorType || 'sliding';    // sliding=推拉 / double=双开 / single=单开
    const ow = +o.props.doorW > 0 ? Math.min(+o.props.doorW, d) : d; // 门洞净宽（0=全宽）
    for (const sx of [-1, 1]) {
      const ex = sx * w / 2;
      const hasDoor = ed === 'both' || (ed === 'one' && sx === -1);
      if (!hasDoor) { seg(ex, -d / 2, ex, d / 2, 'DASHED'); continue; } // 封板端：整端虚线
      if (ow < d) { seg(ex, -d / 2, ex, -ow / 2, 'DASHED'); seg(ex, ow / 2, ex, d / 2, 'DASHED'); } // 门洞两侧固定封窗段
      if (dtype === 'sliding') { // 推拉门：两片错位实线（内/外各一片，各覆盖洞口一半）
        seg(ex - sx * 40, -ow / 2, ex - sx * 40, 0);
        seg(ex + sx * 40, 0, ex + sx * 40, ow / 2);
      } else { // 平开门：门扇 90° 外开 + 1/4 开启弧；局部角 → 世界角 ψ=-(φ+rot)（Y 镜像约定，见 localPt）；单开铰链在局部 -z 侧
        const openLoc = sx > 0 ? 0 : 180;
        const leaf = (hz, closedLoc, r) => {
          const hp = localPt(o, ex, hz);
          const wo = norm360(-(openLoc + rot)), wc = norm360(-(closedLoc + rot));
          line(E, hp.x, hp.y, hp.x + Math.cos(wo * Math.PI / 180) * r, hp.y + Math.sin(wo * Math.PI / 180) * r, 'IDC-AISLE', color);
          let a1 = wc, a2 = wo;
          if ((a2 - a1 + 360) % 360 > 180) [a1, a2] = [a2, a1]; // 取 90° 短弧那一侧
          arc(E, hp.x, hp.y, r, a1, a2, 'IDC-AISLE', color);
        };
        if (dtype === 'double') { leaf(-ow / 2, 90, ow / 2); leaf(ow / 2, -90, ow / 2); }
        else leaf(-ow / 2, 90, ow);
      }
    }
  }
  const txt = (cold ? t('aisle.cold') : t('aisle.hot')) + (enclosed ? t('aisle.enclosed') : '') + ' ' + Math.round(d) + 'mm';
  text(E, txt, o.x, o.y, 250, textAng(o.rotation || 0), 'IDC-AISLE'); // 文字沿通道长轴（textAng 归一化防倒置），南北向通道不溢出带宽
}

/* ---------- 框架梁：两侧边线 + 端头线 + 中线点划（DASHED）+ 编号截面标注 ---------- */
function beamToDxf(E, o, resolve) {
  const e = beamEnds(o, resolve);
  const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  if (L < 1) return;
  const ux = (e.x2 - e.x1) / L, uy = (e.y2 - e.y1) / L;
  const nx = -uy, ny = ux;
  const b = o.props.b || 300, h = b / 2;
  const pt = (t, v) => [e.x1 + ux * t + nx * v, e.y1 + uy * t + ny * v]; // 局部(沿/跨)→世界
  for (const off of [-h, h]) { // 两侧边线
    const a = pt(0, off), q = pt(L, off);
    line(E, a[0], a[1], q[0], q[1], 'IDC-BEAM');
  }
  for (const t of [0, L]) { // 两端头线
    const a = pt(t, -h), q = pt(t, h);
    line(E, a[0], a[1], q[0], q[1], 'IDC-BEAM');
  }
  line(E, e.x1, e.y1, e.x2, e.y2, 'IDC-BEAM', undefined, 'DASHED'); // 中线点划
  text(E, t('label.beam', { name: o.props.name || t('type.beam'), b, h: o.props.h || 600 }),
    (e.x1 + e.x2) / 2 + nx * (h + 300), (e.y1 + e.y2) / 2 + ny * (h + 300),
    220, textAng(rad2deg(Math.atan2(uy, ux))), 'IDC-BEAM');
}

/* ---------- 桥架：矩形外框 + 菱形交叉网格（45° 斜线，格宽=桥架宽）+ 名称/宽度/长度标注 ---------- */
function trayToDxf(E, o) {
  const L = wallLen(o);
  if (L < 1) return;
  const ux = (o.x2 - o.x1) / L, uy = (o.y2 - o.y1) / L;
  const nx = -uy, ny = ux;
  const w = o.props.width || 300, h = w / 2;
  const pt = (t, v) => [o.x1 + ux * t + nx * v, o.y1 + uy * t + ny * v]; // 局部(沿/跨)→世界
  const seg = (a, b) => line(E, a[0], a[1], b[0], b[1], 'IDC-TRAY');
  for (const off of [-h, h]) seg(pt(0, off), pt(L, off)); // 两侧边线
  for (const t of [0, L]) seg(pt(t, -h), pt(t, h));       // 两端封头线
  for (const [a, b] of trayDiamonds(L, w)) seg(pt(a[0], a[1]), pt(b[0], b[1])); // 菱形网格
  text(E, t('label.tray', { name: o.props.name || t('type.tray'), w, len: Math.round(L) }),
    (o.x1 + o.x2) / 2 + nx * (h + 300), (o.y1 + o.y2) / 2 + ny * (h + 300),
    220, textAng(rad2deg(Math.atan2(uy, ux))), 'IDC-TRAY');
}

/* ---------- DXF 组装（纯函数，便于 Node 单测） ---------- */
export function buildDXF(project) {
  const objs = (project && Array.isArray(project.objects) ? project.objects : [])
    .filter(o => o && o.type)
    .map(o => o.props ? o : { ...o, props: {} }); // 残缺对象补空 props，容错导出
  const byId = new Map(objs.map(o => [o.id, o]));
  const resolve = id => byId.get(id) || null;
  const walls = objs.filter(o => o.type === 'wall');

  const E = []; // ENTITIES 段行
  for (const w of walls) {
    wallToDxf(E, w, objs.filter(o =>
      (o.type === 'door' || o.type === 'window' || o.type === 'grille') && o.wallId === w.id), walls);
  }
  for (const o of objs) {
    if (o.type === 'column') columnToDxf(E, o);
    else if (o.type === 'cabinet') cabinetToDxf(E, o);
    else if (o.type === 'pdu') pduToDxf(E, o);
    else if (o.type === 'dbox') distributionBoxToDXF(E, o, { rectLines, frontStrip, localPt, line, text });
    else if (o.type === 'ac') acToDxf(E, o);
    else if (o.type === 'ups') upsToDxf(E, o);
    else if (o.type === 'battery') batteryToDxf(E, o);
    else if (o.type === 'extinguisher') extinguisherToDxf(E, o);
    else if (o.type === 'vent') ventToDxf(E, o);
    else if (o.type === 'aisle') aisleToDxf(E, o);
    else if (o.type === 'pipe') pipeToDXF(E,o,project.meta||{},{line,circle,text});
    else if (o.type === 'tray') trayToDxf(E, o);
    else if (o.type === 'beam') beamToDxf(E, o, resolve);
  }

  // 图幅范围（EXTMIN/EXTMAX，用于 CAD 缩放到全图）+ 右下角工勘落款
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const o of objs) {
    const poly = objOutline(o, resolve);
    if (!poly) continue;
    for (const p of poly) {
      if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
    }
  }
  if (minx > maxx) { minx = miny = 0; maxx = maxy = 1000; }
  const meta = project.meta || {};
  const info = [project.name, meta.surveyor ? t('export.surveyor') + meta.surveyor : '', meta.date || '']
    .filter(Boolean).join('  |  ');
  if (objs.some(o=>o.type==='pipe')) text(E,'LC: PLAN Z=0 / RGB approximated to ACI / Solid=pipe OD / Dashed=insulation / no fittings',minx,miny-1100,140,0,'IDC-TEXT');
  if (info) text(E, info, maxx + 800, miny - 800, 300, 0, 'IDC-TEXT', 'right');

  const out = [];
  out.push('0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1009',
    '9', '$INSUNITS', '70', '4',     // 插入单位：毫米
    '9', '$MEASUREMENT', '70', '1',  // 公制
    '9', '$EXTMIN', '10', f(minx - 1000), '20', f(miny - 1000), '30', '0.0',
    '9', '$EXTMAX', '10', f(maxx + 1000), '20', f(maxy + 1000), '30', '0.0',
    '0', 'ENDSEC');
  out.push('0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LTYPE', '70', '2',
    '0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0',
    '0', 'LTYPE', '2', 'DASHED', '70', '0', '3', 'Dashed __ __ __', '72', '65', '73', '2',
    '40', '750.0', '49', '500.0', '49', '-250.0',
    '0', 'ENDTAB');
  out.push('0', 'TABLE', '2', 'LAYER', '70', String(LAYERS.length + 1),
    '0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS');
  for (const [name, color] of LAYERS) {
    out.push('0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS');
  }
  out.push('0', 'ENDTAB',
    '0', 'TABLE', '2', 'STYLE', '70', '1',
    '0', 'STYLE', '2', 'STANDARD', '70', '0', '40', '0.0', '41', '1.0', '50', '0.0', '71', '0',
    '42', '250.0', '3', 'simsun.ttf', '4', '',
    '0', 'ENDTAB',
    '0', 'ENDSEC');
  out.push('0', 'SECTION', '2', 'ENTITIES', ...E, '0', 'ENDSEC', '0', 'EOF');
  return out.join('\n') + '\n';
}

/* ---------- 导出入口（浏览器下载） ---------- */
export function exportDXF() {
  if (!state.project.objects.length) { ui.hint(t('hint.exportEmpty')); return; }
  const dxf = buildDXF(state.project);
  const blob = new Blob([dxf], { type: 'application/dxf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.project.name || t('file.pngName')) + t('file.dxfSuffix') + '.dxf';
  a.click();
  URL.revokeObjectURL(a.href);
  ui.hint(t('hint.dxfDone'));
}
