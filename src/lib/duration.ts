/**
 * A length of time in words, the way a run card says it: "45 s", "3 min", "1 h 20 min", "2 h".
 * Never negative; under a second reads "0 s".
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${String(total)} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}
