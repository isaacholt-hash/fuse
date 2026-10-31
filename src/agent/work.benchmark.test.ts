// @vitest-environment node
// M8 step 13: the Work benchmark, recorded. Each task is a Work run on a fresh copy of
// data/work/fixture (real Word, Excel and PDF files, real moves) through the real Anthropic and
// OpenAI adapters, fed each turn as that provider streams it. The model's turns are scripted, so
// this checks everything but the model: the document tools, the organise plan and its approval,
// and the checks. `pnpm work:live` runs the same tasks with real models (work.live.test.ts).
import { parseCatalog, type CatalogModel, type ProviderId } from "@/catalog/catalog";
import { createAnthropicAdapter } from "@/providers/anthropic/adapter";
import { createOpenAIAdapter } from "@/providers/openai/adapter";
import { fakeFetch, noSleep } from "@/providers/testing/fakeFetch";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { grantFolder } from "@/storage/folders";
import { listSteps } from "@/storage/runs";
import { openTestDb } from "@/storage/testing/nodeDb";
import { startRun, type ApprovalRequest, type RunDeps } from "./run";
import {
  dropRepo,
  failedChecks,
  freshFolder,
  loadWorkTasks,
  nodePython,
  nodeRepo,
} from "./testing/bench";
import { anthropicTurn, openaiTurn, type Turn } from "./testing/turns";

const block = (kind: string, text: string | null, rows: string[][] | null = null) => ({
  kind,
  text,
  level: kind === "heading" ? 1 : null,
  rows,
});

/** What a good model would do for each task. */
const SCRIPTS: Record<string, Turn[]> = {
  "summarise-to-docx": [
    {
      text: "1. Read the three reports.\n2. Write summary.docx with a table.",
      calls: [
        {
          name: "read_document",
          input: { path: "reports/supplier-review.docx", offset: null, sheet: null, range: null },
        },
        { name: "read_file", input: { path: "reports/q3-update.md", offset: null } },
        { name: "read_file", input: { path: "reports/customer-feedback.txt", offset: null } },
      ],
    },
    {
      calls: [
        {
          name: "write_document",
          input: {
            path: "summary.docx",
            title: "Summary of the reports",
            sheets: null,
            blocks: [
              block("paragraph", "Growth is steady; deliveries in the north are the main risk."),
              block("table", null, [
                ["Document", "Key points"],
                ["Q3 update", "Revenue 1.2M (+8%); hiring paused; launch moved to May"],
                ["Supplier review", "Northwind late on 3 of 12; move the route to Contoso"],
                ["Customer feedback", "NPS 41; wants CSV export and dark mode"],
              ]),
            ],
          },
        },
      ],
    },
    { text: "Wrote summary.docx: a one-line summary and a table of each report's key points." },
  ],
  "xlsx-from-csvs": [
    {
      calls: [
        { name: "read_file", input: { path: "data/units.csv", offset: null } },
        { name: "read_file", input: { path: "data/prices.csv", offset: null } },
      ],
    },
    {
      text: "The prices are in a different order; matching by product.",
      calls: [
        {
          name: "write_document",
          input: {
            path: "revenue.xlsx",
            title: null,
            blocks: null,
            sheets: [
              {
                name: "Revenue",
                rows: [
                  ["Product", "Units", "Price", "Revenue"],
                  ["Lamp", "120", "25", "=B2*C2"],
                  ["Kettle", "80", "40", "=B3*C3"],
                  ["Toaster", "45", "30", "=B4*C4"],
                  ["Total", "", "", "=SUM(D2:D4)"],
                ],
              },
            ],
          },
        },
      ],
    },
    { text: "Made revenue.xlsx: revenue per product as units × price, and a SUM total." },
  ],
  "organise-messy": [
    { calls: [{ name: "list_files", input: { path: "messy", recursive: true } }] },
    {
      calls: [
        {
          name: "organise",
          input: {
            reason: "Grouped by kind: money, pictures and notes.",
            moves: [
              ["invoice-0931.pdf", "Invoices and receipts"],
              ["Invoice 0932.pdf", "Invoices and receipts"],
              ["receipt-taxi.pdf", "Invoices and receipts"],
              ["IMG_2041.jpg", "Images"],
              ["Screenshot 2026-10-02.png", "Images"],
              ["notes from call.txt", "Notes"],
              ["trip ideas.md", "Notes"],
              ["packing list.csv", "Notes"],
            ].map(([name, to]) => ({
              from: `messy/${String(name)}`,
              to: `messy/${String(to)}/${String(name)}`,
            })),
          },
        },
      ],
    },
    { text: "Sorted the 8 files into Invoices and receipts, Images and Notes." },
  ],
  "python-total": [
    {
      text: "1. Total units times price with run_python.\n2. Keep the total.",
      calls: [
        {
          name: "run_python",
          input: {
            script: [
              "import csv, os",
              'units = {r["product"]: int(r["units"]) for r in csv.DictReader(open("data/units.csv"))}',
              'prices = {r["product"]: float(r["price"]) for r in csv.DictReader(open("data/prices.csv"))}',
              "total = sum(units[p] * prices[p] for p in units)",
              "print(total)",
              'open(os.path.join(os.environ["FUSE_OUT"], "total.txt"), "w").write(f"{total:g}\\n")',
            ].join("\n"),
            keep: [{ from: "total.txt", to: "revenue-total.txt" }],
            timeout_seconds: null,
          },
        },
      ],
    },
    { text: "Total revenue is 7550, worked out with Python; it's in revenue-total.txt." },
  ],
};

