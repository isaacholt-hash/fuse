// @vitest-environment node
import { describeSecrets, redactLines, scanForSecrets } from "./fileSecrets";

test("lines with secrets are found; code and data that only look random aren't", () => {
  const text = [
    "host: example.com",
    "password: hunter2hunter2",
    "id: 9f3c2a7b1e0d4c5b8a6f2e1d0c9b8a7f6e5d4c3b",
    // Built in parts so the repo's secret scan doesn't flag this test.
    `api_key = ${["sk", "abcdefghijklmnopqrstuvwx"].join("-")}`,
    "const hash = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';",
  ].join("\n");
  const found = scanForSecrets(text);
  expect(found).toEqual({ lines: [2, 4], kinds: ["password", "api_key"] });
  expect(describeSecrets(found ?? { lines: [], kinds: [] })).toBe(
    "a password or PIN and an API key or token (2 lines)",
  );
  expect(redactLines(text, found ?? { lines: [], kinds: [] }).split("\n")).toEqual([
    "host: example.com",
    "[line removed by FUSE: it looked like a secret]",
    "id: 9f3c2a7b1e0d4c5b8a6f2e1d0c9b8a7f6e5d4c3b",
    "[line removed by FUSE: it looked like a secret]",
    "const hash = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';",
  ]);
  expect(scanForSecrets("just notes\nnothing here")).toBeNull();
});
