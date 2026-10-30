import { useCallback, useEffect, useState } from "react";
import type { CloudProviderId } from "@/catalog/catalog";
import { describeTest, PROVIDERS, type KeysApi, type KeyTestResult } from "@/keys/api";
import type { KeyView } from "@/ui/types";

/** Key state for Settings and the composer. Keys only pass through here on their way to Rust. */
export function useKeys(
  api: KeysApi,
  onTested?: (provider: CloudProviderId, result: KeyTestResult) => void,
) {
  const [keys, setKeys] = useState<KeyView[]>(() =>
    PROVIDERS.map((p) => ({
      provider: p.id,
      name: p.name,
      consoleUrl: p.consoleUrl,
      saved: false,
      masked: null,
      busy: "loading",
      result: null,
    })),
  );
  const patch = useCallback((provider: CloudProviderId, change: Partial<KeyView>) => {
    setKeys((all) => all.map((k) => (k.provider === provider ? { ...k, ...change } : k)));
  }, []);

  useEffect(() => {
    for (const { id } of PROVIDERS) {
      api.status(id).then(
        (s) => {
          patch(id, { saved: s.saved, masked: s.masked, busy: null });
        },
        (e: unknown) => {
          patch(id, { busy: null, result: { tone: "error", text: String(e) } });
        },
      );
    }
  }, [api, patch]);

  const run = useCallback(
    async (
      provider: CloudProviderId,
      busy: KeyView["busy"],
      work: () => Promise<Partial<KeyView>>,
    ) => {
      patch(provider, { busy, result: null });
      try {
        patch(provider, { busy: null, ...(await work()) });
      } catch (e) {
        patch(provider, { busy: null, result: { tone: "error", text: String(e) } });
      }
    },
    [patch],
  );

  const save = (provider: CloudProviderId, key: string) =>
    void run(provider, "saving", async () => {
      const r = await api.save(provider, key);
      onTested?.(provider, r.test);
      return { saved: r.status.saved, masked: r.status.masked, result: describeTest(r.test) };
    });
  const test = (provider: CloudProviderId) =>
    void run(provider, "testing", async () => {
      const r = await api.test(provider);
      onTested?.(provider, r);
      return { result: describeTest(r) };
    });
  const remove = (provider: CloudProviderId) =>
    void run(provider, "deleting", async () => {
      const s = await api.remove(provider);
      return { saved: s.saved, masked: s.masked, result: null };
    });

  return { keys, save, test, remove };
}
