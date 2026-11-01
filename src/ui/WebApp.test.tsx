// M10 step 5: the web app's own pieces: greyed desktop features (PL-02), the folder dialog,
// and Settings → FUSE on HULK (devices, Sign out).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { httpAuthApi } from "@/platform/auth";
import { configureHttp } from "@/platform/http";
import { tauriRepo, type RepoInfo } from "@/repo/api";
import { fakeServer, reply } from "@/test/fakeServer";
import { AppLockSection } from "./AppLock";
import { DataSection } from "./DataSection";
import { FileViewer } from "./FileViewer";
import { LocalModelSection } from "./LocalModel";
import { McpServersSection } from "./McpServers";
import { QuickCaptureSection } from "./QuickCapture";
import { ServerSection } from "./ServerSection";
import { SettingsView } from "./Settings";
import { WebFolderDialog } from "./WebFolder";
import { WindowsSandboxSection } from "./WindowsSandbox";
import { WEB_REASONS } from "./webReasons";

afterEach(cleanup);

const noop = () => undefined;

describe("greyed with a reason in the web app (PL-02)", () => {
  test("quick capture: the shortcut box and Save are disabled", () => {
    render(
      <QuickCaptureSection web shortcut={null} mayNotWork={false} error={null} onSave={noop} />,
    );
    expect(screen.getByRole("textbox", { name: "Quick capture shortcut" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(WEB_REASONS.hotkey)).toBeInTheDocument();
  });

  test("app lock and Windows Hello", () => {
    render(
      <AppLockSection
        web
        enabled={false}
        idleMinutes={5}
        minLength={4}
        onSet={() => Promise.resolve(null)}
        onRemove={() => Promise.resolve(null)}
        onIdle={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Turn on app lock" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Unlock with Windows Hello" })).toBeDisabled();
    expect(screen.queryByLabelText("New passcode")).not.toBeInTheDocument();
    expect(screen.getByText(WEB_REASONS.appLock)).toBeInTheDocument();
  });

  test("the local model", () => {
    render(<LocalModelSection web view={null} />);
    expect(screen.getByRole("button", { name: "Download and install" })).toBeDisabled();
    expect(screen.getByText(WEB_REASONS.local)).toBeInTheDocument();
    expect(screen.queryByText("Checking this computer…")).not.toBeInTheDocument();
  });

  test("the Windows sandbox switch", () => {
    const onToggle = vi.fn();
    render(
      <WindowsSandboxSection web on onToggle={onToggle} onReset={() => Promise.resolve("")} />,
    );
    expect(screen.getByRole("checkbox", { name: "Run commands in the sandbox" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset folder permissions" })).toBeDisabled();
    expect(screen.getByText(WEB_REASONS.windowsSandbox)).toBeInTheDocument();
  });

  test("open in its app and show in folder", () => {
    render(
      <FileViewer
        file={{ name: "report.docx", kind: "text", text: "hi", openReason: WEB_REASONS.open }}
        onClose={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Open in its app" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show in folder" })).toBeDisabled();
    expect(screen.getByText(WEB_REASONS.open)).toBeInTheDocument();
  });

  test("MCP sign-in (OAuth)", () => {
    render(
      <McpServersSection
        signInReason={WEB_REASONS.mcpSignIn}
        servers={[
          {
            id: "m1",
            name: "Linear",
            detail: "https://mcp.example.com",
            local: false,
            network: true,
            variables: [],
            signedIn: false,
          },
        ]}
        onAdd={() => Promise.resolve(null)}
        onRemove={noop}
        onNetwork={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    expect(screen.getByText(WEB_REASONS.mcpSignIn)).toBeInTheDocument();
  });

  test("restoring a backup", async () => {
    render(
      <DataSection
        onExport={() => Promise.resolve(null)}
        backupRestoreReason={WEB_REASONS.restore}
        backups={{
          list: () =>
            Promise.resolve([
              { name: "fuse-1.db", createdMs: 1_800_000_000_000, bytes: 1024, reason: "manual" },
            ]),
          backupNow: () => Promise.reject(new Error("unused")),
          restore: () => Promise.reject(new Error("unused")),
          checkFiles: () => Promise.reject(new Error("unused")),
        }}
      />,
    );
    const restore = await screen.findByRole("button", { name: /^Restore / });
    expect(restore).toBeDisabled();
    expect(screen.getByText(WEB_REASONS.restore)).toBeInTheDocument();
  });

  test("Settings: the server's version, updated with the server, and no zoom", () => {
    render(
      <SettingsView
        web
        server={<p>server section</p>}
        keys={[]}
        version="0.1.0"
        onCheckUpdates={() => Promise.resolve("")}
        onRecoveryKey={() => Promise.resolve("")}
        instructions={null}
        theme="light"
        onTheme={noop}
        textSize="normal"
        onTextSize={noop}
        motion="system"
        onMotion={noop}
        onBack={noop}
        onSaveKey={noop}
        onTestKey={noop}
        onDeleteKey={noop}
        onShowLog={noop}
      />,
    );
    expect(screen.getByText("FUSE on HULK 0.1.0 · Updated with the server")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
    expect(screen.getByText("server section")).toBeInTheDocument();
    const size = screen.getByRole("radiogroup", { name: "Text size" });
    for (const option of within(size).getAllByRole("radio")) expect(option).toBeDisabled();
    expect(screen.getByText(WEB_REASONS.textSize)).toBeInTheDocument();
  });
});

test("the web folder dialog checks the typed path on the server with repo_check", async () => {
  const server = fakeServer({ setUp: true });
  server.signedIn = true;
  server.commands.repo_check = (args) =>
    args.path === "/home/daywalker/projects/x"
      ? reply({ root: "/home/daywalker/projects/x", name: "x", isGit: true })
      : reply(
          {
            error:
              "/etc isn't under /home/daywalker: FUSE on HULK can only use folders in its user's home.",
          },
          400,
        );
  configureHttp({ base: "", fetch: server.fetch });
  const done = vi.fn<(info: RepoInfo | null) => void>();
  const user = userEvent.setup();
  render(<WebFolderDialog open check={(path) => tauriRepo.check(path)} onDone={done} />);
  expect(screen.getByText("A folder on HULK, e.g. /home/daywalker/projects/x")).toBeInTheDocument();

  await user.type(screen.getByLabelText("Folder on HULK"), "/etc{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("isn't under /home/daywalker");
  expect(done).not.toHaveBeenCalled();

  await user.clear(screen.getByLabelText("Folder on HULK"));
  await user.type(screen.getByLabelText("Folder on HULK"), "/home/daywalker/projects/x");
  await user.click(screen.getByRole("button", { name: "Use this folder" }));
  await waitFor(() => {
    expect(done).toHaveBeenCalledWith({
      root: "/home/daywalker/projects/x",
      name: "x",
      isGit: true,
    });
  });
  expect(server.seen.filter((s) => s.path === "/api/invoke/repo_check").map((s) => s.body)).toEqual(
    [{ path: "/etc" }, { path: "/home/daywalker/projects/x" }],
  );
});

test("Settings → Devices: pair a device, list them, and revoke one after asking", async () => {
  const server = fakeServer({ setUp: true });
  server.signedIn = true;
  server.devices = [
    { id: "d1", name: "TCHALLA", createdAt: 1_798_761_600, lastUsedAt: 1_799_020_800 },
    { id: "d2", name: "Runner", createdAt: 1_798_761_600, lastUsedAt: null },
  ];
  configureHttp({ base: "", fetch: server.fetch });
  const signedOut = vi.fn();
  const user = userEvent.setup();
  render(
    <ServerSection
      version="0.1.0"
      auth={httpAuthApi}
      onSignedOut={signedOut}
      now={() => 1_800_000_000_000}
    />,
  );
  expect(screen.getByText("FUSE on HULK 0.1.0")).toBeInTheDocument();
  const list = await screen.findByRole("list", { name: "Paired devices" });
  expect(within(list).getByText("TCHALLA")).toBeInTheDocument();
  expect(within(list).getByText(/never used/)).toBeInTheDocument();
  expect(within(list).getAllByText(/^Paired /)).toHaveLength(2);

  await user.click(screen.getByRole("button", { name: "Pair a device" }));
  const code = await screen.findByRole("status");
  expect(code).toHaveTextContent("ABCD-EFG1");
  expect(code).toHaveTextContent("(10 min)");

  await user.click(screen.getByRole("button", { name: "Revoke TCHALLA" }));
  expect(await screen.findByRole("dialog", { name: "Revoke TCHALLA?" })).toBeInTheDocument();
  expect(server.seen.some((s) => s.path === "/api/auth/revoke")).toBe(false);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
  await waitFor(() => {
    expect(screen.queryByText("TCHALLA")).not.toBeInTheDocument();
  });
  expect(server.seen.find((s) => s.path === "/api/auth/revoke")?.body).toEqual({ id: "d1" });
  expect(screen.getByText("Runner")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() => {
    expect(signedOut).toHaveBeenCalledTimes(1);
  });
  expect(server.signedIn).toBe(false);
});
