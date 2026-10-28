-- 0012_search: full-text search across chats (M2 step 4, CH-02). See docs/data-model.md.
-- Never edit once shipped.

-- An index over messages.content (external content: the text itself stays in messages).
-- workspace_id and user_id ride along unindexed so results can be scoped like every table.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  workspace_id UNINDEXED,
  user_id UNINDEXED,
  content = 'messages',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, content, workspace_id, user_id)
  VALUES (new.rowid, new.content, new.workspace_id, new.user_id);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content, workspace_id, user_id)
  VALUES ('delete', old.rowid, old.content, old.workspace_id, old.user_id);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content, workspace_id, user_id)
  VALUES ('delete', old.rowid, old.content, old.workspace_id, old.user_id);
  INSERT INTO messages_fts (rowid, content, workspace_id, user_id)
  VALUES (new.rowid, new.content, new.workspace_id, new.user_id);
END;

-- Index the messages that already exist.
INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');
