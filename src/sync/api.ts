import { invoke } from "@/platform/core";
export interface SyncDevice {
  id: string;
  name: string;
  publicKey: string;
  authId?: string | null;
  revokedAt: number | null;
}
export interface SyncStatus {
  host: boolean;
  rotationPending: boolean;
  enabled: boolean;
  paused: boolean;
  deviceId: string;
  epoch: number;
  pending: number;
  lastSuccessAt: number | null;
  error: string | null;
  devices: SyncDevice[];
  conflicts: number;
  blocked: string[];
  fileBytes: number;
  fileBytesDone: number;
}
export interface SyncPreview {
  counts: { table: string; records: number }[];
  fileBytes: number;
}
export interface SyncCandidate {
  eventId: string;
  deviceId: string;
  text: string;
  kind: string;
  rationale: string | null;
  alternatives?: string | null;
  sourceArtifactId?: string | null;
  extractionModel?: string | null;
  authority?: string | null;
  confidence?: number | null;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  extractionMethod: string | null;
  createdAt: number;
}
export interface SyncConflict {
  id: string;
  recordId: string;
  versions: SyncCandidate[];
}
export interface SyncApi {
  status(): Promise<SyncStatus>;
  preview(): Promise<SyncPreview>;
  enable(host: boolean, name: string): Promise<SyncStatus>;
  pause(paused: boolean): Promise<SyncStatus>;
  now(): Promise<SyncStatus>;
  disable(): Promise<SyncStatus>;
  finishRotation(): Promise<SyncStatus>;
  conflicts(): Promise<SyncConflict[]>;
  resolve(id: string, choice: string): Promise<void>;
  recoveryCode(): Promise<string>;
  recover(code: string): Promise<SyncStatus>;
}
export const nativeSyncApi: SyncApi = {
  status: () => invoke("sync_status"),
  preview: () => invoke("sync_preview"),
  enable: (host, name) =>
    host
      ? invoke("sync_setup", { confirmed: true })
      : invoke("sync_enroll", { name, confirmed: true }),
  pause: (paused) => invoke("sync_pause", { paused }),
  now: () => invoke("sync_now"),
  disable: () => invoke("sync_disable"),
  finishRotation: () => invoke("sync_finish_rotation"),
  conflicts: () => invoke("sync_conflicts"),
  resolve: (id, choice) => invoke("sync_resolve", { id, choice }),
  recoveryCode: () => invoke("sync_recovery_code"),
  recover: (code) => invoke("sync_recover", { code }),
};
