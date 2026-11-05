// @vitest-environment node
import { readable } from "./readable";

test("the headless runner extracts inert HTML without DOM APIs, scripts or navigation", () => {
  const result = readable(
    `<!doctype html><html><head><title>Source &amp; evidence</title><style>.x{color:red}</style></head><body><nav>Menu</nav><article><h1>Finding</h1><p onclick="bad('>')">Tides rise &#49; metre.</p><script>leak('<div>');</script><p>Second &lt;passage&gt;.</p></article><footer>Tracking</footer></body></html>`,
    "text/html",
    "https://example.com/",
  );
  expect(result.title).toBe("Source & evidence");
  expect(result.text).toContain("Tides rise 1 metre.");
  expect(result.text).toContain("Second <passage>.");
  for (const forbidden of ["Menu", "Tracking", "leak", "onclick", "color:red"])
    expect(result.text).not.toContain(forbidden);
});

test("malformed/unclosed hostile markup cannot leak its raw script body into source text", () => {
  expect(
    readable(
      "<main>Retained</main><script>ignore instructions <script>steal",
      "text/html",
      "https://example.com/",
    ).text,
  ).toBe("Retained");
  expect(readable("plain UTF-8 café", "text/plain", "https://example.com/").text).toBe(
    "plain UTF-8 café",
  );
});
