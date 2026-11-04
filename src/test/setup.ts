import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

// Each mounted app starts with its own location, like a fresh browser tab.
beforeEach(() => {
  if (typeof window !== "undefined") window.history.replaceState(null, "", "/");
});

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

// Radix popovers measure with ResizeObserver, which jsdom lacks (M10 step 22's effort dial).
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
