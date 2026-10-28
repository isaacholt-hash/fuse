import { invoke } from "@tauri-apps/api/core";

/** Attachment bytes on disk (src-tauri/src/files.rs), content-addressed by SHA-256. */
export interface FilesApi {
  put(bytes: Uint8Array): Promise<{ sha256: string; size: number }>;
  get(sha256: string): Promise<Uint8Array>;
  /** Removes every stored file (SE-07 delete-all); returns how many. */
  wipe?(): Promise<number>;
}

export const tauriFilesApi: FilesApi = {
  // A Uint8Array payload goes over IPC as a raw body, not JSON.
  put: (bytes) => invoke("file_put", bytes),
  get: async (sha256) => new Uint8Array(await invoke<ArrayBuffer>("file_get", { sha256 })),
  wipe: () => invoke<number>("file_wipe"),
};

/** In-memory FilesApi for tests. */
export function memoryFilesApi(): FilesApi & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async put(bytes) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
      const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
      files.set(sha256, bytes);
      return { sha256, size: bytes.length };
    },
    get(sha256) {
      const f = files.get(sha256);
      return f ? Promise.resolve(f) : Promise.reject(new Error("can't read the file"));
    },
    wipe() {
      const n = files.size;
      files.clear();
      return Promise.resolve(n);
    },
  };
}

/** Base64 without blowing the call stack on large files. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
