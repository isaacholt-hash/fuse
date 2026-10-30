/** The local model's worker on desktop (src-tauri/src/local.rs). */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { LocalBackend, LocalMsg } from "./adapter";

export const tauriLocalBackend: LocalBackend = {
  generate: (req, onMsg) => {
    const onEvent = new Channel<LocalMsg>();
    onEvent.onmessage = onMsg;
    return invoke("local_generate", {
      file: req.file,
      system: req.system,
      messages: req.messages,
      maxTokens: req.maxTokens,
      timeoutSecs: req.timeoutSecs,
      onEvent,
    });
  },
  cancel: () => invoke("local_cancel"),
};
