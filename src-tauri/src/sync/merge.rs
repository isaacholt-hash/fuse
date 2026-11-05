//! Causal record reconciliation. All identifiers used in SQL come from the bundled registry.
use super::{
    Ctx, USER, WORKSPACE, now, registry,
    transport::{Change, Operation},
};
use crate::db;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};
mod deletion;
pub async fn finalize(ctx: &Ctx) -> Result<(), String> {
    deletion::finalize(ctx).await
}

type Vector = BTreeMap<String, u64>;
type Record = BTreeMap<String, Value>;
#[derive(Debug, PartialEq, Eq)]
enum Relation {
    Before,
    Equal,
    After,
    Concurrent,
}
fn relation(a: &Vector, b: &Vector) -> Relation {
    let mut less = false;
    let mut greater = false;
    for actor in a.keys().chain(b.keys()) {
        let left = a.get(actor).copied().unwrap_or(0);
        let right = b.get(actor).copied().unwrap_or(0);
        less |= left < right;
        greater |= left > right;
    }
    match (less, greater) {
        (true, true) => Relation::Concurrent,
        (true, false) => Relation::Before,
        (false, true) => Relation::After,
        _ => Relation::Equal,
    }
}
fn union(a: &Vector, b: &Vector) -> Vector {
    let mut result = a.clone();
    for (actor, seq) in b {
        result
            .entry(actor.clone())
            .and_modify(|v| *v = (*v).max(*seq))
            .or_insert(*seq);
    }
    result
}
fn rank(event: &Change) -> (u64, &str, &str) {
    (event.clock, &event.device_id, &event.id)
}
fn fail(e: sqlx::Error) -> String {
    format!("Couldn't merge sync history: {e}")
}
async fn execute(conn: &mut SqliteConnection, sql: &str, params: &[Value]) -> Result<u64, String> {
    db::bind(sqlx::query(sql), params)
        .execute(conn)
        .await
        .map(|r| r.rows_affected())
        .map_err(fail)
}
async fn select(
    conn: &mut SqliteConnection,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Record>, String> {
    let rows = db::bind(sqlx::query(sql), params)
        .fetch_all(conn)
        .await
        .map_err(fail)?;
    rows.iter()
        .map(|r| {
            db::row_to_json(r)
                .map(|m| m.into_iter().collect())
                .map_err(fail)
        })
        .collect()
}
pub(crate) fn keys(table: &str) -> Result<Vec<String>, String> {
    registry()["tables"][table]["key"]
        .as_array()
        .ok_or("Unknown replicated table.")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or("Invalid registry key.".into())
        })
        .collect()
}
pub(crate) fn predicate(table: &str) -> Result<String, String> {
    Ok(keys(table)?
        .iter()
        .map(|k| format!("{k} IS ?"))
        .collect::<Vec<_>>()
        .join(" AND "))
}
pub(crate) fn key_values(event: &Change) -> Result<Vec<Value>, String> {
    let cols = keys(&event.table)?;
    if cols.len() == 1 && cols[0] == "id" {
        Ok(vec![json!(event.key)])
    } else {
        serde_json::from_str::<Vec<Value>>(&event.key)
            .map_err(|_| "Malformed logical sync key.".into())
            .and_then(|v| {
                if v.len() == cols.len() {
                    Ok(v)
                } else {
                    Err("Malformed logical sync key.".into())
                }
            })
    }
}
async fn row(conn: &mut SqliteConnection, event: &Change) -> Result<Option<Record>, String> {
    let mut values = vec![json!(WORKSPACE), json!(USER)];
    values.extend(key_values(event)?);
    Ok(select(
        conn,
        &format!(
            "SELECT * FROM {} WHERE workspace_id=? AND user_id=? AND {}",
            event.table,
            predicate(&event.table)?
        ),
        &values,
    )
    .await?
    .into_iter()
    .next())
}
async fn alias(conn: &mut SqliteConnection, table: &str, id: &str) -> Result<String, String> {
    let mut current = id.to_owned();
    let mut seen = BTreeSet::new();
    loop {
        if !seen.insert(current.clone()) {
            return Err("Sync identity aliases contain a cycle.".into());
        }
        let next:Option<String>=sqlx::query_scalar("SELECT canonical_id FROM sync_aliases WHERE workspace_id=? AND table_name=? AND original_id=?").bind(WORKSPACE).bind(table).bind(&current).fetch_optional(&mut *conn).await.map_err(fail)?;
        match next {
            Some(next) if next != current => current = next,
            _ => return Ok(current),
        }
    }
}
#[derive(Clone)]
struct Foreign {
    column: String,
    table: String,
    target: String,
}
async fn foreign(conn: &mut SqliteConnection, table: &str) -> Result<Vec<Foreign>, String> {
    let portable = registry()["tables"][table]["columns"]
        .as_array()
        .ok_or("Invalid portable registry.")?;
    let mut result = Vec::new();
    for row in sqlx::query(&format!("PRAGMA foreign_key_list({table})"))
        .fetch_all(&mut *conn)
        .await
        .map_err(fail)?
    {
        let column: String = row.get("from");
        let table: String = row.get("table");
        if portable.iter().any(|v| v.as_str() == Some(&column))
            && registry()["tables"].get(&table).is_some()
        {
            result.push(Foreign {
                column,
                table,
                target: row.get("to"),
            });
        }
    }
    Ok(result)
}
async fn remap(
    conn: &mut SqliteConnection,
    table: &str,
    mut value: Record,
) -> Result<Record, String> {
    for fk in foreign(conn, table).await? {
        if let Some(id) = value.get(&fk.column).and_then(Value::as_str) {
            let mapped = alias(conn, &fk.table, id).await?;
            value.insert(fk.column, json!(mapped));
        }
    }
    Ok(value)
}
async fn archive(conn: &mut SqliteConnection, event: &Change) -> Result<(), String> {
    let stamp = now();
    execute(conn,"INSERT INTO sync_revisions(id,workspace_id,user_id,table_name,record_key,event,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",&[json!(event.id),json!(WORKSPACE),json!(USER),json!(event.table),json!(event.key),json!(serde_json::to_string(event).map_err(|_|"Couldn't retain a sync revision.")?),json!(stamp+30*24*60*60*1000i64),json!(stamp),json!(stamp)]).await?;
    Ok(())
}

