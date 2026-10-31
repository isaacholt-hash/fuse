// M9 step 8 part 2: a server's check shows it running with its tools, or why it isn't.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { McpServersSection, type McpServerView } from "./McpServers";

afterEach(cleanup);

const server: McpServerView = {
  id: "s1",
  name: "Memory",
  detail: "Local: npx -y memory",
  local: true,
  network: false,
  variables: [],
};

const show = (s: McpServerView, onCheck = vi.fn()) => {
  render(
    <McpServersSection
      servers={[s]}
      onAdd={() => Promise.resolve(null)}
      onRemove={() => undefined}
      onNetwork={() => undefined}
      onCheck={onCheck}
    />,
  );
  return onCheck;
};

test("Check starts it; running shows its tools by kind; an error says why", () => {
  const onCheck = show(server);
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  expect(onCheck).toHaveBeenCalledWith("s1");
  cleanup();

  show({ ...server, health: "checking" });
  expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
  cleanup();

  show({
    ...server,
    health: {
      server: "memory 1.2",
      tools: [
        { name: "read_graph", kind: "Reads", description: "Reads the graph" },
        { name: "delete_entities", kind: "Writes", description: "Deletes" },
      ],
    },
  });
  const tools = screen.getByLabelText("Memory tools");
  expect(tools).toHaveTextContent("Running: memory 1.2 · 2 tools");
  expect(tools).toHaveTextContent("read_graph Reads");
  expect(tools).toHaveTextContent("delete_entities Writes");
  cleanup();

  show({ ...server, health: { error: "Couldn't start the server: No such file" } });
  expect(screen.getByRole("alert")).toHaveTextContent("No such file");
});
