/**
 * The local model (LL-02): a model file on this computer, run by FUSE's own worker. Never a
 * network request, never a key. Until a model is installed and the worker is running, every
 * request fails with a clear reason, and callers fall back to the cloud.
 */
import { ProviderError } from "../errors";
import type { ProviderAdapter } from "../types";

export const NO_LOCAL_MODEL = "No local model is installed. Install one in Settings → Local model.";

/** The adapter while no local model can run. */
export function unavailableLocalAdapter(reason = NO_LOCAL_MODEL): ProviderAdapter {
  return {
    provider: "local",
    listModels: () => Promise.resolve([]),
    // eslint-disable-next-line require-yield -- fails before the first event, by design
    async *streamChat() {
      await Promise.resolve();
      throw new ProviderError("unavailable", reason);
    },
  };
}
