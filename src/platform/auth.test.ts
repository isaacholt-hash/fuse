import { afterEach, expect, test } from "vitest";
import { AuthError, httpAuthApi } from "./auth";
import { configureHttp } from "./http";

function answering(body: string, status = 200): typeof fetch {
  return () => Promise.resolve(new Response(body || null, { status }));
}

afterEach(() => {
  configureHttp({ fetch: (...a) => globalThis.fetch(...a) });
});

test("a page instead of JSON is an error, not a null state (impeccable audit)", async () => {
  configureHttp({ fetch: answering("<!doctype html><html></html>") });
  await expect(httpAuthApi.state()).rejects.toThrow(AuthError);
  await expect(httpAuthApi.state()).rejects.toThrow("didn't answer as expected");
});

test("an empty sign-in state is an error too", async () => {
  configureHttp({ fetch: answering("") });
  await expect(httpAuthApi.state()).rejects.toThrow(AuthError);
});

test("an empty answer to an action is still fine", async () => {
  configureHttp({ fetch: answering("", 204) });
  await expect(httpAuthApi.signOut()).resolves.toBeUndefined();
});

test("the server's state comes through", async () => {
  configureHttp({
    fetch: answering(JSON.stringify({ setUp: true, signedIn: false, version: "1" })),
  });
  await expect(httpAuthApi.state()).resolves.toMatchObject({ setUp: true, signedIn: false });
});
