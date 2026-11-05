import { searchSources, searchUses, reportedSearchCount } from "./search";

test("bounded searches reject malformed and unbounded requests before transport", () => {
  for (const maxUses of [0, -1, 1.5, NaN, Infinity, 13])
    expect(() => searchUses({ webSearch: true, searchBounds: { maxUses } })).toThrow();
  expect(searchUses({ webSearch: true })).toBe(5);
  expect(searchUses({ webSearch: true, searchBounds: { maxUses: 12 } })).toBe(12);
  expect(searchUses({})).toBeNull();
  expect(() => searchUses({ searchBounds: { maxUses: 1 } })).toThrow();
});

test("source metadata excludes executable URLs, credentials, duplicates and excessive results", () => {
  const result = searchSources([
    null,
    { url: "javascript:alert(1)" },
    { url: "https://user:pass@example.com/" },
    { url: "https://example.com", title: "a".repeat(900) },
    { url: "https://example.com/" },
    ...Array.from({ length: 30 }, (_, i) => ({ url: `https://example.com/${String(i)}` })),
  ]);
  expect(result.truncated).toBe(true);
  expect(result.sources).toHaveLength(24);
  expect(result.sources[0]).toEqual({ url: "https://example.com/", title: "a".repeat(512) });
  expect(searchSources({ url: "https://example.com" }).sources).toEqual([]);
  expect(searchSources([{ url: "https://example.com/" + "a".repeat(4096) }]).sources).toEqual([]);
});

test("unknown and invalid tool usage is distinct from a reported zero", () => {
  for (const value of [null, undefined, NaN, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1])
    expect(reportedSearchCount(value)).toBeNull();
  expect(reportedSearchCount(0)).toBe(0);
  expect(reportedSearchCount(12)).toBe(12);
});
