import { SseParser } from "./sse";

const all = (chunks: string[]) => {
  const p = new SseParser();
  return chunks.flatMap((c) => p.push(c));
};

test("parses named events with JSON data", () => {
  expect(all(['event: ping\ndata: {"type":"ping"}\n\n'])).toEqual([
    { event: "ping", data: '{"type":"ping"}' },
  ]);
});

test("defaults the event name and joins multi-line data", () => {
  expect(all(["data: a\ndata: b\n\n"])).toEqual([{ event: "message", data: "a\nb" }]);
});

test("ignores comments and blank keep-alives", () => {
  expect(all([": hello\n\n", "\n", "data: x\n\n"])).toEqual([{ event: "message", data: "x" }]);
});

test("handles CRLF, including a CRLF split across chunks", () => {
  expect(all(["data: x\r", "\n\r\n"])).toEqual([{ event: "message", data: "x" }]);
  expect(all(["data: y\r\n\r\n"])).toEqual([{ event: "message", data: "y" }]);
});

test("same result whatever the chunk boundaries", () => {
  const text = "event: a\ndata: 1\n\nevent: b\ndata: 2\n\n: c\ndata: 3\n\n";
  const whole = all([text]);
  for (let size = 1; size < 12; size++) {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    expect(all(chunks)).toEqual(whole);
  }
  expect(whole.map((e) => e.data)).toEqual(["1", "2", "3"]);
});

test("an unterminated final event is not dispatched", () => {
  expect(all(["data: complete\n\ndata: cut-off"])).toEqual([
    { event: "message", data: "complete" },
  ]);
});
