/** Single default tenant for v1. Seeded by src-tauri/migrations/0001_init.sql; keep in sync. */
export const DEFAULT_WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
export const DEFAULT_USER_ID = "00000000-0000-7000-8000-000000000002";

export interface Tenant {
  workspaceId: string;
  userId: string;
}

export const DEFAULT_TENANT: Tenant = {
  workspaceId: DEFAULT_WORKSPACE_ID,
  userId: DEFAULT_USER_ID,
};
