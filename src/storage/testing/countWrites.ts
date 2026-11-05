// Test-only: counts what a flow writes, by statement and table ("INSERT INTO request_log",
// "UPDATE messages"), so a test can pin writes per answer or run (M10 step 20).
import type { SqlDb } from "../sql";

export function countingDb(db: SqlDb): { db: SqlDb; writes: Map<string, number> } {
  const writes = new Map<string, number>();
  const count = (sql: string) => {
    const head = /^(INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(\w+)/i.exec(
      sql.trim().replace(/\s+/g, " "),
    );
    const verb = head?.[1]?.toUpperCase().replace(/^INSERT OR \w+ INTO$/, "INSERT INTO");
    const key = head && verb ? `${verb} ${head[2] ?? ""}` : "other";
    writes.set(key, (writes.get(key) ?? 0) + 1);
  };
  return {
    writes,
    db: {
      execute(sql, params) {
        count(sql);
        return db.execute(sql, params);
      },
      select: (sql, params) => db.select(sql, params),
      batch: (statements) => {
        for (const statement of statements) count(statement.sql);
        return db.batch(statements);
      },
    },
  };
}
