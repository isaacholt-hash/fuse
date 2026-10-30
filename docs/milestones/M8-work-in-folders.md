# M8 — Work in folders (P2, part 1)

**Goal:** what Claude's Cowork and ChatGPT's Work do on the desktop. You pick a folder for any chat, and FUSE reads, writes and organises the files in it: documents, spreadsheets, PDFs and images, not just code. It turns them into finished deliverables, with every change shown before it happens and undoable after, and with commands sandboxed to the chat's folders. It builds on the M6 coding agent: file access through Rust, approvals, diffs and undo, runs with a plan and a cost cap, egress on every send path (requirements §11c, WF-01 to WF-08; CA-11 and FK-07 brought forward).

**Done when:** the recorded Work benchmark (step 13) passes on both providers. Those tasks are: summarise a folder of documents into a Word file, build a spreadsheet from CSVs, and reorganise a messy folder through one approved plan. The sandbox tests show a command can't write outside the chat's folders or reach the network unless allowed, on Linux and on Windows. Isaac then runs `pnpm work:live` with his own keys.

**Out of scope:** the virtual-machine sandbox, connectors (AG-11), reaching folders from another device (CA-15, CA-16), code review, parallel runs, skills, hooks and MCP (option A, later), and editing files inside other apps.

## Decisions (Isaac, 2026-10-30)

- **Work is its own mode.** The composer toggle becomes Off / Code / Work. Work has its own instructions and tools for documents, spreadsheets and organising files. It shares Code's approvals, diffs, undo, cost cap and permission modes (Ask first by default).
- **Any folder, per chat.** Any chat can work in folders you pick. A project can link several folders that all its chats use. A folder is granted once and can be removed; nothing outside the granted folders is reachable. A project's existing linked repository becomes its first folder.
- **Formats:** read and create Word (.docx), Excel (.xlsx) and PDF, read images, and preview anything FUSE made. Text, Markdown and CSV already work.
- **Sandbox:** commands run in an OS sandbox. They can write only in the chat's folders, with no network unless allowed. On Linux that's bubblewrap; on Windows, a restricted token with an AppContainer and a job object. They still ask first, and destructive ones ask every time.

## Steps (one PR each, in order)

- [x] **0. M8 plan.** This file, requirements §11c (WF-01 to WF-08), and CLAUDE.md pointed here.
- [x] **1. Folders as their own records (WF-02).**
  - Migration 0040: `folders` (path, read-secrets; one row per path), `project_folders` and `thread_folders`. Every project's `repo_root` became a folder linked to it; projects sharing a path share one folder, and deleted projects are skipped. Proven by an upgrade test from 0039. `projects.repo_root` is no longer read.
  - Rust's `project_root` reads the project's first linked folder. `src/storage/folders.ts` grants folders and links them to projects and chats, and the M6 setter is now backed by it. Delete everything covers the three tables.
  - No behaviour change yet. The commands take a folder id in step 2.
- [x] **2. Pick folders for a chat, and several for a project (WF-02).**
  - The composer gets a folder button, and Project settings lists folders with Add and Remove. Only granted folders are reachable.
  - The tools name paths as `<folder>/<path>` when a chat has more than one folder.
  - Part 1 done (engine): the Rust file, command and git calls take a folder id. Migration 0041 makes `runs.project_id` optional, adds `runs.kind`, and adds `run_folders`, the folders a run works in and their labels. Old runs got their project's folder.
  - `src/agent/folders.ts` scopes a run to its folders. One folder works as in M6. With several, paths start with the folder's label, the root lists them, and search covers all of them. Commands and git run in the first folder.
  - A run takes the chat's folders, then the project's. CLAUDE.md and AGENTS.md are read from each folder's root. Part 2 is the pickers.
  - Part 2 done (pickers): the composer shows the chat's folders as chips, with an X on the chat's own and the project's shown without one, plus a Folder button that picks one. A new chat's folders are kept until it's saved. Code works in any chat with a folder, in a project or not. Project settings → Folders lists several, each with Remove and its own secrets switch.
- [x] **3. Work mode (WF-01).**
  - The composer has Code and Work side by side; one at a time, per chat. Both use the same permission modes, approvals, diffs, undo, plan and cost cap.
  - Work runs (`runs.kind = 'work'`) get their own guide (`<work_agent>`): deliverables, say which files were used, prefer a new file over overwriting, never delete unless asked. Their planner has its own guide too.
  - Tools: list, read, search, write, edit, move, delete and commands, with no git and no branch. Document, preview and organise tools join in steps 4 to 7. The run card says "Work run".
