// M9 step 1: Project settings → Tools.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectToolsSection, type ProjectToolView } from "./ProjectTools";

const tools: ProjectToolView[] = [
  { name: "read_file", kind: "Reads", where: "Code and Work", on: true, core: true },
  { name: "write_file", kind: "Writes", where: "Code and Work", on: true, core: false },
  { name: "run_command", kind: "Runs commands", where: "Code and Work", on: false, core: false },
];

test("tools are listed by kind, each with a switch; core ones stay on", async () => {
  const switched: [string, boolean][] = [];
  render(
    <ProjectToolsSection
      tools={tools}
      onSwitch={(name, on) => {
        switched.push([name, on]);
      }}
    />,
  );
  expect(screen.getByRole("group", { name: "Reads" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Runs commands" })).toBeInTheDocument();
  const read = screen.getByRole("checkbox", { name: /read_file/ });
  expect(read).toBeChecked();
  expect(read).toBeDisabled();
  expect(screen.getByText("Code and Work · always on")).toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: /write_file/ }));
  await user.click(screen.getByRole("checkbox", { name: /run_command/ }));
  expect(switched).toEqual([
    ["write_file", false],
    ["run_command", true],
  ]);
});

test("M9 step 9: the project's MCP servers, each with a switch", async () => {
  const switched: [string, boolean][] = [];
  render(
    <ProjectToolsSection
      tools={tools}
      onSwitch={() => undefined}
      servers={[
        { id: "s1", name: "Notes", on: true },
        { id: "s2", name: "GitHub", on: false },
      ]}
      onServer={(id, on) => {
        switched.push([id, on]);
      }}
    />,
  );
  expect(screen.getByRole("group", { name: "MCP servers" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Notes" })).toBeChecked();
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "GitHub" }));
  expect(switched).toEqual([["s2", true]]);
});
