/**
 * A check of a tool call's input against FUSE's own schema. Claude gets strict only on as many
 * tools as its grammar budget allows (providers/anthropic/adapter.ts), so a call to one of the
 * rest can come back loose: this turns a bad one into an error the model can fix, not a crash.
 * Covers what FUSE's schemas use: type (or a type list), properties, required,
 * additionalProperties: false, items and enum.
 */
export function checkInput(schema: Record<string, unknown>, input: unknown): string | null {
  return check(schema, input, "input");
}

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case "null":
      return v === null;
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "array":
      return Array.isArray(v);
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    default:
      return true;
  }
}

function check(schema: Record<string, unknown>, v: unknown, at: string): string | null {
  const types = schema.type === undefined ? [] : ([] as unknown[]).concat(schema.type);
  if (types.length && !types.some((t) => typeof t === "string" && typeOk(t, v))) {
    return `${at} should be ${types.join(" or ")}.`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(v)) {
    return `${at} should be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}.`;
  }
  if (Array.isArray(v) && schema.items && typeof schema.items === "object") {
    for (const [i, item] of v.entries()) {
      const bad = check(schema.items as Record<string, unknown>, item, `${at}[${String(i)}]`);
      if (bad) return bad;
    }
  }
  if (typeOk("object", v) && schema.properties && typeof schema.properties === "object") {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const obj = v as Record<string, unknown>;
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!(key in obj)) return `${at}.${key} is missing.`;
    }
    for (const [key, val] of Object.entries(obj)) {
      const sub = props[key];
      if (!sub) {
        if (schema.additionalProperties === false)
          return `${at}.${key} isn't a field of this tool.`;
        continue;
      }
      const bad = check(sub, val, `${at}.${key}`);
      if (bad) return bad;
    }
  }
  return null;
}
