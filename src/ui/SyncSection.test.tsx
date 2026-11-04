import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SyncApi, SyncConflict, SyncStatus } from "@/sync/api";
import { SyncSection } from "./SyncSection";
afterEach(cleanup);
const state: SyncStatus = {
  host: true,
  enabled: false,
  paused: false,
  deviceId: "host",
  epoch: 0,
  pending: 0,
  lastSuccessAt: null,
  error: null,
  devices: [],
  conflicts: 0,
  blocked: [],
  fileBytes: 0,
  fileBytesDone: 0,
  rotationPending: false,
};
function fixture(status = state) {
  const api = {
    status: vi.fn(() => Promise.resolve(status)),
    preview: vi.fn(() =>
      Promise.resolve({
        counts: [
          { table: "threads", records: 2 },
          { table: "messages", records: 4 },
        ],
        fileBytes: 123,
      }),
    ),
    enable: vi.fn(() => Promise.resolve({ ...status, enabled: true })),
    pause: vi.fn(() => Promise.resolve(status)),
    now: vi.fn(() => Promise.resolve(status)),
    disable: vi.fn(() => Promise.resolve(status)),
    finishRotation: vi.fn(() => Promise.resolve(status)),
    conflicts: vi.fn((): Promise<SyncConflict[]> => Promise.resolve([])),
    resolve: vi.fn(async () => {}),
    recoveryCode: vi.fn(() => Promise.resolve("synthetic-sync-recovery")),
    recover: vi.fn(() => Promise.resolve(status)),
  } satisfies SyncApi;
  const refresh = vi.fn(async () => {});
  const revoke = vi.fn(async () => {});
  render(
    <SyncSection
      api={api}
      status={status}
      error={null}
      paired
      address="https://hulk.test"
      onRefresh={refresh}
      onRevoke={revoke}
    />,
  );
  return { api, refresh, revoke };
}
test("preview and an explicit trust choice precede enrollment; pairing never enrolls", async () => {
  const { api } = fixture({ ...state, host: false });
  const user = userEvent.setup();
  expect(api.enable).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Preview & enable sync" }));
  const dialog = await screen.findByRole("dialog", { name: "Enable encrypted sync" });
  await within(dialog).findByText("threads: 2");
  const enable = within(dialog).getByRole("button", { name: "Enable sync and merge histories" });
  expect(enable).toBeDisabled();
  expect(api.enable).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("checkbox"));
  await user.click(enable);
  await waitFor(() => {
    expect(api.enable).toHaveBeenCalledWith(false, "This desktop");
  });
});
test("disable preserves data and recovery code is fetched only on explicit display", async () => {
  const { api } = fixture({ ...state, epoch: 1, enabled: true });
  const user = userEvent.setup();
  expect(api.recoveryCode).not.toHaveBeenCalled();
  expect(screen.getByText(/does not delete everywhere/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Disable sync" }));
  await waitFor(() => {
    expect(api.disable).toHaveBeenCalledOnce();
  });
  await user.click(screen.getByRole("button", { name: "Show sync recovery code" }));
  expect(await screen.findByText("synthetic-sync-recovery")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByText("synthetic-sync-recovery")).toBeNull();
});
test("revocation requires its concrete confirmation and explains downloaded copies", async () => {
  const { revoke } = fixture({
    ...state,
    epoch: 1,
    enabled: true,
    devices: [
      {
        id: "desktop",
        name: "Laptop",
        publicKey: "public",
        authId: "paired-token-id",
        revokedAt: null,
      },
    ],
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Revoke Laptop" }));
  const modal = screen.getByRole("dialog", { name: "Revoke Laptop?" });
  expect(within(modal).getByText(/cannot erase copies already downloaded/)).toBeInTheDocument();
  expect(revoke).not.toHaveBeenCalled();
  await user.click(within(modal).getByRole("button", { name: "Revoke device and rotate keys" }));
  await waitFor(() => {
    expect(revoke).toHaveBeenCalledWith("paired-token-id");
  });
});
test("pending rotation blocks Resume and offers a retry", async () => {
  const { api } = fixture({
    ...state,
    epoch: 1,
    enabled: true,
    paused: true,
    rotationPending: true,
  });
  expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Finish device revocation" }));
  await waitFor(() => {
    expect(api.finishRotation).toHaveBeenCalledOnce();
  });
});
test("conflict review shows both versions and provenance, then submits a chosen revision", async () => {
  const { api } = fixture({ ...state, epoch: 1, enabled: true, conflicts: 1 });
  api.conflicts.mockResolvedValue([
    {
      id: "conflict",
      recordId: "memory",
      versions: [
        {
          eventId: "A:1",
          deviceId: "A",
          text: "First decision",
          kind: "decision",
          rationale: "First rationale",
          alternatives: "First alternative",
          sourceThreadId: "chat-one",
          sourceMessageId: "message-one",
          sourceArtifactId: "artifact-one",
          extractionMethod: "extracted",
          extractionModel: "synthetic-model",
          authority: "user",
          confidence: 90,
          createdAt: 1,
        },
        {
          eventId: "B:1",
          deviceId: "B",
          text: "Second decision",
          kind: "decision",
          rationale: "Second rationale",
          sourceThreadId: "chat-two",
          sourceMessageId: "message-two",
          extractionMethod: "manual",
          createdAt: 2,
        },
      ],
    },
  ]);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review 1 conflict" }));
  const modal = await screen.findByRole("dialog", { name: "Review memory conflicts" });
  expect(within(modal).getByText("First decision")).toBeInTheDocument();
  expect(within(modal).getByText("Second decision")).toBeInTheDocument();
  expect(within(modal).getByText(/First alternative/)).toBeInTheDocument();
  expect(within(modal).getByText(/artifact-one/)).toBeInTheDocument();
  await user.click(within(modal).getByRole("button", { name: "Use version from B" }));
  await waitFor(() => {
    expect(api.resolve).toHaveBeenCalledWith("memory", "B:1");
  });
});
