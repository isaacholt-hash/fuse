/** The local model's Rust side (src-tauri/src/local.rs, hardware.rs, model_files.rs). */
import { Channel, invoke } from "@/platform/core";
import type { Hardware } from "./hardware";
import type { InstalledFile, InstallMsg } from "./install";
import type { LocalProfile } from "./models";

export interface LocalApi {
  hardware(): Promise<Hardware>;
  installed(): Promise<InstalledFile[]>;
  /** Downloads, checks and installs the profile's file; resumes a paused download. */
  install(profile: LocalProfile, onMsg: (m: InstallMsg) => void): Promise<InstalledFile>;
  /** Pauses the download under way (it resumes on the next install). */
  cancelInstall(): Promise<void>;
  remove(file: string): Promise<void>;
}

export const tauriLocalApi: LocalApi = {
  hardware: () => invoke<Hardware>("local_hardware"),
  installed: () => invoke<InstalledFile[]>("local_installed"),
  install: (p, onMsg) => {
    const onEvent = new Channel<InstallMsg>();
    onEvent.onmessage = onMsg;
    return invoke<InstalledFile>("local_install", {
      url: p.url,
      file: p.file,
      sha256: p.sha256,
      revision: p.revision,
      sizeBytes: p.sizeBytes,
      onEvent,
    });
  },
  cancelInstall: () => invoke("local_install_cancel"),
  remove: (file) => invoke("local_remove", { file }),
};
