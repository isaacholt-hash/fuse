# FUSE export format (PL-12)

A FUSE export is a zip that FUSE can restore and any other program can read. It holds everything FUSE stores, or one project. API keys are never in it: they live in the OS keychain. Search indexes (`chunks`, `chunk_vectors`) aren't in it either; they are rebuilt.

Made from Settings → Your data → **Export everything…**, or Project settings → **Export project…**. Code: `src/data/exportAll.ts`.

## Layout

```
manifest.json            what this export is (below)
records/<table>.json     one JSON array per table: the rows exactly as stored
files/<sha256>           attachment and knowledge file bytes, named by their SHA-256
chats/<date> <title>.md  each chat as Markdown, for reading (restore ignores these)
```

## manifest.json

```json
{
  "format": "fuse-export",
  "version": 2,
  "exportedAt": "2026-10-29T12:00:00.000Z",
  "scope": { "kind": "project", "projectId": "0193…", "name": "Kitchen" },
  "schema": 28,
  "tables": { "threads": 3, "messages": 41, "memories": 7 },
  "files": [{ "sha256": "9f86d0…", "bytes": 4 }],
  "note": "…"
}
```

| Field | Meaning |
| --- | --- |
| `format` | Always `fuse-export` |
| `version` | `2` for this layout. Version 1 (FUSE before M5) was one file, `fuse-export.json`, holding `{ format, version: 1, exportedAt, tables: { <table>: rows } }` plus `files/` and `chats/`; restore reads both |
| `exportedAt` | When it was made, ISO 8601 UTC |
| `scope` | `{ "kind": "all" }`, or `{ "kind": "project", projectId, name }` |
| `schema` | The last database migration applied when it was made (`src-tauri/migrations/NNNN_*.sql`), or `null` if unknown. Columns are as of that migration |
| `tables` | Row count per `records/` file |
| `files` | Every file under `files/`, with its size |

## Records

Each `records/<table>.json` is an array of objects, one per row, with the database's own column names and values. Tables and columns are documented in `docs/data-model.md`. Things to know when reading them:

- **Ids** are UUIDv7 strings, stable for a record's life, and kept on restore.
- **Times** are integer milliseconds since the Unix epoch (UTC).
- **Money** is integer micro-dollars (`cost_micro_usd`), never floats.
- **Every row** carries `workspace_id` and `user_id`.
- **Soft deletes:** a row with `deleted_at` set (or memories with `status = 'deleted'`) was deleted in FUSE and is kept so deletions can travel.
- **JSON in a column:** some columns hold JSON as text, e.g. `memories.alternatives` and `memories.depends_on` (arrays of strings).
- **Memories** are typed records (`kind`: fact, preference, person, constraint, decision, task, source), with scope, authority, status and provenance (PM-12 to PM-14).
- **Files:** a `files` row's `sha256` names its bytes under `files/`. A row can exist without its bytes when the file was missing on disk at export time.

Tables, in the order they're written: `threads`, `messages`, `message_citations`, `message_files`, `files`, `thread_summaries`, `projects`, `project_files`, `memories`, `memory_proposals`, `message_memories`, `artifacts`, `artifact_versions`, `user_instructions`, `budgets`, `budget_events`, `golden_prompts`, `web_pages`, `imports`, `thread_tags`, `prompts`, `egress_rules`, `request_log`. Every table is present, even when empty.

## A project export

A project export holds:

- the project and its non-incognito chats, with their messages, citations, summaries, tags, artifacts and request log;
- the files attached in those chats and the project's knowledge files;
- memories scoped to the project or to one of its chats, including its decisions and tasks;
- its prompts, budgets and egress rules.

Global records (instructions, global memories, the routing test set) aren't included. A row that points at something outside the export (for example a memory that replaced a global one) is restored with that link cleared.

## What is never exported

- API keys.
- Incognito chats.
- Search indexes.
- Settings tied to this computer (`settings`: theme, passcode hash, device id).

## Compatibility

Readers should ignore unknown tables and columns. A new version number means the layout changed, not that columns were added; columns are added freely within a version.
