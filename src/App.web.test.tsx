// M10 step 5: the web app on HULK signs in before it opens anything, against a fake fuse-server.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memoryFilesApi } from "@/files/api";
import { configureHttp, httpInvoke } from "@/platform/http";
import { unavailableLocalAdapter } from "@/providers/local/adapter";
import type { ProviderAdapter } from "@/providers/types";
import type { RepoApi } from "@/repo/api";
import { openTestDb } from "@/storage/testing/nodeDb";
import { fakeKeysApi } from "@/test/fakeKeysApi";
import { fakeServer } from "@/test/fakeServer";
import App from "./App";

const PASS = "made-up passphrase for tests";

const noRepo: RepoApi = {
  pick: () => Promise.resolve(null),
  check: () => Promise.reject(new Error("unused")),
  write: () => Promise.reject(new Error("unused")),
  remove: () => Promise.reject(new Error("unused")),
  move: () => Promise.reject(new Error("unused")),
  list: () => Promise.reject(new Error("unused")),
  read: () => Promise.reject(new Error("unused")),
  search: () => Promise.reject(new Error("unused")),
};

/** No provider is called in these tests; models just aren't listed. */
const adapterFor = (provider: "anthropic" | "openai" | "local"): ProviderAdapter => ({
  ...unavailableLocalAdapter(),
  provider,
});

function start(server: ReturnType<typeof fakeServer>) {
  configureHttp({ base: "", fetch: server.fetch });
  const opened: number[] = [];
  const keys = fakeKeysApi();
  keys.keys.set("anthropic", "fake-value-for-tests-0000");
  render(
    <App
      webApp
      openDb={() => {
        opened.push(Date.now());
        return Promise.resolve(openTestDb());
      }}
      keysApi={keys.api}
      adapterFor={adapterFor}
      files={memoryFilesApi()}
      repo={noRepo}
      backups={{
        list: () => Promise.resolve([]),
        backupNow: () => Promise.reject(new Error("unused")),
        restore: () => Promise.reject(new Error("unused")),
        checkFiles: () => Promise.reject(new Error("unused")),
      }}
      preview={{ url: () => Promise.resolve("about:blank") }}
      web={{ fetch: () => Promise.reject(new Error("unused")) }}
    />,
  );
  return { opened, user: userEvent.setup() };
}

const passphrase = () => screen.getByLabelText("Passphrase");

afterEach(cleanup);

test("the first visit chooses a passphrase: 12 characters at least, typed twice", async () => {
  const server = fakeServer({ setUp: false });
  const { opened, user } = start(server);
  expect(await screen.findByRole("heading", { name: "Choose a passphrase" })).toBeInTheDocument();
  expect(opened).toEqual([]);
  const submit = screen.getByRole("button", { name: "Set passphrase" });

  await user.type(passphrase(), "too short");
  expect(screen.getByText(/At least 12 characters \(9 so far\)/)).toBeInTheDocument();
  expect(submit).toBeDisabled();

  await user.clear(passphrase());
  await user.type(passphrase(), PASS);
  await user.type(screen.getByLabelText("Passphrase again"), `${PASS}!`);
  expect(screen.getByText("The two don't match.")).toBeInTheDocument();
  expect(submit).toBeDisabled();

  await user.clear(screen.getByLabelText("Passphrase again"));
  await user.type(screen.getByLabelText("Passphrase again"), PASS);
  await user.click(submit);

  expect(await screen.findByRole("textbox", { name: "Message" })).toBeInTheDocument();
  expect(server.seen.find((s) => s.path === "/api/auth/set-up")?.body).toEqual({
    passphrase: PASS,
  });
  expect(opened).toHaveLength(1);
});

test("sign in: a wrong passphrase and a pause show the server's words, the right one opens FUSE", async () => {
  const server = fakeServer({ setUp: true, passphrase: PASS });
  const { opened, user } = start(server);
  expect(
    await screen.findByRole("heading", { name: "Sign in to FUSE on HULK" }),
  ).toBeInTheDocument();

  await user.type(passphrase(), "not the passphrase{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("That isn't right.");
  expect(opened).toEqual([]);

  server.pause = { status: 429, error: "Too many wrong tries. Try again in 15 minutes." };
  await user.type(passphrase(), `${PASS}{Enter}`);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Too many wrong tries. Try again in 15 minutes.",
  );

  server.pause = null;
  await user.type(passphrase(), `${PASS}{Enter}`);
  expect(await screen.findByRole("textbox", { name: "Message" })).toBeInTheDocument();
  expect(opened).toHaveLength(1);
});

test("a command that finds the session gone brings the sign-in screen back", async () => {
  const server = fakeServer({ setUp: true, passphrase: PASS });
  server.signedIn = true;
  const { user } = start(server);
  expect(await screen.findByRole("textbox", { name: "Message" })).toBeInTheDocument();

  // The session runs out on the server; the next command is refused.
  server.signedIn = false;
  await act(async () => {
    await expect(httpInvoke("key_status", { provider: "openai" })).rejects.toBe("signed_out");
  });
  expect(
    await screen.findByRole("heading", { name: "Sign in to FUSE on HULK" }),
  ).toBeInTheDocument();
  await user.type(passphrase(), `${PASS}{Enter}`);
  expect(await screen.findByRole("textbox", { name: "Message" })).toBeInTheDocument();
});
