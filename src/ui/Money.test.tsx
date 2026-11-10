import { render, screen } from "@testing-library/react";
import { Money } from "./primitives";

test("exact money keeps fractions of a cent on dollar amounts, so a small spend isn't rounded away", () => {
  render(
    <>
      <Money micro={4_997_800} exact />
      <Money micro={4_997_800} />
      <Money micro={5_000_000} exact />
    </>,
  );
  expect(screen.getByText("$4.9978")).toBeInTheDocument();
  expect(screen.getByText("$5.00", { selector: "span:nth-child(2)" })).toBeInTheDocument();
  expect(screen.getAllByText("$5.00")).toHaveLength(2);
});
