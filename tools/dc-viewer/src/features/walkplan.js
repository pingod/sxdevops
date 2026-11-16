/**
 * 手动步行的纯计算层（不依赖 DOM / three，可直接单测）。
 *
 * 碰撞复用巡视的 380mm 人身余量网格（route.buildWalkGrid）：
 *   · canStand     格心可走 + 身体半径四向探测（防擦角/贴墙）；
 *   · moveWalk     小步进 + 轴向滑动（撞柜沿柜面滑走，不穿柜不卡死）；
 *   · speedFactor  窄通道降速（按 5×5 网格可走比例线性插值）；
 *   · joystickAxis / walkDirection / lookDelta 输入数学。
 *
 * 坐标约定：项目 mm，x 东 / y 北；yaw=0 面向北（场景 -Z），yaw = atan2(-dx, dy)。
 */

/** 步行参数（视高/速度：m、m/s；距离：mm） */
export const WALK = Object.freeze({
  eye: 1.62,         // 视高（静电地板面层起算）
  base: 1.3,         // 步速 m/s
  narrow: 0.62,      // 窄通道最低速度倍率
  accel: 9,          // 速度阻尼（1/s）
  body: 60,          // 身体半径 mm（网格已留 380mm 余量）
  step: 100,         // 最大子步长 mm
  bobAmp: 0.009,     // 步行起伏幅度 m
  bobStride: 720,    // 起伏周期对应行走距离 mm
  turnDrag: 0.0042,  // 拖拽灵敏度 rad/px
  pitchMin: -1.15,
  pitchMax: 1.05,
  enterSec: 1.15,
  exitSec: 1.0,
  joyDead: 0.12,     // 摇杆死区（归一化）
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 角度归一到 (-π, π] */
export const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));

/* ---------- 碰撞 ---------- */

