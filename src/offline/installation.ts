/**
 * M18.1: this installation's identity for the offline queue. It lives in the app's own
 * storage, not the database, so a restored or replicated database never matches it and its
 * queued messages can't send from somewhere else.
 */
const KEY = "fuse.installation";
let fallback: string | null = null;

export function installationId(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
    const made = crypto.randomUUID();
    localStorage.setItem(KEY, made);
    return made;
  } catch {
    // No storage: this session only, so nothing queued here can outlive it unnoticed.
    fallback ??= crypto.randomUUID();
    return fallback;
  }
}

/** Online state with change events; injectable for tests. */
export interface Connectivity {
  online(): boolean;
  subscribe(onChange: (online: boolean) => void): () => void;
}

export const browserConnectivity: Connectivity = {
  online: () => (typeof navigator === "undefined" ? true : navigator.onLine),
  subscribe(onChange) {
    const up = () => {
      onChange(true);
    };
    const down = () => {
      onChange(false);
    };
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  },
};
