import { e2eDeps } from "./deps";
import { invoke } from "@/platform/core";

vi.mock("@/platform/core", async (original) => ({
  ...(await original<typeof import("@/platform/core")>()),
  // A paired host would answer this command; the scripted app must not ask it.
  invoke: vi.fn(() => Promise.resolve({ paired: true, address: "https://host.invalid" })),
}));

test("scripted desktop stays unpaired without reading or changing the host's HULK link", async () => {
  const { hulk } = e2eDeps();
  expect(await hulk.status()).toEqual({
    address: null,
    paired: false,
    mine: null,
    server: null,
    mismatch: null,
  });
  await expect(hulk.pair("https://host.invalid", "fixture-code", "fixture")).rejects.toThrow(
    "Live HULK access is disabled",
  );
  await expect(hulk.unpair()).rejects.toThrow("Live HULK access is disabled");
  await expect(hulk.invoke("db_select", { sql: "SELECT 1" })).rejects.toThrow(
    "Live HULK access is disabled",
  );
  await expect(hulk.putFile(new Uint8Array([1]))).rejects.toThrow("Live HULK access is disabled");
  expect(invoke).not.toHaveBeenCalled();
});
