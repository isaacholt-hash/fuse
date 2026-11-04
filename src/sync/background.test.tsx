import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatApp } from "@/app/ChatApp";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { memoryFilesApi } from "@/files/api";
import { unavailableLocalAdapter } from "@/providers/local/adapter";
import { DEFAULT_TENANT } from "@/storage/defaults";
import { createThread } from "@/storage/threads";
import { openTestDb } from "@/storage/testing/nodeDb";
import { fakeKeysApi } from "@/test/fakeKeysApi";
import { noUpdates } from "@/update/api";
import type { SyncApi, SyncStatus } from "./api";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});
test("background sync refreshes received history while preserving the draft and making no provider call", async () => {
  vi.useFakeTimers();
  localStorage.clear();
  const db = openTestDb();
  let status: SyncStatus = {
    host: false,
    enabled: true,
    paused: false,
    epoch: 1,
    deviceId: "desktop",
    pending: 0,
    lastSuccessAt: null,
    error: null,
    devices: [],
    blocked: [],
    conflicts: 0,
    fileBytes: 0,
    fileBytesDone: 0,
    rotationPending: false,
  };
  const api: SyncApi = {
    status: vi.fn(() => Promise.resolve(status)),
    preview: () => Promise.resolve({ counts: [], fileBytes: 0 }),
    enable: () => Promise.resolve(status),
    pause: () => Promise.resolve(status),
    now: () => Promise.resolve(status),
    disable: () => Promise.resolve(status),
    finishRotation: () => Promise.resolve(status),
    conflicts: () => Promise.resolve([]),
    resolve: async () => {},
    recoveryCode: () => Promise.resolve("synthetic-only"),
    recover: () => Promise.resolve(status),
  };
  const keys = fakeKeysApi();
  keys.keys.set("anthropic", "synthetic-fixture-only");
  const model = unavailableLocalAdapter();
  const chat = vi.spyOn(model, "streamChat");
  await act(async () => {
    render(
      <ChatApp
        db={db}
        tenant={DEFAULT_TENANT}
        catalog={defaultCatalog}
        policy={defaultPolicy}
        keysApi={keys.api}
        adapterFor={() => model}
        files={memoryFilesApi()}
        prepareImage={() => Promise.reject(new Error("unused"))}
        updates={noUpdates}
        recoveryKey={() => Promise.resolve("synthetic-only")}
        syncApi={api}
      />,
    );
    await vi.advanceTimersByTimeAsync(0);
  });
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "My unsent draft" } });
  await createThread(db, DEFAULT_TENANT, "History from another device");
  status = { ...status, lastSuccessAt: 123 };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5001);
  });
  expect(screen.getByText("History from another device")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
  expect(input).toHaveValue("My unsent draft");
  expect(chat).not.toHaveBeenCalled();
});
