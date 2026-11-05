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

test.each(["chat", "queue"] as const)(
  "lost %s acknowledgement retries the same reviewed Chat and start identity",
  async (where) => {
    const db = openTestDb();
    const original = db.execute.bind(db);
    let lose = true;
    db.execute = async (sql, params) => {
      const result = await original(sql, params);
      const matches =
        where === "chat"
          ? sql.includes("INSERT INTO threads")
          : sql.includes("INSERT INTO run_requests");
      if (lose && matches) {
        lose = false;
        throw new Error("fixture acknowledgement lost");
      }
      return result;
    };
    const model = researchModels(catalog, policy, { kind: "auto" }, "Tides", ["openai"]).worker;
    const onSelect = vi.fn(),
      onError = vi.fn();
    function Harness() {
      const research = useResearch({
        deps: {
          db,
          tenant,
          catalog,
          adapterFor: () => {
            throw new Error("A browser cannot execute research");
          },
        },
        threadId: null,
        projectId: null,
        mode: { kind: "model", provider: model.provider, id: model.id },
        policy,
        providers: ["openai"],
        hulkStatus: null,
        web: true,
        incognito: false,
        draftInstructions: "Use the owner's outline.",
        onSelect,
        onError,
        onChanged: vi.fn(),
      });
      return (
        <>
          <button
            onClick={() => {
              research.open("Compare tides");
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
    const dialog = within(await screen.findByRole("dialog", { name: "Research" }));
    fireEvent.click(dialog.getByRole("checkbox", { name: "Chat instructions" }));
    fireEvent.change(dialog.getByLabelText("Research spending cap (USD)"), {
      target: { value: "5" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Start research" }));
    await screen.findByText("fixture acknowledgement lost");
    fireEvent.click(dialog.getByRole("button", { name: "Start research" }));
    await screen.findByRole("button", { name: "Open research" });
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Research" })).not.toBeInTheDocument(),
    );
    const threads = await db.select<{ id: string; instructions: string; pinned_model: string }>(
      "SELECT id,instructions,pinned_model FROM threads",
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      instructions: "Use the owner's outline.",
      pinned_model: model.id,
    });
    const requests = await db.select<{ input: string }>("SELECT input FROM run_requests");
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]?.input ?? "{}")).toMatchObject({
      threadId: threads[0]?.id,
      research: { selection: { instructions: ["thread"] } },
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(await db.select("SELECT id FROM request_log")).toEqual([]);
    expect(await db.select("SELECT id FROM folders")).toEqual([]);
  },
);
