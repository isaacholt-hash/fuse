import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { defaultCatalog as catalog } from "@/catalog/defaultCatalog";
import { defaultPolicy as policy } from "@/routing/defaultPolicy";
import { openTestDb } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { setEgressRule } from "@/storage/egress";
import type { SqlValue } from "@/storage/sql";
import type { HulkApi, HulkStatus } from "@/handover/api";
import { useResearch } from "./useResearch";
import { researchModels } from "./routing";

afterEach(cleanup);
test("HULK preview respects the execution owner's policy and prefers desktop when hosted search is unavailable", async () => {
  const db = openTestDb(),
    owner = openTestDb();
  await setEgressRule(owner, tenant, null, "anthropic", false);
  const status: HulkStatus = {
    address: "https://hulk.example",
    paired: true,
    mismatch: null,
    mine: { schema: 66, builtFrom: "fixture", builtOn: "2026-11-05", researchProtocol: 1 },
    server: { schema: 66, builtFrom: "fixture", builtOn: "2026-11-05", researchProtocol: 1 },
  };
  const hulk: HulkApi = {
    status: () => Promise.resolve(status),
    pair: () => Promise.reject(new Error("Unused")),
    unpair: () => Promise.reject(new Error("Unused")),
    putFile: () => Promise.reject(new Error("Preview cannot upload files")),
    async invoke<T>(command: string, args: Record<string, unknown> = {}) {
      let value: unknown;
      if (command === "key_status") value = { saved: true };
      else if (command === "db_select" && typeof args.sql === "string")
        value = await owner.select(args.sql, args.params as SqlValue[]);
      else throw new Error("Preview cannot dispatch or mutate HULK");
      return value as T;
    },
  };
  const onError = vi.fn();
  function Harness() {
    const research = useResearch({
      deps: {
        db,
        tenant,
        catalog,
        adapterFor: () => {
          throw new Error("Preview cannot call a provider");
        },
      },
      threadId: null,
      projectId: null,
      mode: { kind: "auto" },
      policy,
      providers: ["openai", "anthropic"],
      hulk,
      hulkStatus: status,
      web: false,
      incognito: false,
      onChanged: vi.fn(),
      onSelect: vi.fn(),
      onError,
    });
    return (
      <>
        <button
          onClick={() => {
            research.open("Compare tide measurements");
          }}
        >
          Open research
        </button>
        {research.dialogs}
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Open research" }));
  let dialog = within(await screen.findByRole("dialog", { name: "Research" }));
  expect(dialog.getByRole("radio", { name: /^HULK/ })).toBeChecked();
  const expected = researchModels(catalog, policy, { kind: "auto" }, "Compare tide measurements", [
    "openai",
  ]);
  expect(dialog.getByText(/Auto routing:/)).toHaveTextContent(expected.best.displayName);
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  await setEgressRule(owner, tenant, null, "anthropic", null);
  await setEgressRule(owner, tenant, null, "openai", false);
  fireEvent.click(screen.getByRole("button", { name: "Open research" }));
  dialog = within(await screen.findByRole("dialog", { name: "Research" }));
  expect(dialog.getByRole("radio", { name: /^HULK/ })).toBeDisabled();
  expect(dialog.getByRole("radio", { name: /^This computer/ })).toBeChecked();
  expect(await owner.select("SELECT id FROM run_requests")).toEqual([]);
  expect(await owner.select("SELECT id FROM request_log")).toEqual([]);
  expect(onError).not.toHaveBeenCalled();
});
