/**
 * The app lock's passcode (SE-03). Only a salted PBKDF2-SHA-256 hash is stored, never the
 * passcode; checking takes a deliberate fraction of a second so guessing is slow.
 */
export const ITERATIONS = 600_000;
export const MIN_LENGTH = 4;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(passcode: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** "pbkdf2-sha256$<iterations>$<salt>$<hash>" */
export async function hashPasscode(passcode: string, iterations = ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(passcode, salt, iterations);
  return `pbkdf2-sha256$${String(iterations)}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPasscode(passcode: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  const iterations = Number(iter);
  if (scheme !== "pbkdf2-sha256" || !salt || !hash || !Number.isInteger(iterations)) return false;
  const got = await derive(passcode, unb64(salt), iterations);
  const want = unb64(hash);
  // Compare every byte, so the time taken doesn't hint at how close a guess was.
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.max(got.length, want.length); i++)
    diff |= (got[i] ?? 0) ^ (want[i] ?? 0);
  return diff === 0;
}

/** Seconds to wait before the next try: none for the first 5 wrong ones, then doubling to 5 min. */
export function lockoutSeconds(wrongTries: number): number {
  return wrongTries < 5 ? 0 : Math.min(300, 2 ** (wrongTries - 4) * 15);
}
