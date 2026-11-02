-- A realistic database as FUSE wrote it at migration 0050 (M10 step 1, 2026-10-31), for the
-- upgrade test in src-tauri/src/db.rs (M10 step 19, PL-11): every later migration runs over it
-- and no row may go missing. Written by hand against the schema at 0050; never edited to suit
-- a later migration (that would hide what the migration does to real data). Ids are short on
-- purpose: nothing here parses them.
--
-- The default tenant from 0001: workspace W, user U.
-- W = 00000000-0000-7000-8000-000000000001, U = 00000000-0000-7000-8000-000000000002

INSERT INTO projects (id, workspace_id, user_id, name, instructions, default_provider, default_model, created_at, updated_at, deleted_at, default_tier, privacy_mode, allow_embeddings, repo_root, repo_read_sensitive, run_mode, answer_without_model) VALUES
  ('p1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Kitchen renovation', 'Prices in pounds.', NULL, NULL, 1761000000000, 1761000000000, NULL, 'balanced', 'normal', 1, '/home/me/kitchen', 0, 'ask', 1),
  ('p2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Old project', '', 'anthropic', 'claude-sonnet-5-5', 1760000000000, 1760900000000, 1760900000000, NULL, 'local_only', 0, NULL, 0, 'plan', 0);

INSERT INTO folders (id, workspace_id, user_id, path, read_sensitive, created_at, updated_at) VALUES
  ('f1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', '/home/me/kitchen', 0, 1761000000000, 1761000000000);
