// AG-05: Settings → Cost cap per run, which can be turned off; MM-09: key caps turn off too.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KeyCapsSection, RunCapSection } from "./KeyCaps";

afterEach(cleanup);

test("the run cap is set, turned off and turned back on", () => {
  const onCap = vi.fn();
  const { rerender } = render(<RunCapSection capMicroUsd={1_000_000} onCap={onCap} />);
  const field = screen.getByLabelText<HTMLInputElement>("Cost cap per run");
  expect(field.value).toBe("1.00");
  fireEvent.change(field, { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onCap).toHaveBeenLastCalledWith(5_000_000);
  fireEvent.click(screen.getByLabelText("Pause runs at a cost cap"));
  expect(onCap).toHaveBeenLastCalledWith(2 ** 52);
  rerender(<RunCapSection capMicroUsd={2 ** 52} onCap={onCap} />);
  expect(screen.getByText("Off: runs don't stop on cost.")).toBeTruthy();
  expect(field.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("Pause runs at a cost cap"));
  expect(onCap).toHaveBeenLastCalledWith(5_000_000);
});

test("a key's caps turn off in one click", () => {
  const onSave = vi.fn();
  render(
    <KeyCapsSection
      caps={[
        {
          provider: "openai",
          name: "OpenAI",
          daily: 2,
          monthly: null,
          spentToday: 0,
          spentMonth: 0,
          stopped: null,
          raised: false,
        },
      ]}
      onSave={onSave}
      onRaise={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Turn off OpenAI caps" }));
  expect(onSave).toHaveBeenCalledWith("openai", null, null);
  expect(screen.getByLabelText<HTMLInputElement>("OpenAI daily cap").value).toBe("");
});
