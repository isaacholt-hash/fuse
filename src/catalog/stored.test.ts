// @vitest-environment node
import { openTestDb } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { setSetting } from "@/storage/settings";
import { defaultCatalog } from "./defaultCatalog";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { serializePolicy } from "@/routing/policy";
import { storedRouting } from "./stored";

test("headless routing reads the execution owner's price edits, custom models and project rules", async () => {
  const db = openTestDb();
  try {
    const model = defaultCatalog.models.find((item) => item.provider === "openai");
    if (!model) throw new Error("Missing fixture model");
    await setSetting(
      db,
      tenant,
      "catalog.custom_models",
      JSON.stringify([{ ...model, id: "gpt-fixture-custom" }]),
    );
    await setSetting(
      db,
      tenant,
      "catalog.price_edits",
      JSON.stringify({
        [`${model.provider}/${model.id}`]: { ...model.price, input: 42, editedOn: "2026-11-05" },
      }),
    );
    await setSetting(db, tenant, "routing.policy", JSON.stringify(serializePolicy(defaultPolicy)));
    await setSetting(
      db,
      tenant,
      "routing.project_rules",
      JSON.stringify({
        fixture: [
          { id: "research-project", when: {}, tier: "best", reason: "Project quality floor" },
        ],
      }),
    );
    const loaded = await storedRouting(db, tenant, "fixture");
    expect(loaded.catalog.models.find((item) => item.id === model.id)?.price.input).toBe(42);
    expect(loaded.catalog.models.some((item) => item.id === "gpt-fixture-custom")).toBe(true);
    expect(loaded.policy.rules[0]?.id).toBe("research-project");
  } finally {
    db.raw.close();
  }
});
