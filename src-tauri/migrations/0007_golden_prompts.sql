-- 0007_golden_prompts: the routing test set (M1 step 9a, RT-16). See docs/data-model.md.
-- Never edit once shipped.

-- Real prompts with the tier the user expects; step 10 scores the classifier against them.
-- Importing a file replaces the whole set. Cheap never answers (RT-17), so it is never expected.
CREATE TABLE golden_prompts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  prompt        TEXT NOT NULL,
  expected_tier TEXT NOT NULL CHECK (expected_tier IN ('balanced', 'best')),
  intent        TEXT NOT NULL CHECK (intent IN ('chat', 'writing', 'coding', 'analysis',
                  'long_document', 'reasoning', 'vision', 'creative')),
  complexity    TEXT NOT NULL CHECK (complexity IN ('low', 'medium', 'high')),
  -- 1 when the prompt only makes sense mid-conversation; scored separately.
  needs_context INTEGER NOT NULL DEFAULT 0 CHECK (needs_context IN (0, 1)),
  notes         TEXT NOT NULL DEFAULT '',
  -- Order in the imported file, from 1.
  position      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX golden_prompts_workspace ON golden_prompts (workspace_id, position);
