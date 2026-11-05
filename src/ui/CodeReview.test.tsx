import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CodeReviewSetup } from "./CodeReview";
afterEach(cleanup);
function show(over: Partial<Parameters<typeof CodeReviewSetup>[0]> = {}) {
  const props = {
    draft: "Preserve my draft",
    folders: [{ id: "folder", name: "Recorded repo" }],
    accounts: [{ id: "account", name: "Recorded GitHub" }],
    projectName: "Recorded project",
    web: false,
    capMicroUsd: 1_000_000,
    modelSummary: "Best plans and concludes; Balanced reviews.",
    reason: null,
    busy: false,
    error: null,
    onCancel: vi.fn(),
    onStart: vi.fn(),
    ...over,
  };
  render(<CodeReviewSetup {...props} />);
  return props;
}
test("opening setup never starts; explicit read-only start carries the scope and cap", () => {
  const p = show();
  expect(p.onStart).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Review focus")).toHaveValue("Preserve my draft");
  fireEvent.click(screen.getByRole("button", { name: "Start read-only review" }));
  expect(p.onStart).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "changes",
      folderId: "folder",
      task: "Preserve my draft",
      capMicroUsd: 1_000_000,
    }),
  );
});
test("branch review requires explicit revisions and a valid cap", () => {
  const p = show();
  fireEvent.change(screen.getByLabelText("Review source"), { target: { value: "branch" } });
  expect(screen.getByRole("button", { name: "Start read-only review" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Review base"), { target: { value: "main" } });
  fireEvent.change(screen.getByLabelText("Review spending cap"), { target: { value: "0" } });
  expect(screen.getByRole("button", { name: "Start read-only review" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Review spending cap"), { target: { value: "0.5" } });
  fireEvent.click(screen.getByRole("button", { name: "Start read-only review" }));
  expect(p.onStart).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "branch",
      baseRef: "main",
      headRef: "HEAD",
      capMicroUsd: 500000,
    }),
  );
});
test("GitHub works without a folder; unavailable project accounts stay explained", () => {
  const p = show({ folders: [], web: true });
  expect(screen.getByLabelText("Review source")).toHaveValue("github");
  fireEvent.change(screen.getByLabelText("Review pull request URL"), {
    target: { value: "https://github.com/recorded/repo/pull/5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start read-only review" }));
  expect(p.onStart).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "github", serverId: "account" }),
  );
});
test("cancel, blocked models and busy setup never dispatch a review", () => {
  const p = show({ reason: "The provider is not permitted." });
  expect(screen.getByRole("alert")).toHaveTextContent("not permitted");
  expect(screen.getByRole("button", { name: "Start read-only review" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(p.onCancel).toHaveBeenCalledOnce();
  expect(p.onStart).not.toHaveBeenCalled();
});
