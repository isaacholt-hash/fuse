import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountStatus, ConnectorRegistration, ConnectorsApi } from "@/connectors/api";
import { listConnectorRegistrations } from "@/connectors/storage";
import type { SqlDb } from "@/storage/sql";
import type { Tenant } from "@/storage/defaults";
import { uuidv7 } from "@/storage/ids";
import { removeMcpServer } from "@/storage/mcp";

export type ConnectorDraft = Omit<ConnectorRegistration, keyof Tenant | "id"> & { id?: string };
export interface ConnectorView {
  registration: ConnectorRegistration;
  status: AccountStatus | null;
  projects: string[];
  error: string | null;
}
export function connectorLabel(view: ConnectorView): string {
  const kind = view.registration.kind === "microsoft" ? "Microsoft" : "GitHub";
  const account = view.status?.accountHint ?? view.status?.label;
  return account ? `${kind} · ${account}` : kind;
}
export function useConnectors(db: SqlDb, tenant: Tenant, api: ConnectorsApi | undefined) {
  const [records, setRecords] = useState<ConnectorView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const working = useRef(new Set<string>());
  const generation = useRef({ value: 0 });
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (!api) return;
    const version = ++generation.current.value;
    const registrations = await listConnectorRegistrations(db, tenant);
    const next = await Promise.all(
      registrations.map(async (registration): Promise<ConnectorView> => {
        const projects = await db.select<{ project_id: string }>(
          "SELECT project_id FROM project_mcp_servers WHERE workspace_id=? AND user_id=? AND server_id=?",
          [tenant.workspaceId, tenant.userId, registration.id],
        );
        try {
          return {
            registration,
            status: await api.status(registration.id),
            projects: projects.map((p) => p.project_id),
            error: null,
          };
        } catch (e) {
          return {
            registration,
            status: null,
            projects: projects.map((p) => p.project_id),
            error: String(e),
          };
        }
      }),
    );
    if (mounted.current && version === generation.current.value) {
      setRecords(next);
      setError(null);
    }
  }, [api, db, tenant]);
  useEffect(() => {
    mounted.current = true;
    const lifecycle = generation.current;
    void refresh().catch((e: unknown) => {
      if (mounted.current) setError(String(e));
    });
    return () => {
      mounted.current = false;
      lifecycle.value++;
    };
  }, [refresh]);
  const client = () => {
    if (!api) throw new Error("Connector accounts aren't available here.");
    return api;
  };
  const act = async (id: string, operation: () => Promise<AccountStatus> | Promise<void>) => {
    if (!api || working.current.has(id)) return;
    working.current.add(id);
    setBusy(new Set(working.current));
    generation.current.value++;
    setRecords((rows) => rows.map((r) => (r.registration.id === id ? { ...r, error: null } : r)));
    try {
      const result = await operation();
      await refresh();
      if (
        mounted.current &&
        result &&
        ["denied", "expired", "sign_in_required"].includes(result.state)
      ) {
        setRecords((rows) =>
          rows.map((r) => (r.registration.id === id ? { ...r, status: result } : r)),
        );
      }
    } catch (e) {
      let refreshed = true;
      try {
        await refresh();
      } catch {
        refreshed = false;
      }
      if (mounted.current) {
        setError(records.some((r) => r.registration.id === id) ? null : String(e));
        setRecords((rows) =>
          rows.map((r) =>
            r.registration.id === id
              ? { ...r, error: String(e), ...(refreshed ? {} : { status: null }) }
              : r,
          ),
        );
      }
      throw e;
    } finally {
      working.current.delete(id);
      if (mounted.current) setBusy(new Set(working.current));
    }
  };
  return {
    records,
    busy,
    error,
    refresh,
    async configure(draft: ConnectorDraft) {
      if (!api) throw new Error("Connector accounts aren't available here.");
      const registration: ConnectorRegistration = { ...draft, ...tenant, id: draft.id ?? uuidv7() };
      await act(registration.id, () => api.configure(registration));
    },
    begin: (id: string) => act(id, () => client().begin(id)),
    poll: (id: string, flowId: string) => act(id, () => client().poll(id, flowId)),
    disconnect: (id: string) => act(id, () => client().disconnect(id)),
    async changeAccount(id: string) {
      await act(id, async () => {
        await client().disconnect(id);
        return client().begin(id);
      });
    },
    async remove(id: string) {
      await act(id, async () => {
        await client().disconnect(id);
        await removeMcpServer(db, tenant, id);
      });
    },
    async project(id: string, projectId: string, enabled: boolean) {
      const record = records.find((r) => r.registration.id === id);
      if (!record) throw new Error("Refresh this account before changing its project access.");
      await act(id, () =>
        client().projectAccess(
          record.registration,
          projectId,
          record.status?.identity ?? null,
          enabled,
        ),
      );
    },
  };
}
export type ConnectorController = ReturnType<typeof useConnectors>;
