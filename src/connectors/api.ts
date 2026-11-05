/** Native device authorization. No token/device credential crosses this interface. */
import { invoke } from "@/platform/core";
import type { Tenant } from "@/storage/defaults";
export type ConnectorKind = "microsoft" | "github";
export type ConnectorService = "onedrive" | "mail" | "calendar" | "github";
export interface ConnectorRegistration extends Tenant {
  id: string;
  kind: ConnectorKind;
  clientId: string;
  tenant: string;
  services: ConnectorService[];
}
export interface AccountStatus {
  state: "signed_out" | "pending" | "connected" | "sign_in_required" | "expired" | "denied";
  identity: string | null;
  label: string | null;
  accountHint: string | null;
  /** Unix seconds, for either the sign-in challenge or connected token. */
  expiresAt: number | null;
  flowId: string | null;
  userCode: string | null;
  verificationUri: string | null;
  pollAfterSeconds: number | null;
}
export interface ConnectorsApi {
  configure(registration: ConnectorRegistration): Promise<AccountStatus>;
  status(id: string): Promise<AccountStatus>;
  begin(id: string): Promise<AccountStatus>;
  poll(id: string, flowId: string): Promise<AccountStatus>;
  disconnect(id: string): Promise<AccountStatus>;
  prepareDelete(tenant: Tenant, removeCredentials: boolean): Promise<number>;
  projectAccess(
    registration: ConnectorRegistration,
    projectId: string,
    identity: string | null,
    enabled: boolean,
  ): Promise<void>;
}
export const nativeConnectorsApi: ConnectorsApi = {
  configure: (registration) => invoke("connector_configure", { registration }),
  status: (id) => invoke("connector_status", { id }),
  begin: (id) => invoke("connector_begin", { id }),
  poll: (id, flowId) => invoke("connector_poll", { id, flowId }),
  disconnect: (id) => invoke("connector_disconnect", { id }),
  prepareDelete: (tenant, removeCredentials) =>
    invoke("connector_prepare_delete", { ...tenant, removeCredentials }),
  projectAccess: (registration, projectId, identity, enabled) =>
    invoke("connector_project_access", { registration, projectId, identity, enabled }),
};
