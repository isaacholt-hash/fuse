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
- [x] **7. Organise as one plan (WF-06).**
  - Work runs have an `organise` tool: a list of moves and renames, with new folders made as needed, and one line on the idea behind it. It's checked before anything moves: no move onto itself, no two moves to one place, and nothing landing where another file is moving from. At most 500 moves.
  - It always asks, even in "Can edit files". The card lists every move with a box, all ticked, and the folders they go into, with Allow all, Allow N ticked, or Deny. Nothing is deleted.
  - The allowed moves run in order. If one fails, the ones already made are put back and nothing stays moved.
  - Migration 0044 adds `run_changes.batch_id`. The run card shows the plan as one row, "Organised N files", listing the moves, with one Undo that puts the whole plan back.
- [x] **8. Sandbox on Linux (WF-07, CA-11).**
  - Commands from Code and Work runs run under bubblewrap: the whole system read-only, a fresh `/dev`, `/proc` and `/tmp`, and the run's folders bound read-write (each looked up in the database, never sent in). There's no network when not allowed, and the sandbox dies with FUSE.
  - FUSE checks once that bubblewrap can make its namespaces (Ubuntu's AppArmor can block it). Where it can't, or on Windows until step 9, the command's approval says it runs with your full rights.
  - Tests on HULK, which also run in CI where bubblewrap works: a write outside the folder fails as read-only, `/etc` can't be written, a connection fails with no network, and the time limit still ends a sandboxed command.
  - Network stays allowed for now, as in M6. Step 10 switches it off by default, with an allow per chat or folder.
  - Known limit: tools that write outside the folder (npm's cache in `~/.npm`, `~/.cargo`) can fail in the sandbox.
- [x] **9. Sandbox on Windows (WF-07, CA-11).**
  - Commands run in an AppContainer, Windows' app sandbox, inside a job object. The container can write only in the folders it was granted (the run's folders, each looked up in the database), has its own TEMP, and gets the network capabilities only when the network is allowed. The job ends the whole tree on the time limit or Stop, and when FUSE quits.
  - To grant a folder, FUSE adds an entry for the container to the folder's permissions the first time a command runs there. Granted folders are listed in `sandbox-grants.txt` in the app's data folder. Settings → "Reset folder permissions" takes the entries off them all and deletes the container.
  - The code is its own small crate, `src-tauri/sandbox-win`, so a new Windows CI job tests it in minutes. The tests check that a write inside works and outside fails, that there's no network without the capability, that killing ends the tree, that the exit code comes back and keys aren't passed on, and that revoke takes the access away. The same job runs clippy on the whole app for Windows.
  - **On by default since F3** (Isaac's call, 2026-10-31, after the checklist below passed). Before that it was off until tried on a real PC. Settings → "Sandbox on Windows" switches it off. While it's off, Windows commands run unsandboxed, and each says so.
  - Isaac's checklist, on a test folder such as `C:\fuse-sandbox-test`:
    1. Settings → "Sandbox on Windows": "Run commands in the sandbox" is ticked.
    2. In a Work chat on that folder (Work on, and still on for each message), send: Run this exact command with run_command, and don't use any other tool: `echo hi> inside.txt`. It asks to run it; allow it. The file appears, and the result says "[sandboxed, network off]".
    3. The same way, run `echo x> %USERPROFILE%\Documents\escape.txt`. It's denied, and no file appears there.
    4. The same way, run `curl.exe -sS -m 10 https://example.com`. It fails and asks about the network. Allow it for the chat: it runs again and succeeds.
    5. The same way, run `echo hidden>NUL && echo shown`. It prints "shown" (CI can't check this one: Windows Server denies the NUL device to every sandboxed app, Windows 10 and 11 don't).
    6. The same way, run `for /l %i in (1,1,300000000) do @rem` (it keeps one core busy for about 100 s) and press Stop after a few seconds. It ends at once, and Task Manager shows no busy `cmd.exe` left. (`ping` can't be used: it doesn't run in the sandbox at all.)
    7. Settings → "Reset folder permissions". It says it put back 1 folder. The test folder's Properties → Security no longer lists the FUSE sandbox.
  - Also fixed: on Windows, commands started in `\\?\C:\…` (the form `canonicalize` gives), where cmd.exe can't start. They now get the plain path.
  - Known limits: programs installed under your user folder can't run in the sandbox, localhost can't be reached, a first grant on a large folder (with `node_modules`, say) takes a while, `ping` fails with "Unable to contact IP driver" (Windows doesn't let sandboxed apps send ICMP, even to localhost), and on Windows Server the NUL device is denied (so `>NUL` and Git fail there).
  - **Result on Isaac's PC (2026-10-30, v0.1.126 and v0.1.127):** all 7 checks passed. After F2, Isaac chose to turn it on by default (F3).

    | Check | Result |
    | --- | --- |
    | 2. write inside the folder | pass, after F1 (the first try went out as plain chat) |
    | 3. write to Documents | pass: "Access is denied", exit 1 |
    | 4. network | pass: blocked, asked, allowed for the chat, then "Example Domain" |
    | 5. `>NUL` | pass: printed "shown", exit 0 |
    | 6. Stop | pass: the card says Stopped and the audit log "[stopped by the user]". The first try used `ping`, which can't run in the sandbox |
    | 7. reset | pass: "Put back 1 folder." |
- [x] **10. Network per chat (WF-07).**
  - Sandboxed commands have **no network** unless the chat, or a folder of the run, was allowed it (migration 0045, `network_grants`).
  - When a sandboxed command fails with what looks like a network error (DNS or connect errors from common tools), the run asks: Allow for this chat, Allow for this folder, or No. Allowing runs it again, once. It's never allowed without asking.
  - Project settings → Folders has a switch per folder. Each command's result in the activity log says "[sandboxed, network on]", "[sandboxed, network off]", or that it wasn't sandboxed.
  - This applies to Code runs too, since M6 commands had the network: the first `pnpm install` in a folder now asks once.
- [x] **11. Knowledge that follows a folder (FK-07).**
  - The documents in a project's folders are added to its knowledge and indexed like uploaded files (word search always, embeddings when the project allows them). That covers PDF, Word, Excel, Markdown, text, CSV, HTML and similar. Code isn't included, since the agent reads code with its tools.
  - Ignored files are never listed and secret-looking files are skipped. Files over 25 MB, and anything past 500 documents per folder, are left out.
  - At start, every project's folders are checked by content hash. While FUSE runs, they're checked each minute by size and modified time, and a changed file is re-read and re-hashed.
  - A changed document replaces its old text, chunks and embeddings. A deleted one leaves knowledge.
  - A folder that's missing, like an unplugged drive, keeps what was indexed. Unlinking a folder takes its documents out of the project.
  - In Project settings → Knowledge they show "In folder" instead of Remove (migration 0046, `folder_files`).
  - **Deviation:** the folder is polled once a minute instead of using a file watcher. That avoids a new dependency and works the same on every platform and drive. A change can take up to a minute to show.
- [x] **12. Security and privacy.**
  - The threat model has a new §7, Work in folders and the sandbox. §5's "no sandbox" gap is updated.
  - Each send path was checked: run turns, plans, summaries, folder knowledge and images from tools. They all keep the egress policy in the app and again in the Rust transport. A Work run outside any project keeps the global rules (new test).
  - Settings → Privacy says what leaves the computer when a model reads your documents.
  - **Gaps written down:**
    - Sandboxed commands can read what you can read, and their output reaches the model.
    - Once the network is allowed for a folder, every later command there has it.
    - Windows has no sandbox yet (built in step 9, off until tried on a real PC).
- [x] **13. Work benchmark.**
  - The fixture `data/work/fixture` has three reports (Markdown, text, and a Word file made by python-docx, not by FUSE), two CSVs whose rows are in different orders, and a messy folder of 8 files: PDFs, images, notes and a CSV.
  - The three tasks are in `data/work/tasks.json`:
    - summarise the reports into a .docx with a table
    - build an .xlsx with a formula per row and a SUM total from the two CSVs
    - sort the messy folder in one organise plan, with no loose files left and the same files kept
  - `pnpm test` runs them on both providers through the real adapters with scripted turns and no API calls (`src/agent/work.benchmark.test.ts`). The checks read the made files back with FUSE's own Word and Excel readers.
  - Isaac runs `pnpm work:live` with his keys. A provider passes with 2 of the 3 tasks.
  - **Live result (2026-10-30, Isaac on HULK):** both providers passed all 3 tasks, for $0.091 in all.

    | Model | summarise-to-docx | xlsx-from-csvs | organise-messy | Cost |
    | --- | --- | --- | --- | --- |
    | anthropic/claude-sonnet-5-5 | pass, 4 turns | pass, 3 turns | pass, 3 turns | $0.064 |
    | openai/gpt-6.1-sol | pass, 4 turns | pass, 5 turns | pass, 4 turns | $0.027 |

    None of the tasks reads a picture. Since F3, `pnpm work:live` also runs a second test: each model reads `data/work/image/gate.png` through read_file and writes the code it shows into a file. The code can't be guessed, so a pass means the image reached the model. Not yet run live.
  - The turn streamers the M6 benchmark used now live in `src/agent/testing/turns.ts`, shared by both benchmarks.

## Fixes

- [x] **F1. Work and Code stayed on for one message only in a new chat.** The switch, run mode and branch choice were kept under the draft. After the first message saved the chat, the next one went out as plain chat (found by Isaac running the step 9 checklist). They now carry over to the saved chat, as its folders already did. Also, an answer from a Code or Work run is marked as one in the history sent to the model, so a later answer without tools doesn't claim the run's changes never happened.

- [x] **F2. What the run card leaves out (found by Isaac running the step 9 checklist).**
  - A "Ran …" row can't be opened, so the command's output, exit code and sandbox line can't be seen. Open it to show them.
  - A failed command's red text repeats the command ("$ …"). Show its first line of output instead.
  - "Always allow in this project" is offered in a chat with no project, where it can't be kept. Show it only in a project.
  - The model isn't told which shell commands run in, and guessed bash on Windows. The command tool now names it.
  - Settings → Coding agent activity squeezes the What column to a few letters.
  - The Windows CI test for Stop used `ping`, which exits at once in the sandbox, so it never checked that a running command was killed. It now kills a busy loop and checks it was still running.

- [x] **F3. The Windows sandbox on by default, and a live check of images in tool results (Isaac, 2026-10-31).**
  - The sandbox is on unless it was switched off in Settings. A saved "off" stays off; Isaac's saved "on" is kept. The "(testing)" label is gone.
  - `pnpm work:live` has a second test, "images in tool results": a Work run on a folder with only `gate.png`, a picture of the code HERON-4172. It passes when `code.txt` holds the code and a tool result carried the image.

## Notes

- The usual rules apply to each step: one PR, tests, a screenshot for UI changes, the secret scan, `cargo fmt --check` and clippy when Rust changes, CI green, then merge.
- HULK has bubblewrap (`/usr/bin/bwrap`). The Windows sandbox is tested in CI (`src-tauri/sandbox-win`) and then on Isaac's PC.
- File access stays in Rust. The webview never gets a path outside the granted folders.
- Document libraries, and any new crates, are pinned and at least two weeks old, with their licences checked when they're added.
