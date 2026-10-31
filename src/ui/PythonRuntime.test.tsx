// M9 step 5: Settings → Python for data work.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PythonRuntimeSection, type PythonRuntimeView } from "./PythonRuntime";

afterEach(cleanup);

const offer = { python: "3.13.16", downloadMb: 76, libraries: ["pandas", "numpy"] };

function show(view: PythonRuntimeView) {
  const calls: string[] = [];
  render(
    <PythonRuntimeSection
      view={view}
      onInstall={() => calls.push("install")}
      onStop={() => calls.push("stop")}
      onRemove={() => calls.push("remove")}
    />,
  );
  return calls;
}

test("not installed: what it is, how big, and Install", () => {
  const calls = show({ offer, installed: null, job: null, error: null });
  expect(screen.getByText("Python 3.13.16")).toBeInTheDocument();
  expect(screen.getByText(/With pandas, numpy\. A 76 MB download/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  expect(calls).toEqual(["install"]);
});

test("installing: the step and progress, and Stop", () => {
  const calls = show({
    offer,
    installed: null,
    job: { step: "downloading", percent: 42 },
    error: null,
  });
  expect(screen.getByRole("status")).toHaveTextContent("Downloading Python · 42%");
  expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(calls).toEqual(["stop"]);
});

test("installed: version, libraries and size, and Remove; a failure says why", () => {
  const calls = show({
    offer,
    installed: { python: "3.13.16", sizeMb: 412, libraries: 14 },
    job: null,
    error: "Couldn't install the data libraries: no network.",
  });
  expect(screen.getByText("Python 3.13.16 is installed")).toBeInTheDocument();
  expect(screen.getByText("14 libraries · 412 MB on disk")).toBeInTheDocument();
  expect(screen.getByText(/no network/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(calls).toEqual(["remove"]);
});

test("a computer FUSE has no build for says so", () => {
  show({ offer: null, installed: null, job: null, error: null });
  expect(screen.getByText(/no Python build for this computer/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
});
