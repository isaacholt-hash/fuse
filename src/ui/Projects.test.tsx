import { cleanup, render, screen } from "@testing-library/react";
import { KnowledgeSection, type KnowledgeFileView } from "./Projects";

afterEach(cleanup);

const file = (over: Partial<KnowledgeFileView>): KnowledgeFileView => ({
  id: "f",
  name: "notes.md",
  tokens: 100,
  status: "Searchable by word",
  ready: true,
  wholeMicro: 10,
  maySend: true,
  ...over,
});

test("FK-07: a folder's document says it's in the folder instead of offering Remove", () => {
  render(
    <KnowledgeSection
      files={[file({ id: "a" }), file({ id: "b", name: "client/brief.md", folder: "client" })]}
      busy={false}
      error={null}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Remove notes.md" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove client/brief.md" })).toBeNull();
  expect(screen.getByTitle(/Kept in step with client/)).toBeTruthy();
});
