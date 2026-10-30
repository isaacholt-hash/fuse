import { NETWORK_FAILURE } from "@/storage/network";
import { isSandboxed } from "./exec";

test("WF-07: bubblewrap and the Windows AppContainer sandbox; none, or no answer, doesn't", () => {
  expect(isSandboxed("bubblewrap")).toBe(true);
  expect(isSandboxed("app_container")).toBe(true);
  expect(isSandboxed("none")).toBe(false);
  expect(isSandboxed(undefined)).toBe(false);
});

test("WF-07: the Windows sandbox's refusals read as a missing network", () => {
  for (const out of [
    "curl: (7) Failed to connect to example.com port 443 after 3 ms: Permission denied",
    "Error: connect EACCES 93.184.215.14:443",
    "An attempt was made to access a socket in a way forbidden by its access permissions.",
    "curl: (6) Could not resolve host: example.com",
  ]) {
    expect(NETWORK_FAILURE.test(out), out).toBe(true);
  }
  expect(NETWORK_FAILURE.test("Access is denied.")).toBe(false);
});