- [x] **4. Reading documents (WF-03).** `read_file` returns:
  - Word as text with headings and tables
  - Excel as sheets with cell ranges (capped, and searchable by range)
  - PDF text per page (the existing reader)
  - images as images, for models that take them (otherwise a clear note)

  Size limits and truncation follow M7's ceilings.

  Part 1 done (documents):
  - Rust `repo_read_bytes` reads whole files, up to 25 MB, with the same path, ignore and secret rules.
  - `src/documents/read.ts` turns Word into text (headings, lists, tables) and Excel into a table per sheet (cell references, values and formulas, a named sheet and range, 200 rows by 30 columns at a time), using fflate and no new dependency. PDFs use the PDF.js reader.
  - Work runs get a `read_document` tool that pages at 40,000 characters.

  Part 2 done (images):
  - `read_document` on a .png, .jpg, .gif or .webp up to 3.75 MB returns the image with its result. The bytes go into the encrypted attachment store, and migration 0042's `run_steps.images` records them, so every later turn of the run sends it again.
  - Anthropic gets text then an image block inside `tool_result`; OpenAI gets `input_text` then `input_image` inside `function_call_output`. A model without vision gets a note instead.
  - Not yet checked against the live APIs; `pnpm work:live` (step 13) covers that.
- [x] **5. Creating documents (WF-04).**
  - `write_document`, for Work runs, takes structured content and writes .docx, .xlsx or .pdf. Word and PDF take headings, paragraphs, bullet and numbered items, and tables; Excel takes sheets of cells, where `=…` is a formula and numbers are numbers.
  - `src/documents/write.ts` writes minimal Office Open XML zipped with fflate (formulas are calculated when the file opens), and PDFs with jsPDF. Both libraries were already in the app, so no new dependency. The PDF font covers Latin scripts.
  - Rust `repo_write_bytes` and `repo_remove_bytes` apply the same path rules as text writes. Migration 0043 adds `before_sha` and `after_sha` to `run_changes`: the old and new bytes go into the attachment store, and the diff shows readable text of both.
  - Undo is refused if the file changed since. Otherwise it puts the old bytes back, or removes a file the run created.
- [x] **6. Previews (WF-05).**
  - Each file a run made or changed (not deleted or undone) has **Preview** in the run card. It opens in the side panel from its folder: Word and Excel as formatted text and tables, PDFs as pages, images as images, anything else as text.
  - **Open in its app** and **Show in folder** use Rust `repo_open`, which resolves the path inside the granted folder first. Only documents, images and plain text open in their app, never a program, script or web page; Show in folder works for any file.
  - Fixed: written Excel files now have a default cell style, which openpyxl asked for. Checked with `uvx` and python-docx, openpyxl and pypdf: Word, Excel and PDF files from step 5 open with their headings, lists, tables, numbers and formulas.
- [ ] **7. Organise as one plan (WF-06).**
  - An `organise` tool proposes moves, renames and new folders together. You see the whole plan as a tree before and after, then Allow all, untick some, or Deny. It runs as one change with one Undo.
  - Nothing is deleted by an organise plan.
- [ ] **8. Sandbox on Linux (WF-07, CA-11).**
  - Commands run under bubblewrap. The system is read-only, the chat's folders are writable, and there's a private temporary folder and no network (`--unshare-net`) unless allowed.
  - Without bubblewrap, a command asks with a plain warning that it will run unsandboxed.
  - Tests: writing outside the folders fails, and reaching the network fails.
- [ ] **9. Sandbox on Windows (WF-07, CA-11).**
  - Commands run with a restricted token in an AppContainer. Write access is granted only on the chat's folders, there's no network capability unless allowed, and a job object ends the whole tree.
  - The same tests run in Windows CI; HULK can't run them.
  - This is the riskiest step. If it can't be made reliable, it stops and Isaac is asked.
- [ ] **10. Network per chat (WF-07).** "Allow network for this chat" or "for this folder", asked the first time a sandboxed command needs it. Destructive commands still ask every time. The activity log records which commands had network access.
- [ ] **11. Knowledge that follows a folder (FK-07).** A project folder's documents are indexed (M7's word search, plus embeddings when allowed). They're re-indexed when they change: watched while FUSE runs, and checked against their content hash at start. Ignored and secret files are skipped.
- [ ] **12. Security and privacy.** The threat model gets a section on Work and the sandbox. Every send path keeps the egress policy (Local only projects can still use fixed rules and local housekeeping). The privacy wording says what leaves the computer when a model reads your documents.
- [ ] **13. Work benchmark.** A fixture folder (`data/work/fixture`: documents, CSVs, a messy folder) and three recorded tasks, checked on both providers with no API calls:
  - summarise the documents into a .docx with a table
  - build an .xlsx with a formula from two CSVs
  - reorganise the messy folder through one approved plan

  Plus `pnpm work:live` for Isaac.

## Notes

- The usual rules apply to each step: one PR, tests, a screenshot for UI changes, the secret scan, `cargo fmt --check` and clippy when Rust changes, CI green, then merge.
- HULK has bubblewrap (`/usr/bin/bwrap`). The Windows sandbox is tested in CI and confirmed by the Release build.
- File access stays in Rust. The webview never gets a path outside the granted folders.
- Document libraries, and any new crates, are pinned and at least two weeks old, with their licences checked when they're added.
