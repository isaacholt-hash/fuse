-- 0038_chunks_fts: lexical search over file chunks (M7 step 10, LL-05). See docs/data-model.md.
-- Never edit once shipped.
--
-- Large files and project knowledge are searched by their words first, on this computer, so it
-- works without an OpenAI key; embeddings, when there are any, are merged in. External content,
-- like messages_fts (0012): the text stays in chunks.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  workspace_id UNINDEXED,
  user_id UNINDEXED,
  content = 'chunks',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text, workspace_id, user_id)
  VALUES (new.rowid, new.text, new.workspace_id, new.user_id);
END;

CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text, workspace_id, user_id)
  VALUES ('delete', old.rowid, old.text, old.workspace_id, old.user_id);
END;

CREATE TRIGGER chunks_fts_update AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text, workspace_id, user_id)
  VALUES ('delete', old.rowid, old.text, old.workspace_id, old.user_id);
  INSERT INTO chunks_fts (rowid, text, workspace_id, user_id)
  VALUES (new.rowid, new.text, new.workspace_id, new.user_id);
END;

-- Index the chunks that already exist.
INSERT INTO chunks_fts (chunks_fts) VALUES ('rebuild');
