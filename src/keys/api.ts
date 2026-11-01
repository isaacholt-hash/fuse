import { invoke } from "@/platform/core";

/** Mirrors src-tauri/src/keys.rs. The key itself only ever travels frontend → Rust, on save. */
export type Provider = "openai" | "anthropic";

export const PROVIDERS: { id: Provider; name: string; consoleUrl: string }[] = [
  { id: "openai", name: "OpenAI", consoleUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", name: "Anthropic", consoleUrl: "https://platform.claude.com/settings/keys" },
];

export interface KeyStatus {
  saved: boolean;
  /** e.g. `sk-…3f9a` */
  masked: string | null;
}

export type KeyTestStatus = "ok" | "invalid" | "rate_limited" | "provider_error" | "network";

export interface KeyTestResult {
  status: KeyTestStatus;
  httpStatus: number | null;
  latencyMs: number;
  requestId: string | null;
}

export interface KeySaveResult {
  saved: boolean;
  status: KeyStatus;
  test: KeyTestResult;
}

export interface KeysApi {
  status(provider: Provider): Promise<KeyStatus>;
  save(provider: Provider, key: string): Promise<KeySaveResult>;
  test(provider: Provider): Promise<KeyTestResult>;
  remove(provider: Provider): Promise<KeyStatus>;
}

export const tauriKeysApi: KeysApi = {
  status: (provider) => invoke("key_status", { provider }),
  save: (provider, key) => invoke("key_save", { provider, key }),
  test: (provider) => invoke("key_test", { provider }),
  remove: (provider) => invoke("key_delete", { provider }),
};

/** Plain-English outcome for the UI. */
export function describeTest(r: KeyTestResult): { tone: "ok" | "warn" | "error"; text: string } {
  switch (r.status) {
    case "ok":
      return { tone: "ok", text: "Working" };
    case "invalid":
      return { tone: "error", text: "Invalid key. Check it and paste it again." };
    case "rate_limited":
      return { tone: "warn", text: "Key works, but the provider is rate-limiting right now." };
    case "provider_error":
      return {
        tone: "error",
        text: `Provider error (HTTP ${String(r.httpStatus ?? "?")}). Try again in a minute.`,
      };
    case "network":
      return { tone: "error", text: "Couldn't reach the provider. Check your connection." };
  }
}
