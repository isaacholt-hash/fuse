import { cleanup, render, screen } from "@testing-library/react";
import { Tooltip } from "radix-ui";
import { Messages } from "./Conversation";

afterEach(cleanup);

test("LL-01: an answer from a fixed rule says no model was asked, at $0", () => {
  render(
    <Tooltip.Provider>
      <Messages
        startedAt={0}
        onRetry={() => undefined}
        modelName="Auto"
        messages={[
          { id: "q", role: "user", content: "convert 5 km to miles", status: "complete" },
          {
            id: "a",
            role: "assistant",
            content: "5 km = 3.10685596119 mi",
            status: "complete",
            model: "No model",
            noModel: "Unit conversion",
          },
        ]}
      />
    </Tooltip.Provider>,
  );
  expect(screen.getByText("5 km = 3.10685596119 mi")).toBeTruthy();
  const badge = screen.getByRole("button", { name: "Answered without a model" });
  expect(badge.textContent).toBe("answered without a model·$0");
});
