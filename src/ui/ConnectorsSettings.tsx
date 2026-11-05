import { useEffect, useEffectEvent, useState } from "react";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConnectorService } from "@/connectors/api";
import {
  connectorLabel,
  type ConnectorController,
  type ConnectorDraft,
  type ConnectorView,
} from "@/app/useConnectors";
import { usePanelActive, usePanelLeave } from "./panelActivity";
import { openExternal } from "./openExternal";

const field = "w-full rounded-md border bg-background px-2 py-2 text-xs";
const serviceNames: Record<ConnectorService, string> = {
  onedrive: "OneDrive files",
  mail: "Outlook Mail",
  calendar: "Outlook Calendar",
  github: "GitHub repositories, issues and PRs",
};
function fresh(kind: "microsoft" | "github"): ConnectorDraft {
  return { kind, clientId: "", tenant: "common", services: kind === "github" ? ["github"] : [] };
}
export function ConnectorsSettings({
  controller,
  projects,
  web = false,
}: {
  controller: ConnectorController;
  projects: { id: string; name: string }[];
  web?: boolean;
}) {
  const active = usePanelActive();
  const [draft, setDraft] = useState<ConnectorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const perform = (operation: Promise<unknown>) => {
    void operation.catch((e: unknown) => {
      setProblem(String(e));
    });
  };
  usePanelLeave(() => {
    setProblem(null);
    setRemove(null);
  });
  const refresh = controller.refresh;
  useEffect(() => {
    if (active)
      void refresh().catch((e: unknown) => {
        setProblem(String(e));
      });
  }, [active, refresh]);
  return (
    <section aria-label="Connections" className="space-y-4">
      <div className="flex items-center gap-2">
        <Plug className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Connections</h2>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Read OneDrive, Outlook and selected GitHub repositories in your projects. Sign in with an
        application you register, then enable each project explicitly.{" "}
        {web ? "Authorization stays on HULK." : "Authorization stays on this computer."} Accounts
        and project permissions do not sync.
      </p>
      {(problem ?? controller.error) && (
        <p role="alert" className="text-xs text-destructive">
          {problem ?? controller.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setDraft(fresh("microsoft"));
            setProblem(null);
          }}
        >
          Add Microsoft account
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setDraft(fresh("github"));
            setProblem(null);
          }}
        >
          Add GitHub account
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            perform(controller.refresh());
          }}
        >
          Refresh accounts
        </Button>
      </div>
      {draft && (
        <form
          aria-label="Connector registration"
          className="space-y-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (saving) return;
            setSaving(true);
            setProblem(null);
            void controller
              .configure(draft)
              .then(
                () => {
                  setDraft(null);
                },
                (e: unknown) => {
                  setProblem(String(e));
                },
              )
              .finally(() => {
                setSaving(false);
              });
          }}
        >
          <h3 className="text-sm font-medium">
            {draft.id ? "Edit" : "Register"} {draft.kind === "microsoft" ? "Microsoft" : "GitHub"}{" "}
            connection
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
            Use the public application client ID. No client secret is needed. Saving does not sign
            in or enable a project.
          </p>
          <label className="block space-y-1 text-xs">
            <span>Application client ID</span>
            <input
              className={field}
              required
              maxLength={128}
              autoComplete="off"
              value={draft.clientId}
              onChange={(e) => {
                setDraft({ ...draft, clientId: e.target.value });
              }}
            />
          </label>
          {draft.kind === "microsoft" ? (
            <>
              <label className="block space-y-1 text-xs">
                <span>Microsoft tenant</span>
                <input
                  className={field}
                  required
                  maxLength={253}
                  list="connector-tenants"
                  value={draft.tenant}
                  onChange={(e) => {
                    setDraft({ ...draft, tenant: e.target.value });
                  }}
                />
              </label>
              <datalist id="connector-tenants">
                <option value="common" />
                <option value="consumers" />
                <option value="organizations" />
              </datalist>
              <p className="text-xs text-muted-foreground">
                common: personal and work/school; consumers: personal; organizations: work/school.
                Your application and tenant policies must allow the account.
              </p>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-xs font-medium">
                  Services to authorize (read only)
                </legend>
                {(["onedrive", "mail", "calendar"] as const).map((service) => (
                  <label key={service} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={draft.services.includes(service)}
                      onChange={(e) => {
                        setDraft({
                          ...draft,
                          services: e.target.checked
                            ? [...draft.services, service]
                            : draft.services.filter((s) => s !== service),
                        });
                      }}
                    />
                    {serviceNames[service]}
                  </label>
                ))}
              </fieldset>
              <p className="text-xs text-muted-foreground">
                Register a public client, allow device authorization, and add delegated
                User.Read/offline_access plus read access for the selected services.{" "}
                <a
                  className="underline"
                  href="https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration"
                  onClick={(e) => {
                    e.preventDefault();
                    openExternal(e.currentTarget.href);
                  }}
                >
                  Microsoft registration instructions
                </a>
              </p>
            </>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              Register a GitHub App, enable Device Flow, and install it on Only select repositories.
              Use Metadata, Contents, Issues and Pull requests read permissions only. Webhooks and a
              callback are unnecessary for this flow.{" "}
              <a
                className="underline"
                href="https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app"
                onClick={(e) => {
                  e.preventDefault();
                  openExternal(e.currentTarget.href);
                }}
              >
                GitHub App instructions
              </a>
            </p>
          )}
          {draft.id && (
            <p className="text-xs text-muted-foreground">
              Saving a changed registration disconnects this account and removes its project access.
              Sign in and enable projects again.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={saving || !draft.clientId.trim() || draft.services.length === 0}
            >
              {saving ? "Saving…" : draft.id ? "Save and disconnect" : "Save registration"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setDraft(null);
              }}
            >
              Cancel registration
            </Button>
          </div>
        </form>
      )}
      {controller.records.length === 0 && !draft && (
        <p className="text-xs text-muted-foreground">
          No accounts configured. Account sign-in never grants project access by itself.
        </p>
      )}
      {controller.records.map((record) => (
        <AccountCard
          key={record.registration.id}
          record={record}
          busy={controller.busy.has(record.registration.id)}
          controller={controller}
          projects={projects}
          web={web}
          onEdit={() => {
            setDraft(record.registration);
          }}
          onRemove={() => {
            setRemove(record.registration.id);
          }}
        />
      ))}
      {remove && (
        <div
          role="alertdialog"
          aria-label="Remove connector account"
          className="space-y-3 rounded-lg border p-4 text-xs"
        >
          <p>
            Remove this account from {web ? "HULK" : "this installation"}? Its local credentials and
            project access will be cleared. Previously retrieved conversation content remains.
          </p>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              perform(
                controller.remove(remove).then(() => {
                  setRemove(null);
                }),
              );
            }}
          >
            Remove account
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setRemove(null);
            }}
          >
            Keep account
          </Button>
        </div>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        Readers stay subject to each project's provider rules and approvals. They cannot send mail,
        change events, write repositories or grant local folders. Disconnect here clears local
        authorization; revoke the application in your provider account to remove provider-side
        authorization too. Sign in separately on each computer and HULK where you need access.
      </p>
    </section>
  );
}
function AccountCard({
  record,
  busy,
  controller,
  projects,
  web,
  onEdit,
  onRemove,
}: {
  record: ConnectorView;
  busy: boolean;
  controller: ConnectorController;
  projects: { id: string; name: string }[];
  web: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const active = usePanelActive();
  const { registration: r, status } = record;
  const checkSignIn = useEffectEvent((flowId: string) => controller.poll(r.id, flowId));
  useEffect(() => {
    if (!active || busy || record.error || status?.state !== "pending" || !status.flowId) return;
    const id = status.flowId;
    const timer = setTimeout(
      () => {
        void checkSignIn(id).catch(() => undefined);
      },
      Math.max(1, status.pollAfterSeconds ?? 5) * 1000,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [active, busy, record.error, status, r.id]);
  const perform = (operation: Promise<unknown>) => {
    void operation.catch(() => undefined);
  };
  const pending = status?.state === "pending";
  const connected = status?.state === "connected";
  const state = status?.state;
  const stateLabel =
    state === "connected"
      ? "Connected"
      : state === "pending"
        ? "Waiting for provider sign-in"
        : state === "denied"
          ? "Consent denied — sign in again when ready"
          : state === "expired"
            ? "Sign-in code expired — start again"
            : state === "sign_in_required"
              ? "Authorization needs sign-in again"
              : status
                ? "Signed out"
                : "Status unavailable — refresh or check registration";
  return (
    <article aria-label={connectorLabel(record)} className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium break-words">{connectorLabel(record)}</h3>
          <p className="mt-1 text-xs text-muted-foreground" role="status">
            {busy ? "Updating account…" : stateLabel}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">Read only</span>
      </div>
      {status?.label && status.accountHint && (
        <p className="text-xs text-muted-foreground">
          {status.label} · {status.accountHint}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {r.services.map((s) => serviceNames[s]).join(" · ")}
        {r.kind === "microsoft" ? ` · Tenant: ${r.tenant}` : ""}
      </p>
      {record.error && (
        <p role="alert" className="text-xs text-destructive">
          {record.error} Refresh to retry; tenant or organization policies may require administrator
          consent.
        </p>
      )}
      {pending && (
        <div className="space-y-2 rounded-md bg-muted p-3 text-xs">
          <p>Open the provider's sign-in page and enter this code:</p>
          <p className="font-mono text-lg tracking-wider" aria-label="Device sign-in code">
            {status.userCode}
          </p>
          {status.verificationUri && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                openExternal(status.verificationUri ?? undefined);
              }}
            >
              Open {r.kind === "microsoft" ? "Microsoft" : "GitHub"} sign-in
            </Button>
          )}
          <p className="text-muted-foreground">
            {status.expiresAt
              ? `Expires ${new Date(status.expiresAt * 1000).toLocaleTimeString()}. `
              : ""}
            FUSE checks at the provider's required interval. Close this panel to pause checks;
            reopen and refresh to continue.
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              perform(controller.disconnect(r.id));
            }}
          >
            Cancel sign-in
          </Button>
        </div>
      )}
      {!pending && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              perform(connected ? controller.changeAccount(r.id) : controller.begin(r.id));
            }}
          >
            {connected ? "Change account and reset project access" : "Sign in"}
          </Button>
          {(connected || state === "sign_in_required") && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                perform(controller.disconnect(r.id));
              }}
            >
              Disconnect
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
            Edit registration
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
            Remove…
          </Button>
        </div>
      )}
      {connected && status.expiresAt && (
        <p className="text-xs text-muted-foreground">
          {r.kind === "github"
            ? "Sign in again after"
            : "Authorization renews when used; current token expires"}{" "}
          {new Date(status.expiresAt * 1000).toLocaleString()}.
        </p>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-2 text-xs font-medium">
          Projects allowed on {web ? "HULK" : "this computer"}
        </legend>
        {projects.length ? (
          projects.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={record.projects.includes(p.id)}
                disabled={busy || (!connected && !record.projects.includes(p.id))}
                onChange={(e) => {
                  perform(controller.project(r.id, p.id, e.target.checked));
                }}
              />
              {p.name}
            </label>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            Create a project first. No linked folder is required.
          </p>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {(r.kind === "github"
          ? [
              {
                label: "Manage GitHub authorization",
                url: "https://github.com/settings/apps/authorizations",
              },
            ]
          : [
              {
                label: "Manage personal Microsoft authorization",
                url: "https://account.live.com/consent/Manage",
              },
              {
                label: "Manage work/school applications",
                url: "https://myapplications.microsoft.com",
              },
            ]
        ).map((link) => (
          <a
            key={link.url}
            className="text-xs text-muted-foreground underline"
            href={link.url}
            onClick={(e) => {
              e.preventDefault();
              openExternal(e.currentTarget.href);
            }}
          >
            {link.label}
          </a>
        ))}
      </div>
    </article>
  );
}
