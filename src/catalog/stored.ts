/** The execution owner's accepted catalog and routing settings, using the UI's parsers. */
import type { SqlDb } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import { getSetting } from "@/storage/settings";
import { defaultCatalog } from "./defaultCatalog";
import { CUSTOM_MODELS_SETTING, parseCustomModels, withCustomModels } from "./discovery";
import { applyEdits, baseCatalog, EDITS_SETTING, FETCHED_SETTING, parseEdits } from "./prices";
import { defaultPolicy } from "@/routing/defaultPolicy";
import {
  loadPolicy,
  loadProjectRules,
  POLICY_SETTING,
  PROJECT_RULES_SETTING,
  withProjectRules,
} from "@/routing/policyStore";

export async function storedCatalog(db: SqlDb, tenant: Tenant) {
  const [fetched, custom, edits] = await Promise.all(
    [FETCHED_SETTING, CUSTOM_MODELS_SETTING, EDITS_SETTING].map((key) =>
      getSetting(db, tenant, key),
    ),
  );
  return applyEdits(
    withCustomModels(
      baseCatalog(defaultCatalog, fetched ?? null),
      parseCustomModels(custom ?? null),
    ),
    parseEdits(edits ?? null),
  );
}

export async function storedRouting(db: SqlDb, tenant: Tenant, projectId: string | null) {
  const [catalog, raw, rules] = await Promise.all([
    storedCatalog(db, tenant),
    getSetting(db, tenant, POLICY_SETTING),
    getSetting(db, tenant, PROJECT_RULES_SETTING),
  ]);
  const global = loadPolicy(defaultPolicy, raw, catalog);
  return {
    catalog,
    policy: withProjectRules(
      global,
      projectId ? loadProjectRules(global, rules)[projectId] : undefined,
    ),
  };
}
