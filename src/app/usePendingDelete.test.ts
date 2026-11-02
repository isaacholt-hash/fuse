import { act, renderHook } from "@testing-library/react";
import { usePendingDelete, type PendingDelete } from "./usePendingDelete";

const thread: PendingDelete = { kind: "thread", id: "t1", title: "Tile budget" };
const messages: PendingDelete = {
  kind: "messages",
  threadId: "t1",
  ids: ["a", "b"],
  previousLeafId: "b",
  count: 2,
};

function setup() {
  const calls: string[] = [];
  const handlers = {
    finalise: (p: PendingDelete) => {
      calls.push(`finalise:${p.kind}`);
      return Promise.resolve();
    },
    undo: (p: PendingDelete) => {
      calls.push(`undo:${p.kind}`);
      return Promise.resolve();
    },
  };
  return { calls, ...renderHook(() => usePendingDelete(1000, handlers)) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("a delete waits for its window, then is finalised", async () => {
  const { calls, result } = setup();
  await act(() => result.current.start(thread));
  expect(result.current.pending).toEqual(thread);
  act(() => {
    vi.advanceTimersByTime(999);
  });
  expect(calls).toEqual([]);
  await act(async () => {
    vi.advanceTimersByTime(1);
    await Promise.resolve();
  });
  expect(calls).toEqual(["finalise:thread"]);
  expect(result.current.pending).toBeNull();
});

test("undo and dismiss end the window early, each in its own way", async () => {
  const { calls, result } = setup();
  await act(() => result.current.start(thread));
  await act(() => result.current.undo());
  expect(calls).toEqual(["undo:thread"]);
  expect(result.current.pending).toBeNull();
  await act(() => result.current.start(messages));
  await act(() => result.current.flush());
  expect(calls).toEqual(["undo:thread", "finalise:messages"]);
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  expect(calls).toEqual(["undo:thread", "finalise:messages"]);
});

test("a second delete finalises the first; unmounting finalises what's left", async () => {
  const { calls, result, unmount } = setup();
  await act(() => result.current.start(thread));
  await act(() => result.current.start(messages));
  expect(calls).toEqual(["finalise:thread"]);
  expect(result.current.pending).toEqual(messages);
  unmount();
  expect(calls).toEqual(["finalise:thread", "finalise:messages"]);
});
