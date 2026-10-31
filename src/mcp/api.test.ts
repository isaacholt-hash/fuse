// M9 step 8: a server's command line, split without a shell.
import { joinCommand, splitCommand } from "./api";

test("plain words, double and single quotes; nothing else is special", () => {
  expect(splitCommand("npx -y @modelcontextprotocol/server-memory")).toEqual({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  });
  expect(splitCommand(`node "C:\\My Tools\\server.js" --name 'a b' $HOME;rm`)).toEqual({
    command: "node",
    args: ["C:\\My Tools\\server.js", "--name", "a b", "$HOME;rm"],
  });
  expect(splitCommand('python -c ""')).toEqual({ command: "python", args: ["-c", ""] });
  expect(splitCommand("  ")).toEqual({ error: "Give the command that starts the server." });
  expect(splitCommand('node "unclosed')).toEqual({ error: "A quote isn't closed." });
});

test("shown again with quotes where they're needed", () => {
  expect(joinCommand("node", ["C:\\My Tools\\s.js", "-v"])).toBe('node "C:\\My Tools\\s.js" -v');
});
