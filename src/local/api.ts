/** The local model's Rust side (src-tauri/src/local.rs, hardware.rs). */
import { invoke } from "@tauri-apps/api/core";
import type { Hardware } from "./hardware";

export interface LocalApi {
  hardware(): Promise<Hardware>;
}

export const tauriLocalApi: LocalApi = {
  hardware: () => invoke<Hardware>("local_hardware"),
};