async fn revision(conn: &mut SqliteConnection, id: &str) -> Result<Option<Change>, String> {
    let prepared: Option<String> = sqlx::query_scalar("SELECT event FROM sync_prepared WHERE id=?")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(fail)?;
    if let Some(body) = prepared {
        return serde_json::from_str(&body)
            .map(Some)
            .map_err(|_| "A prepared sync revision is damaged.".into());
    }
    let archived: Option<String> =
        sqlx::query_scalar("SELECT event FROM sync_revisions WHERE id=?")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(fail)?;
    let body=match archived {
        Some(body)=>Some(body),
        None=>sqlx::query_scalar("SELECT json_object('id',id,'workspaceId',workspace_id,'userId',user_id,'table',table_name,'key',record_key,'deviceId',device_id,'seq',seq,'clock',clock,'version',json(version),'operation',operation,'payload',json(payload),'createdAt',created_at,'resolves',json(resolves),'retained',json(retained),'format',wire_format,'barriers',json(barriers)) FROM sync_outbox WHERE id=?").bind(id).fetch_optional(&mut *conn).await.map_err(fail)?,
    };
    body.map(|body| {
        serde_json::from_str(&body).map_err(|_| "A current sync revision is damaged.".into())
    })
    .transpose()
}
async fn canonicalize(
    conn: &mut SqliteConnection,
    event: &Change,
    mut value: Record,
    existing: Option<&Record>,
) -> Result<Record, String> {
    if keys(&event.table)? == ["id"] {
        return remap(conn, &event.table, value).await;
    }
    if let Some(incoming) = value.get("id").and_then(Value::as_str).map(str::to_owned) {
        let incoming = alias(conn, &event.table, &incoming).await?;
        let prior = existing
            .and_then(|r| r.get("id"))
            .and_then(Value::as_str)
            .unwrap_or(&incoming)
            .to_owned();
        let canonical = prior.clone().min(incoming.clone());
        for original in BTreeSet::from([prior.clone(), incoming]) {
            if original != canonical {
                execute(conn,"UPDATE sync_aliases SET canonical_id=?,updated_at=? WHERE workspace_id=? AND table_name=? AND canonical_id=?",&[json!(canonical),json!(now()),json!(WORKSPACE),json!(event.table),json!(original)]).await?;
                execute(conn,"INSERT INTO sync_aliases(workspace_id,user_id,table_name,original_id,canonical_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,table_name,original_id) DO UPDATE SET canonical_id=excluded.canonical_id,updated_at=excluded.updated_at",&[json!(WORKSPACE),json!(USER),json!(event.table),json!(original),json!(canonical),json!(now()),json!(now())]).await?;
            }
        }
        if prior != canonical && existing.is_some() {
            execute(
                conn,
                &format!(
                    "UPDATE {} SET id=? WHERE workspace_id=? AND id=?",
                    event.table
                ),
                &[json!(canonical), json!(WORKSPACE), json!(prior)],
            )
            .await?;
            for (child, _) in registry()["tables"]
                .as_object()
                .ok_or("Invalid registry.")?
            {
                for fk in foreign(conn, child).await? {
                    if fk.table == event.table && fk.target == "id" {
                        execute(
                            conn,
                            &format!(
                                "UPDATE {child} SET {}=? WHERE workspace_id=? AND {}=?",
                                fk.column, fk.column
                            ),
                            &[json!(canonical), json!(WORKSPACE), json!(prior)],
                        )
                        .await?;
                    }
                }
            }
        }
        value.insert("id".into(), json!(canonical));
    }
    remap(conn, &event.table, value).await
}
async fn install(
    conn: &mut SqliteConnection,
    event: &Change,
    value: &Record,
    exists: bool,
) -> Result<(), String> {
    let columns: Vec<_> = value.keys().cloned().collect();
    let mut params: Vec<_> = columns.iter().map(|c| value[c].clone()).collect();
    let sql = if exists {
        let mut filter = vec![json!(WORKSPACE), json!(USER)];
        filter.extend(key_values(event)?);
        params.extend(filter);
        format!(
            "UPDATE {} SET {} WHERE workspace_id=? AND user_id=? AND {}",
            event.table,
            columns
                .iter()
                .map(|c| format!("{c}=?"))
                .collect::<Vec<_>>()
                .join(","),
            predicate(&event.table)?
        )
    } else {
        format!(
            "INSERT INTO {} ({}) VALUES ({})",
            event.table,
            columns.join(","),
            vec!["?"; columns.len()].join(",")
        )
    };
    execute(conn, &sql, &params).await?;
    if event.table == "runs" && !exists {
        execute(
            conn,
            "UPDATE runs SET sync_owner=? WHERE workspace_id=? AND id=?",
            &[json!(event.device_id), json!(WORKSPACE), json!(event.key)],
        )
        .await?;
    }
    Ok(())
}
fn needs_review(a: &Change, b: &Change) -> bool {
    if a.table != "memories" {
        return false;
    }
    let (Some(a), Some(b)) = (&a.payload, &b.payload) else {
        return false;
    };
    let reviewed = |r: &Record| {
        matches!(
            r.get("kind").and_then(Value::as_str),
            Some("fact" | "decision")
        )
    };
    (reviewed(a) || reviewed(b))
        && ["text", "kind", "rationale", "alternatives"]
            .iter()
            .any(|field| a.get(*field) != b.get(*field))
}
fn restrictive(table: &str, a: &Record, b: &Record, winner: &Record) -> Record {
    let mut merged = winner.clone();
    let and = match table {
        "projects" => vec!["allow_embeddings"],
        "egress_rules" => vec!["allow"],
        _ => vec![],
    };
    for field in and {
        merged.insert(
            field.into(),
            json!(i64::from(
                a.get(field).and_then(Value::as_i64) == Some(1)
                    && b.get(field).and_then(Value::as_i64) == Some(1)
            )),
        );
    }
    if table == "projects" {
        if [a, b]
            .iter()
            .any(|row| row.get("privacy_mode") == Some(&json!("cloud_only")))
        {
            merged.insert("privacy_mode".into(), json!("cloud_only"));
        }
        if [a, b]
            .iter()
            .any(|row| row.get("answer_without_model") == Some(&json!(1)))
        {
            merged.insert("answer_without_model".into(), json!(1));
        }
    }
    merged
}
async fn record_meta(
    conn: &mut SqliteConnection,
    event: &Change,
    version: &Vector,
) -> Result<(), String> {
    let operation = match event.operation {
        Operation::Put => "put",
        Operation::Delete => "delete",
        Operation::Withdraw => "withdraw",
    };
    let revision = event
        .payload
        .as_ref()
        .and_then(|p| p.get("revision"))
        .and_then(Value::as_i64)
        .unwrap_or(1);
    execute(conn,"INSERT INTO sync_records(workspace_id,user_id,table_name,record_key,event_id,device_id,clock,version,revision,operation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET event_id=excluded.event_id,device_id=excluded.device_id,clock=excluded.clock,version=excluded.version,revision=excluded.revision,operation=excluded.operation,updated_at=excluded.updated_at",&[json!(WORKSPACE),json!(USER),json!(event.table),json!(event.key),json!(event.id),json!(event.device_id),json!(event.clock),json!(serde_json::to_string(version).map_err(|_|"Couldn't save causal metadata.")?),json!(revision),json!(operation),json!(now()),json!(now())]).await?;
    execute(conn,"UPDATE sync_records SET wire_format=?,barriers=? WHERE workspace_id=? AND table_name=? AND record_key=?",&[json!(event.format),json!(serde_json::to_string(&event.barriers).map_err(|_|"Couldn't preserve lifecycle acknowledgements.")?),json!(WORKSPACE),json!(event.table),json!(event.key)]).await?;
    if let Some(payload) = &event.payload {
        deletion::entity(conn, event, payload).await?;
        execute(
            conn,
            "DELETE FROM sync_lineage WHERE workspace_id=? AND table_name=? AND record_key=?",
            &[json!(WORKSPACE), json!(event.table), json!(event.key)],
        )
        .await?;
        for reference in registry()["tables"][&event.table]["references"]
            .as_array()
            .ok_or("Invalid sync provenance registry.")?
        {
            let column = reference["column"]
                .as_str()
                .ok_or("Invalid provenance column.")?;
            let table = reference["table"]
                .as_str()
                .ok_or("Invalid provenance table.")?;
            if let Some(id) = payload.get(column).and_then(Value::as_str) {
                execute(conn,"INSERT INTO sync_lineage(workspace_id,user_id,table_name,record_key,column_name,parent_table,parent_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,table_name,record_key,column_name) DO UPDATE SET parent_table=excluded.parent_table,parent_id=excluded.parent_id,updated_at=excluded.updated_at",&[json!(WORKSPACE),json!(USER),json!(event.table),json!(event.key),json!(column),json!(table),json!(id),json!(now()),json!(now())]).await?;
            }
        }
        execute(
            conn,
            "DELETE FROM sync_unavailable WHERE workspace_id=? AND table_name=? AND record_key=?",
            &[json!(WORKSPACE), json!(event.table), json!(event.key)],
        )
        .await?;
        for (column, source) in &event.unavailable {
            execute(conn,"INSERT INTO sync_unavailable(workspace_id,user_id,table_name,record_key,column_name,parent_table,parent_id,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",&[json!(WORKSPACE),json!(USER),json!(event.table),json!(event.key),json!(column),json!(source.table),json!(source.id),json!(source.reason),json!(now()),json!(now())]).await?;
        }
    }
    Ok(())
}

async fn meta(conn: &mut SqliteConnection, event: &Change) -> Result<Option<Record>, String> {
    Ok(select(
        conn,
        "SELECT * FROM sync_records WHERE workspace_id=? AND table_name=? AND record_key=?",
        &[json!(WORKSPACE), json!(event.table), json!(event.key)],
    )
    .await?
    .into_iter()
    .next())
}
async fn block(conn: &mut SqliteConnection, event: &Change, reason: &str) -> Result<(), String> {
    execute(
        conn,
        "UPDATE sync_inbox SET blocked=? WHERE workspace_id=? AND id=?",
        &[json!(reason), json!(WORKSPACE), json!(event.id)],
    )
    .await?;
    Ok(())
}
async fn complete(conn: &mut SqliteConnection, event: &Change) -> Result<(), String> {
    execute(
        conn,
        "UPDATE sync_inbox SET applied=1,blocked=NULL,updated_at=? WHERE workspace_id=? AND id=?",
        &[json!(now()), json!(WORKSPACE), json!(event.id)],
    )
    .await?;
    Ok(())
}
async fn resolve_review(conn: &mut SqliteConnection, event: &Change) -> Result<(), String> {
    if event.resolves.is_empty() {
        return Ok(());
    }
    let conflicts=select(conn,"SELECT id,ours,theirs FROM sync_conflicts WHERE workspace_id=? AND table_name=? AND record_key=? AND resolved_at IS NULL",&[json!(WORKSPACE),json!(event.table),json!(event.key)]).await?;
    for conflict in conflicts {
        let mut covered = true;
        for field in ["ours", "theirs"] {
            let candidate: Change = serde_json::from_str(
                conflict[field]
                    .as_str()
                    .ok_or("Invalid review candidate.")?,
            )
            .map_err(|_| "Invalid review candidate.")?;
            covered &= event.resolves.contains(&candidate.id)
                && matches!(
                    relation(&event.version, &candidate.version),
                    Relation::After | Relation::Equal
                );
        }
        if covered {
            execute(
                conn,
                "UPDATE sync_conflicts SET resolved_at=?,updated_at=? WHERE id=?",
                &[json!(now()), json!(now()), conflict["id"].clone()],
            )
            .await?;
        }
    }
    Ok(())
}

