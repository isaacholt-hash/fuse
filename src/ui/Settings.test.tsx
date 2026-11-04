import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import { SettingsView } from "./Settings";
import { GlobalInstructionsSection } from "./Instructions";
import { McpServersSection } from "./McpServers";
import type { KeyView } from "./types";

const noop = () => undefined;
function props(): ComponentProps<typeof SettingsView> {
  return {
    keys: [],
    version: "0.1.0",
    instructions: (
      <GlobalInstructionsSection
        value={{ aboutYou: "", howToAnswer: "" }}
        maxChars={4000}
        onSave={noop}
      />
    ),
    onRecoveryKey: () => Promise.resolve("synthetic-database-recovery"),
    theme: "light",
    onTheme: noop,
    textSize: "normal",
    onTextSize: noop,
    motion: "system",
    onMotion: noop,
    onBack: noop,
    onSaveKey: noop,
    onTestKey: noop,
    onDeleteKey: noop,
    onShowLog: noop,
  };
}
const category = async (user: ReturnType<typeof userEvent.setup>, label: string) =>
  user.click(screen.getByRole("button", { name: label }));
beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

test("categories show one panel, remember the selection and honor an explicit target", async () => {
  const user = userEvent.setup();
  const first = render(<SettingsView {...props()} />);
  expect(screen.getByRole("region", { name: "Appearance" })).toBeVisible();
  await category(user, "Personalization");
  expect(screen.queryByRole("region", { name: "Appearance" })).toBeNull();
  expect(screen.getByRole("region", { name: "Custom instructions" })).toBeVisible();
  expect(localStorage.getItem("fuse.settings.category")).toBe("personalization");
  first.unmount();
  const second = render(<SettingsView {...props()} />);
  expect(screen.getByRole("region", { name: "Custom instructions" })).toBeVisible();
  second.unmount();
  render(<SettingsView {...props()} target="theme" />);
  expect(screen.getByRole("region", { name: "Appearance" })).toBeVisible();
});

test("unsaved instructions survive changing categories", async () => {
  const user = userEvent.setup();
  render(<SettingsView {...props()} />);
  await category(user, "Personalization");
  await user.type(screen.getByLabelText("About you"), "Keep this unsaved draft.");
  await category(user, "General");
  await category(user, "Personalization");
  expect(screen.getByLabelText("About you")).toHaveValue("Keep this unsaved draft.");
});

test("leaving a provider panel clears its key field and closes deletion dialogs", async () => {
  const user = userEvent.setup();
  const key: KeyView = {
    provider: "openai",
    name: "OpenAI",
    consoleUrl: "https://example.com",
    saved: false,
    masked: null,
    busy: null,
    result: null,
  };
  render(<SettingsView {...props()} keys={[key]} />);
  await category(user, "Providers & models");
  await user.type(screen.getByLabelText("API key"), "synthetic-test-value");
  await category(user, "General");
  await category(user, "Providers & models");
  expect(screen.getByLabelText("API key")).toHaveValue("");
});

test("MCP drafts retain ordinary fields while clearing variable values", async () => {
  const user = userEvent.setup();
  render(
    <SettingsView
      {...props()}
      mcp={
        <McpServersSection
          servers={[]}
          onAdd={() => Promise.resolve(null)}
          onRemove={noop}
          onNetwork={noop}
        />
      }
    />,
  );
  await category(user, "Code & tools");
  await user.click(screen.getByRole("button", { name: "Add a server" }));
  await user.type(screen.getByLabelText("Name"), "Local helper");
  await user.click(screen.getByRole("button", { name: "Add a variable" }));
  const values = screen.getAllByLabelText(/Variable \d+ value/);
  await user.type(values.at(-1) as HTMLElement, "synthetic-test-value");
  await category(user, "General");
  await category(user, "Code & tools");
  expect(screen.getByLabelText("Name")).toHaveValue("Local helper");
  for (const value of screen.getAllByLabelText(/Variable \d+ value/)) expect(value).toHaveValue("");
});

