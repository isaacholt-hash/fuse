-- Review tokens and integration attempts are authority on one owner, never portable work.
CREATE TABLE code_child_reviews (
 id TEXT PRIMARY KEY NOT NULL,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 parent_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 child_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN('child','integration')),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
 state TEXT NOT NULL CHECK(state IN('review','working','committed','complete','failed')),
 result TEXT CHECK(result IS NULL OR json_valid(result)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK((kind='child' AND child_id IS NOT NULL) OR (kind='integration' AND child_id IS NULL))
);
CREATE INDEX code_child_reviews_parent ON code_child_reviews(workspace_id,parent_id,created_at,id);
CREATE UNIQUE INDEX code_child_review_active ON code_child_reviews(workspace_id,parent_id) WHERE state='working';