/// Apply markers before fetching file bytes so an old, reordered file cannot be installed
/// while its deletion is already staged. No network I/O occurs in this transaction.
pub async fn apply_deletions(ctx: &Ctx) -> Result<usize, String> {
    let pool = ctx.db.pool()?;
    let mut tx = pool.begin().await.map_err(fail)?;
    if execute(
        &mut tx,
        "UPDATE sync_state SET applying=1 WHERE workspace_id=? AND enabled=1 AND paused=0",
        &[json!(WORKSPACE)],
    )
    .await?
        == 0
    {
        return Ok(0);
    }
    execute(&mut tx, "PRAGMA defer_foreign_keys=ON", &[]).await?;
    let bodies:Vec<String>=sqlx::query_scalar("SELECT event FROM sync_inbox WHERE workspace_id=? AND applied=0 AND json_extract(event,'$.operation')!='put' ORDER BY CASE WHEN json_extract(event,'$.table')='$workspace' THEN 0 ELSE 1 END,cursor,id").bind(WORKSPACE).fetch_all(&mut *tx).await.map_err(fail)?;
    let mut count = 0;
    for body in bodies {
        let event: Change =
            serde_json::from_str(&body).map_err(|_| "A staged deletion marker is damaged.")?;
        event.validate()?;
        if deletion::apply(&mut tx, &event).await? {
            count += 1;
        }
    }
    execute(
        &mut tx,
        "UPDATE sync_state SET applying=0 WHERE workspace_id=?",
        &[json!(WORKSPACE)],
    )
    .await?;
    tx.commit().await.map_err(fail)?;
    Ok(count)
}

pub async fn ready_for_files(ctx: &Ctx, event: &Change) -> Result<bool, String> {
    let mut conn = ctx.db.pool()?.acquire().await.map_err(fail)?;
    Ok(deletion::incoming_guard(&mut conn, event).await?.is_none())
}

pub async fn stale(ctx: &Ctx, event: &Change) -> Result<bool, String> {
    let mut conn = ctx.db.pool()?.acquire().await.map_err(fail)?;
    deletion::stale(&mut conn, event).await
}

/// Stage missing parents; a complete cyclic component can commit with deferred foreign keys.
/// Files wait for the verified file store (step 6), and final deletion uses that step's purge.
pub async fn apply(ctx: &Ctx) -> Result<usize, String> {
    let pool = ctx.db.pool()?;
    let mut tx = pool.begin().await.map_err(fail)?;
    let active = execute(
        &mut tx,
        "UPDATE sync_state SET applying=1 WHERE workspace_id=? AND enabled=1 AND paused=0",
        &[json!(WORKSPACE)],
    )
    .await?;
    if active == 0 {
        return Ok(0);
    }
    execute(&mut tx, "PRAGMA defer_foreign_keys=ON", &[]).await?;
    let bodies: Vec<String> = sqlx::query_scalar(
        "SELECT event FROM sync_inbox WHERE workspace_id=? AND applied=0 ORDER BY cursor,id",
    )
    .bind(WORKSPACE)
    .fetch_all(&mut *tx)
    .await
    .map_err(fail)?;
    let mut candidates = Vec::new();
    for body in bodies {
        let event: Change =
            serde_json::from_str(&body).map_err(|_| "A staged sync record is damaged.")?;
        event.validate()?;
        if event.operation != Operation::Put {
            deletion::apply(&mut tx, &event).await?;
            continue;
        }
        if let Some(reason) = deletion::incoming_guard(&mut tx, &event).await? {
            match reason {
                "deleted" => {
                    complete(&mut tx, &event).await?;
                }
                "private" => {
                    complete(&mut tx, &event).await?;
                }
                "public_parent" => {
                    block(
                        &mut tx,
                        &event,
                        "Waiting for the shared file's public parent.",
                    )
                    .await?;
                }
                "undo" => {
                    block(
                        &mut tx,
                        &event,
                        "Waiting for the local deletion undo window.",
                    )
                    .await?;
                }
                _ => {
                    block(&mut tx, &event, "Waiting for the execution owner.").await?;
                }
            }
            continue;
        }
        let mut files_ready = true;
        for sha in super::attachments::referenced(&event)? {
            let verified:Option<i64>=sqlx::query_scalar("SELECT 1 FROM sync_transfers WHERE event_id=? AND sha256=? AND direction='download' AND bytes_done=total_bytes AND verified=1").bind(&event.id).bind(&sha).fetch_optional(&mut *tx).await.map_err(fail)?;
            files_ready &= verified.is_some();
        }
        if !files_ready {
            block(
                &mut tx,
                &event,
                "Waiting for verified encrypted file bytes.",
            )
            .await?;
            continue;
        }
        let existing = row(&mut tx, &event).await?;
        if existing.is_some() && meta(&mut tx, &event).await?.is_none() {
            block(
                &mut tx,
                &event,
                "Waiting for this installation's existing history to be captured.",
            )
            .await?;
            continue;
        }
        let payload = event
            .payload
            .clone()
            .ok_or("A staged put is missing its data.")?;
        let mut payload = canonicalize(&mut tx, &event, payload, existing.as_ref()).await?;
        if event.table == "files" {
            let sha = payload
                .get("sha256")
                .and_then(Value::as_str)
                .ok_or("Missing verified file hash.")?;
            payload.insert("storage_path".into(), json!(format!("files/{sha}")));
        }
        candidates.push((event, payload));
    }
    let mut ready: BTreeSet<usize> = (0..candidates.len()).collect();
    loop {
        let mut removed = Vec::new();
        for &index in &ready {
            let (event, payload) = &candidates[index];
            for fk in foreign(&mut tx, &event.table).await? {
                let Some(value) = payload.get(&fk.column).filter(|v| !v.is_null()) else {
                    continue;
                };
                let present: i64 = db::bind(
                    sqlx::query(&format!(
                        "SELECT COUNT(*) AS n FROM {} WHERE workspace_id=? AND {} IS ?",
                        fk.table, fk.target
                    )),
                    &[json!(WORKSPACE), value.clone()],
                )
                .fetch_one(&mut *tx)
                .await
                .map_err(fail)?
                .get("n");
                let staged = ready.iter().any(|other| {
                    candidates[*other].0.table == fk.table
                        && candidates[*other].1.get(&fk.target) == Some(value)
                });
                if present == 0 && !staged {
                    removed.push(index);
                    break;
                }
            }
        }
        if removed.is_empty() {
            break;
        }
        for index in removed {
            ready.remove(&index);
            block(
                &mut tx,
                &candidates[index].0,
                "Waiting for a missing parent record.",
            )
            .await?;
        }
    }
    let mut derived = BTreeSet::new();
    let mut processed = 0;
    for index in ready {
        let (event, payload) = &candidates[index];
        let current_meta = meta(&mut tx, event).await?;
        let mut vector = deletion::effective(&mut tx, event).await?;
        let mut selected = event.clone();
        let mut chosen = payload.clone();
        let existing = row(&mut tx, event).await?;
        let mut changed = true;
        if let Some(current_meta) = current_meta {
            let current_vector: Vector = serde_json::from_str(
                current_meta["version"]
                    .as_str()
                    .ok_or("Missing causal vector.")?,
            )
            .map_err(|_| "Damaged causal vector.")?;
            let reset = deletion::replaces_lifecycle(&mut tx, event, &current_meta).await?;
            let causality = if reset {
                Relation::After
            } else {
                relation(&vector, &current_vector)
            };
            if causality == Relation::Concurrent
                && current_meta["operation"] != "put"
                && event.table == "egress_rules"
                && payload.get("allow") == Some(&json!(0))
            {
                vector = union(&vector, &current_vector);
                install(&mut tx, event, payload, existing.is_some()).await?;
                archive(&mut tx, event).await?;
                record_meta(&mut tx, event, &vector).await?;
                execute(&mut tx,"INSERT INTO sync_policy_joins(workspace_id,user_id,record_key,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING",&[json!(WORKSPACE),json!(USER),json!(event.key),json!(now()),json!(now())]).await?;
                complete(&mut tx, event).await?;
                processed += 1;
                continue;
            }
            if matches!(causality, Relation::Before | Relation::Equal)
                || (causality == Relation::Concurrent && current_meta["operation"] != "put")
            {
                archive(&mut tx, event).await?;
                complete(&mut tx, event).await?;
                processed += 1;
                continue;
            }
            let current = revision(
                &mut tx,
                current_meta["event_id"]
                    .as_str()
                    .ok_or("Missing current revision.")?,
            )
            .await?
            .ok_or("A current sync revision is missing; pending history was preserved.")?;
            archive(&mut tx, &current).await?;
            if !reset {
                vector = union(&current_vector, &vector);
            }
            if causality == Relation::Concurrent {
                if needs_review(&current, event) {
                    let (a, b) = if current.id < event.id {
                        (&current, event)
                    } else {
                        (event, &current)
                    };
                    execute(&mut tx,"INSERT INTO sync_conflicts(id,workspace_id,user_id,table_name,record_key,ours,theirs,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",&[json!(format!("{}|{}",a.id,b.id)),json!(WORKSPACE),json!(USER),json!(event.table),json!(event.key),json!(serde_json::to_string(a).map_err(|_|"Couldn't save a review candidate.")?),json!(serde_json::to_string(b).map_err(|_|"Couldn't save a review candidate.")?),json!(now()),json!(now())]).await?;
                }
                if rank(&current) > rank(event) {
                    selected = current.clone();
                    chosen = canonicalize(
                        &mut tx,
                        &selected,
                        current.payload.clone().ok_or("Current put has no data.")?,
                        existing.as_ref(),
                    )
                    .await?;
                    changed = false;
                }
                if let Some(actual) = &existing {
                    let restricted = restrictive(&event.table, actual, payload, &chosen);
                    if restricted != chosen {
                        derived.insert(index);
                        changed = true;
                        chosen = restricted;
                    }
                }
            }
        }
        if changed {
            install(&mut tx, &selected, &chosen, existing.is_some()).await?;
        }
        archive(&mut tx, event).await?;
        record_meta(&mut tx, &selected, &vector).await?;
        resolve_review(&mut tx, event).await?;
        complete(&mut tx, event).await?;
        processed += 1;
    }
    execute(
        &mut tx,
        "UPDATE sync_state SET applying=0,force_capture=1 WHERE workspace_id=?",
        &[json!(WORKSPACE)],
    )
    .await?;
    // A restrictive join is a new causal revision, rather than an altered accepted packet.
    let joins = select(
        &mut tx,
        "SELECT record_key FROM sync_policy_joins WHERE workspace_id=?",
        &[json!(WORKSPACE)],
    )
    .await?;
    for joined in joins {
        let values: Vec<Value> = serde_json::from_str(
            joined["record_key"]
                .as_str()
                .ok_or("Invalid restrictive policy identity.")?,
        )
        .map_err(|_| "Invalid restrictive policy identity.")?;
        execute(&mut tx,"UPDATE egress_rules SET allow=0 WHERE project_id IS ? AND provider IS ? AND workspace_id=?",&[values.first().cloned().ok_or("Missing policy scope.")?,values.get(1).cloned().ok_or("Missing policy provider.")?,json!(WORKSPACE)]).await?;
    }
    execute(
        &mut tx,
        "DELETE FROM sync_policy_joins WHERE workspace_id=?",
        &[json!(WORKSPACE)],
    )
    .await?;
    for index in derived {
        let event = &candidates[index].0;
        let first = &keys(&event.table)?[0];
        let mut params = vec![json!(WORKSPACE), json!(USER)];
        params.extend(key_values(event)?);
        execute(
            &mut tx,
            &format!(
                "UPDATE {} SET {first}={first} WHERE workspace_id=? AND user_id=? AND {}",
                event.table,
                predicate(&event.table)?
            ),
            &params,
        )
        .await?;
    }
    execute(
        &mut tx,
        "UPDATE sync_state SET force_capture=0 WHERE workspace_id=?",
        &[json!(WORKSPACE)],
    )
    .await?;
    tx.commit().await.map_err(fail)?;
    Ok(processed)
}

