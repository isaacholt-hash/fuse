import speech from "../../data/speech.json";

export const speechPrice = speech;

/** Round upward once, using integer micro-dollars and milliseconds, including subsecond clips. */
export function durationCost(
  durationMs: number,
  microPerMinute = speech.micro_usd_per_minute,
): number {
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    !Number.isSafeInteger(microPerMinute) ||
    microPerMinute < 0
  )
    throw new Error("Audio duration and price must be non-negative safe integers.");
  const result = (BigInt(durationMs) * BigInt(microPerMinute) + 59_999n) / 60_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Audio cost overflow.");
  return Number(result);
}
