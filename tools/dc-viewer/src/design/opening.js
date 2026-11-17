/**
 * 开洞吸附的纯几何：从世界坐标 mm 找墙、算沿墙位置 t。
 * 与射线拾取分离，便于单测（viewport.wallHit 只负责把屏幕坐标变成世界点）。
 */

/** 点到线段的最近位置：返回 {t, distance}（t 夹在 0–1，distance 单位 mm）。 */
export function projectOnWall(wall, x, y) {
  if (!wall) return null;
  const dx = Number(wall.x2) - Number(wall.x1);
  const dy = Number(wall.y2) - Number(wall.y1);
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 1)) return null;
  const t = Math.min(1, Math.max(0, ((x - wall.x1) * dx + (y - wall.y1) * dy) / len2));
  const px = Number(wall.x1) + dx * t;
  const py = Number(wall.y1) + dy * t;
  return { t, distance: Math.hypot(x - px, y - py) };
}

/** 在 maxDistance（mm）内最近的墙；没有则返回 null。 */
export function nearestWall(walls, x, y, maxDistance = 500) {
  let best = null;
  for (const wall of walls || []) {
    if (!wall || wall.type !== 'wall') continue;
    const spot = projectOnWall(wall, x, y);
    if (!spot || spot.distance > maxDistance) continue;
    if (!best || spot.distance < best.distance) best = { wall, t: spot.t, distance: spot.distance };
  }
  return best ? { wall: best.wall, t: best.t } : null;
}

/**
 * 把 t 收到 `[width/2L, 1-width/2L]`；墙短于洞口宽度时返回 null（放不下）。
 */
export function clampTOnWall(wall, width, t) {
  const L = Math.hypot(Number(wall?.x2) - Number(wall?.x1), Number(wall?.y2) - Number(wall?.y1));
  if (!(L > 0) || !(width > 0) || width > L) return null;
  const half = width / 2 / L;
  const value = Number.isFinite(Number(t)) ? Number(t) : 0.5;
  return Math.min(1 - half, Math.max(half, value));
}
