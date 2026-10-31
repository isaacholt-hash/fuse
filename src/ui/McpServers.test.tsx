// M9 step 8: Settings → MCP servers.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpServersSection, type McpServerDraft } from "./McpServers";

afterEach(cleanup);

test("a server is added with a command and a variable; a problem is shown; network and Remove", async () => {
  const added: McpServerDraft[] = [];
  const calls: string[] = [];
  let answer: string | null = "Give the command that starts it.";
  render(
    <McpServersSection
      servers={[
        {
          id: "s1",
          name: "GitHub",
          detail: "Local: npx -y github-mcp",
          local: true,
          network: false,
          variables: [{ name: "GITHUB_TOKEN", set: true }],
        },
      ]}
      onAdd={(d) => {
        added.push(d);
        return Promise.resolve(answer);
      }}
      onRemove={(id) => calls.push(`remove ${id}`)}
      onNetwork={(id, on) => calls.push(`network ${id} ${String(on)}`)}
    />,
  );
  expect(screen.getByText("Variables: GITHUB_TOKEN (set)")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /Let it use the network/ }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(calls).toEqual(["network s1 true", "remove s1"]);

  fireEvent.click(screen.getByRole("button", { name: "Add a server" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Memory" } });
  fireEvent.click(screen.getByRole("button", { name: "Add server" }));
  expect(await screen.findByText("Give the command that starts it.")).toBeInTheDocument();

  answer = null;
  fireEvent.change(screen.getByLabelText("Command"), {
    target: { value: "npx -y @modelcontextprotocol/server-memory" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
  fireEvent.change(screen.getByLabelText("Variable 1 name"), { target: { value: "API_TOKEN" } });
  const value = screen.getByLabelText("Variable 1 value");
  expect(value).toHaveAttribute("type", "password");
  fireEvent.change(value, { target: { value: "tok" } });
  fireEvent.click(screen.getByRole("button", { name: "Add server" }));
  await waitFor(() => {
    expect(screen.queryByRole("form", { name: "Add an MCP server" })).toBeNull();
  });
  expect(added.at(-1)).toEqual({
    name: "Memory",
    transport: "stdio",
    commandLine: "npx -y @modelcontextprotocol/server-memory",
    url: "",
    variables: [{ name: "API_TOKEN", value: "tok" }],
    network: false,
  });
});
