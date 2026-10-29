// @vitest-environment node
import { reactPage } from "./preview";

test("a React component becomes a page: compiled, run against the bundled React, mounted in #root", async () => {
  const page = await reactPage(
    'import { useState } from "react";\nexport default function App(): JSX.Element { const [s] = useState("</script>"); return <p>{s}</p>; }',
  );
  expect(page).toMatch(/^<!doctype html>/);
  expect(page).toContain('<div id="root"></div>');
  expect(page).toMatch(/require\(["']react["']\)/);
  expect(page).toContain('require("react/jsx-runtime")');
  // Types are stripped, and a closing script tag in the code can't end the script early.
  expect(page).not.toContain("JSX.Element");
  expect(page.match(/<\/script>/g)).toHaveLength(2);
});
