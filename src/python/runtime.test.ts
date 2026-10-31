// M9 step 5: the Python runtime's pins (data/python.json and its locks).
import raw from "../../data/python.json";
import { pinnedIn, pythonPin, thisPlatform, type PythonPlatform } from "./runtime";

const PLATFORMS: PythonPlatform[] = ["linux-x86_64", "windows-x86_64"];

test("each platform's build is pinned to the release, with a size and a SHA-256", () => {
  for (const platform of PLATFORMS) {
    const pin = pythonPin(platform);
    expect(pin?.python).toBe("3.13.16");
    // The rule src-tauri/src/python_runtime.rs check_url applies.
    expect(
      pin?.url.startsWith(
        `https://github.com/astral-sh/python-build-standalone/releases/download/${raw.release}/cpython-${raw.python}`,
      ),
    ).toBe(true);
    expect(pin?.url.endsWith("-install_only.tar.gz")).toBe(true);
    expect(pin?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin?.sizeBytes).toBeGreaterThan(10_000_000);
  }
  expect(raw.release).toMatch(/^\d{8}$/);
});

test("every library in each lock is pinned with hashes, and matches data/python.json", () => {
  for (const platform of PLATFORMS) {
    const pin = pythonPin(platform);
    const lock = pin?.lock ?? "";
    const blocks = lock.split("\n").filter((l) => /^[A-Za-z0-9]/.test(l));
    expect(blocks.length).toBe(pin?.packages.length);
    // Each requirement line is followed by its --hash lines.
    const lines = lock.split("\n");
    for (const [i, line] of lines.entries()) {
      if (!/^[A-Za-z0-9]/.test(line)) continue;
      expect(line).toMatch(/^[a-z0-9.-]+==[0-9][\w.]*\s+\\$/);
      expect(lines[i + 1]).toMatch(/^\s+--hash=sha256:[0-9a-f]{64}/);
    }
    for (const pv of pin?.packages ?? []) {
      const [name, version] = pv.split("==");
      const lib = (raw.libraries as Record<string, { version: string }>)[name ?? ""];
      expect(lib?.version, pv).toBe(version);
    }
    expect(pin?.packages).toEqual(expect.arrayContaining(["pandas==3.0.6", "matplotlib==3.11.2"]));
  }
  // tzdata only on Windows, where there's no system time zone database.
  expect(pinnedIn(pythonPin("linux-x86_64")?.lock ?? "")).not.toContain("tzdata==2026.5");
  expect(pinnedIn(pythonPin("windows-x86_64")?.lock ?? "")).toContain("tzdata==2026.5");
});

test("Windows and Linux on x86-64 get a build; others don't", () => {
  expect(thisPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows-x86_64");
  expect(thisPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux-x86_64");
  expect(thisPlatform("Mozilla/5.0 (X11; Linux aarch64)")).toBeNull();
  expect(thisPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBeNull();
  expect(pythonPin(null)).toBeNull();
});
