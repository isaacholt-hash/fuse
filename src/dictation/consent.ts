import { useSyncExternalStore } from "react";
import type { SqlDb } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import { uuidv7 } from "@/storage/ids";

// Installation/browser origin only. Never a portable setting or permission on another device.
const KEY = "fuse.dictation.audio-consent.v1";
const EVENT = "fuse-dictation-consent";
const read = () => {
  try {
    return localStorage.getItem(KEY) === "yes";
  } catch {
    return false;
  }
};
const subscribe = (changed: () => void) => {
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) changed();
  };
  window.addEventListener("storage", storage);
  window.addEventListener(EVENT, changed);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(EVENT, changed);
  };
};
export const useAudioConsent = () => useSyncExternalStore(subscribe, read, () => false);
export function clearAudioConsent() {
  try {
    localStorage.removeItem(KEY);
  } finally {
    window.dispatchEvent(new Event(EVENT));
  }
}
export async function setAudioConsent(db: SqlDb, tenant: Tenant, enabled: boolean) {
  // Turning off is immediate even if writing the audit fails. Enabling fails closed.
  if (!enabled) clearAudioConsent();
  const now = Date.now();
  await db.execute(
    `INSERT INTO security_audit
    (id,workspace_id,user_id,event_kind,provider,scope_kind,scope_id,action,created_at,updated_at)
    VALUES(?,?,?,'policy_change','openai','global','dictation.audio-transfer',?,?,?)`,
    [uuidv7(), tenant.workspaceId, tenant.userId, enabled ? "set" : "remove", now, now],
  );
  if (enabled) {
    localStorage.setItem(KEY, "yes");
    window.dispatchEvent(new Event(EVENT));
  }
}
