-- 0015_budgets: budgets and their alerts (M2 step 11, CO-03, RT-10, CO-07). See docs/data-model.md.
-- Never edit once shipped.

CREATE TABLE budgets (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  scope           TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project_id      TEXT REFERENCES projects(id),
  period          TEXT NOT NULL CHECK (period IN ('day', 'month')),
  limit_micro_usd INTEGER NOT NULL CHECK (limit_micro_usd > 0),
  -- Over the limit: refuse to send (until a temporary raise) instead of asking.
  hard_stop       INTEGER NOT NULL DEFAULT 0 CHECK (hard_stop IN (0, 1)),
  -- "Allow for the rest of this period": no asking, no downshift, until this time.
  allow_until     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);

-- Each alert (50/80/100% of a budget in one period, or a spend anomaly on one day) shows once.
CREATE TABLE budget_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  budget_id    TEXT REFERENCES budgets(id),
  kind         TEXT NOT NULL CHECK (kind IN ('50', '80', '100', 'anomaly')),
  period_start INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX budget_events_once ON budget_events (workspace_id, COALESCE(budget_id, ''), kind, period_start);
