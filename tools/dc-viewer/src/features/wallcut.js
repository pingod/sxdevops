/**
 * 近侧墙体剖切判定（纯几何，可在 Node 单测）。
 *
 * 把每面墙看成一条竖直平面：相机落在墙的外侧（背离机房中心）时，这面墙正挡在
 * 相机与机房之间，应隐藏；相机回到内侧即恢复。判定只看「相机在墙的哪一侧」，
 * 与俯角/距离无关，因此拖动视角时行为稳定。带 ±HIDE.margin 滞回避免抖动。
 */

export const HIDE = Object.freeze({ margin: 120 });

/** 机房中心（墙体线包围盒中心），无有效墙体返回 null */
export function roomCenter(walls) {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const w of walls) {
    if (!w) continue;
    minx = Math.min(minx, w.x1, w.x2);
    maxx = Math.max(maxx, w.x1, w.x2);
    miny = Math.min(miny, w.y1, w.y2);
    maxy = Math.max(maxy, w.y1, w.y2);
  }
  if (!(maxx >= minx) || !(maxy >= miny)) return null;
  return { x: (minx + maxx) / 2, y: (miny + maxy) / 2 };
}

/**
 * 墙面平面：中心 (mx,my) + 朝外单位法向 (nx,ny) + 墙长 L。
 * 过中心的隔墙无内外之分（法向置 0 → 永不隐藏）；零长墙返回 null。
 */
export function wallPlane(w, center) {
  const L = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
  if (!(L > 1)) return null;
  const mx = (w.x1 + w.x2) / 2;
  const my = (w.y1 + w.y2) / 2;
  let nx = -(w.y2 - w.y1) / L;
  let ny = (w.x2 - w.x1) / L;
  const toCenter = (center.x - mx) * nx + (center.y - my) * ny;
  if (Math.abs(toCenter) < 1) return { mx, my, nx: 0, ny: 0, L };
  if (toCenter > 0) {
    nx = -nx;
    ny = -ny;
  }
  return { mx, my, nx, ny, L };
}

/** 相机在墙外侧的距离（mm）：> 0 = 该墙挡在相机与机房之间 */
export function outsideOf(plane, cam) {
  return (cam.x - plane.mx) * plane.nx + (cam.y - plane.my) * plane.ny;
}

/** 每面墙目标状态（true = 隐藏），带滞回 */
export function hideTargets(planes, cam, prev = []) {
  return planes.map((p, i) => {
    const d = outsideOf(p, cam);
    return prev[i] ? d > -HIDE.margin : d > HIDE.margin;
  });
}
