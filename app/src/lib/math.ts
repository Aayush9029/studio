/** Clamps to [0, 1]; NaN maps to 0. Branch-only, so it is safe on per-frame hot paths. */
export function clamp01(v: number): number {
  return v > 1 ? 1 : v > 0 ? v : 0;
}
