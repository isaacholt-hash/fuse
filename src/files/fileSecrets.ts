/**
 * Secrets in files (FK-11): before a file goes to a provider, its lines are checked for keys,
 * passwords, card and account numbers and ID numbers. You can remove those lines or send as is.
 */
import { findSecretInFile, SECRET_LABELS, type SecretKind } from "@/memory/secrets";

export interface FileSecrets {
  /** 1-based line numbers. */
  lines: number[];
  kinds: SecretKind[];
}

/** Lines that look like they hold a secret; null when none do. */
export function scanForSecrets(text: string): FileSecrets | null {
  const lines: number[] = [];
  const kinds = new Set<SecretKind>();
  text.split("\n").forEach((line, i) => {
    const kind = findSecretInFile(line);
    if (kind) {
      lines.push(i + 1);
      kinds.add(kind);
    }
  });
  return lines.length ? { lines, kinds: [...kinds] } : null;
}

/** The text with those lines replaced by a note saying why. */
export function redactLines(text: string, found: FileSecrets): string {
  const drop = new Set(found.lines);
  return text
    .split("\n")
    .map((line, i) => (drop.has(i + 1) ? "[line removed by FUSE: it looked like a secret]" : line))
    .join("\n");
}

/** e.g. "an API key or token and a password or PIN (3 lines)" */
export function describeSecrets(found: FileSecrets): string {
  const labels = found.kinds.map((k) => SECRET_LABELS[k]);
  const what =
    labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1) ?? ""}` : labels[0];
  const n = found.lines.length;
  return `${what ?? "a secret"} (${String(n)} line${n === 1 ? "" : "s"})`;
}
