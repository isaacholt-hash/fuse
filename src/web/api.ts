import { invoke } from "@/platform/core";

/** A web page as read by the Rust side (src-tauri/src/web.rs): public addresses only, capped. */
export interface WebPage {
  /** After redirects. */
  url: string;
  contentType: string;
  body: string;
  truncated: boolean;
}

export interface WebApi {
  fetch(url: string): Promise<WebPage>;
}

export const tauriWebApi: WebApi = {
  fetch: (url) => invoke<WebPage>("url_fetch", { url }),
};
