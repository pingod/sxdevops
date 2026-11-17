/** 配电箱三维外观：浅型金属箱体、检修门、断路器窗口和拉手。
 * 位置/颜色沿用设备共用规则；安装方式是工勘属性，不改变 XYZ、不自动挂墙开洞。 */
import { M, deviceMat } from './materials3d.js';

export function buildDistributionBox(g, o, { placed, lbox }) {
  const p = o.props, w = p.w || 600, d = p.d || 200, h = p.h || 800;
  const grp = placed(g, o);
  const body = deviceMat(p.color, M.pduBody);
  const panel = deviceMat(p.color, M.dark, 'front');
  lbox(grp, body, w, h, d, 0, 0, 0);
  const fz = d / 2;
  lbox(grp, panel, w * .92, h * .90, 6, 0, h * .05, fz + 3);
  lbox(grp, M.pduStripe, w * .88, h * .045, 4, 0, h * .82, fz + 8, false);
  // 断路器观察窗与三个拨杆，区别于列头柜的监控显示屏。
  lbox(grp, M.steel, w * .65, h * .2, 4, -w * .06, h * .5, fz + 8, false);
  for (let i = -1; i <= 1; i++) {
    lbox(grp, M.dark, w * .12, h * .09, 8, -w * .06 + i * w * .18, h * .55, fz + 13, false);
  }
  lbox(grp, M.steel, w * .025, h * .22, 10, w * .37, h * .28, fz + 12, false);
}
