import type { Device } from "@/platform/auth";

/** One request the page made to the fake fuse-server. */
export interface Seen {
  method: string;
  path: string;
  body: unknown;
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/**
 * A fuse-server stand-in for the web app's tests (M10 step 5): sign-in as src-tauri/src/auth.rs
 * answers it, devices, and any commands the test adds to `commands`. Pass `server.fetch` to
 * `configureHttp`. Every other command answers `unknown_command`, as the server does.
 */
export function fakeServer({
  setUp = false,
  passphrase = "made-up passphrase for tests",
  version = "0.1.0",
}: { setUp?: boolean; passphrase?: string; version?: string } = {}) {
  const server = {
    setUp,
    signedIn: false,
    seen: [] as Seen[],
    /** The next sign-ins are refused like this (status, error) before the passphrase is checked. */
    pause: null as { status: number; error: string } | null,
    devices: [] as Device[],
    pairCodes: 0,
    commands: {} as Record<string, (args: Record<string, unknown>) => Response>,
    fetch: ((input: string, init?: RequestInit) => {
      const path = new URL(input, "http://hulk.test").pathname;
      const raw = init?.body;
      const body: unknown = typeof raw === "string" && raw ? JSON.parse(raw) : null;
      server.seen.push({ method: init?.method ?? "GET", path, body });
      return Promise.resolve(answer(path, body as Record<string, unknown> | null));
    }) as unknown as typeof fetch,
  };
  const pass = (body: Record<string, unknown> | null) =>
    typeof body?.passphrase === "string" ? body.passphrase : "";
  const signedOut = () => json({ error: "signed_out" }, 401);
  function answer(path: string, body: Record<string, unknown> | null): Response {
    switch (path) {
      case "/api/auth/state":
        return json({ setUp: server.setUp, signedIn: server.signedIn, version });
      case "/api/auth/set-up":
        if (server.setUp) return json({ error: "A passphrase is already set." }, 400);
        if (pass(body).length < 12)
          return json({ error: "Use a passphrase of at least 12 characters." }, 400);
        passphrase = pass(body);
        server.setUp = true;
        server.signedIn = true;
        return json({ signedIn: true });
      case "/api/auth/sign-in":
        if (!server.setUp) return json({ error: "not_set_up" }, 409);
        if (server.pause) return json({ error: server.pause.error }, server.pause.status);
        if (pass(body) !== passphrase) return json({ error: "That isn't right." }, 401);
        server.signedIn = true;
        return json({ signedIn: true });
      case "/api/auth/sign-out":
        server.signedIn = false;
        return json({ signedIn: false });
      case "/api/auth/pair-code":
        if (!server.signedIn) return signedOut();
        server.pairCodes += 1;
        return json({ code: `ABCD-EFG${String(server.pairCodes)}`, expiresAt: 1_800_000_600 });
      case "/api/auth/devices":
        return server.signedIn ? json(server.devices) : signedOut();
      case "/api/auth/revoke": {
        if (!server.signedIn) return signedOut();
        const before = server.devices.length;
        server.devices = server.devices.filter((d) => d.id !== body?.id);
        return json({ removed: server.devices.length < before });
      }
    }
    const command = /^\/api\/invoke\/(.+)$/.exec(path)?.[1];
    if (command) {
      if (!server.signedIn) return signedOut();
      const run = server.commands[command];
      return run ? run(body ?? {}) : json({ error: `unknown_command: ${command}` }, 400);
    }
    return json({ error: "not found" }, 404);
  }
  return server;
}

export const reply = json;
