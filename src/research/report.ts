/** Source-backed claims are rendered by FUSE; a model cannot invent a citation target. */
import type { ResearchClaim, ResearchReport, ResearchSource, ResearchState } from "./types";
import config from "../../data/research.json";
const execution = config.execution;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a structured research result.");
  return value as Record<string, unknown>;
};
export function parseJson(text: string): Record<string, unknown> {
  if (text.length > execution.max_model_chars)
    throw new Error("Research response exceeded its size limit.");
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return object(JSON.parse(cleaned));
}
function text(value: unknown, limit = execution.max_model_chars): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error("Research returned malformed text.");
  return value.trim();
}
const strings = (value: unknown, limit = 24): string[] => {
  if (!Array.isArray(value) || value.length > limit)
    throw new Error("Research returned malformed lists.");
  return value.map((v) => text(v, 2000));
};
const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
export function parsePlan(raw: string): string[] {
  const values = strings(parseJson(raw).queries, config.limits.searches);
  const unique = [...new Set(values.map((q) => text(q, execution.max_query_chars)))];
  if (!unique.length) throw new Error("Research needs at least one bounded search query.");
  return unique;
}
function hasEvidence(claim: ResearchClaim, sources: readonly ResearchSource[]): boolean {
  return (
    claim.evidence.length > 0 &&
    claim.evidence.every((e) => {
      const source = sources.find((s) => s.id === e.sourceId);
      return (
        source?.text &&
        !source.error &&
        normalized(e.quote).length > 0 &&
        normalized(source.text).includes(normalized(e.quote))
      );
    })
  );
}
export function parseReport(raw: string, sources: readonly ResearchSource[]): ResearchReport {
  const value = parseJson(raw);
  if (!Array.isArray(value.claims) || value.claims.length > 48)
    throw new Error("Research returned an invalid claim list.");
  const claims: ResearchClaim[] = value.claims.map((entry, index) => {
    const c = object(entry);
    if (!Array.isArray(c.evidence) || c.evidence.length > config.limits.sources)
      throw new Error("Invalid claim evidence.");
    const claim: ResearchClaim = {
      id: `C${String(index + 1)}`,
      text: text(c.text, 4000),
      evidence: c.evidence.map((v) => {
        const e = object(v);
        return {
          sourceId: text(e.sourceId, 128),
          quote: text(e.quote, execution.max_claim_quote_chars),
        };
      }),
      supported: false,
      warning: "Not yet checked against source evidence.",
    };
    if (!hasEvidence(claim, sources))
      claim.warning =
        "Unsupported: citation or quoted passage is missing from the collected sources.";
    return claim;
  });
  return {
    title: text(value.title, 512),
    claims,
    limitations: strings(value.limitations ?? []),
    disagreements: strings(value.disagreements ?? []),
  };
}
export function verifyReport(
  raw: string,
  report: ResearchReport,
  sources: readonly ResearchSource[],
): ResearchReport {
  const value = parseJson(raw);
  if (!Array.isArray(value.claims) || value.claims.length > 48)
    throw new Error("Research support review was malformed.");
  const reviews = value.claims.map(object);
  return {
    ...report,
    claims: report.claims.map((claim) => {
      const matching = reviews.filter((c) => c.id === claim.id);
      const supported =
        matching.length === 1 && matching[0]?.supported === true && hasEvidence(claim, sources);
      return {
        ...claim,
        supported,
        warning: supported
          ? null
          : typeof matching[0]?.reason === "string"
            ? matching[0].reason.slice(0, 500)
            : "Unsupported or unresolved after source review.",
      };
    }),
  };
}
/** External links in generated prose must refer to collected sources; artifact tags remain inert. */
function safeText(value: string, sources: readonly ResearchSource[]): string {
  const allowed = new Set(sources.flatMap((s) => [s.url, ...(s.finalUrl ? [s.finalUrl] : [])]));
  return value
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) =>
      allowed.has(url) ? url : "[uncollected link omitted]",
    )
    .replace(/<\/?artifact\b/gi, (match) => match.replace("<", "&lt;"));
}
function sourceHref(source: ResearchSource): string | null {
  try {
    const url = new URL(source.finalUrl ?? source.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > config.max_source_url_chars
    )
      return null;
    return url.href.replace(
      /[()[\]<>]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    return null;
  }
}
const label = (value: string) => value.replace(/[[\]\\\n\r]/g, " ").slice(0, 512);
export function renderReportDetailed(
  state: ResearchState,
  task: string,
): { markdown: string; truncated: boolean } {
  const sources = state.sources;
  const report = state.report;
  const lines = [
    `# ${label(report?.title ?? "Research report")}`,
    "",
    state.partialReason ? `**Partial result — ${state.partialReason}**` : "**Research report**",
    "",
    `Scope: ${safeText(task.slice(0, 2000), sources)}${task.length > 2000 ? " (scope excerpt; full scope is retained in Chat)" : ""}`,
    "",
  ];
  if (report) {
    for (const claim of report.claims) {
      const refs = [...new Set(claim.evidence.map((e) => e.sourceId))].flatMap((id) => {
        const source = sources.find((s) => s.id === id);
        const href = source ? sourceHref(source) : null;
        return href && source?.fetchedAt !== null ? [`[${label(id)}](${href})`] : [];
      });
      lines.push(
        `${claim.supported ? "" : "**Unverified:** "}${safeText(claim.text, sources)} ${refs.join(" ")}`.trim(),
        "",
      );
      if (claim.warning) lines.push(`> ${safeText(claim.warning, sources)}`, "");
    }
  } else {
    lines.push("## Unverified working notes", "");
    for (const finding of state.findings)
      lines.push(
        `### ${label(finding.query)}`,
        "",
        safeText(finding.text.slice(0, 4000), sources),
        "",
      );
    if (!state.findings.length) lines.push("No completed findings are available.", "");
  }
  lines.push("## Sources and provenance", "");
  const readSources = sources.filter((source) => source.fetchedAt !== null);
  for (const source of readSources) {
    lines.push(
      `- ${label(source.id)}: ${sourceHref(source) ? `[${label(source.title ?? source.url)}](${sourceHref(source) ?? ""})` : label(source.title ?? "Unavailable source URL")} — query: ${label(source.query)}; found ${new Date(source.foundAt).toISOString()}; ${source.fetchedAt ? `read ${new Date(source.fetchedAt).toISOString()}` : "not read"}${source.truncated ? "; excerpt truncated" : ""}${source.error ? `; ${safeText(source.error, sources)}` : ""}${source.flags.length ? "; potentially hostile instructions flagged" : ""}`,
    );
  }
  if (!readSources.length) lines.push("No source pages were read.");
  if (sources.length > readSources.length)
    lines.push(
      `${String(sources.length - readSources.length)} additional collected links were not read under the current source bounds.`,
    );
  const tailStart = lines.length;
  lines.push("", "## Limitations", "");
  const limitations = [
    ...(report?.limitations ?? []),
    ...state.warnings,
    "Citations are checked against collected URLs and retained passages. Automated support review can miss errors; a citation does not establish that a source is correct.",
    `Search allowances used: ${String(state.searches)}/${String(config.limits.searches)}; page reads attempted: ${String(state.reads)}/${String(config.limits.sources)}; model requests reserved: ${String(state.modelCalls)}/${String(config.limits.model_calls)}.`,
  ];
  for (const limitation of [...new Set(limitations)])
    lines.push(`- ${safeText(limitation, sources)}`);
  lines.push("", "## Unresolved disagreements", "");
  const disagreements = report?.disagreements ?? [];
  lines.push(
    ...(disagreements.length
      ? disagreements.map((d) => `- ${safeText(d, sources)}`)
      : ["No unresolved disagreements were identified; this does not prove consensus."]),
  );
  const inert = (line: string) =>
    line.replace(/<\/?artifact\b/gi, (match) => match.replace("<", "&lt;"));
  const tail = lines.slice(tailStart).map(inert).join("\n");
  const budget = Math.max(0, execution.max_report_chars - tail.length - 512);
  const kept: string[] = [];
  let length = 0,
    truncated = false;
  for (const line of lines.slice(0, tailStart).map(inert)) {
    if (length + line.length + 1 > budget) {
      truncated = true;
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  if (truncated) {
    kept[2] = "**Partial result — report size bound reached.**";
    kept.push(
      "",
      "Additional report content was omitted under the size bound; retained run evidence remains available.",
    );
  }
  return { markdown: `${kept.join("\n")}\n${tail}`, truncated };
}
export const renderReport = (state: ResearchState, task: string): string =>
  renderReportDetailed(state, task).markdown;
