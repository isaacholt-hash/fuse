/**
 * Runs inside a React artifact's preview frame (AR-05), built into one inline script at build
 * time (vite.config.ts). It gives the component React from the app's own bundle, so a preview
 * needs no network, and shows any error in the frame.
 */
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JsxRuntime from "react/jsx-runtime";

const modules: Record<string, unknown> = {
  react: React,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": JsxRuntime,
};

function fail(error: unknown) {
  const pre = document.createElement("pre");
  pre.style.cssText = "color:#b91c1c;white-space:pre-wrap;font:12px ui-monospace,monospace";
  pre.textContent = error instanceof Error ? error.message : String(error);
  document.body.replaceChildren(pre);
}

function mount(exports: Record<string, unknown>) {
  const component = exports.default ?? Object.values(exports).find((v) => typeof v === "function");
  if (typeof component !== "function") {
    throw new Error("The artifact doesn't export a component to show.");
  }
  const root = document.getElementById("root");
  if (!root) throw new Error("The preview page has no root element.");
  ReactDOMClient.createRoot(root).render(React.createElement(component as React.ComponentType));
}

Object.assign(window, {
  __fuse: {
    require(name: string): unknown {
      if (name in modules) return modules[name];
      throw new Error(
        `"${name}" isn't available in previews: only React is bundled, and previews have no network.`,
      );
    },
    mount,
    fail,
  },
});
window.addEventListener("error", (e) => {
  fail(e.error ?? e.message);
});
