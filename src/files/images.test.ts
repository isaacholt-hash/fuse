// @vitest-environment node
import { fitWithin, imageTokens, isImageType } from "./images";

test("images are shrunk to a 2000 px long edge, never enlarged", () => {
  expect(fitWithin(3000, 2000)).toEqual({ width: 2000, height: 1333 });
  expect(fitWithin(1200, 4000)).toEqual({ width: 600, height: 2000 });
  expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
});

test("Anthropic token estimate: ⌈w/28⌉ × ⌈h/28⌉, capped for 5.x models", () => {
  expect(imageTokens("anthropic", 1024, 1024)).toBe(37 * 37);
  expect(imageTokens("anthropic", 2000, 1333)).toBe(72 * 48);
  expect(imageTokens("anthropic", 8000, 8000)).toBe(4784);
});

test("OpenAI token estimate: 32 px patches × 1.2, capped at 2,500 patches (detail high)", () => {
  expect(imageTokens("openai", 1024, 1024)).toBe(1229); // the docs' worked example
  expect(imageTokens("openai", 2048, 2048)).toBe(3000); // capped: 2,500 × 1.2
});

test("only the four image types both providers accept", () => {
  for (const t of ["image/png", "image/jpeg", "image/webp", "image/gif"])
    expect(isImageType(t)).toBe(true);
  for (const t of ["image/svg+xml", "image/heic", "application/pdf"])
    expect(isImageType(t)).toBe(false);
});
