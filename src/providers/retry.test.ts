import { ProviderError } from "./errors";
import { withRetry } from "./retry";

const fails = (errors: ProviderError[], value = "ok") => {
  let n = 0;
  return vi.fn(() => {
    const e = errors[n++];
    return e ? Promise.reject(e) : Promise.resolve(value);
  });
};

test("retries transient errors, then succeeds", async () => {
  const sleep = vi.fn((_ms: number, _signal?: AbortSignal) => Promise.resolve());
  const attempt = fails([
    new ProviderError("overloaded", "529"),
    new ProviderError("server", "500"),
  ]);
  const r = await withRetry(attempt, { sleep, random: () => 0 });
  expect(r).toEqual({ value: "ok", attempts: 3 });
  expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
});

test("waits at least retry-after", async () => {
  const sleep = vi.fn((_ms: number, _signal?: AbortSignal) => Promise.resolve());
  await withRetry(fails([new ProviderError("rate_limit", "429", { retryAfter: 7 })]), {
    sleep,
    random: () => 0,
  });
  expect(sleep).toHaveBeenCalledWith(7000, undefined);
});

test("never retries errors the user must fix", async () => {
  for (const kind of ["auth", "billing", "invalid_request", "not_found"] as const) {
    const attempt = fails([new ProviderError(kind, kind)]);
    await expect(withRetry(attempt, { sleep: () => Promise.resolve() })).rejects.toMatchObject({
      kind,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  }
});

test("gives up after 3 retries (4 attempts)", async () => {
  const e = new ProviderError("overloaded", "529");
  const attempt = fails([e, e, e, e, e]);
  await expect(withRetry(attempt, { sleep: () => Promise.resolve() })).rejects.toBe(e);
  expect(attempt).toHaveBeenCalledTimes(4);
});

test("stops retrying once aborted", async () => {
  const controller = new AbortController();
  const attempt = vi.fn(() => {
    controller.abort();
    return Promise.reject(new ProviderError("server", "500"));
  });
  await expect(
    withRetry(attempt, { signal: controller.signal, sleep: () => Promise.resolve() }),
  ).rejects.toMatchObject({ kind: "server" });
  expect(attempt).toHaveBeenCalledTimes(1);
});
