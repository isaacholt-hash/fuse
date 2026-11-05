/** Synthetic public account states only, imported solely by tests/the e2e build.
 * No token, native sign-in or provider request is created by this fixture. */
import type { AccountStatus, ConnectorRegistration, ConnectorsApi } from "../api";
import type { SqlDb } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import { setProjectMcpServer } from "@/storage/mcp";
const signedOut = (): AccountStatus => ({
  state: "signed_out",
  identity: null,
  label: null,
  accountHint: null,
  expiresAt: null,
  flowId: null,
  userCode: null,
  verificationUri: null,
  pollAfterSeconds: null,
});
const fingerprint = (r: ConnectorRegistration | undefined) =>
  r && JSON.stringify([r.id, r.kind, r.workspaceId, r.userId, r.clientId, r.tenant, r.services]);
export function scriptedConnectorsApi(
  openDb: () => Promise<SqlDb>,
  tenant: Tenant,
  options: { pollAfterSeconds?: number } = {},
): ConnectorsApi {
  const states = new Map<string, AccountStatus>();
  const registrations = new Map<string, ConnectorRegistration>();
  const disconnect = async (id: string) => {
    states.set(id, signedOut());
    const db = await openDb();
    await db.execute(
      "DELETE FROM project_mcp_servers WHERE server_id=? AND workspace_id=? AND user_id=?",
      [id, tenant.workspaceId, tenant.userId],
    );
    return signedOut();
  };
  return {
    async configure(r) {
      if (r.workspaceId !== tenant.workspaceId || r.userId !== tenant.userId)
        throw new Error("Fixture account scope mismatch.");
      if (!r.clientId || !r.services.length)
        throw new Error("Choose the public client ID and services first.");
      const db = await openDb();
      const now = Date.now();
      await db.batch([
        {
          sql: "INSERT INTO mcp_servers(id,workspace_id,user_id,name,transport,builtin_kind,created_at,updated_at) VALUES(?,?,?,?,'http',?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at",
          params: [
            r.id,
            r.workspaceId,
            r.userId,
            r.kind === "microsoft" ? "Microsoft" : "GitHub",
            r.kind,
            now,
            now,
          ],
        },
        {
          sql: "INSERT INTO connector_accounts(id,workspace_id,user_id,client_id,tenant,services,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,tenant=excluded.tenant,services=excluded.services,updated_at=excluded.updated_at",
          params: [
            r.id,
            r.workspaceId,
            r.userId,
            r.clientId,
            r.tenant,
            JSON.stringify(r.services),
            now,
            now,
          ],
        },
        { sql: "DELETE FROM project_mcp_servers WHERE server_id=?", params: [r.id] },
      ]);
      registrations.set(r.id, structuredClone(r));
      states.set(r.id, signedOut());
      return signedOut();
    },
    status: (id) => Promise.resolve(states.get(id) ?? signedOut()),
    begin(id) {
      const r = registrations.get(id);
      if (!r) throw new Error("Save the fixture registration first.");
      const status: AccountStatus = {
        ...signedOut(),
        state: "pending",
        flowId: `fixture-flow-${id}`,
        userCode: "FIXT-CODE",
        verificationUri:
          r.kind === "github"
            ? "https://github.com/login/device"
            : "https://microsoft.com/devicelogin",
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        pollAfterSeconds: options.pollAfterSeconds ?? 1,
      };
      states.set(id, status);
      return Promise.resolve(status);
    },
    poll(id, flowId) {
      const current = states.get(id);
      if (current?.flowId !== flowId) throw new Error("This fixture sign-in was replaced.");
      const outcome = localStorage.getItem("fuse.e2e.connectorOutcome");
      if (outcome === "offline")
        throw new Error("Recorded connector service unreachable. Refresh to retry.");
      if (outcome === "denied" || outcome === "expired") {
        const status: AccountStatus = { ...signedOut(), state: outcome };
        states.set(id, status);
        return Promise.resolve(status);
      }
      const r = registrations.get(id);
      const work = localStorage.getItem("fuse.e2e.connectorAccount") === "work";
      const status: AccountStatus = {
        ...signedOut(),
        state: "connected",
        identity:
          r?.kind === "github"
            ? "fixture-github-owner"
            : work
              ? "fixture-ms-work"
              : "fixture-ms-personal",
        label: "Recorded owner",
        accountHint:
          r?.kind === "microsoft"
            ? work
              ? "owner@organization.test"
              : "owner@outlook.test"
            : null,
        expiresAt: Math.floor(Date.now() / 1000) + 28800,
      };
      states.set(id, status);
      return Promise.resolve(status);
    },
    disconnect,
    async prepareDelete(_tenant, removeCredentials) {
      const ids = [...states.keys()];
      if (removeCredentials) for (const id of ids) await disconnect(id);
      return ids.length;
    },
    async projectAccess(expected, projectId, identity, enabled) {
      const current = registrations.get(expected.id);
      const status = states.get(expected.id);
      if (
        enabled &&
        (fingerprint(current) !== fingerprint(expected) ||
          status?.state !== "connected" ||
          status.identity !== identity)
      )
        throw new Error(
          "This fixture account changed. Refresh and enable the current account explicitly.",
        );
      await setProjectMcpServer(await openDb(), tenant, projectId, expected.id, enabled);
    },
  };
}
