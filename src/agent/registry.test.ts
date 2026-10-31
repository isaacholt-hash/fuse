// M9 step 1: one registry of tools, with kinds.
import { kindOf, placesLabel, toolEntry, toolsIn, TOOLS } from "./registry";

const names = (place: "code" | "work", opts?: Parameters<typeof toolsIn>[1]) =>
  toolsIn(place, opts).map((t) => t.name);

test("runs are offered the same tools, in the same order, as before the registry (plus fetch_url)", () => {
  expect(names("code")).toEqual([
    "list_files",
    "read_file",
    "search_files",
    "git_status",
    "git_diff",
    "git_log",
    "fetch_url",
    "edit_file",
    "write_file",
    "delete_file",
    "move_file",
    "run_command",
    "git_branch",
    "git_commit",
    "git_push",
    "open_pull_request",
  ]);
  expect(names("code", { readOnly: true })).toEqual([
    "list_files",
    "read_file",
    "search_files",
    "git_status",
    "git_diff",
    "git_log",
    "fetch_url",
  ]);
  expect(names("work")).toEqual([
    "list_files",
    "read_file",
    "search_files",
    "read_document",
    "fetch_url",
    "edit_file",
    "write_file",
    "delete_file",
    "move_file",
    "write_document",
    "organise",
    "run_command",
  ]);
  expect(names("work", { readOnly: true })).toEqual([
    "list_files",
    "read_file",
    "search_files",
    "read_document",
    "fetch_url",
  ]);
});

test("each tool has one entry and a kind; pushes and pull requests are sends", () => {
  expect(new Set(TOOLS.map((t) => t.spec.name)).size).toBe(TOOLS.length);
  expect(kindOf("read_file")).toBe("read");
  expect(kindOf("git_log")).toBe("read");
  expect(kindOf("write_document")).toBe("write");
  expect(kindOf("organise")).toBe("write");
  expect(kindOf("git_commit")).toBe("write");
  expect(kindOf("run_command")).toBe("command");
  expect(kindOf("fetch_url")).toBe("read");
  expect(toolEntry("fetch_url")?.places).toEqual(["code", "work", "chat"]);
  expect(kindOf("git_push")).toBe("send");
  expect(kindOf("open_pull_request")).toBe("send");
  expect(kindOf("no_such_tool")).toBeUndefined();
  expect(toolEntry("git_push")?.places).toEqual(["code"]);
  expect(placesLabel(["code", "work"])).toBe("Code and Work");
  expect(placesLabel(["code", "work", "chat"])).toBe("Code, Work and Chat");
  expect(placesLabel(["work"])).toBe("Work");
});

test("a project can switch tools off, but not the ones a run needs to find its way", () => {
  const off = new Set(["run_command", "write_document", "list_files", "read_file"]);
  const work = names("work", { off });
  expect(work).not.toContain("run_command");
  expect(work).not.toContain("write_document");
  expect(work).toContain("list_files");
  expect(work).toContain("read_file");
});