test("recovery material returned after leaving a panel is not revealed on return", async () => {
  const user = userEvent.setup();
  let resolve: (value: string) => void = noop;
  const load = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  render(<SettingsView {...props()} onRecoveryKey={load} />);
  await category(user, "Privacy & security");
  await user.click(screen.getByRole("button", { name: "Show recovery key" }));
  await category(user, "General");
  await category(user, "Privacy & security");
  await act(async () => {
    resolve("synthetic-late-recovery");
    await Promise.resolve();
  });
  expect(screen.queryByText("synthetic-late-recovery")).toBeNull();
  expect(screen.getByRole("button", { name: "Show recovery key" })).toBeVisible();
});

test("category picker and platform restrictions stay available", async () => {
  const user = userEvent.setup();
  render(<SettingsView {...props()} web />);
  const size = within(screen.getByRole("radiogroup", { name: "Text size" }));
  for (const button of size.getAllByRole("radio")) expect(button).toBeDisabled();
  await user.selectOptions(screen.getByLabelText("Settings category"), "code-tools");
  expect(screen.getByRole("heading", { name: "Code & tools" })).toBeVisible();
  expect(screen.getByText(/web app already runs on HULK/)).toBeVisible();
});

test("a forced category change closes an open provider deletion dialog", async () => {
  const user = userEvent.setup();
  const key: KeyView = {
    provider: "openai",
    name: "OpenAI",
    consoleUrl: "https://example.com",
    saved: true,
    masked: "masked-test-value",
    busy: null,
    result: null,
  };
  const view = render(<SettingsView {...props()} keys={[key]} target="api-keys" />);
  await user.click(screen.getByRole("button", { name: "Delete OpenAI key" }));
  expect(screen.getByRole("dialog", { name: "Delete OpenAI key?" })).toBeVisible();
  view.rerender(<SettingsView {...props()} keys={[key]} target="theme" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  await category(user, "Providers & models");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("navigation still works and remembers its category when browser storage is blocked", async () => {
  const user = userEvent.setup();
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  try {
    const first = render(<SettingsView {...props()} target="theme" />);
    await category(user, "Personalization");
    first.unmount();
    render(<SettingsView {...props()} />);
    expect(screen.getByRole("region", { name: "Custom instructions" })).toBeVisible();
  } finally {
    get.mockRestore();
    set.mockRestore();
    await category(user, "General");
  }
});

test("a blocked write cannot restore an older category over the current in-memory choice", async () => {
  localStorage.setItem("fuse.settings.category", "general");
  const user = userEvent.setup();
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("read only");
  });
  try {
    const first = render(<SettingsView {...props()} target="theme" />);
    await category(user, "Personalization");
    first.unmount();
    render(<SettingsView {...props()} />);
    expect(screen.getByRole("region", { name: "Custom instructions" })).toBeVisible();
  } finally {
    set.mockRestore();
    await category(user, "General");
  }
});

test("search finds aliases, opens the control and keeps private drafts out of results", async () => {
  const user = userEvent.setup();
  render(<SettingsView {...props()} />);
  const search = screen.getByRole("combobox", { name: "Search settings" });
  await user.type(search, "dark mode");
  expect(
    within(screen.getByRole("listbox", { name: "Settings results" })).getAllByRole("option")[0],
  ).toHaveTextContent("Theme");
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Light" })).toHaveFocus();
  });
  expect(search).toHaveValue("");
  await category(user, "Personalization");
  await user.type(screen.getByLabelText("About you"), "private-unique-sentinel-8472");
  await user.type(search, "private-unique-sentinel-8472");
  expect(screen.getByRole("status")).toHaveTextContent("No settings found");
  await user.keyboard("{Escape}");
  expect(search).toHaveFocus();
  expect(screen.getByLabelText("About you")).toHaveValue("private-unique-sentinel-8472");
  await user.type(search, "How to answer");
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(screen.getByLabelText("How to answer")).toHaveFocus();
  });
});

