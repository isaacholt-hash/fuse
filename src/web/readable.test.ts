import { readable } from "./readable";

test("keeps the article, drops scripts, menus and footers, marks headings and lists", () => {
  const html = `<!doctype html><html><head><title>Atlas service | VW</title>
    <script>alert("x")</script><style>p{}</style></head>
    <body><nav><a href="/">Home</a> <a href="/x">Menu</a></nav>
    <article><h1>Service intervals</h1><p>Change the   oil every
    10,000 miles.</p><ul><li>Filter</li><li>Plugs</li></ul>
    <pre>code  stays</pre></article>
    <footer>© VW</footer></body></html>`;
  const r = readable(html, "text/html; charset=utf-8", "https://www.vw.com/atlas");
  expect(r.title).toBe("Atlas service | VW");
  expect(r.text).toBe(
    "# Service intervals\n\nChange the oil every 10,000 miles.\n\n- Filter\n- Plugs\n\ncode  stays",
  );
  expect(r.text).not.toMatch(/alert|Menu|©/);
});

test("plain text stays as it is; a page without a title is named after its host", () => {
  expect(readable("Hello\nthere", "text/plain", "https://example.com/a.txt")).toEqual({
    title: "example.com",
    text: "Hello\nthere",
  });
  expect(readable("<p>Hi</p>", "text/html", "https://www.example.org/").title).toBe("example.org");
});
