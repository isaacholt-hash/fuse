// Commands in the linked repository (CA-03), through Rust (src-tauri/src/exec.rs): the folder
// comes from the project, input is closed, and a time limit and Stop end the whole process tree.
import { Channel, invoke } from "@tauri-apps/api/core";

type ExecMsg =
  | { type: "out"; text: string }
  | {
      type: "done";
      exitCode: number | null;
      timedOut: boolean;
      stopped: boolean;
      truncated: boolean;
      elapsedMs: number;
    }
  | { type: "error"; message: string };

export interface ExecResult {
  output: string;
  /** null when it was killed (time limit, Stop). */
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  /** Output went past 1 MB and the rest wasn't kept. */
  truncated: boolean;
  elapsedMs: number;
}

/** WF-07: what sandboxes commands on this computer. */
export type SandboxKind = "bubblewrap" | "app_container" | "none";

/** WF-07: whether a command run here is sandboxed (no answer means it isn't). */
export const isSandboxed = (kind: SandboxKind | undefined) => kind !== undefined && kind !== "none";

/** The saved choice for the Windows sandbox: "on", or anything else for off. */
export const WINDOWS_SANDBOX_SETTING = "sandbox.windows";

/** M8 step 9: the Windows sandbox, off until switched on in Settings while it's tested. */
export interface WindowsSandboxApi {
  /** This is Windows, and commands can run in an AppContainer here. */
  available(): Promise<boolean>;
  set(on: boolean): Promise<void>;
  /** Puts every folder the sandbox was given back as it was; resolves to how many. */
  reset(): Promise<number>;
}

export interface ExecApi {
  run(
    folderId: string,
    command: string,
    opts: {
      timeoutSecs?: number;
      signal?: AbortSignal;
      onOutput?: (soFar: string) => void;
      /** WF-07: run sandboxed: writable only in these folders (and a private /tmp). */
      sandbox?: { folderIds: string[]; network: boolean };
      /** WF-07: with a run's sandbox, whether it may use the network (off unless allowed). */
      network?: boolean;
    },
  ): Promise<ExecResult>;
  /** WF-07: whether commands can be sandboxed here. */
  sandboxKind?(): Promise<SandboxKind>;
  windowsSandbox?: WindowsSandboxApi;
}

export const tauriExec: ExecApi = {
  sandboxKind: () => invoke<SandboxKind>("sandbox_status"),
  windowsSandbox: {
    available: () => invoke<boolean>("sandbox_windows_available"),
    set: (on) => invoke("sandbox_windows_set", { on }),
    reset: () => invoke<number>("sandbox_windows_reset"),
  },
  run: (folderId, command, { timeoutSecs, signal, onOutput, sandbox }) =>
    new Promise<ExecResult>((resolve, reject) => {
      let output = "";
      const channel = new Channel<ExecMsg>();
      channel.onmessage = (m) => {
        if (m.type === "out") {
          output += m.text;
          onOutput?.(output);
        } else if (m.type === "done") {
          const { type: _type, ...rest } = m;
          resolve({ output, ...rest });
        } else reject(new Error(m.message));
      };
      invoke<number>("repo_exec", {
        folderId,
        command,
        timeoutSecs: timeoutSecs ?? null,
        sandbox: sandbox ?? null,
        onEvent: channel,
      })
        .then((id) => {
          const stop = () => void invoke("repo_exec_stop", { id });
          if (signal?.aborted) stop();
          else signal?.addEventListener("abort", stop, { once: true });
        })
        .catch(reject);
    }),
};
