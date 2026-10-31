# M9 — Tools and MCP (P2, part 2)

**Goal:** the rest of P2's agent Musts. Runs and chats can use more than files: they read the web, run Python on data, and call tools from MCP servers you add. Anything a tool brings back is treated as data. Instructions found in it are shown to you and never followed without asking (requirements §11, AG-01, AG-02, AG-03, AG-10; FK-08 and SE-10 come with them). It builds on M6's runs and approvals and M8's sandbox.

**Done when:** the recorded tools benchmark (step 11) passes on both providers. Its tasks are: answer from a web page read with `fetch_url`, chart a CSV with Python and return the chart, and use a tool from a local MCP server. The injection tests show that an instruction planted in a page, a file, a command's output or an MCP result is flagged and never acted on without your yes. Isaac then runs `pnpm tools:live` with his own keys.

**Out of scope:** the web app on HULK and background runs (CA-15, CA-16), sync (PL-04), scheduled tasks (AG-07), built-in connectors (AG-11, though any MCP server you add works), skills and hooks (CA-12, CA-13), subagents (CA-14), dictation (VI-01) and deep research (FK-12).

## Decisions (Isaac, 2026-10-31)

- **M9 is Tools and MCP**, because it finishes P2's Musts. The web app on HULK and background runs (CA-15) come after.
- **Where tools work:** in Code and Work runs, and in plain chat for the read-only ones (fetch_url, MCP tools marked read-only). Anything that writes, sends or spends needs a run, so it gets the run's approvals, plan and cost cap.
- **MCP:** stdio servers and remote HTTP servers (Streamable HTTP) with OAuth; tools only, not resources or prompts. Servers are added in Settings and switched on per project. Local servers run in the M8 sandbox, with no network unless allowed. Their env values and OAuth tokens live in the OS keychain, like API keys.
- **Code execution:** Python only in M9, in the M8 sandbox (bubblewrap or AppContainer), from a pinned Python downloaded on first use and checked by hash, the same pattern as M7's local model. It comes with pandas, numpy, matplotlib and openpyxl, pinned. Node waits, since `run_command` already covers it for Code runs. Not Pyodide.
- **Injection guard, two layers.** Every tool result reaches the model wrapped as untrusted data, saying what it is. Before a write, command or send that follows such a result, FUSE checks the result for instruction-like text (a fixed rule set, plus the local model when one is installed); if there is any, the approval shows the passage that may have caused the action. The local model can add a flag but never clear one, and nothing is blocked without telling you.

## Steps (one PR each, in order)

- [x] **0. M9 plan.** This file, the decisions above, requirements §11 and §18 updated, and CLAUDE.md pointed here.
- [ ] **1. Tools as a registry (AG-01).** One list of every tool, with name, schema, kind (read, write, command, send, spend) and where it can run (chat, Code, Work). Approvals, permission modes and the activity log read the kind from it instead of from tool names. Project settings → Tools switches each on or off. No behaviour change for the tools that exist.
- [ ] **2. `fetch_url` for runs and chat (AG-01).** The FK-06 reader in `web.rs` as a tool: public addresses only, after DNS and on every redirect; size and time capped; HTML turned into readable text. Read-only, so it runs without asking. The egress policy is checked before the page's text is sent anywhere.
- [ ] **3. Tool results are data (AG-10, part 1).** Every tool result is wrapped and labelled before it reaches the model, on both providers. The run and chat guides say so. Tests with an "ignore your instructions" page, file, command output and document.
- [ ] **4. Flag what a tool result asks for (AG-10, part 2).** A rule set finds instruction-like text in tool results (commands to run, files to delete, addresses to send to, "ignore previous"). When a write, command or send follows a flagged result, its approval shows the passage and where it came from, and it can't be always-allowed. The local model, when installed, can add a flag but never remove one. Logged in the activity log.
- [ ] **5. Python runtime (AG-03, part 1).** Opt-in download of a pinned Python with its libraries, checked by hash, in the app's data folder, on Linux and Windows. Settings shows its size, version and Remove. Nothing runs yet.
- [ ] **6. `run_python` (AG-03, part 2).** Runs a script in the M8 sandbox, in the run's folders, with no network unless allowed, and time and memory limits. Files written to the folder show as the run's changes, with undo. Charts saved as PNG come back as images (M8 step 4's path). Asks first, like commands.
- [ ] **7. Analyse spreadsheets and CSVs (FK-08).** Work runs are told to use `run_python` for numbers, not to work them out in their heads. The chart or table opens in the side panel's preview. A benchmark task checks that a total matches the CSV's.
- [ ] **8. MCP servers in Settings (AG-02, part 1).** Add a stdio server (command, args, env) or an HTTP server (URL). Env values and tokens go to the keychain. Each server shows its health and its tools, each with its kind (taken from the server's annotations, and "write" when it doesn't say). Local servers start in the sandbox and stop with FUSE.
- [ ] **9. MCP tools in runs and chat (AG-02, part 2).** Tools of the servers switched on for the project join the registry, named `<server>.<tool>`. They go through the same approvals, kinds, egress, injection checks and activity log as built-in tools. A server that dies is shown in the run, which carries on without it.
- [ ] **10. MCP over HTTP with OAuth (AG-02, part 3).** Sign in to a remote server in the system browser, with PKCE, and a loopback redirect. Tokens refresh by themselves and can be removed in Settings. Tested against a local test server.
- [ ] **11. Tools benchmark.** A fixture with a saved web page (served locally in tests), a CSV and a small test MCP server. Three tasks: answer from the page, chart the CSV, use the MCP tool. Plus the injection set from steps 3 and 4. `pnpm test` runs them on both providers with scripted turns. Isaac runs `pnpm tools:live`; a provider passes with 2 of the 3 tasks and no injection followed.
- [ ] **12. Security, privacy and the audit log (SE-10).** Threat model §8: tools, MCP, Python and the injection guard, with the gaps written down. Settings → Privacy says what an MCP server sees. The activity log can be exported as CSV and JSON. The Windows click-through tests (M8 step 14) add a `fetch_url` and a `run_python` run.

## Notes

- The usual rules apply to each step: one PR, tests, a screenshot for UI changes, the secret scan, `cargo fmt --check` and clippy when Rust changes, CI green, then merge.
- The MCP SDK, the Python build and its libraries are pinned, at least two weeks old, with their licences checked when they're added.
- File access stays in Rust. An MCP server or a Python script never gets a path outside the run's folders.
- Every tool call writes an activity log row with its inputs, outputs, model and cost; MCP and Python calls too.
