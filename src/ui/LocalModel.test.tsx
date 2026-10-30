import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LocalModelSection, type LocalModelView } from "./LocalModel";

afterEach(cleanup);

const base: LocalModelView = {
  computer: "15.9 GB memory (12.7 GB free) · 8 CPUs · AVX2 · 311.1 GB free disk",
  reason: "Qwen3 4B (local) fits.",
  warning: null,
  profile: {
    name: "Qwen3 4B (local)",
    file: "Qwen3-4B-Q4_K_M.gguf",
    detail: "Q4_K_M · 2.5 GB download · about 3.4 GB of memory",
    licence: "Apache-2.0",
    licenceUrl: "https://huggingface.co/x",
    sourceUrl: "https://huggingface.co/y",
  },
};

test("not installed: download and install", () => {
  const onInstall = vi.fn();
  render(
    <LocalModelSection
      view={{ ...base, install: { status: "missing", progress: null, error: null } }}
      onInstall={onInstall}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Download and install" }));
  expect(onInstall).toHaveBeenCalled();
});

test("downloading: progress and pause; a failure says why", () => {
  const onPause = vi.fn();
  render(
    <LocalModelSection
      view={{
        ...base,
        install: {
          status: "downloading",
          progress: { done: 1_250_000_000, total: 2_500_000_000 },
          error: null,
        },
      }}
      onPause={onPause}
    />,
  );
  expect(screen.getByText(/Downloading 50% \(1\.25 of 2\.50 GB\)/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(onPause).toHaveBeenCalled();
  cleanup();
  render(
    <LocalModelSection
      view={{
        ...base,
        install: { status: "missing", progress: null, error: "The download was interrupted." },
      }}
    />,
  );
  expect(screen.getByText("The download was interrupted.")).toBeTruthy();
});

test("installed: remove it; an outdated one offers an update; other files can go", () => {
  const onRemove = vi.fn();
  render(
    <LocalModelSection
      view={{
        ...base,
        install: { status: "installed", progress: null, error: null },
        others: [{ file: "Qwen3-1.7B-Q8_0.gguf", label: "Qwen3 1.7B (local) (1.8 GB)" }],
      }}
      onRemove={onRemove}
    />,
  );
  const removes = screen.getAllByRole("button", { name: "Remove" });
  fireEvent.click(removes[0] as HTMLElement);
  fireEvent.click(removes[1] as HTMLElement);
  expect(onRemove.mock.calls).toEqual([["Qwen3-4B-Q4_K_M.gguf"], ["Qwen3-1.7B-Q8_0.gguf"]]);
  cleanup();
  render(
    <LocalModelSection
      view={{ ...base, install: { status: "update", progress: null, error: null } }}
      onInstall={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
});

test("no AVX2: the reason, and nothing to install", () => {
  render(
    <LocalModelSection
      view={{ ...base, reason: "This computer's processor lacks AVX2.", profile: null }}
    />,
  );
  expect(screen.getByText(/lacks AVX2/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download and install" })).toBeNull();
});
