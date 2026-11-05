/** Exact owner-entered USD amounts; no floating-point rounding or implicit cap. */
export function parseResearchCap(value: string): number | null {
  if (value.trim().length > 24) return null;
  if (!/^\d+(?:\.\d{1,6})?$/.test(value.trim())) return null;
  const [whole = "", fraction = ""] = value.trim().split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

export function formatResearchCap(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) return "";
  const amount = BigInt(value),
    fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${String(amount / 1_000_000n)}${fraction ? `.${fraction}` : ""}`;
}
