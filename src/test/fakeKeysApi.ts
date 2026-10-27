import type { KeysApi, KeyStatus, KeyTestResult, Provider } from "@/keys/api";

/** In-memory KeysApi for UI tests. `accept` decides how the fake provider answers a test call. */
export function fakeKeysApi(accept: (key: string) => KeyTestResult["status"] = () => "ok") {
  const keys = new Map<Provider, string>();
  const statusOf = (p: Provider): KeyStatus => {
    const k = keys.get(p);
    return { saved: k !== undefined, masked: k ? `…${k.slice(-4)}` : null };
  };
  const result = (status: KeyTestResult["status"]): KeyTestResult => ({
    status,
    httpStatus: status === "ok" ? 200 : status === "invalid" ? 401 : null,
    latencyMs: 120,
    requestId: "req_fake",
  });
  const api: KeysApi = {
    status: (p) => Promise.resolve(statusOf(p)),
    save: (p, key) => {
      const test = result(accept(key));
      const saved = test.status === "ok" || test.status === "rate_limited";
      if (saved) keys.set(p, key.trim());
      return Promise.resolve({ saved, status: statusOf(p), test });
    },
    test: (p) => {
      const k = keys.get(p);
      return k ? Promise.resolve(result(accept(k))) : Promise.reject(new Error("No key saved"));
    },
    remove: (p) => {
      keys.delete(p);
      return Promise.resolve(statusOf(p));
    },
  };
  return { api, keys };
}