INSERT INTO project_folders (id, workspace_id, user_id, project_id, folder_id, created_at) VALUES
  ('pf1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'p1', 'f1', 1761000000000);

INSERT INTO threads (id, workspace_id, user_id, title, title_source, last_message_at, created_at, updated_at, deleted_at, web_search, instructions, project_id, memory_injection, memory_checked_at, pinned_tier, pinned_provider, pinned_model, active_leaf_id, incognito, pinned_at, archived_at, stay_provider) VALUES
  ('t1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Tile budget', 'auto', 1761000500000, 1761000100000, 1761000500000, NULL, 1, 'Keep it short.', 'p1', 'on', 1761000400000, NULL, NULL, NULL, NULL, 0, 1761000600000, NULL, NULL),
  ('t2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Grout colour', 'user', 1760500200000, 1760500100000, 1760500300000, NULL, 0, '', NULL, 'off', NULL, 'best', NULL, NULL, NULL, 0, NULL, 1760600000000, 'openai'),
  ('t3', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'New chat', 'auto', NULL, 1761001000000, 1761001000000, NULL, 0, '', NULL, 'on', NULL, 'balanced', 'anthropic', 'claude-haiku-5-5', NULL, 1, NULL, NULL, NULL),
  ('t4', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Deleted chat', 'auto', 1760000200000, 1760000100000, 1760000900000, 1760000900000, 0, '', 'p2', 'on', NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL);
INSERT INTO thread_folders (id, workspace_id, user_id, thread_id, folder_id, created_at) VALUES
  ('tf1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', 'f1', 1761000100000);
INSERT INTO thread_tags (id, workspace_id, user_id, thread_id, tag, created_at, updated_at) VALUES
  ('tg1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', 'home', 1761000100000, 1761000100000);

INSERT INTO request_log (id, workspace_id, user_id, thread_id, message_id, purpose, provider, model, attempt, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, reasoning_tokens, cost_micro_usd, price_version, latency_ms, ttft_ms, http_status, error_code, error_message, provider_request_id, created_at, updated_at, web_search_calls, tier, route_rule_id) VALUES
  ('r1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', 'a2', 'chat', 'anthropic', 'claude-sonnet-5-5', 1, 1240, 380, 800, 0, 0, 9300, '2026-10-27', 2100, 400, 200, NULL, NULL, 'req_1', 1761000500000, 1761000500000, 0, 'balanced', 'everyday'),
  ('r2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', NULL, 'title', 'anthropic', 'claude-haiku-5-5', 1, 60, 8, 0, 0, 0, 40, '2026-10-27', 300, 100, 200, NULL, NULL, NULL, 1761000200000, 1761000200000, 0, 'cheap', NULL),
  ('r3', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't2', 'a3', 'chat', 'openai', 'gpt-6.1-sol', 2, 500, 120, 0, 0, 90, 3100, '2026-10-27', 1500, 300, 429, 'rate_limit', 'Too many requests', NULL, 1760500200000, 1760500200000, 1, 'balanced', 'everyday'),
  ('r4', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', NULL, 'agent', 'anthropic', 'claude-opus-5-5', 1, 38100, 6200, 21000, 0, 0, 291000, '2026-10-27', 60000, 900, 200, NULL, NULL, NULL, 1761000700000, 1761000700000, 0, 'best', 'complex-coding');

INSERT INTO messages (id, workspace_id, user_id, thread_id, parent_id, role, content, status, error_code, error_message, provider, model, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, reasoning_tokens, cost_micro_usd, price_version, latency_ms, ttft_ms, request_id, created_at, updated_at, deleted_at, web_search_calls, pinned_mode, tier, route_rule_id, route_reason, route_intent, route_complexity, best_cost_micro_usd, escalated_from_id, feedback) VALUES
  ('q1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', NULL, 'user', 'Total the tile quotes', 'complete', NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, 1761000100000, 1761000100000, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('a1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', 'q1', 'assistant', 'Marrakech includes the trim.', 'complete', NULL, NULL, 'anthropic', 'claude-sonnet-5-5', 900, 200, 0, 0, 0, 4200, '2026-10-27', 1800, 350, NULL, 1761000200000, 1761000200000, NULL, 0, 'auto', 'balanced', 'everyday', 'Everyday answers start on Balanced', 'analysis', 'medium', 12000, NULL, 'up'),
  ('a1x', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', 'q1', 'assistant', 'Topps is cheapest.', 'complete', NULL, NULL, 'anthropic', 'claude-sonnet-5-5', 900, 150, 800, 0, 0, 2100, '2026-10-27', 1200, 300, NULL, 1761000300000, 1761000300000, NULL, 0, 'auto', 'balanced', 'everyday', 'Everyday answers start on Balanced', 'analysis', 'medium', NULL, NULL, NULL),
  ('q2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', 'a1', 'user', 'Work out the cost per square metre', 'complete', NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, 1761000400000, 1761000400000, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('a2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', 'q2', 'assistant', 'About £125 per metre.', 'complete', NULL, NULL, 'anthropic', 'claude-sonnet-5-5', 1240, 380, 800, 0, 0, 9300, '2026-10-27', 2100, 400, 'r1', 1761000500000, 1761000500000, NULL, 0, 'auto', 'balanced', 'everyday', 'Everyday answers start on Balanced', 'analysis', 'medium', 15000, NULL, NULL),
  ('a2b', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', 'q2', 'assistant', 'About £125.09 per square metre, trim included.', 'complete', NULL, NULL, 'anthropic', 'claude-opus-5-5', 1300, 420, 0, 0, 2000, 41000, '2026-10-27', 5000, 900, NULL, 1761000550000, 1761000550000, NULL, 0, 'tier', 'best', 'escalation', 'Stronger model: same question', 'analysis', 'hard', NULL, 'a2', NULL),
  ('q3', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't2', NULL, 'user', 'Which grout colour for grey tiles?', 'complete', NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, 1760500100000, 1760500100000, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('a3', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't2', 'q3', 'assistant', 'Charcoal hides', 'error', 'rate_limit', 'Too many requests', 'openai', 'gpt-6.1-sol', 500, 120, 0, 0, 90, 3100, '2026-10-27', 1500, 300, 'r3', 1760500200000, 1760500200000, NULL, 1, 'model', NULL, NULL, 'Pinned to GPT-6.1 Sol', 'chat', 'simple', NULL, NULL, 'down'),
  ('q4', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't4', NULL, 'user', 'Old question', 'complete', NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, 1760000200000, 1760000200000, 1760000900000, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
UPDATE threads SET active_leaf_id = 'a2b' WHERE id = 't1';
UPDATE threads SET active_leaf_id = 'a3' WHERE id = 't2';

INSERT INTO files (id, workspace_id, user_id, name, mime, size_bytes, sha256, storage_path, width, height, token_estimate, parse_status, parse_error, project_id, thread_id, created_at, updated_at, deleted_at, may_send) VALUES
  ('fi1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'quote.pdf', 'application/pdf', 48211, 'ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34', 'files/ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34', NULL, NULL, 1200, 'ready', NULL, NULL, 't1', 1761000100000, 1761000100000, NULL, 1),
  ('fi2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'plan.png', 'image/png', 90000, 'ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56', 'files/ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56', 1024, 768, 1105, 'error', 'Not a text file', 'p1', NULL, 1761000050000, 1761000050000, NULL, 0);
INSERT INTO message_files (id, workspace_id, user_id, message_id, file_id, ordinal, mode, created_at, updated_at) VALUES
  ('mf1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'q1', 'fi1', 0, 'retrieval', 1761000100000, 1761000100000);

INSERT INTO memories (id, workspace_id, user_id, text, kind, scope, project_id, thread_id, authority, source_thread_id, source_message_id, source_artifact_id, extraction_method, extraction_model, confidence, last_verified_at, expires_at, status, sensitivity, may_send, superseded_by_id, rationale, alternatives, task_status, depends_on, revision, device_id, created_at, updated_at, deleted_at) VALUES
  ('m1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Prefers metric units', 'preference', 'global', NULL, NULL, 'you', NULL, NULL, NULL, 'typed', NULL, 100, NULL, NULL, 'active', 'normal', 1, NULL, NULL, NULL, NULL, NULL, 2, 'dev-1', 1760000000000, 1760900000000, NULL),
  ('m2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'The kitchen is 11.4 square metres', 'fact', 'project', 'p1', NULL, 'extracted', 't1', 'a2', NULL, 'chat', 'claude-haiku-5-5', 85, 1761000500000, NULL, 'active', 'normal', 1, NULL, NULL, NULL, NULL, NULL, 1, 'dev-1', 1761000500000, 1761000500000, NULL),
  ('m3', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Only this chat: use Marrakech prices', 'constraint', 'conversation', NULL, 't1', 'you', NULL, NULL, NULL, 'typed', NULL, 100, NULL, NULL, 'active', 'normal', 1, NULL, NULL, NULL, NULL, NULL, 1, 'dev-1', 1761000400000, 1761000400000, NULL),
  ('m4', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Prefers imperial units', 'preference', 'global', NULL, NULL, 'imported', NULL, NULL, NULL, 'import', NULL, 100, NULL, NULL, 'superseded', 'normal', 1, 'm1', NULL, NULL, NULL, NULL, 1, 'dev-1', 1759000000000, 1760900000000, NULL),
  ('m5', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Go with Marrakech Tile', 'decision', 'project', 'p1', NULL, 'you', 't1', NULL, NULL, 'typed', NULL, 100, NULL, NULL, 'active', 'normal', 1, NULL, 'Includes the trim pieces', '["Topps","Mandarin Stone"]', NULL, NULL, 1, 'dev-1', 1761000600000, 1761000600000, NULL),
  ('m6', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Order the bullnose pieces', 'task', 'project', 'p1', NULL, 'you', NULL, NULL, NULL, 'typed', NULL, 100, NULL, 1764000000000, 'active', 'normal', 1, NULL, NULL, NULL, 'open', '["m5"]', 1, 'dev-1', 1761000650000, 1761000650000, NULL),
  ('m7', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Bank account ends 4421', 'fact', 'global', NULL, NULL, 'you', NULL, NULL, NULL, 'typed', NULL, 100, NULL, NULL, 'deleted', 'sensitive', 0, NULL, NULL, NULL, NULL, NULL, 1, 'dev-1', 1759500000000, 1760800000000, 1760800000000);
INSERT INTO memory_proposals (id, workspace_id, user_id, op, memory_id, text, kind, project_id, confidence, source_thread_id, origin, extraction_model, status, created_at, updated_at) VALUES
  ('pr1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'add', NULL, 'Likes grey grout', 'preference', NULL, 80, 't2', 'chat', 'claude-haiku-5-5', 'pending', 1760500300000, 1760500300000),
  ('pr2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'update', 'm1', 'Prefers metric, except for pipe sizes', 'preference', NULL, 70, 't1', 'chat', 'claude-haiku-5-5', 'rejected', 1761000600000, 1761000600000);
INSERT INTO message_memories (message_id, memory_id, workspace_id, user_id, created_at, reason, score) VALUES
  ('a2', 'm1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 1761000500000, 'keyword', 0.9);

INSERT INTO thread_summaries (id, workspace_id, user_id, thread_id, upto_message_id, summary, created_at, updated_at) VALUES
  ('s1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', 'a1', 'Three quotes compared; Marrakech includes trim.', 1761000350000, 1761000350000);

INSERT INTO artifacts (id, workspace_id, user_id, thread_id, key, title, type, language, created_at, updated_at, deleted_at, allow_cdn) VALUES
  ('ar1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', 'sheet', 'Tile costs', 'markdown', '', 1761000500000, 1761000560000, NULL, 0),
  ('ar2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 't1', 'calc', 'Cost calculator', 'react', 'tsx', 1761000550000, 1761000550000, NULL, 1);
INSERT INTO artifact_versions (id, workspace_id, user_id, artifact_id, version, content, source, message_id, created_at, updated_at) VALUES
  ('v1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'ar1', 1, '# Costs', 'model', 'a2', 1761000500000, 1761000500000),
  ('v2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'ar1', 2, '# Costs, revised', 'user', NULL, 1761000560000, 1761000560000),
  ('v3', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'ar2', 1, 'export default function Calc() { return null; }', 'model', 'a2b', 1761000550000, 1761000550000);

INSERT INTO runs (id, workspace_id, user_id, project_id, thread_id, message_id, task, kind, mode, provider, model, status, cap_micro_usd, spent_micro_usd, note, summary, summary_upto, branch, plan, planner, created_at, updated_at) VALUES
  ('run1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'p1', 't1', 'a2b', 'Add a FOOTER.md', 'code', 'ask', 'anthropic', 'claude-opus-5-5', 'done', 1000000, 291000, 'Pushed fuse/footer', 'Added the footer', 'st2', 'fuse/footer', NULL, NULL, 1761000700000, 1761000800000),
  ('run2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'p1', NULL, NULL, 'Tidy the spreadsheet', 'work', 'auto_edit', 'openai', 'gpt-6.1-sol', 'stopped', 500000, 12000, 'Stopped by you', NULL, NULL, NULL, '["Open the sheet","Sort by date"]', 'claude-opus-5-5', 1761000900000, 1761000950000);
INSERT INTO run_steps (id, workspace_id, user_id, run_id, seq, kind, text, native, request_id, tool_name, tool_call_id, input, output, is_error, cost_micro_usd, created_at, updated_at, approval, images, flags) VALUES
  ('st1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'run1', 1, 'model', 'I will add the file.', NULL, 'r4', NULL, NULL, NULL, NULL, 0, 291000, 1761000700000, 1761000700000, NULL, NULL, NULL),
  ('st2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'run1', 2, 'tool', NULL, NULL, NULL, 'write_file', 'call_1', '{"path":"FOOTER.md"}', '{"ok":true}', 0, 0, 1761000750000, 1761000750000, 'you', NULL, '["passage"]');
INSERT INTO run_changes (id, workspace_id, user_id, run_id, step_id, path, from_path, before, after, status, created_at, updated_at, before_sha, after_sha, batch_id) VALUES
  ('c1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'run1', 'st2', 'FOOTER.md', NULL, NULL, 'Made by FUSE', 'applied', 1761000750000, 1761000750000, NULL, NULL, NULL);

INSERT INTO chunks (id, workspace_id, user_id, source_kind, source_id, ordinal, text, tokens, page, line_start, line_end, created_at, updated_at) VALUES
  ('ch1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'memory', 'm1', 0, 'Prefers metric units', 3, NULL, NULL, NULL, 1760000000000, 1760000000000),
  ('ch2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'file', 'fi1', 0, 'Marrakech Tile quote: field tile 1240, trim 186', 12, 1, NULL, NULL, 1761000100000, 1761000100000);
INSERT INTO chunk_vectors (chunk_id, workspace_id, user_id, model, dims, vector, created_at, updated_at) VALUES
  ('ch1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'text-embedding-3-small', 2, '[1,0]', 1760000000000, 1760000000000);

INSERT INTO prompts (id, workspace_id, user_id, project_id, name, body, created_at, updated_at) VALUES
  ('pm1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', NULL, 'Summarise', 'Summarise {{text}} in three lines.', 1760000000000, 1760000000000);
INSERT INTO budgets (id, workspace_id, user_id, scope, project_id, period, limit_micro_usd, hard_stop, allow_until, created_at, updated_at) VALUES
  ('b1', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'global', NULL, 'month', 60000000, 0, NULL, 1760000000000, 1760000000000),
  ('b2', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'project', 'p1', 'day', 5000000, 1, NULL, 1761000000000, 1761000000000);