const catalog = parseCatalog({
  price_version: "2026-10-30",
  models: (["anthropic", "openai"] as const).map((provider) => ({
    provider,
    id: `${provider}-balanced`,
    display_name: provider,
    context_window: 200000,
    max_output: 4000,
    price: { input: 1, output: 4 },
    capabilities: [],
    verified_on: "2026-10-30",
    source_url: "https://example.com",
  })),
});

describe.each(["anthropic", "openai"] as ProviderId[])("%s", (provider) => {
  for (const task of loadWorkTasks()) {
    test(`${task.id}: passes its checks`, async () => {
      const dir = freshFolder();
      try {
        const turns = SCRIPTS[task.id] ?? [];
        const f = fakeFetch(
          turns.map((t, i) => ({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: provider === "anthropic" ? anthropicTurn(t, i) : openaiTurn(t, i),
            chunkSize: 37,
          })),
        );
        const adapter =
          provider === "anthropic"
            ? createAnthropicAdapter({ fetch: f.fetch, retry: noSleep })
            : createOpenAIAdapter({ fetch: f.fetch, retry: noSleep });
        const db = openTestDb();
        const t = DEFAULT_TENANT;
        const asked: ApprovalRequest[] = [];
        const deps: RunDeps = {
          db,
          tenant: t,
          catalog,
          adapterFor: () => adapter,
          repo: nodeRepo(dir),
          // M9 step 7: the Python task's run_python (system python3; see nodePython).
          exec: {
            run: () => Promise.reject(new Error("no commands in this benchmark")),
            sandboxKind: () => Promise.resolve("bubblewrap"),
            python: nodePython(dir),
          },
          pythonReady: () => Promise.resolve(true),
          approve: (req) => {
            asked.push(req);
            return Promise.resolve(true);
          },
        };
        const model = catalog.models.find((m) => m.provider === provider) as CatalogModel;
        // A chat outside any project, with its own folder, as Work is used.
        const run = await startRun(deps, {
          projectId: null,
          folders: [await grantFolder(db, t, dir)],
          threadId: null,
          messageId: null,
          task: task.task,
          model,
          mode: "auto_edit",
          kind: "work",
        });
        expect(run.status, run.note ?? "").toBe("done");
        expect(failedChecks(dir, task.checks)).toEqual([]);
        if (task.checks.some((c) => c.kind === "one_organise_plan")) {
          expect(asked.map((a) => a.kind)).toEqual(["organise"]);
        }
        const steps = await listSteps(db, t, run.id);
        for (const c of task.checks) {
          if (c.kind === "used_tool") {
            expect(
              steps.some((s) => s.kind === "tool" && s.call.name === c.tool),
              c.tool,
            ).toBe(true);
          }
        }
        expect(f.sent).toHaveLength(turns.length);
        const failed = (await listSteps(db, t, run.id)).flatMap((s) =>
          s.kind === "tool" && s.isError ? [`${s.call.name}: ${s.output}`] : [],
        );
        expect(failed).toEqual([]);
      } finally {
        dropRepo(dir);
      }
    }, 30_000);
  }
});

test("the fixture starts messy: the checks fail before any run", () => {
  const dir = freshFolder();
  try {
    for (const task of loadWorkTasks()) {
      expect(failedChecks(dir, task.checks).length, task.id).toBeGreaterThan(0);
    }
  } finally {
    dropRepo(dir);
  }
});
