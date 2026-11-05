import { fireEvent, render, screen } from "@testing-library/react";
import { parseResearchCap, formatResearchCap } from "@/research/cap";
import { ResearchSetup, ContinueResearch } from "./Research";
import { defaultCatalog } from "@/catalog/defaultCatalog";
import { defaultPolicy } from "@/routing/defaultPolicy";
import { researchModels } from "@/research/routing";
const models = researchModels(defaultCatalog, defaultPolicy, { kind: "auto" }, "Tides", [
  "openai",
  "anthropic",
]);
test("research setup requires an empty cap to be filled and starts only through the explicit action", () => {
  const onStart = vi.fn(),
    onCancel = vi.fn();
  render(
    <ResearchSetup
      initialScope="Compare tides"
      initialLocation="hulk"
      locations={{ hulk: null, desktop: null }}
      context={[{ kind: "memoryIds", id: "m", label: "Memory: chosen fact" }]}
      preview={() => models}
      busy={false}
      error={null}
      onStart={onStart}
      onCancel={onCancel}
    />,
  );
  expect(screen.getByLabelText("Research spending cap (USD)")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Start research" })).toBeDisabled();
  expect(screen.getByLabelText("Memory: chosen fact")).not.toBeChecked();
  expect(screen.getByText(/Base planning reservation/)).toHaveTextContent(
    "before selected context",
  );
  expect(onStart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText("Memory: chosen fact"));
  fireEvent.change(screen.getByLabelText("Research spending cap (USD)"), {
    target: { value: "2.50" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start research" }));
  expect(onStart).toHaveBeenCalledWith({
    task: "Compare tides",
    location: "hulk",
    capMicroUsd: 2_500_000,
    selection: { memoryIds: ["m"], artifactIds: [], messageIds: [], instructions: [] },
  });
});
test("browser local execution and unavailable research models explain why setup cannot start", () => {
  render(
    <ResearchSetup
      initialScope="Tides"
      initialLocation="hulk"
      locations={{ hulk: null, desktop: "Browsers cannot run research on this computer." }}
      context={[]}
      preview={() => {
        throw new Error("Choose a model with a conservative search cost bound.");
      }}
      busy={false}
      error={null}
      onCancel={vi.fn()}
      onStart={vi.fn()}
    />,
  );
  expect(screen.getByRole("radio", { name: /This computer/ })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("conservative");
  fireEvent.change(screen.getByLabelText("Research spending cap (USD)"), {
    target: { value: "3" },
  });
  expect(screen.getByRole("button", { name: "Start research" })).toBeDisabled();
});
test("continuation uses an explicit total cap without adding a default increment", () => {
  const onContinue = vi.fn();
  render(
    <ContinueResearch
      capMicroUsd={2_000_000}
      error={null}
      busy={false}
      onCancel={vi.fn()}
      onContinue={onContinue}
    />,
  );
  expect(onContinue).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Continue research total cap (USD)"), {
    target: { value: "1" },
  });
  expect(screen.getByRole("button", { name: "Continue research" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Continue research total cap (USD)"), {
    target: { value: "2.10" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue research" }));
  expect(onContinue).toHaveBeenCalledWith(2_100_000);
});
test("caps preserve integer micro-dollars and reject empty, fractional-micro and excessive values", () => {
  expect(parseResearchCap("0.000001")).toBe(1);
  expect(parseResearchCap("9007199254.740991")).toBe(Number.MAX_SAFE_INTEGER);
  expect(formatResearchCap(Number.MAX_SAFE_INTEGER)).toBe("9007199254.740991");
  expect(parseResearchCap(formatResearchCap(Number.MAX_SAFE_INTEGER))).toBe(
    Number.MAX_SAFE_INTEGER,
  );
  for (const value of ["", "0", "0.0000001", "9007199254.740992", "1e4", "9".repeat(10000)])
    expect(parseResearchCap(value)).toBeNull();
});
