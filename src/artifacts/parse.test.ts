// @vitest-environment node
import { artifactsIn, splitAnswer } from "./parse";

test("splits chat text from artifacts, in order, with their attributes", () => {
  const parts = splitAnswer(
    'Here is the plan.\n<artifact id="trip-plan" type="markdown" title="Lisbon trip">\n# Day 1\nTram 28\n</artifact>\nAnd a script:\n<artifact id="fetch" type="code" language="py" title="fetch.py">print(1)</artifact>',
  );
  expect(parts.map((p) => p.kind)).toEqual(["text", "artifact", "text", "artifact"]);
  expect(parts[1]).toEqual({
    kind: "artifact",
    artifact: {
      key: "trip-plan",
      title: "Lisbon trip",
      type: "markdown",
      language: "",
      content: "# Day 1\nTram 28",
      complete: true,
    },
  });
  expect(parts[3]).toMatchObject({
    artifact: { type: "code", language: "py", content: "print(1)" },
  });
});

test("a half-streamed artifact is incomplete; artifactsIn only returns finished ones", () => {
  const text =
    'Writing it now.\n<artifact id="a" type="markdown" title="Report">\n# Heading\nFirst para';
  const parts = splitAnswer(text);
  expect(parts[1]).toMatchObject({
    artifact: { complete: false, content: "# Heading\nFirst para" },
  });
  expect(artifactsIn(text)).toEqual([]);
});

test("missing or odd attributes get sensible defaults; plain answers are one text part", () => {
  expect(artifactsIn('<artifact title="My Notes!">x</artifact>')[0]).toMatchObject({
    key: "my-notes",
    type: "markdown",
    title: "My Notes!",
  });
  expect(artifactsIn('<artifact type="exe">x</artifact>')[0]).toMatchObject({
    type: "markdown",
    key: "untitled",
  });
  expect(splitAnswer("Just text.")).toEqual([{ kind: "text", text: "Just text." }]);
});
