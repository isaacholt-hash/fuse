# M6 — Coding agent (P1.5 part 2)

**Goal:** FUSE does the daily Claude Code and Codex loop in a local repository, on Isaac's keys, with every step routed, priced and checked against the egress policy (requirements §11b, CA-01 to CA-09; §3). Decisions taken 2026-10-30 (§17): tools in Rust behind the transport, one repository per project, desktop only, commands on the host with Ask as the default, native tool calling on both providers, GitHub through `gh`.

**Done when:** the recorded coding benchmark (step 13) passes on both providers, and no repository content reaches a blocked provider in tests. Isaac then runs `pnpm coding:live` with his own keys, and the phase gate is his: two weeks of his edit, run, review and commit loop in FUSE.

**Out of scope:** sandboxing, code review, skills, hooks, subagents, background and remote runs (CA-10 to CA-19, P2 and later); MCP (AG-02); Local and lean (M7).

## Steps (one PR each, in order)

- [x] **0. M6 plan.** This file, CLAUDE.md pointed at it, the §17 decisions recorded.
- [ ] **1. Provider notes for tool calling.** Extend `docs/providers.md` from the current official docs: function tools on the OpenAI Responses API and the Anthropic Messages API, streamed tool-call events, sending results back, parallel calls, and how tool tokens are counted and priced.
- [ ] **2. Tool calling in both adapters.** `streamChat` takes tool definitions and yields tool calls; a follow-up request carries the results. Contract tests on recorded fixtures (Isaac runs the fixture recorder once with his shell keys). Chat is unchanged when no tools are passed.
- [ ] **3. Link a repository (CA-01).** A project links one local folder. Rust `repo.rs` lists, reads and searches under the root only, skips ignored files, and refuses secret-looking files unless allowed. A test per path rule (outside the root, `..`, symlinks, ignored, secret).
- [ ] **4. Instruction files (CA-06).** CLAUDE.md and AGENTS.md (root and nested) go into the context assembler as instructions with their file as the source, and show in the effective-instructions view.
- [ ] **5. Coding runs, read-only (CA-07 part 1, CA-04 Plan only, CA-09).** A run record with steps; the agent loop with the read, list and search tools; a run view with plan, steps, cost per step, stop, and a cost cap that pauses for approval. Every model call goes through routing, the egress check and `request_log`.
- [ ] **6. File edits with diffs (CA-02).** Edit, create, move and delete under the root. Changes are shown as diffs to accept, reject or undo, per file or per run.
- [ ] **7. Commands (CA-03).** Rust runs a command in the root with streamed output, a time limit, an output cap and the exit code. Each command asks first, with the exact command shown.
- [ ] **8. Permission modes (CA-04).** Ask, Auto-edit and Plan only per project; always-allow per command; destructive commands always ask; every tool call goes in an audit log with inputs, outputs, model and cost.
- [ ] **9. Context budget for tools (CA-08).** File reads and command output capped with a pointer to the rest; older tool results summarized on the Cheap tier; resume a stopped run from its record.
- [ ] **10. Git (CA-05).** Status, diff, branch and commit with a message; a run can work on its own branch or worktree; push and open a pull request through `gh`, and a push always asks.
- [ ] **11. Routing inside runs (CA-07 part 2, RT-14).** Planning on Best, steps on Balanced, summaries on Cheap, never below the quality floor; one-click override per run; the run's total against its cap.
- [ ] **12. Egress and threat model for the agent (CA-09, SE-13).** A test per new send path; a Local only project runs no cloud step; `docs/threat-model.md` covers file and command tools on the host.
- [ ] **13. Coding benchmark.** Recorded tasks on a small fixture repository (add a test and make it pass, fix a bug across two files, commit on a branch), checked on both providers with recorded responses and no API calls, plus `pnpm coding:live` for Isaac.

## Notes

- Each step keeps the usual rules: one PR, tests, screenshot for UI changes, secret scan, `cargo fmt --check` and clippy when Rust changes, CI green, then merge.
- Rust changes are cross-checked for Windows; paths and commands behave differently there (separators, shells), so tests cover both.
- Tests never run real commands outside a temporary fixture repository, and never push.
- Step 2 needs Isaac once: recording tool-calling fixtures with his shell keys. Everything else runs without keys.
