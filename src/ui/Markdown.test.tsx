import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Markdown } from "./Markdown";
import { normaliseMath } from "./math";

test("\\( \\) and \\[ \\] become math; code is left alone", () => {
  expect(normaliseMath(String.raw`Area \(\pi r^2\) here`)).toBe(String.raw`Area $$\pi r^2$$ here`);
  expect(normaliseMath(String.raw`\[ E = mc^2 \]`)).toBe("\n$$\nE = mc^2\n$$\n");
  const code = "`\\(x\\)` and ```\n\\[y\\]\n```";
  expect(normaliseMath(code)).toBe(code);
});

test("math renders with KaTeX; single dollars stay money", () => {
  const { container } = render(
    <Markdown content={"Euler: $$e^{i\\pi} + 1 = 0$$\n\nIt costs $5 and $10."} />,
  );
  expect(container.querySelector(".katex")).not.toBeNull();
  expect(container).toHaveTextContent("It costs $5 and $10.");
});

test("a mermaid fence becomes a diagram block with its code a click away", async () => {
  render(<Markdown content={"```mermaid\ngraph TD; A-->B\n```"} />);
  expect(screen.getByLabelText("Mermaid diagram")).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("tab", { name: "Code" }));
  expect(screen.getByLabelText("Mermaid diagram")).toHaveTextContent("graph TD; A-->B");
});
