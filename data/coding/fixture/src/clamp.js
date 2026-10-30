/** Keeps x between lo and hi. */
export function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);
}
