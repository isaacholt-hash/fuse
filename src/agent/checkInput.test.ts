// @vitest-environment node
import { expect, test } from "vitest";
import { checkInput } from "./checkInput";
import { toolsIn } from "./registry";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "count", "mode"],
  properties: {
    path: { type: "string" },
    count: { type: ["integer", "null"] },
    mode: { type: "string", enum: ["a", "b"] },
    rows: {
      type: "array",
      items: { type: "object", required: ["n"], properties: { n: { type: "number" } } },
    },
  },
};

test("a loose call that matches the schema passes", () => {
  expect(checkInput(schema, { path: "x", count: null, mode: "a" })).toBeNull();
  expect(checkInput(schema, { path: "x", count: 3, mode: "b", rows: [{ n: 1.5 }] })).toBeNull();
});

test("a loose call that doesn't match says what's wrong", () => {
  expect(checkInput(schema, { count: 1, mode: "a" })).toBe("input.path is missing.");
  expect(checkInput(schema, { path: "x", count: 1.5, mode: "a" })).toBe(
    "input.count should be integer or null.",
  );
  expect(checkInput(schema, { path: "x", count: 1, mode: "c" })).toBe(
    'input.mode should be one of "a", "b".',
  );
  expect(checkInput(schema, { path: "x", count: 1, mode: "a", extra: 1 })).toBe(
    "input.extra isn't a field of this tool.",
  );
  expect(checkInput(schema, { path: "x", count: 1, mode: "a", rows: [{}] })).toBe(
    "input.rows[0].n is missing.",
  );
  expect(checkInput(schema, "nope")).toBe("input should be object.");
});

test("every FUSE tool's schema is one the check understands", () => {
  const known = new Set([
    "type",
    "description",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
  ]);
  const walk = (s: Record<string, unknown>, at: string) => {
    for (const k of Object.keys(s)) expect(known.has(k), `${at}: ${k}`).toBe(true);
    if (s.items) walk(s.items as Record<string, unknown>, `${at}[]`);
    for (const [k, p] of Object.entries(
      (s.properties ?? {}) as Record<string, Record<string, unknown>>,
    )) {
      walk(p, `${at}.${k}`);
    }
  };
  for (const place of ["code", "work", "chat"] as const) {
    for (const t of toolsIn(place)) walk(t.schema, t.name);
  }
});
