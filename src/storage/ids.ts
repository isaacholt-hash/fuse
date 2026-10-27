/** UUIDv7 (RFC 9562): 48-bit Unix-ms timestamp, then a 12-bit counter (rand_a), then random bits.
 * Monotonic within this process: ids made in the same millisecond still sort in creation order
 * (RFC 9562 §6.2 method 1), so "ORDER BY id" is a reliable tie-breaker. */
let lastMs = -1;
let seq = 0;

export function uuidv7(now: number = Date.now()): string {
  let ms = Math.max(now, lastMs);
  if (ms === lastMs) {
    seq++;
    if (seq > 0xfff) {
      ms++; // counter exhausted: borrow the next millisecond
      seq = 0;
    }
  } else {
    seq = 0;
  }
  lastMs = ms;

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ts = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = 0x70 | (seq >> 8);
  bytes[7] = seq & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
