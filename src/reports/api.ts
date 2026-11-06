import { invoke } from "@/platform/core";

export type ReportProvider = "openai" | "anthropic";

/** A sanitized collection result (src-tauri/src/usage_reports.rs): no credentials or bodies. */
export interface ReportRunSummary {
  state: "ok" | "auth" | "rate_limited" | "error";
  pages: number;
  rows: number;
  windowStart: number;
  windowEnd: number;
  message: string;
}

/** M18.3: the dedicated reporting credentials and on-demand collection. */
export interface ReportsApi {
  keySaved(provider: ReportProvider): Promise<boolean>;
  saveKey(provider: ReportProvider, key: string): Promise<boolean>;
  removeKey(provider: ReportProvider): Promise<boolean>;
  refresh(provider: ReportProvider): Promise<ReportRunSummary>;
}

export const tauriReportsApi: ReportsApi = {
  keySaved: (provider) => invoke<boolean>("report_key_status", { provider }),
  saveKey: (provider, key) => invoke<boolean>("report_key_save", { provider, key }),
  removeKey: (provider) => invoke<boolean>("report_key_delete", { provider }),
  refresh: (provider) => invoke<ReportRunSummary>("report_refresh", { provider }),
};
