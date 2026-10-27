// Secrets filter (PM-05): memory never stores API keys, passwords, card or account numbers, or
// government IDs. Errs on the side of skipping: a missed fact is cheap, a stored secret isn't.

export type SecretKind =
  "api_key" | "password" | "card_number" | "account_number" | "government_id";

export const SECRET_LABELS: Record<SecretKind, string> = {
  api_key: "an API key or token",
  password: "a password or PIN",
  card_number: "a card number",
  account_number: "an account number",
  government_id: "a government ID number",
};

const API_KEYS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, // OpenAI, Anthropic, Stripe-style
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_ -]?key|secret|token|private key)\b\W{0,3}(?:is\W{0,3})?[A-Za-z0-9_\-./+=]{12,}/i,
];

const PASSWORD =
  /\b(?:password|passcode|passwd|passphrase|pwd|pin)\b(?:\s+(?:is|was|=|:)|\s*[:=])\s*\S+/i;

const ACCOUNT = [
  /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/, // IBAN
  /\b(?:account|acct|routing|transit|sort code|bsb)\b(?:\s+(?:number|no\.?|#))?\s*(?:is|:)?\s*[\d][\d -]{4,}\d/i,
];

const GOVERNMENT = [
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN
  /\b(?:passport|driver'?s? licen[cs]e|licen[cs]e number|social security|ssn|sin|social insurance|national insurance|nino|health card|tax id|tin)\b\D{0,20}[A-Z0-9][A-Z0-9 -]{4,}\d/i,
];

/** Luhn check, for card numbers (and Canadian SINs). */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(/\b\d(?:[ -]?\d){12,18}\b/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

/** A long token mixing letters and digits, the shape of most keys. */
function looksLikeToken(text: string): boolean {
  for (const match of text.matchAll(/[A-Za-z0-9_\-+/=]{32,}/g)) {
    const t = match[0];
    if (/[a-z]/i.test(t) && /\d/.test(t) && !/^[0-9a-f]+$/i.test(t)) return true;
  }
  return false;
}

/** What kind of secret the text holds, or null when it looks safe to remember. */
export function findSecret(text: string): SecretKind | null {
  if (API_KEYS.some((r) => r.test(text)) || looksLikeToken(text)) return "api_key";
  if (PASSWORD.test(text)) return "password";
  if (hasCardNumber(text)) return "card_number";
  if (GOVERNMENT.some((r) => r.test(text))) return "government_id";
  if (ACCOUNT.some((r) => r.test(text))) return "account_number";
  return null;
}
