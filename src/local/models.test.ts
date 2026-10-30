// @vitest-environment node
import raw from "../../data/local-models.json";
import { localCatalogModel, localModels, parseLocalModels } from "./models";

test("the shipped profiles: pinned, checksummed, Apache-2.0, largest first", () => {
  expect(localModels.profiles.map((p) => p.id)).toEqual(["qwen3-4b", "qwen3-1.7b"]);
  for (const p of localModels.profiles) {
    expect(p.url).toContain(`/resolve/${p.revision}/${p.file}`);
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.licence).toBe("Apache-2.0");
    expect(p.peakMemoryBytes).toBeGreaterThan(p.sizeBytes);
  }
});

test("a local catalog model costs nothing and is provider local", () => {
  const p = localModels.profiles[1];
  if (!p) throw new Error("missing profile");
  const m = localCatalogModel(p, localModels.verifiedOn);
  expect(m).toMatchObject({ provider: "local", id: "qwen3-1.7b", price: { input: 0, output: 0 } });
});

test("bad entries are refused with where and why", () => {
  const first = (change: Record<string, unknown>) => ({
    ...raw,
    profiles: [{ ...raw.profiles[0], ...change }],
  });
  expect(() => parseLocalModels(first({ sha256: "abc" }))).toThrow(/sha256/);
  expect(() => parseLocalModels(first({ url: "https://example.com/x.gguf" }))).toThrow(/url/);
  expect(() =>
    parseLocalModels(
      first({ url: raw.profiles[0]?.url.replace(/resolve\/[0-9a-f]+/, "resolve/main") }),
    ),
  ).toThrow(/pinned revision/);
  expect(() => parseLocalModels(first({ file: "../evil.gguf" }))).toThrow(/file/);
  expect(() => parseLocalModels(first({ peak_memory_bytes: 1 }))).toThrow(/peak_memory/);
  expect(() => parseLocalModels({ ...raw, profiles: [...raw.profiles].reverse() })).toThrow(
    /largest first/,
  );
});
