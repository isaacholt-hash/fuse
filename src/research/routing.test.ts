import { defaultCatalog } from "@/catalog/defaultCatalog";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { tierOf } from "@/routing/policy";
import { researchModels } from "./routing";

test("Auto research keeps Best text stages while filtering unsafe search combinations", () => {
  const result = researchModels(
    defaultCatalog,
    defaultPolicy,
    { kind: "auto" },
    "Compare tide measurements",
    ["openai", "anthropic"],
  );
  expect(result.worker.provider).toBe("openai");
  expect(tierOf(defaultPolicy, result.worker)).not.toBe("cheap");
  expect(tierOf(defaultPolicy, result.best)).toBe("best");
  expect(result.pinned).toBe(false);
  expect(result.estimatedMicroUsd).toBeGreaterThan(0);
  expect(result.searchBoundMicroUsd).toBeGreaterThan(0);
});
test("explicit research pins never silently fall back, including unsupported or missing connections", () => {
  const unsupported = defaultCatalog.models.find(
    (model) => model.provider === "anthropic" && model.capabilities.includes("web_search"),
  );
  if (!unsupported) throw new Error("Missing fixture model");
  expect(() =>
    researchModels(
      defaultCatalog,
      defaultPolicy,
      { kind: "model", provider: unsupported.provider, id: unsupported.id },
      "Tides",
      ["openai", "anthropic"],
    ),
  ).toThrow("conservative");
  const supported = defaultCatalog.models.find(
    (model) =>
      model.provider === "openai" &&
      tierOf(defaultPolicy, model) === "balanced" &&
      model.capabilities.includes("web_search"),
  );
  if (!supported) throw new Error("Missing fixture model");
  const result = researchModels(
    defaultCatalog,
    defaultPolicy,
    { kind: "model", provider: supported.provider, id: supported.id },
    "Tides",
    ["openai"],
  );
  expect(result.worker.id).toBe(supported.id);
  expect(result.best.id).toBe(supported.id);
  expect(result.pinned).toBe(true);
  expect(() =>
    researchModels(
      defaultCatalog,
      defaultPolicy,
      { kind: "model", provider: supported.provider, id: supported.id },
      "Tides",
      ["anthropic"],
    ),
  ).toThrow("connection");
});
