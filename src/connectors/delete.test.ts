// @vitest-environment node
import { openTestDb } from "@/storage/testing/nodeDb";
import { DEFAULT_TENANT as tenant } from "@/storage/defaults";
import { addMcpServer } from "@/storage/mcp";
import { deleteAllData } from "@/data/deleteAll";
import { memoryFilesApi } from "@/files/api";
import { scriptedConnectorsApi } from "./testing/scripted";
import { listConnectorRegistrations } from "./storage";
import { prepareAccountDeletion } from "./delete";
test.each([true, false])(
  "global deletion applies credential choice %s before metadata disappears",
  async (removeCredentials) => {
    const db = openTestDb();
    const native = scriptedConnectorsApi(() => Promise.resolve(db), tenant);
    await native.configure({
      ...tenant,
      id: "00000000-0000-7000-8000-000000001504",
      kind: "microsoft",
      clientId: "10000000-0000-4000-8000-000000000001",
      tenant: "common",
      services: ["mail"],
    });
    const generic = await addMcpServer(db, tenant, {
      name: "Recorded remote",
      transport: "http",
      command: null,
      args: [],
      url: "https://fixture.example.test",
      envNames: ["FIXTURE_TOKEN"],
      network: false,
    });
    const calls: string[] = [];
    const original = native.prepareDelete.bind(native);
    native.prepareDelete = async (scope, remove) => {
      expect(await listConnectorRegistrations(db, tenant)).toHaveLength(1);
      calls.push(`native:${String(remove)}`);
      return original(scope, remove);
    };
    await prepareAccountDeletion(db, tenant, removeCredentials, native, {
      removeSecret: async (id, name) => {
        expect(id).toBe(generic.id);
        expect(name).toBe("FIXTURE_TOKEN");
        expect(await db.select("SELECT id FROM mcp_servers WHERE id=?", [id])).toHaveLength(1);
        calls.push("generic-variable");
      },
      signOut: () => {
        calls.push("generic-signout");
        return Promise.resolve();
      },
      stop: () => {
        calls.push("generic-stop");
        return Promise.resolve();
      },
    });
    await deleteAllData(db, tenant, memoryFilesApi());
    expect(await listConnectorRegistrations(db, tenant)).toEqual([]);
    expect(calls).toEqual(
      removeCredentials
        ? ["native:true", "generic-variable", "generic-signout", "generic-stop"]
        : ["native:false"],
    );
  },
);
test("credential cleanup failure preserves application data and registration for an explicit retry", async () => {
  const db = openTestDb();
  const native = scriptedConnectorsApi(() => Promise.resolve(db), tenant);
  await native.configure({
    ...tenant,
    id: "00000000-0000-7000-8000-000000001504",
    kind: "github",
    clientId: "Iv23.fixture",
    tenant: "common",
    services: ["github"],
  });
  native.prepareDelete = () => Promise.reject(new Error("Recorded native cleanup failure"));
  await expect(
    (async () => {
      await prepareAccountDeletion(db, tenant, true, native, undefined);
      await deleteAllData(db, tenant, memoryFilesApi());
    })(),
  ).rejects.toThrow("cleanup failure");
  expect(await listConnectorRegistrations(db, tenant)).toHaveLength(1);
});
