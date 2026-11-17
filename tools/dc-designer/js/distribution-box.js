/** 配电箱：独立于列头柜的设备定义、属性表单、平面符号和清单参数。
 * 不依赖 state/DOM，创建默认值、2D、CSV 共用同一字段口径。 */
import { t } from './i18n.js';
import { cabPaint } from './cabinetcolor.js';

export const DISTRIBUTION_BOX_DEFAULTS = Object.freeze({
  w: 600, d: 200, h: 800, boxUse: '动力配电', mounting: '壁挂明装',
  voltage: 380, current: 100, outCircuits: '', remark: '',
});
export const DISTRIBUTION_BOX_PALETTE = Object.freeze({
  body: '#f3ead7', front: '#a67c29', edge: '#8a651e',
});

/** 使用属性面板既有的安全输入构造器，复用修改/撤销/默认值跟随逻辑。 */
export function distributionBoxFields(o, { row, text, num, sel }) {
  const p = o.props;
  return row(t('f.nameNum'), text('props.name', p.name)) +
    row(t('f.w'), num('props.w', p.w, 50, 0)) +
    row(t('f.d'), num('props.d', p.d, 50, 0)) +
    row(t('f.h'), num('props.h', p.h, 50, 0)) +
    row(t('db.use'), sel('props.boxUse', p.boxUse || '动力配电',
      [['动力配电', t('db.power')], ['照明配电', t('db.lighting')], ['综合配电', t('db.general')], ['其他', t('db.other')]])) +
    row(t('db.mounting'), sel('props.mounting', p.mounting || '壁挂明装',
      [['壁挂明装', t('db.wall')], ['嵌入暗装', t('db.recessed')], ['落地安装', t('db.floor')]])) +
    row(t('db.voltage'), num('props.voltage', p.voltage ?? 380, 1, 0)) +
    row(t('db.current'), num('props.current', p.current ?? 100, 1, 0)) +
    row(t('f.outCircuits'), text('props.outCircuits', p.outCircuits)) +
    row(t('f.cx'), num('x', o.x)) + row(t('f.cy'), num('y', o.y)) +
    row(t('f.rot'), num('rotation', o.rotation || 0, 15)) +
    row(t('f.remark'), text('props.remark', p.remark)) +
    `<div class="tip"><p>${t('tip.dbox')}</p></div>`;
}

/** 独立的浅型箱体符号：正面条 + 框内闪电；标注保持水平，薄箱也能辨识。 */
export function drawDistributionBox(ctx, o, { point, scale, selected, selectionColor }) {
  const { x, y } = point, p = o.props;
  const w = p.w * scale, d = p.d * scale;
  const pc = cabPaint(p.color, DISTRIBUTION_BOX_PALETTE);
  const edge = selected ? selectionColor : pc.edge;
  ctx.save();
  ctx.translate(x, y); ctx.rotate((o.rotation || 0) * Math.PI / 180);
  ctx.fillStyle = pc.body; ctx.fillRect(-w / 2, -d / 2, w, d);
  ctx.fillStyle = selected ? selectionColor : pc.front;
  ctx.fillRect(-w / 2, -d / 2, w, Math.min(4, d / 5));
  ctx.strokeStyle = edge; ctx.lineWidth = 1.2;
  ctx.strokeRect(-w / 2, -d / 2, w, d);
  const k = Math.min(w * .2, d * .3);
  if (k >= 3) {
    ctx.strokeRect(-k, -k, k * 2, k * 2);
    ctx.beginPath();
    ctx.moveTo(k * .25, -k * .8); ctx.lineTo(-k * .45, k * .1);
    ctx.lineTo(k * .1, k * .1); ctx.lineTo(-k * .25, k * .8);
    ctx.stroke();
  }
  ctx.restore();
  if (w >= 26 && d >= 8) {
    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = pc.custom ? pc.text : DISTRIBUTION_BOX_PALETTE.edge;
    ctx.font = 'bold 10px sans-serif';
    if (d >= 45) {
      ctx.fillText(p.name || t('type.dbox'), x, y + d * .28, Math.max(w, d) - 6);
    } else {
      // 名称置于箱体下方，避免默认 600×200 的浅型箱体被文字遮满。
      ctx.fillStyle = DISTRIBUTION_BOX_PALETTE.edge;
      ctx.fillText(p.name || t('type.dbox'), x, y + Math.hypot(w, d) / 2 + 8, Math.max(w, d));
    }
    ctx.restore();
  }
}

/** DXF 平面符号与 2D 一致，独立 IDC-DBOX 图层，不把配电箱伪装成列头柜。 */
export function distributionBoxToDXF(E, o, { rectLines, frontStrip, localPt, line, text }) {
  const p = o.props, w = p.w || 600, d = p.d || 200, layer = 'IDC-DBOX';
  rectLines(E, o, w, d, layer);
  frontStrip(E, o, w, d, layer, 0);
  const k = Math.min(w * .2, d * .3);
  const seg = (x1, y1, x2, y2) => {
    const a = localPt(o, x1, y1), b = localPt(o, x2, y2);
    line(E, a.x, a.y, b.x, b.y, layer);
  };
  for (const [a, b] of [[[-1, -1], [1, -1]], [[1, -1], [1, 1]], [[1, 1], [-1, 1]], [[-1, 1], [-1, -1]],
    [[.25, -.8], [-.45, .1]], [[-.45, .1], [.1, .1]], [[.1, .1], [-.25, .8]]]) {
    seg(a[0] * k, a[1] * k, b[0] * k, b[1] * k);
  }
  const y = o.y - Math.hypot(w, d) / 2 - 120;
  if (p.name) text(E, p.name, o.x, y, 140, 0, layer);
  text(E, `${+p.voltage || 0}V / ${+p.current || 0}A`, o.x, y - 170, 120, 0, layer);
}

/** CSV 使用固定中文业务值，与其它设备清单口径一致。 */
export function distributionBoxParams(p) {
  return [p.boxUse, p.mounting, `${+p.voltage || 0}V/${+p.current || 0}A`,
    p.outCircuits ? `输出 ${p.outCircuits}` : ''].filter(Boolean).join(' · ');
}