/** 该点能否站立：格心可走 + 身体半径四向探测 */
export function canStand(model, x, y, body = WALK.body) {
  if (!model || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (!model.freeAt(x, y)) return false;
  if (!(body > 0)) return true;
  return model.freeAt(x + body, y) && model.freeAt(x - body, y)
    && model.freeAt(x, y + body) && model.freeAt(x, y - body);
}

/** 最近可站立点（世界 mm → 格心），由内向外环形搜索 */
export function nearestStand(model, x, y, { body = WALK.body, maxR = 20 } = {}) {
  if (!model || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const ci = model.ci(x), cj = model.cj(y);
  const test = (i, j) => {
    if (!model.inside(i, j)) return null;
    const id = model.id(i, j);
    if (!model.freeId(id)) return null;
    const p = model.point(id);
    return canStand(model, p.x, p.y, body) ? { ...p, cell: id } : null;
  };
  const center = test(ci, cj);
  if (center) return center;
  for (let r = 1; r <= maxR; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const hit = test(ci + di, cj + dj);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * 小步进移动，撞障碍时按轴滑动。
 *
 * 位移拆成 ≤ step 的子步；每个子步先试对角，再分别试 x / y 轴；
 * 两轴都不行则本帧停住并计数。
 *
 * @returns {{x,y,moved,blocked,slide,ok}}
 */
export function moveWalk(model, x, y, dx, dy, { body = WALK.body, step = WALK.step } = {}) {
  if (!canStand(model, x, y, body)) {
    return { x, y, moved: 0, blocked: 0, slide: false, ok: false };
  }
  const dist = Math.hypot(dx, dy);
  if (!(dist > 1e-6)) return { x, y, moved: 0, blocked: 0, slide: false, ok: true };

  const n = Math.max(1, Math.ceil(dist / Math.max(20, step)));
  const sx = dx / n, sy = dy / n;
  let cx = x, cy = y, moved = 0, blocked = 0, slide = false;

  for (let i = 0; i < n; i++) {
    if (canStand(model, cx + sx, cy + sy, body)) {
      cx += sx; cy += sy;
      moved += Math.hypot(sx, sy);
      continue;
    }
    let any = false;
    if (Math.abs(sx) > 1e-9 && canStand(model, cx + sx, cy, body)) {
      cx += sx; moved += Math.abs(sx); any = true; slide = true;
    }
    if (Math.abs(sy) > 1e-9 && canStand(model, cx, cy + sy, body)) {
      cy += sy; moved += Math.abs(sy); any = true; slide = true;
    }
    if (!any) {
      blocked++;
      break; // 已完全顶住，剩余子步只会重复撞同一处
    }
  }
  return { x: cx, y: cy, moved, blocked, slide, ok: true };
}

/* ---------- 窄通道降速 ---------- */

/** 5×5 窗口内可走格比例（边界外不计入分母） */
export function clearanceRatio(model, x, y, radius = 2) {
  if (!model || !model.inside(model.ci(x), model.cj(y))) return 0;
  const ci = model.ci(x), cj = model.cj(y);
  let free = 0, total = 0;
  for (let dj = -radius; dj <= radius; dj++) {
    for (let di = -radius; di <= radius; di++) {
      if (!model.inside(ci + di, cj + dj)) continue;
      total++;
      if (model.freeId(model.id(ci + di, cj + dj))) free++;
    }
  }
  return total ? free / total : 0;
}

/** 速度倍率：比例 ≥0.78 全速、≤0.42 取 WALK.narrow，中间线性过渡 */
export function speedFactor(model, x, y) {
  const ratio = clearanceRatio(model, x, y, 2);
  const lo = 0.42, hi = 0.78;
  if (ratio >= hi) return 1;
  if (ratio <= lo) return WALK.narrow;
  return WALK.narrow + (1 - WALK.narrow) * ((ratio - lo) / (hi - lo));
}

/* ---------- 输入数学 ---------- */

/**
 * 虚拟摇杆：屏幕位移 → 归一化轴（y 向上为正，超出半径按圆边界夹取）。
 * @returns {{x:number,y:number,mag:number,active:boolean}}
 */
export function joystickAxis(dx, dy, radius = 44, dead = WALK.joyDead) {
  const r = Math.max(1, radius);
  let x = dx / r, y = -dy / r;
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  const mag = Math.min(1, len);
  if (mag <= dead) return { x: 0, y: 0, mag: 0, active: false };
  // 死区外重新映射到 0–1：轻推也能缓慢移动
  const k = (mag - dead) / (1 - dead);
  const inv = mag > 1e-6 ? 1 / mag : 0;
  return { x: x * inv * k, y: y * inv * k, mag: k, active: true };
}

/**
 * 移动方向（项目 mm 单位向量 × 输入强度）。yaw=0 面向北(+y)，yaw=-π/2 面向东(+x)。
 * @returns {{x:number,y:number,mag:number}}
 */
export function walkDirection(yaw, forward, strafe) {
  const f = Number.isFinite(forward) ? forward : 0;
  const s = Number.isFinite(strafe) ? strafe : 0;
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  let dx = -sin * f + cos * s;
  let dy = cos * f + sin * s;
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  return { x: dx, y: dy, mag: Math.min(1, len) };
}

/** 拖拽看向：右移向右看、下移向下看 */
export function lookDelta(yaw, pitch, dx, dy, sens = WALK.turnDrag) {
  return {
    yaw: wrapPi(yaw - dx * sens),
    pitch: clamp(pitch - dy * sens, WALK.pitchMin, WALK.pitchMax),
  };
}

/** 步行相机位姿（场景米制；eye 视高，bob 起伏偏移） */
export function walkCameraPose(x, y, eye = WALK.eye, bob = 0) {
  return { x: x / 1000, y: eye + bob, z: -y / 1000 };
}

/** HUD 提示文案（桌面 / 触屏） */
export function walkHint(touch) {
  return touch
    ? '左侧摇杆移动 · 右侧拖拽看向 · 轻点设备选中 · 「切自动」回巡检 / Esc 退出'
    : 'WASD / 方向键移动 · 拖拽画面看向 · 点击设备选中 · 「切自动」回巡检 / Esc 退出';
}

/** 速度显示（m/s，一位小数） */
export function speedText(mmPerSec) {
  return (Math.max(0, mmPerSec) / 1000).toFixed(1) + ' m/s';
}
