import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

// M8 step 14: the click-through test build swaps in scripted providers. Any other build drops
// this branch, and CI checks the release bundle for it (src/e2e/deps.ts).
const deps = import.meta.env.MODE === "e2e" ? (await import("./e2e/deps")).e2eDeps() : {};

createRoot(root).render(
  <StrictMode>
    <App {...deps} />
  </StrictMode>,
);
