import "@testing-library/jest-dom/vitest";

// jsdom has no matchMedia; the theme hook reads it (always "light" in tests).
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

// jsdom has no object URLs; thumbnails only need a string.
if (typeof URL !== "undefined" && !("createObjectURL" in URL)) {
  let n = 0;
  Object.assign(URL, {
    createObjectURL: () => `blob:test/${String(++n)}`,
    revokeObjectURL: () => undefined,
  });
}
