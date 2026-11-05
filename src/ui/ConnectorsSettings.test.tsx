import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { openTestDb } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createProject } from "@/storage/projects";
import { useConnectors } from "@/app/useConnectors";
import type { ConnectorsApi } from "@/connectors/api";
import { scriptedConnectorsApi } from "@/connectors/testing/scripted";
import { PanelActivity } from "./panelActivity";
import { ConnectorsSettings } from "./ConnectorsSettings";
import type { SqlDb } from "@/storage/sql";

vi.mock("./openExternal", () => ({ openExternal: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
function Harness({
  db,
  api,
  projects,
  active = true,
}: {
  db: SqlDb;
  api: ConnectorsApi;
  projects: { id: string; name: string }[];
  active?: boolean;
}) {
  const controller = useConnectors(db, DEFAULT_TENANT, api);
  return (
    <div hidden={!active}>
      <PanelActivity value={active}>
        <ConnectorsSettings controller={controller} projects={projects} web />
      </PanelActivity>
    </div>
  );
}
async function fixture() {
  const db = openTestDb();
  const project = await createProject(db, DEFAULT_TENANT, "Reader project");
  const api = scriptedConnectorsApi(() => Promise.resolve(db), DEFAULT_TENANT);
  return { db, api, project, projects: [project] };
}
async function register(kind: "Microsoft" | "GitHub" = "Microsoft") {
  fireEvent.click(screen.getByRole("button", { name: `Add ${kind} account` }));
  fireEvent.change(screen.getByLabelText("Application client ID"), {
    target: {
      value: kind === "Microsoft" ? "10000000-0000-4000-8000-000000000001" : "Iv23.fixture",
    },
  });
  if (kind === "Microsoft") {
    expect(screen.getByRole("button", { name: "Save registration" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "OneDrive files" }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Save registration" }));
  await screen.findByText("Signed out");
}
async function signIn() {
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByLabelText("Device sign-in code");
  await screen.findByText("Connected", {}, { timeout: 4000 });
}
test("registration never signs in or grants a project; explicit enablement needs no linked folder and starts no execution", async () => {
  const f = await fixture();
  const begin = vi.spyOn(f.api, "begin");
  const project = vi.spyOn(f.api, "projectAccess");
  render(<Harness {...f} />);
  await register();
  expect(begin).not.toHaveBeenCalled();
  expect(project).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "Reader project" })).toBeDisabled();
  await signIn();
  expect(project).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "Reader project" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Reader project" }));
  await waitFor(() => {
    expect(screen.getByRole("checkbox", { name: "Reader project" })).toBeChecked();
  });
  expect(project).toHaveBeenCalledWith(
    expect.objectContaining({ services: ["onedrive"], tenant: "common" }),
    f.project.id,
    "fixture-ms-personal",
    true,
  );
  expect(await f.db.select("SELECT * FROM runs")).toEqual([]);
  expect(await f.db.select("SELECT * FROM request_log")).toEqual([]);
});
test.each(["denied", "expired"] as const)(
  "%s sign-in remains actionable and grants nothing",
  async (outcome) => {
    const f = await fixture();
    localStorage.setItem("fuse.e2e.connectorOutcome", outcome);
    const project = vi.spyOn(f.api, "projectAccess");
    render(<Harness {...f} />);
    await register("GitHub");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText(
      outcome === "denied" ? /Consent denied/ : /Sign-in code expired/,
      {},
      { timeout: 4000 },
    );
    expect(project).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Reader project" })).toBeDisabled();
    expect(await f.db.select("SELECT * FROM project_mcp_servers")).toEqual([]);
  },
);
test("a transport failure stops polling until explicit refresh, and cancellation clears its pending sign-in", async () => {
  const f = await fixture();
  localStorage.setItem("fuse.e2e.connectorOutcome", "offline");
  const poll = vi.spyOn(f.api, "poll");
  const disconnect = vi.spyOn(f.api, "disconnect");
  render(<Harness {...f} />);
  await register();
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findAllByText(/Recorded connector service unreachable/, {}, { timeout: 4000 });
  const calls = poll.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(poll).toHaveBeenCalledTimes(calls);
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await screen.findByText("Signed out");
  expect(disconnect).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("Device sign-in code")).toBeNull();
});
test("hidden settings pause polling and reopening continues only the already requested flow", async () => {
  const f = await fixture();
  const poll = vi.spyOn(f.api, "poll");
  const begin = vi.spyOn(f.api, "begin");
  const view = render(<Harness {...f} />);
  await register();
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByLabelText("Device sign-in code");
  view.rerender(<Harness {...f} active={false} />);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(poll).not.toHaveBeenCalled();
  view.rerender(<Harness {...f} active />);
  await screen.findByText("Connected", {}, { timeout: 4000 });
  expect(begin).toHaveBeenCalledOnce();
});
test("account switching clears project access and displays the new personal or work identity", async () => {
  const f = await fixture();
  const disconnect = vi.spyOn(f.api, "disconnect");
  render(<Harness {...f} />);
  await register();
  await signIn();
  fireEvent.click(screen.getByRole("checkbox", { name: "Reader project" }));
  await waitFor(() => {
    expect(screen.getByRole("checkbox", { name: "Reader project" })).toBeChecked();
  });
  localStorage.setItem("fuse.e2e.connectorAccount", "work");
  fireEvent.click(screen.getByRole("button", { name: "Change account and reset project access" }));
  await screen.findByText("Connected", {}, { timeout: 4000 });
  expect(disconnect).toHaveBeenCalledOnce();
  expect(
    await screen.findByRole("article", { name: "Microsoft · owner@organization.test" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Reader project" })).not.toBeChecked();
});
test("editing registration disconnects and removal waits for confirmation without deleting retrieved history", async () => {
  const f = await fixture();
  const disconnect = vi.spyOn(f.api, "disconnect");
  render(<Harness {...f} />);
  await register("GitHub");
  await signIn();
  fireEvent.click(screen.getByRole("button", { name: "Edit registration" }));
  fireEvent.click(screen.getByRole("button", { name: "Save and disconnect" }));
  await screen.findByText("Signed out");
  fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
  expect(disconnect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep account" }));
  expect(screen.getByRole("article")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove account" }));
  await waitFor(() => {
    expect(screen.queryByRole("article")).toBeNull();
  });
  expect(disconnect).toHaveBeenCalledOnce();
});

test("a failed account switch refreshes the disconnected state rather than claiming the old account is connected", async () => {
  const f = await fixture();
  render(<Harness {...f} />);
  await register();
  await signIn();
  vi.spyOn(f.api, "begin").mockRejectedValueOnce(
    new Error("Recorded device sign-in refusal. Check application settings."),
  );
  fireEvent.click(screen.getByRole("button", { name: "Change account and reset project access" }));
  await screen.findByText("Signed out");
  expect(screen.queryByText("Connected")).toBeNull();
  expect(await screen.findByRole("alert")).toHaveTextContent("device sign-in refusal");
  expect(screen.getByRole("checkbox", { name: "Reader project" })).toBeDisabled();
});
