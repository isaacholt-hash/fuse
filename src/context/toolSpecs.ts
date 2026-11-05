import type { ToolSpec } from "@/providers/types";
/** Provider strict schemas require every field; optional arguments are explicitly nullable. */
const schema = (
  properties: Record<string, Record<string, unknown>>,
  required: string[] = [],
): ToolSpec["schema"] => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties: Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key,
      required.includes(key)
        ? value
        : {
            ...value,
            type: [value.type, "null"],
            ...(Array.isArray(value.enum) ? { enum: [...(value.enum as unknown[]), null] } : {}),
          },
    ]),
  ),
});
const text = { type: "string" };
export const CONTEXT_READ_TOOLS: readonly ToolSpec[] = [
  {
    name: "read_memory",
    description:
      "Read active in-scope memories with revisions and authority. Respects memory-off, privacy and unresolved conflicts. Decisions are owner-managed.",
    schema: schema({ id: text, query: text }),
  },
  {
    name: "search_artifacts",
    description:
      "Find app-managed artifacts in this conversation/project by keywords or meaning. Meaning search may incur a bounded embedding charge; falls back to keywords with an explanation. Returns version UUIDs and source provenance; grants no execution or filesystem access.",
    schema: schema({ query: text, meaning: { type: "boolean" } }, ["query"]),
  },
  {
    name: "read_artifact",
    description:
      "Read a bounded excerpt of an exact current artifact version. Use returned UUIDs, offset and provenance; private or stale sources are refused.",
    schema: schema({ id: text, version_id: text, offset: { type: "integer", minimum: 0 } }, [
      "id",
      "version_id",
    ]),
  },
];
export const CONTEXT_WRITE_TOOLS: readonly ToolSpec[] = [
  {
    name: "propose_memory",
    description:
      "Propose add/update/delete for owner review; never directly changes active memory or decisions. Updates/deletions require an in-scope memory ID and expected revision. New memories stay in this conversation. Review happens in Settings → Memory.",
    schema: schema(
      {
        operation: { type: "string", enum: ["add", "update", "delete"] },
        id: text,
        expected_revision: { type: "integer", minimum: 1 },
        kind: {
          type: "string",
          enum: ["fact", "preference", "person", "constraint", "task", "source"],
        },
        text,
      },
      ["operation"],
    ),
  },
  {
    name: "create_artifact",
    description:
      "Create a versioned app-managed artifact in this conversation (no files, commands or permissions). A duplicate key is refused. Content is text, up to 100,000 characters.",
    schema: schema(
      {
        key: text,
        title: text,
        type: { type: "string", enum: ["markdown", "code", "html", "svg", "mermaid", "react"] },
        language: text,
        content: text,
      },
      ["key", "title", "type", "content"],
    ),
  },
  {
    name: "update_artifact",
    description:
      "Create a new artifact version, retaining the previous one. Requires the exact current version UUID; a stale/deleted artifact is refused. No filesystem writes or execution.",
    schema: schema({ id: text, expected_version_id: text, content: text }, [
      "id",
      "expected_version_id",
      "content",
    ]),
  },
];
export const CONTEXT_TOOL_NAMES = new Set(
  [...CONTEXT_READ_TOOLS, ...CONTEXT_WRITE_TOOLS].map((t) => t.name),
);

/** Loose providers may omit nullable fields. Normalize only these before the shared validator. */
export function contextInput(
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const tool = [...CONTEXT_READ_TOOLS, ...CONTEXT_WRITE_TOOLS].find((t) => t.name === name);
  if (!tool) return input;
  const properties = tool.schema.properties as Record<string, { type?: unknown }>;
  const defaults = Object.fromEntries(
    Object.entries(properties)
      .filter(([, p]) => Array.isArray(p.type) && p.type.includes("null"))
      .map(([key]) => [key, null]),
  );
  return { ...defaults, ...input };
}
