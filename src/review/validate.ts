import type { ReviewFinding, ReviewReport, ReviewSnapshot } from "./types";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed review data.");
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error("Invalid bounded review text.");
  return value;
}
export const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
export const safePath = (value: string): boolean =>
  value.length <= 1024 &&
  !/[\\:]/.test(value) &&
  !Array.from(value, (c) => c.charCodeAt(0)).some((c) => c < 32 || c === 127) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");
export const integer = (value: unknown, max = 10_000_000): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error("Invalid review line or selection.");
  return value;
};
export const lines = (text: string): string[] => {
  const result = text.split(/\r?\n/);
  if (result.at(-1) === "") result.pop();
  return result;
};
export function validateSnapshot(raw: unknown): ReviewSnapshot {
  const v = object(raw);
  if (
    v.protocol !== 1 ||
    typeof v.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.id) ||
    !sha(v.baseCommit) ||
    !sha(v.headCommit) ||
    !Array.isArray(v.files) ||
    v.files.length > 20 ||
    !Array.isArray(v.limitations) ||
    v.limitations.length > 200
  )
    throw new Error("The pinned review snapshot is incompatible or malformed.");
  string(v.label, 500);
  let bytes = 0;
  const paths = new Set<string>();
  for (const rawFile of v.files) {
    const file = object(rawFile);
    const path = string(file.path, 1024);
    if (!safePath(path) || paths.has(path)) throw new Error("Invalid or duplicate review path.");
    paths.add(path);
    if (
      !sha(file.oldRevision) ||
      !(
        sha(file.newRevision) ||
        (typeof file.newRevision === "string" && /^snapshot:[a-f0-9]{64}$/.test(file.newRevision))
      )
    )
      throw new Error("Missing immutable review revisions.");
    for (const side of ["old", "new"] as const) {
      const text = file[`${side}Text`];
      if (
        text !== null &&
        (typeof text !== "string" ||
          text.includes("\0") ||
          new TextEncoder().encode(text).length > 65536)
      )
        throw new Error("Review source exceeds its text limit.");
      bytes += typeof text === "string" ? new TextEncoder().encode(text).length : 0;
      const count = typeof text === "string" ? lines(text).length : 0;
      const changed = file[side === "old" ? "changedOld" : "changedNew"];
      if (
        !Array.isArray(changed) ||
        changed.length > 65536 ||
        changed.some((n: unknown) => integer(n) > count)
      )
        throw new Error("Diff lines do not match the pinned file.");
    }
  }
  if (bytes > 262144) throw new Error("The complete review exceeds its source limit.");
  v.limitations.forEach((limitation: unknown) => string(limitation, 2000));
  return v as unknown as ReviewSnapshot;
}
/** Exact evidence validation is separate from a model's judgment about the consequence. */
export function validateReport(raw: unknown, snapshot: ReviewSnapshot): ReviewReport {
  const v = object(raw);
  if (
    v.snapshotId !== snapshot.id ||
    !Array.isArray(v.findings) ||
    v.findings.length > 20 ||
    !Array.isArray(v.limitations) ||
    v.limitations.length > 20
  )
    throw new Error("The review returned a different snapshot or malformed findings.");
  const findings = v.findings.map((rawFinding: unknown): ReviewFinding => {
    const f = object(rawFinding);
    if (
      !["P0", "P1", "P2", "P3"].includes(String(f.severity)) ||
      !["old", "new"].includes(String(f.side))
    )
      throw new Error("A finding has an invalid severity or side.");
    const path = string(f.path, 1024);
    const file = snapshot.files.find((entry) => entry.path === path);
    const side = f.side === "old" ? "old" : "new";
    const text = file?.[side === "old" ? "oldText" : "newText"];
    const revision = file?.[side === "old" ? "oldRevision" : "newRevision"];
    const startLine = integer(f.startLine),
      endLine = integer(f.endLine);
    const quote = string(f.quote, 10000);
    const changed = file?.[side === "old" ? "changedOld" : "changedNew"] ?? [];
    if (
      !file ||
      typeof revision !== "string" ||
      typeof text !== "string" ||
      f.revision !== revision ||
      endLine < startLine ||
      endLine - startLine > 9 ||
      endLine > lines(text).length ||
      !changed.some((line) => line >= startLine && line <= endLine) ||
      lines(text)
        .slice(startLine - 1, endLine)
        .join("\n") !== quote
    )
      throw new Error(`A finding for ${path} has an unverified revision, line or exact quote.`);
    return {
      severity: f.severity as "P0" | "P1" | "P2" | "P3",
      title: string(f.title, 160),
      consequence: string(f.consequence, 2000),
      path,
      side,
      revision,
      startLine,
      endLine,
      quote,
    };
  });
  const deduplicated = new Map(
    findings.map((f) => [
      `${f.path}:${f.side}:${String(f.startLine)}:${String(f.endLine)}:${f.title}`,
      f,
    ]),
  );
  return {
    snapshotId: snapshot.id,
    findings: [...deduplicated.values()].sort(
      (a, b) =>
        a.severity.localeCompare(b.severity) ||
        a.path.localeCompare(b.path) ||
        a.startLine - b.startLine,
    ),
    limitations: v.limitations.map((value: unknown) => string(value, 2000)),
  };
}
const escape = (s: string) => s.replace(/[\\`*_{}[\]<>]/g, "\\$&");
export function reviewMarkdown(snapshot: ReviewSnapshot, report: ReviewReport): string {
  return [
    "# Code review",
    "",
    escape(snapshot.label),
    "",
    `Snapshot: \`${snapshot.id}\``,
    `Base: \`${snapshot.baseCommit}\` · Head: \`${snapshot.headCommit}\``,
    "",
    ...report.findings.flatMap((f) => [
      `## [${f.severity}] ${escape(f.title)}`,
      "",
      `**${escape(f.path)}** · ${f.side} · lines ${String(f.startLine)}–${String(f.endLine)} · \`${f.revision}\``,
      "",
      escape(f.consequence),
      "",
      ...f.quote.split("\n").map((line) => `> ${escape(line)}`),
      "",
    ]),
    ...(report.findings.length
      ? []
      : [
          "No actionable findings were returned in the captured changes. This is not a guarantee of correctness.",
          "",
        ]),
    "## Limitations",
    "",
    ...[
      ...snapshot.limitations,
      ...report.limitations,
      "Locations and quoted evidence were checked against the pinned snapshot. Consequences remain model judgments; tests were not executed.",
      "Review did not edit files, execute commands, push changes or post GitHub comments.",
    ].map((s) => `- ${escape(s)}`),
  ].join("\n");
}