/// Choosing a reviewed revision creates another signed, replicated revision. Merely receiving
/// a later edit never dismisses an unresolved review.
pub async fn resolve(ctx: &Ctx, id: String, choice: String) -> Result<(), String> {
    let _lock = ctx.sync.administration.lock().await;
    let pool = ctx.db.pool()?;
    let mut tx = pool.begin().await.map_err(fail)?;
    execute(
        &mut tx,
        "UPDATE sync_state SET force_capture=1 WHERE workspace_id=?",
        &[json!(WORKSPACE)],
    )
    .await?;
    let conflicts=select(&mut tx,"SELECT ours,theirs FROM sync_conflicts WHERE workspace_id=? AND table_name='memories' AND record_key=? AND resolved_at IS NULL",&[json!(WORKSPACE),json!(id)]).await?;
    if conflicts.is_empty() {
        return Err("This memory no longer has an unresolved sync conflict.".into());
    }
    let mut versions = BTreeMap::new();
    for conflict in conflicts {
        for field in ["ours", "theirs"] {
            let candidate: Change = serde_json::from_str(
                conflict[field]
                    .as_str()
                    .ok_or("Invalid review candidate.")?,
            )
            .map_err(|_| "Invalid review candidate.")?;
            versions.insert(candidate.id.clone(), candidate);
        }
    }
    let selected = versions
        .get(&choice)
        .ok_or("Choose one of the versions shown in this review.")?;
    let mut payload = selected
        .payload
        .clone()
        .ok_or("The chosen revision no longer has content.")?;
    let existing = row(&mut tx, selected)
        .await?
        .ok_or("The memory was deleted; this review cannot restore it.")?;
    let state = select(
        &mut tx,
        "SELECT device_id,enabled FROM sync_state WHERE workspace_id=?",
        &[json!(WORKSPACE)],
    )
    .await?
    .remove(0);
    if state["enabled"] != json!(1) {
        return Err("Enable sync before resolving a replicated conflict.".into());
    }
    // Choosing a conflicting text must not restore an older, less restrictive scope/policy.
    for field in [
        "may_send",
        "scope",
        "project_id",
        "thread_id",
        "status",
        "expires_at",
    ] {
        if let Some(value) = existing.get(field) {
            payload.insert(field.into(), value.clone());
        }
    }
    payload.insert(
        "revision".into(),
        json!(
            existing["revision"]
                .as_i64()
                .ok_or("Invalid memory revision.")?
                + 1
        ),
    );
    payload.insert("device_id".into(), state["device_id"].clone());
    payload.insert("updated_at".into(), json!(now()));
    let mut vector = Vector::new();
    for candidate in versions.values() {
        vector = union(&vector, &candidate.version);
    }
    if let Some(current) = meta(&mut tx, selected).await? {
        let current: Vector = serde_json::from_str(
            current["version"]
                .as_str()
                .ok_or("Invalid causal metadata.")?,
        )
        .map_err(|_| "Invalid causal metadata.")?;
        vector = union(&vector, &current);
    }
    execute(&mut tx,"UPDATE sync_records SET version=? WHERE workspace_id=? AND table_name='memories' AND record_key=?",&[json!(serde_json::to_string(&vector).map_err(|_|"Invalid causal metadata.")?),json!(WORKSPACE),json!(id)]).await?;
    let payload = remap(&mut tx, "memories", payload).await?;
    install(&mut tx, selected, &payload, true).await?;
    execute(&mut tx,"UPDATE sync_outbox SET resolves=? WHERE id=(SELECT device_id||':'||seq FROM sync_state WHERE workspace_id=?)",&[json!(serde_json::to_string(&versions.keys().collect::<Vec<_>>()).map_err(|_|"Couldn't record conflict resolution.")?),json!(WORKSPACE)]).await?;
    execute(&mut tx,"UPDATE sync_conflicts SET resolved_at=?,updated_at=? WHERE workspace_id=? AND table_name='memories' AND record_key=? AND resolved_at IS NULL",&[json!(now()),json!(now()),json!(WORKSPACE),json!(id)]).await?;
    execute(
        &mut tx,
        "UPDATE sync_state SET force_capture=0 WHERE workspace_id=?",
        &[json!(WORKSPACE)],
    )
    .await?;
    tx.commit().await.map_err(fail)?;
    ctx.sync.wake.notify_one();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{
        setup,
        tests::{cleanup, fixture},
        worker,
    };
    async fn put(ctx: &Ctx, sql: &str, params: &[Value]) {
        db::execute(&ctx.db.pool().unwrap(), sql, params)
            .await
            .unwrap();
    }
    async fn thread(ctx: &Ctx, id: &str, title: &str) {
        put(ctx,"INSERT INTO threads(id,workspace_id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,1,1)",&[json!(id),json!(WORKSPACE),json!(USER),json!(title)]).await;
    }
    async fn stage(ctx: &Ctx, event: &Change) {
        event.validate().unwrap();
        put(ctx,"INSERT INTO sync_inbox(id,workspace_id,user_id,envelope,event,cursor,created_at,updated_at) VALUES (?,?,?,'{}',?,(SELECT COALESCE(MAX(cursor),0)+1 FROM sync_inbox),1,1)",&[json!(event.id),json!(WORKSPACE),json!(USER),json!(serde_json::to_string(event).unwrap())]).await;
    }
    fn edit(base: &Change, actor: &str, clock: u64, field: &str, value: Value) -> Change {
        let mut event = base.clone();
        event.device_id = actor.into();
        event.seq = 1;
        event.id = format!("{actor}:1");
        event.clock = clock;
        event.version.insert(actor.into(), 1);
        event.payload.as_mut().unwrap().insert(field.into(), value);
        event
    }
    async fn scalar(ctx: &Ctx, sql: &str) -> i64 {
        sqlx::query_scalar(sql)
            .fetch_one(&ctx.db.pool().unwrap())
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn skill_packages_stage_dependencies_preserve_versions_and_propagate_deletion() {
        let source = fixture(true);
        let target = fixture(true);
        setup(&source, true).await.unwrap();
        setup(&target, true).await.unwrap();
        put(&source,"INSERT INTO skills(id,workspace_id,user_id,name,created_at,updated_at) VALUES('skill',?,?,'recorded',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        for id in ["version-a", "version-b"] {
            put(&source,"INSERT INTO skill_versions(id,workspace_id,user_id,skill_id,instructions,assets,sha256,source,created_at,updated_at) VALUES(?,?,?,'skill','Recorded instructions','[]',?,'fixture.zip',1,1)",&[json!(id),json!(WORKSPACE),json!(USER),json!("a".repeat(64))]).await;
        }
        let events = worker::pending(&source).await.unwrap();
        for event in events.iter().filter(|e| e.table == "skill_versions") {
            stage(&target, event).await;
        }
        apply(&target).await.unwrap();
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM skill_versions").await,
            0
        );
        for event in events.iter().filter(|e| e.table == "skills") {
            stage(&target, event).await;
        }
        apply(&target).await.unwrap();
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM skill_versions").await,
            2
        );
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM runs").await, 0);
        put(&source, "DELETE FROM skills WHERE id='skill'", &[]).await;
        let markers = worker::pending(&source).await.unwrap();
        for event in markers.iter().filter(|e| e.operation == Operation::Delete) {
            assert!(event.payload.is_none());
            stage(&target, event).await;
        }
        apply_deletions(&target).await.unwrap();
        apply(&target).await.unwrap();
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM skills").await, 0);
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM skill_versions").await,
            0
        );
        // A stale, previously received immutable version cannot resurrect its deleted package.
        for event in &events {
            let field = if event.table == "skills" {
                "name"
            } else {
                "instructions"
            };
            let stale = edit(
                event,
                &format!("offline-{}", event.key),
                event.clock + 1,
                field,
                event.payload.as_ref().unwrap()[field].clone(),
            );
            stage(&target, &stale).await;
        }
        apply_deletions(&target).await.unwrap();
        apply(&target).await.unwrap();
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM skill_versions").await,
            0
        );
        cleanup(&source).await;
        cleanup(&target).await;
    }
    #[tokio::test]
    async fn skill_privacy_withdraws_all_versions_and_keeps_owner_bytes() {
        let ctx = fixture(true);
        setup(&ctx, true).await.unwrap();
        put(&ctx,"INSERT INTO skills(id,workspace_id,user_id,name,created_at,updated_at) VALUES('private-skill',?,?,'recorded',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        put(&ctx,"INSERT INTO skill_versions(id,workspace_id,user_id,skill_id,instructions,assets,sha256,source,created_at,updated_at) VALUES('private-version',?,?,'private-skill','Keep owner content','[]',?,'fixture.zip',1,1)",&[json!(WORKSPACE),json!(USER),json!("a".repeat(64))]).await;
        put(
            &ctx,
            "UPDATE skills SET sync_local_only=1 WHERE id='private-skill'",
            &[],
        )
        .await;
        let immediate = worker::pending(&ctx).await.unwrap();
        assert!(immediate.iter().any(|e| e.table == "skills"
            && e.operation == Operation::Withdraw
            && e.payload.is_none()));
        crate::sync::privacy::sweep(&ctx).await.unwrap();
        let events = worker::pending(&ctx).await.unwrap();
        assert_eq!(events.len(), 2);
        assert!(
            events
                .iter()
                .all(|e| e.operation == Operation::Withdraw && e.payload.is_none())
        );
        assert_eq!(scalar(&ctx, "SELECT COUNT(*) FROM skill_versions").await, 1);
        assert_eq!(scalar(&ctx, "SELECT COUNT(*) FROM runs").await, 0);
        cleanup(&ctx).await;
    }
    #[tokio::test]
    async fn causality_beats_clock_skew_and_concurrent_loser_is_retained() {
        let ctx = fixture(true);
        setup(&ctx, true).await.unwrap();
        thread(&ctx, "t", "Initial").await;
        let base = worker::pending(&ctx).await.unwrap().remove(0);
        let later = edit(
            &base,
            "later",
            0,
            "title",
            json!("Later despite clock skew"),
        );
        stage(&ctx, &later).await;
        put(&ctx, "UPDATE sync_state SET paused=1", &[]).await;
        assert_eq!(apply(&ctx).await.unwrap(), 0);
        put(&ctx, "UPDATE sync_state SET paused=0", &[]).await;
        assert_eq!(apply(&ctx).await.unwrap(), 1);
        let title: String = sqlx::query_scalar("SELECT title FROM threads WHERE id='t'")
            .fetch_one(&ctx.db.pool().unwrap())
            .await
            .unwrap();
        assert_eq!(title, "Later despite clock skew");
        let concurrent = edit(
            &base,
            "concurrent",
            999,
            "title",
            json!("Concurrent winner"),
        );
        stage(&ctx, &concurrent).await;
        apply(&ctx).await.unwrap();
        let title: String = sqlx::query_scalar("SELECT title FROM threads WHERE id='t'")
            .fetch_one(&ctx.db.pool().unwrap())
            .await
            .unwrap();
        assert_eq!(title, "Concurrent winner");
        assert_eq!(scalar(&ctx, "SELECT COUNT(*) FROM sync_revisions").await, 3);
        assert_eq!(scalar(&ctx, "SELECT COUNT(*) FROM sync_outbox").await, 1); // incoming never recaptures
        assert_eq!(apply(&ctx).await.unwrap(), 0);
        assert_eq!(scalar(&ctx, "SELECT applying FROM sync_state").await, 0);
        cleanup(&ctx).await;
    }
    #[tokio::test]
    async fn fact_conflicts_survive_later_edits_until_an_explicit_replicated_resolution() {
        let ctx = fixture(true);
        setup(&ctx, true).await.unwrap();
        put(&ctx,"INSERT INTO memories(id,workspace_id,user_id,text,kind,authority,created_at,updated_at) VALUES ('m',?,?,'Initial','fact','you',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        let base = worker::pending(&ctx).await.unwrap().remove(0);
        let first = edit(&base, "a", 10, "text", json!("Choice A"));
        stage(&ctx, &first).await;
        apply(&ctx).await.unwrap();
        let second = edit(&base, "b", 20, "text", json!("Choice B"));
        stage(&ctx, &second).await;
        apply(&ctx).await.unwrap();
        assert_eq!(
            scalar(
                &ctx,
                "SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL"
            )
            .await,
            1
        );
        put(
            &ctx,
            "UPDATE memories SET expires_at=123,revision=revision+1 WHERE id='m'",
            &[],
        )
        .await;
        assert_eq!(
            scalar(
                &ctx,
                "SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL"
            )
            .await,
            1
        );
        assert!(
            resolve(&ctx, "m".into(), "not-a-candidate".into())
                .await
                .is_err()
        );
        let pending_before = worker::pending(&ctx).await.unwrap();
        put(&ctx, "UPDATE sync_state SET enabled=0", &[]).await;
        assert!(resolve(&ctx, "m".into(), first.id.clone()).await.is_err());
        assert_eq!(worker::pending(&ctx).await.unwrap(), pending_before);
        put(&ctx, "UPDATE sync_state SET enabled=1", &[]).await;
        resolve(&ctx, "m".into(), first.id.clone()).await.unwrap();
        let text: String = sqlx::query_scalar("SELECT text FROM memories WHERE id='m'")
            .fetch_one(&ctx.db.pool().unwrap())
            .await
            .unwrap();
        assert_eq!(text, "Choice A");
        let resolution = worker::pending(&ctx).await.unwrap().pop().unwrap();
        assert!(resolution.resolves.contains(&first.id));
        assert!(resolution.resolves.contains(&second.id));
        assert_eq!(
            relation(&resolution.version, &first.version),
            Relation::After
        );
        assert_eq!(
            relation(&resolution.version, &second.version),
            Relation::After
        );
        assert_eq!(
            scalar(
                &ctx,
                "SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL"
            )
            .await,
            0
        );
        cleanup(&ctx).await;
    }
    #[tokio::test]
    async fn missing_parent_is_staged_then_complete_cycles_commit_atomically() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        thread(&source, "t", "Cyclic").await;
        put(&source,"INSERT INTO messages(id,workspace_id,user_id,thread_id,role,content,status,created_at,updated_at) VALUES ('m',?,?,'t','user','Hello','complete',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        put(
            &source,
            "UPDATE threads SET active_leaf_id='m' WHERE id='t'",
            &[],
        )
        .await;
        let events = worker::pending(&source).await.unwrap();
        let target = fixture(true);
        setup(&target, true).await.unwrap();
        let thread = events.iter().rev().find(|e| e.table == "threads").unwrap();
        stage(&target, thread).await;
        assert_eq!(apply(&target).await.unwrap(), 0);
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM threads").await, 0);
        let message = events.iter().find(|e| e.table == "messages").unwrap();
        stage(&target, message).await;
        assert_eq!(apply(&target).await.unwrap(), 2);
        assert_eq!(
            scalar(
                &target,
                "SELECT COUNT(*) FROM threads WHERE active_leaf_id='m'"
            )
            .await,
            1
        );
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM pragma_foreign_key_check").await,
            0
        );
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM sync_outbox").await, 0);
        cleanup(&source).await;
        cleanup(&target).await;
    }
    #[tokio::test]
    async fn concurrent_policy_edits_create_a_restrictive_causal_join() {
        let ctx = fixture(true);
        setup(&ctx, true).await.unwrap();
        put(&ctx,"INSERT INTO egress_rules(id,workspace_id,user_id,provider,allow,created_at,updated_at) VALUES ('rule',?,?,'fixture',0,1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        let base = worker::pending(&ctx).await.unwrap().remove(0);
        let deny = edit(&base, "deny", 10, "allow", json!(0));
        stage(&ctx, &deny).await;
        apply(&ctx).await.unwrap();
        let allow = edit(&base, "allow", 30, "allow", json!(1));
        stage(&ctx, &allow).await;
        apply(&ctx).await.unwrap();
        assert_eq!(scalar(&ctx, "SELECT allow FROM egress_rules").await, 0);
        let joined = worker::pending(&ctx).await.unwrap().pop().unwrap();
        assert_eq!(joined.payload.as_ref().unwrap()["allow"], json!(0));
        assert_eq!(relation(&joined.version, &allow.version), Relation::After);
        assert_eq!(relation(&joined.version, &deny.version), Relation::After);
        cleanup(&ctx).await;
    }
    #[tokio::test]
    async fn natural_key_aliases_keep_both_artifact_versions_and_local_permissions() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        thread(&source, "t", "Shared").await;
        let target = fixture(true);
        setup(&target, true).await.unwrap();
        thread(&target, "t", "Shared").await;
        for (ctx, id, version, content) in [
            (&source, "a", "va", "Source bytes"),
            (&target, "z", "vz", "Target bytes"),
        ] {
            put(ctx,"INSERT INTO artifacts(id,workspace_id,user_id,thread_id,key,title,type,created_at,updated_at) VALUES (?,?,?,'t','doc','Document','markdown',1,1)",&[json!(id),json!(WORKSPACE),json!(USER)]).await;
            put(ctx,"INSERT INTO artifact_versions(id,workspace_id,user_id,artifact_id,version,content,source,created_at,updated_at) VALUES (?,?,?,?,1,?,'user',1,1)",&[json!(version),json!(WORKSPACE),json!(USER),json!(id),json!(content)]).await;
        }
        put(
            &target,
            "UPDATE artifacts SET allow_cdn=1 WHERE id='z'",
            &[],
        )
        .await;
        for event in worker::pending(&source)
            .await
            .unwrap()
            .iter()
            .filter(|e| e.table != "threads")
        {
            stage(&target, event).await;
        }
        apply(&target).await.unwrap();
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM artifacts").await, 1);
        assert_eq!(
            scalar(
                &target,
                "SELECT COUNT(*) FROM artifact_versions WHERE artifact_id='a'"
            )
            .await,
            2
        );
        assert_eq!(
            scalar(&target, "SELECT allow_cdn FROM artifacts WHERE id='a'").await,
            1
        );
        let mut connection = target.db.pool().unwrap().acquire().await.unwrap();
        assert_eq!(alias(&mut connection, "artifacts", "z").await.unwrap(), "a");
        drop(connection);
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM pragma_foreign_key_check").await,
            0
        );
        cleanup(&source).await;
        cleanup(&target).await;
    }
    #[tokio::test]
    async fn repeated_request_ids_preserve_integer_totals_and_runner_attribution() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        let target = fixture(true);
        setup(&target, true).await.unwrap();
        for ctx in [&source, &target] {
            put(ctx,"INSERT INTO request_log(id,workspace_id,user_id,purpose,provider,model,cost_micro_usd,surface,created_at,updated_at) VALUES ('request-one',?,?,'chat','fixture','fixture',1234567,'runner',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        }
        let event = worker::pending(&source).await.unwrap().remove(0);
        stage(&target, &event).await;
        apply(&target).await.unwrap();
        apply(&target).await.unwrap();
        assert_eq!(
            scalar(&target, "SELECT SUM(cost_micro_usd) FROM request_log").await,
            1234567
        );
        assert_eq!(
            scalar(
                &target,
                "SELECT COUNT(*) FROM request_log WHERE surface='runner'"
            )
            .await,
            1
        );
        cleanup(&source).await;
        cleanup(&target).await;
    }
    #[tokio::test]
    async fn malformed_record_rolls_back_the_entire_component_and_suppression_flag() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        thread(&source, "t", "Must roll back").await;
        put(&source,"INSERT INTO messages(id,workspace_id,user_id,thread_id,role,content,status,created_at,updated_at) VALUES ('m',?,?,'t','user','Hello','complete',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        let mut events = worker::pending(&source).await.unwrap();
        events
            .iter_mut()
            .find(|e| e.table == "messages")
            .unwrap()
            .payload
            .as_mut()
            .unwrap()
            .insert("status".into(), json!("malformed-state"));
        let target = fixture(true);
        setup(&target, true).await.unwrap();
        for event in events {
            stage(&target, &event).await;
        }
        assert!(apply(&target).await.is_err());
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM threads").await, 0);
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM sync_inbox WHERE applied=0").await,
            2
        );
        assert_eq!(scalar(&target, "SELECT applying FROM sync_state").await, 0);
        cleanup(&source).await;
        cleanup(&target).await;
    }
    #[tokio::test]
    async fn only_completed_run_history_moves_without_repository_access_or_execution_queue() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        put(&source,"INSERT INTO projects(id,workspace_id,user_id,name,repo_root,created_at,updated_at) VALUES ('p',?,?,'Fixture','/synthetic/machine/repo',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        put(&source,"INSERT INTO runs(id,workspace_id,user_id,project_id,task,mode,provider,model,status,cap_micro_usd,created_at,updated_at) VALUES ('r',?,?,'p','Synthetic completed history','plan','fixture','fixture','running',100,1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        put(&source,"INSERT INTO run_steps(id,workspace_id,user_id,run_id,seq,kind,tool_name,tool_call_id,input,output,created_at,updated_at) VALUES ('step',?,?,'r',1,'tool','read_file','call','{}','Recorded output',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        assert!(
            worker::pending(&source)
                .await
                .unwrap()
                .iter()
                .all(|e| e.table != "runs" && e.table != "run_steps")
        );
        put(&source, "UPDATE runs SET status='done' WHERE id='r'", &[]).await;
        worker::seed(&source).await.unwrap();
        let target = fixture(true);
        setup(&target, true).await.unwrap();
        for event in worker::pending(&source).await.unwrap() {
            assert!(
                !serde_json::to_string(&event)
                    .unwrap()
                    .contains("/synthetic/machine/repo")
            );
            stage(&target, &event).await;
        }
        apply(&target).await.unwrap();
        assert_eq!(
            scalar(
                &target,
                "SELECT COUNT(*) FROM runs WHERE sync_owner IS NOT NULL AND status='done'"
            )
            .await,
            1
        );
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM run_steps").await, 1);
        assert_eq!(
            scalar(
                &target,
                "SELECT COUNT(*) FROM projects WHERE repo_root IS NULL"
            )
            .await,
            1
        );
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM run_folders").await, 0);
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM run_requests").await,
            0
        );
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM schedules").await, 0);
        cleanup(&source).await;
        cleanup(&target).await;
    }
    #[tokio::test]
    async fn workspace_wipe_covers_unseen_offline_records_and_preserves_private_content() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        thread(&source, "source", "Origin").await;
        let mut wipe = worker::pending(&source).await.unwrap().remove(0);
        wipe.seq += 1;
        wipe.id = format!("{}:{}", wipe.device_id, wipe.seq);
        wipe.version.insert(wipe.device_id.clone(), wipe.seq);
        wipe.clock += 1;
        wipe.table = "$workspace".into();
        wipe.key = WORKSPACE.into();
        wipe.operation = Operation::Delete;
        wipe.payload = None;
        let target = fixture(true);
        setup(&target, true).await.unwrap();
        thread(&target, "unseen", "Offline and never uploaded").await;
        put(&target,"INSERT INTO memories(id,workspace_id,user_id,text,kind,authority,may_send,created_at,updated_at) VALUES ('private',?,?,'Keep this copy','fact','you',0,1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        stage(&target, &wipe).await;
        apply_deletions(&target).await.unwrap();
        assert_eq!(
            scalar(
                &target,
                "SELECT COUNT(*) FROM threads WHERE deleted_at IS NULL"
            )
            .await,
            0
        );
        assert_eq!(
            scalar(&target, "SELECT COUNT(*) FROM memories WHERE id='private'").await,
            1
        );
        thread(&target, "after", "Created after acknowledging the wipe").await;
        let event = worker::pending(&target)
            .await
            .unwrap()
            .into_iter()
            .find(|e| e.key == "after")
            .unwrap();
        assert!(
            event
                .barriers
                .get("$workspace")
                .is_some_and(|v| relation(v, &wipe.version) == Relation::Equal)
        );
        assert!(!stale(&target, &event).await.unwrap());
        cleanup(&source).await;
        cleanup(&target).await;
    }
    #[tokio::test]
    async fn thread_marker_removes_content_but_retains_content_free_cost_attribution() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        thread(&source, "t", "Deleted words").await;
        put(&source,"INSERT INTO messages(id,workspace_id,user_id,thread_id,role,content,status,created_at,updated_at) VALUES ('m',?,?,'t','user','Erase these words','complete',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        put(&source,"INSERT INTO request_log(id,workspace_id,user_id,thread_id,purpose,provider,model,cost_micro_usd,surface,error_message,created_at,updated_at) VALUES ('cost',?,?,'t','chat','fixture','fixture',123,'runner','Erase provider details',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        let target = fixture(true);
        setup(&target, true).await.unwrap();
        for event in worker::pending(&source).await.unwrap() {
            stage(&target, &event).await;
        }
        apply_deletions(&target).await.unwrap();
        apply(&target).await.unwrap();
        put(
            &source,
            "UPDATE threads SET deleted_at=10,purged_at=10 WHERE id='t'",
            &[],
        )
        .await;
        let marker = worker::pending(&source)
            .await
            .unwrap()
            .into_iter()
            .rfind(|e| e.table == "threads" && e.operation == Operation::Delete)
            .unwrap();
        stage(&target, &marker).await;
        apply_deletions(&target).await.unwrap();
        assert_eq!(scalar(&target, "SELECT COUNT(*) FROM messages").await, 0);
        assert_eq!(
            scalar(&target, "SELECT SUM(cost_micro_usd) FROM request_log").await,
            123
        );
        assert_eq!(scalar(&target,"SELECT COUNT(*) FROM request_log WHERE surface='runner' AND error_message IS NULL AND message_id IS NULL").await,1);
        assert_eq!(
            scalar(
                &target,
                "SELECT COUNT(*) FROM threads WHERE title='' AND purged_at IS NOT NULL"
            )
            .await,
            1
        );
        cleanup(&source).await;
        cleanup(&target).await;
    }
    #[tokio::test]
    async fn native_undo_finalizer_and_payload_retention_do_not_resurrect_a_deleted_chat() {
        let ctx = fixture(true);
        setup(&ctx, true).await.unwrap();
        thread(&ctx, "undo", "Retained until deadline").await;
        worker::cycle(&ctx, "test-lease").await.unwrap();
        put(&ctx, "UPDATE threads SET deleted_at=1 WHERE id='undo'", &[]).await;
        finalize(&ctx).await.unwrap();
        assert_eq!(
            scalar(
                &ctx,
                "SELECT COUNT(*) FROM threads WHERE id='undo' AND purged_at IS NULL"
            )
            .await,
            1
        );
        put(
            &ctx,
            "UPDATE threads SET deleted_at=NULL WHERE id='undo'",
            &[],
        )
        .await;
        assert_eq!(
            scalar(&ctx, "SELECT COUNT(*) FROM sync_pending_deletes").await,
            0
        );
        put(&ctx, "UPDATE threads SET deleted_at=2 WHERE id='undo'", &[]).await;
        put(&ctx, "UPDATE sync_pending_deletes SET deadline=0", &[]).await;
        finalize(&ctx).await.unwrap();
        assert_eq!(scalar(&ctx,"SELECT COUNT(*) FROM threads WHERE id='undo' AND title='' AND purged_at IS NOT NULL").await,1);
        worker::cycle(&ctx, "test-lease").await.unwrap();
        assert_eq!(
            scalar(
                &ctx,
                "SELECT COUNT(*) FROM sync_revisions WHERE json_extract(event,'$.operation')='put'"
            )
            .await,
            0
        );
        assert_eq!(
            scalar(
                &ctx,
                "SELECT COUNT(*) FROM sync_relay WHERE operation='put'"
            )
            .await,
            0
        );
        assert!(scalar(&ctx, "SELECT COUNT(*) FROM sync_seen").await >= 2);
        assert_eq!(
            scalar(
                &ctx,
                "SELECT COUNT(*) FROM sync_tombstones WHERE table_name='threads'"
            )
            .await,
            1
        );
        cleanup(&ctx).await;
    }
    #[tokio::test]
    async fn parent_privacy_sweep_withdraws_children_without_sending_their_content() {
        let ctx = fixture(true);
        setup(&ctx, true).await.unwrap();
        put(&ctx,"INSERT INTO projects(id,workspace_id,user_id,name,created_at,updated_at) VALUES ('private',?,?,'Before',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        thread(&ctx, "child", "Private after policy change").await;
        put(
            &ctx,
            "UPDATE threads SET project_id='private' WHERE id='child'",
            &[],
        )
        .await;
        worker::cycle(&ctx, "test-lease").await.unwrap();
        put(
            &ctx,
            "UPDATE projects SET privacy_mode='local_only' WHERE id='private'",
            &[],
        )
        .await;
        super::super::privacy::sweep(&ctx).await.unwrap();
        let pending = worker::pending(&ctx).await.unwrap();
        assert!(pending.iter().any(|e| e.table == "threads"
            && e.operation == Operation::Withdraw
            && e.payload.is_none()));
        assert!(pending.iter().all(|e| e.operation != Operation::Put));
        worker::cycle(&ctx, "test-lease").await.unwrap();
        assert_eq!(
            scalar(
                &ctx,
                "SELECT COUNT(*) FROM threads WHERE title='Private after policy change'"
            )
            .await,
            1
        );
        assert_eq!(
            scalar(
                &ctx,
                "SELECT COUNT(*) FROM sync_relay WHERE operation='put'"
            )
            .await,
            0
        );
        cleanup(&ctx).await;
    }
    #[tokio::test]
    async fn privacy_withdrawal_blocks_unseen_offline_costs_in_that_scope() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        put(&source,"INSERT INTO projects(id,workspace_id,user_id,name,created_at,updated_at) VALUES ('private-scope',?,?,'Scope',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        thread(&source, "scope-thread", "Scope history").await;
        put(
            &source,
            "UPDATE threads SET project_id='private-scope' WHERE id='scope-thread'",
            &[],
        )
        .await;
        put(&source,"INSERT INTO request_log(id,workspace_id,user_id,thread_id,purpose,provider,model,cost_micro_usd,created_at,updated_at) VALUES ('known-cost',?,?,'scope-thread','chat','fixture','fixture',17,1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        let initial = worker::pending(&source).await.unwrap();
        let mut unseen = initial
            .iter()
            .find(|e| e.table == "request_log")
            .unwrap()
            .clone();
        unseen.id = "offline:1".into();
        unseen.device_id = "offline".into();
        unseen.seq = 1;
        unseen.version.insert("offline".into(), 1);
        unseen.key = "unseen-cost".into();
        unseen
            .payload
            .as_mut()
            .unwrap()
            .insert("id".into(), json!("unseen-cost"));
        let target = fixture(true);
        setup(&target, true).await.unwrap();
        for event in initial {
            stage(&target, &event).await;
        }
        apply(&target).await.unwrap();
        put(
            &source,
            "UPDATE projects SET privacy_mode='local_only' WHERE id='private-scope'",
            &[],
        )
        .await;
        let marker = worker::pending(&source)
            .await
            .unwrap()
            .into_iter()
            .find(|e| e.table == "projects" && e.operation == Operation::Withdraw)
            .unwrap();
        stage(&target, &marker).await;
        apply_deletions(&target).await.unwrap();
        stage(&target, &unseen).await;
        apply(&target).await.unwrap();
        assert_eq!(
            scalar(
                &target,
                "SELECT COUNT(*) FROM request_log WHERE id='unseen-cost'"
            )
            .await,
            0
        );
        cleanup(&source).await;
        cleanup(&target).await;
    }
    #[tokio::test]
    async fn late_file_after_scope_deletion_needs_a_surviving_public_share() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        thread(&source, "file-owner", "Owner").await;
        let stored = crate::files::put(&source.data_dir, b"Synthetic shared file").unwrap();
        put(&source,"INSERT INTO files(id,workspace_id,user_id,name,mime,size_bytes,sha256,storage_path,thread_id,created_at,updated_at) VALUES ('late-file',?,?,'Fixture','text/plain',?,?,?,'file-owner',1,1)",&[json!(WORKSPACE),json!(USER),json!(stored.size),json!(stored.sha256),json!(format!("files/{}",stored.sha256))]).await;
        let initial = worker::pending(&source).await.unwrap();
        let file = initial.iter().find(|e| e.table == "files").unwrap().clone();
        let target = fixture(true);
        setup(&target, true).await.unwrap();
        for event in initial.into_iter().filter(|e| e.table != "files") {
            stage(&target, &event).await;
        }
        apply(&target).await.unwrap();
        put(
            &source,
            "UPDATE threads SET deleted_at=1,purged_at=1 WHERE id='file-owner'",
            &[],
        )
        .await;
        let marker = worker::pending(&source)
            .await
            .unwrap()
            .into_iter()
            .rfind(|e| e.table == "threads" && e.operation == Operation::Delete)
            .unwrap();
        stage(&target, &marker).await;
        apply_deletions(&target).await.unwrap();
        assert!(stale(&target, &file).await.unwrap());
        // A separate explicit public project share keeps the same file usable. Its parent can
        // arrive after the file: stage, apply that parent, then receive the bytes and link.
        put(&source,"INSERT INTO projects(id,workspace_id,user_id,name,created_at,updated_at) VALUES ('public-share',?,?,'Public',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        put(&source,"INSERT INTO project_files(id,workspace_id,user_id,project_id,file_id,created_at,updated_at) VALUES ('share-link',?,?,'public-share','late-file',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        let newer = worker::pending(&source).await.unwrap();
        let link = newer.iter().find(|e| e.table == "project_files").unwrap();
        stage(&target, link).await;
        assert!(!stale(&target, &file).await.unwrap());
        assert!(!ready_for_files(&target, &file).await.unwrap());
        let project = newer.iter().find(|e| e.table == "projects").unwrap();
        stage(&target, project).await;
        apply(&target).await.unwrap();
        assert!(ready_for_files(&target, &file).await.unwrap());
        cleanup(&source).await;
        cleanup(&target).await;
    }
    #[tokio::test]
    async fn concurrent_markers_keep_the_restrictive_scope_and_both_causal_barriers() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        put(&source,"INSERT INTO settings(workspace_id,user_id,key,value,created_at,updated_at) VALUES (?,?,'memory.suggest','on',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        let base = worker::pending(&source).await.unwrap().remove(0);
        let target = fixture(true);
        setup(&target, true).await.unwrap();
        stage(&target, &base).await;
        apply(&target).await.unwrap();
        for (actor, operation) in [
            ("delete-actor", Operation::Delete),
            ("private-actor", Operation::Withdraw),
        ] {
            let mut marker = base.clone();
            marker.id = format!("{actor}:1");
            marker.device_id = actor.into();
            marker.seq = 1;
            marker.version.insert(actor.into(), 1);
            marker.operation = operation;
            marker.payload = None;
            stage(&target, &marker).await;
            apply_deletions(&target).await.unwrap();
        }
        assert_eq!(scalar(&target,"SELECT COUNT(*) FROM sync_tombstones WHERE table_name='settings' AND operation='withdraw'").await,1);
        put(&target,"INSERT INTO settings(workspace_id,user_id,key,value,created_at,updated_at) VALUES (?,?,'memory.suggest','off',2,2)",&[json!(WORKSPACE),json!(USER)]).await;
        let fresh = worker::pending(&target).await.unwrap().remove(0);
        assert_eq!(fresh.version.get("delete-actor"), Some(&1));
        assert_eq!(fresh.version.get("private-actor"), Some(&1));
        assert!(!stale(&target, &fresh).await.unwrap());
        cleanup(&source).await;
        cleanup(&target).await;
    }
    #[tokio::test]
    async fn concurrent_rule_removal_never_relaxes_a_denial_in_either_delivery_order() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        put(&source,"INSERT INTO egress_rules(id,workspace_id,user_id,project_id,provider,allow,created_at,updated_at) VALUES ('rule',?,?,NULL,'openai',1,1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        let base = worker::pending(&source).await.unwrap().remove(0);
        let deny = edit(&base, "deny-actor", 1, "allow", json!(0));
        let mut remove = edit(&base, "remove-actor", 100, "allow", json!(1));
        remove.operation = Operation::Delete;
        remove.payload = None;
        for reverse in [false, true] {
            let target = fixture(true);
            setup(&target, true).await.unwrap();
            stage(&target, &base).await;
            apply(&target).await.unwrap();
            let ordered = if reverse {
                vec![&remove, &deny]
            } else {
                vec![&deny, &remove]
            };
            for event in ordered {
                stage(&target, event).await;
                apply_deletions(&target).await.unwrap();
                apply(&target).await.unwrap();
            }
            assert_eq!(
                scalar(
                    &target,
                    "SELECT COUNT(*) FROM egress_rules WHERE provider='openai' AND allow=0"
                )
                .await,
                1
            );
            let joined = worker::pending(&target)
                .await
                .unwrap()
                .into_iter()
                .rfind(|e| e.table == "egress_rules")
                .unwrap();
            assert_eq!(joined.version.get("deny-actor"), Some(&1));
            assert_eq!(joined.version.get("remove-actor"), Some(&1));
            cleanup(&target).await;
        }
        cleanup(&source).await;
    }
}
