// M10 step 14: the home screen.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Home, type HomeView } from "./Home";

afterEach(cleanup);

const empty = { heading: "What are you working on?" };
const nothing: HomeView = { waiting: [], going: [], scheduled: [], today: null };

test("nothing happening: just the area's greeting", () => {
  render(<Home area="chat" view={nothing} empty={empty} modelName="Auto" onOpen={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "What are you working on?" })).toBeInTheDocument();
  expect(screen.queryByLabelText("What's happening")).toBeNull();
});

test("each section when it has something, a row opens its chat, and the Code area leads with runs", () => {
  const onOpen = vi.fn();
  const view: HomeView = {
    waiting: [
      {
        id: "a",
        threadId: "t1",
        title: "Deploy the docs",
        detail: "Run git push",
        activeSince: null,
        spentMicro: 10_000,
        place: "hulk",
      },
    ],
    going: [
      {
        id: "b",
        threadId: null,
        title: "Fix the build",
        detail: "Fix it",
        activeSince: Date.now() - 180_000,
        spentMicro: 5_000,
        place: "local",
      },
    ],
    scheduled: [{ id: "s", name: "Nightly", when: "Today 18:00", where: "HULK", threadId: null }],
    today: { spentMicro: 250_000, budgetMicro: 1_000_000 },
  };
  const { rerender } = render(
    <Home area="code" view={view} empty={empty} modelName="Auto" onOpen={onOpen} />,
  );
  const sections = within(screen.getByLabelText("What's happening"))
    .getAllByRole("region")
    .map((r) => r.getAttribute("aria-label"));
  expect(sections).toEqual(["Waiting for you", "Going", "Next scheduled", "Today"]);
  fireEvent.click(screen.getByRole("button", { name: "Open Deploy the docs" }));
  expect(onOpen).toHaveBeenCalledWith("t1");
  // A run whose chat can't be opened here has no button.
  expect(screen.queryByRole("button", { name: "Open Fix the build" })).toBeNull();
  expect(screen.getByText("3 min")).toBeInTheDocument();
  expect(screen.getByText(/of a \$1\.00 day cap/)).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "$0.25 of $1.00" })).toBeInTheDocument();
  // M10 step 25: the pace sentence (CO-02).
  expect(screen.queryByText(/At this pace/)).toBeNull();
  rerender(
    <Home
      area="code"
      view={{
        ...view,
        month: { spentMicro: 3_000_000, projectedMicro: 38_000_000, budgetMicro: 60_000_000 },
      }}
      empty={empty}
      modelName="Auto"
      onOpen={onOpen}
    />,
  );
  expect(
    screen.getByText("At this pace: about $38.00 by month end, budget $60.00."),
  ).toBeInTheDocument();
  rerender(<Home area="chat" view={view} empty={empty} modelName="Auto" onOpen={onOpen} />);
  expect(
    within(screen.getByLabelText("What's happening"))
      .getAllByRole("region")
      .map((r) => r.getAttribute("aria-label"))[0],
  ).toBe("Today");
});