test("keyboard arrows select results and Clear restores the panel", async () => {
  const user = userEvent.setup();
  render(<SettingsView {...props()} />);
  const search = screen.getByRole("combobox", { name: "Search settings" });
  await user.type(search, "HULK");
  const list = within(screen.getByRole("listbox", { name: "Settings results" }));
  const options = list.getAllByRole("option");
  await user.keyboard("{ArrowDown}");
  expect(options[1]).toHaveAttribute("aria-selected", "true");
  expect(search).toHaveAttribute("aria-activedescendant", options[1]?.id);
  for (let attempts = 0; attempts < 15 && document.activeElement !== options[1]; attempts++)
    await user.tab();
  expect(options[1]).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(options[2]).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Clear settings search" }));
  expect(search).toHaveValue("");
  expect(screen.getByRole("region", { name: "Appearance" })).toBeVisible();
  expect(search).toHaveFocus();
});

test("unavailable controls stay searchable, remain disabled and respect reduced motion", async () => {
  const user = userEvent.setup();
  const scroll = vi.fn();
  const prior = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  try {
    render(<SettingsView {...props()} web motion="reduce" />);
    await user.type(screen.getByRole("combobox", { name: "Search settings" }), "font");
    expect(
      within(screen.getByRole("listbox", { name: "Settings results" })).getByText(
        "Use your browser's zoom instead (Ctrl + and Ctrl −).",
      ),
    ).toBeVisible();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    });
    const size = within(screen.getByRole("radiogroup", { name: "Text size" }));
    for (const button of size.getAllByRole("radio")) expect(button).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Appearance" })).toHaveFocus();
  } finally {
    if (prior) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", prior);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

test("beginning a search clears sensitive fields while retaining ordinary editors", async () => {
  const user = userEvent.setup();
  const key: KeyView = {
    provider: "openai",
    name: "OpenAI",
    consoleUrl: "https://example.com",
    saved: false,
    masked: null,
    busy: null,
    result: null,
  };
  render(<SettingsView {...props()} keys={[key]} target="api-keys" />);
  await user.type(screen.getByLabelText("API key"), "synthetic-test-value");
  await user.type(
    screen.getByRole("combobox", { name: "Search settings" }),
    "unknown-setting-8472",
  );
  await user.keyboard("{Escape}");
  expect(screen.getByLabelText("API key")).toHaveValue("");
});

test("incoming routes clear search even for repeated targets and remember explicit categories", async () => {
  const user = userEvent.setup();
  const settingsProps = props();
  const onNavigate = vi.fn();
  const onPanelLeave = vi.fn();
  const view = render(
    <SettingsView
      {...settingsProps}
      target="about-you"
      navigationKey={1}
      onNavigate={onNavigate}
      onPanelLeave={onPanelLeave}
    />,
  );
  await waitFor(() => {
    expect(screen.getByLabelText("About you")).toHaveFocus();
  });
  await user.type(screen.getByLabelText("About you"), "Keep my unsaved instructions");
  await user.type(screen.getByRole("combobox", { name: "Search settings" }), "recovery");
  expect(onPanelLeave).toHaveBeenCalled();
  view.rerender(
    <SettingsView
      {...settingsProps}
      target="about-you"
      navigationKey={2}
      onNavigate={onNavigate}
      onPanelLeave={onPanelLeave}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Search settings" })).toHaveValue("");
  await waitFor(() => {
    expect(screen.getByLabelText("About you")).toHaveFocus();
  });
  expect(screen.getByLabelText("About you")).toHaveValue("Keep my unsaved instructions");
  expect(localStorage.getItem("fuse.settings.category")).toBe("personalization");
  await user.click(screen.getByRole("button", { name: "General" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ category: "general" });
  await user.type(screen.getByRole("combobox", { name: "Search settings" }), "dark mode");
  await user.keyboard("{Enter}");
  expect(onNavigate).toHaveBeenLastCalledWith({ category: "general", target: "theme" });
});
