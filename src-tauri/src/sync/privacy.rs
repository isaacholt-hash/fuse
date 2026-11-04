//! Live privacy checks and explicit provenance projection. No content is sent merely by pairing.
use super::{
    Ctx, USER, WORKSPACE, registry,
    transport::{Change, Operation, Unavailable},
};
use crate::db;
use serde_json::{Value, json};

#[derive(Debug)]
pub struct Eligibility {
    pub present: bool,
    pub eligible: bool,
    pub ready: bool,
}
pub async fn live(ctx: &Ctx, event: &Change) -> Result<Eligibility, String> {
    event.validate()?;
    let spec = &registry()["tables"][&event.table];
    let eligible = spec["eligible"]
        .as_str()
        .ok_or("Invalid privacy registry.")?
        .replace("{a}", "r");
    let ready = spec["ready"]
        .as_str()
        .ok_or("Invalid publication registry.")?
        .replace("{a}", "r");
    let mut params = vec![json!(WORKSPACE), json!(USER)];
    params.extend(super::merge::key_values(event)?);
    let rows=db::select(&ctx.db.pool()?,&format!("SELECT ({eligible}) AS eligible,({ready}) AS ready FROM {} r WHERE r.workspace_id=? AND r.user_id=? AND {}",event.table,super::merge::predicate(&event.table)?),&params).await?;
    let mut result = match rows.first() {
        Some(row) => Eligibility {
            present: true,
            eligible: row["eligible"] == json!(1),
            ready: row["ready"] == json!(1),
        },
        None => Eligibility {
            present: false,
            eligible: false,
            ready: false,
        },
    };
    // A child captured during its parent's undo window must wait, even if its own row is final.
    if event.operation == Operation::Put {
        let mut todo = vec![(
            event.table.clone(),
            event.payload.clone().unwrap_or_default(),
        )];
        let mut seen = std::collections::BTreeSet::new();
        while let Some((table, row)) = todo.pop() {
            for reference in registry()["tables"][&table]["references"]
                .as_array()
                .ok_or("Invalid ownership registry.")?
            {
                let column = reference["column"]
                    .as_str()
                    .ok_or("Invalid ownership field.")?;
                if reference["ownership"] != true {
                    continue;
                }
                let Some(id) = row.get(column).and_then(Value::as_str) else {
                    continue;
                };
                let parent = reference["table"]
                    .as_str()
                    .ok_or("Invalid ownership table.")?;
                if !seen.insert((parent.to_owned(), id.to_owned())) {
                    continue;
                }
                let target = reference["target"]
                    .as_str()
                    .ok_or("Invalid ownership key.")?;
                let parents = db::select(
                    &ctx.db.pool()?,
                    &format!("SELECT * FROM {parent} WHERE workspace_id=? AND {target}=?"),
                    &[json!(WORKSPACE), json!(id)],
                )
                .await?;
                if let Some(value) = parents.first() {
                    if parent == "threads" && !value["deleted_at"].is_null() {
                        result.ready = false;
                    }
                    todo.push((parent.into(), value.clone().into_iter().collect()));
                }
            }
        }
    }
    Ok(result)
}

pub async fn project(ctx: &Ctx, mut event: Change) -> Result<Change, String> {
    if event.format < 2 || event.table == "$workspace" {
        return Ok(event);
    }
    if event.operation != Operation::Put {
        let mut retained = event.retained.take().unwrap_or_default();
        let ids=db::select(&ctx.db.pool()?,"SELECT original_id FROM sync_entities WHERE workspace_id=? AND table_name=? AND record_key=? ORDER BY original_id",&[json!(WORKSPACE),json!(event.table),json!(event.key)]).await?;
        if !ids.is_empty() {
            retained.insert(
                "ids".into(),
                json!(
                    ids.iter()
                        .map(|r| r["original_id"].clone())
                        .collect::<Vec<_>>()
                ),
            );
        }
        let parents=db::select(&ctx.db.pool()?,"SELECT column_name AS column,parent_table AS `table`,parent_id AS id,parent_key AS key FROM sync_lineage WHERE workspace_id=? AND table_name=? AND record_key=? ORDER BY column_name",&[json!(WORKSPACE),json!(event.table),json!(event.key)]).await?;
        if !parents.is_empty() {
            retained.insert("parents".into(), json!(parents));
        }
        let scope=db::select(&ctx.db.pool()?,"SELECT scope FROM sync_tombstones WHERE workspace_id=? AND table_name=? AND record_key=?",&[json!(WORKSPACE),json!(event.table),json!(event.key)]).await?;
        if scope.first().is_some_and(|r| r["scope"] == "archive") {
            retained.insert("mode".into(), json!("archive"));
        }
        if !retained.is_empty() {
            event.retained = Some(retained);
        }
        event.validate()?;
        return Ok(event);
    }
    let spec = &registry()["tables"][&event.table];
    let Some(row) = event.payload.as_mut() else {
        return Ok(event);
    };
    for reference in spec["references"]
        .as_array()
        .ok_or("Invalid provenance registry.")?
    {
        if reference["optional"] != true {
            continue;
        }
        let column = reference["column"]
            .as_str()
            .ok_or("Invalid provenance field.")?;
        let Some(id) = row.get(column).and_then(Value::as_str).map(str::to_owned) else {
            continue;
        };
        let table = reference["table"]
            .as_str()
            .ok_or("Invalid provenance table.")?;
        let target = reference["target"]
            .as_str()
            .ok_or("Invalid provenance identity.")?;
        let eligible = registry()["tables"][table]["eligible"]
            .as_str()
            .ok_or("Invalid privacy registry.")?
            .replace("{a}", "p");
        let parent = db::select(
            &ctx.db.pool()?,
            &format!(
                "SELECT ({eligible}) AS eligible FROM {table} p WHERE workspace_id=? AND {target}=?"
            ),
            &[json!(WORKSPACE), json!(id)],
        )
        .await?;
        if parent.first().is_some_and(|p| p["eligible"] == json!(0)) {
            row.insert(column.into(), Value::Null);
            event.unavailable.insert(
                column.into(),
                Unavailable {
                    table: table.into(),
                    id,
                    reason: "private_parent".into(),
                },
            );
        }
        // A merely missing parent stays referenced and staged, never silently cleared.
    }
    event.validate()?;
    Ok(event)
}

/// Re-evaluate previously published rows after a parent policy change. Trigger capture stays
/// atomic with the policy-derived write; never rewrite an already accepted event body.
pub async fn sweep(ctx: &Ctx) -> Result<(), String> {
    let pool = ctx.db.pool()?;
    for (table, spec) in registry()["tables"]
        .as_object()
        .ok_or("Invalid sync registry.")?
    {
        let keys = spec["key"].as_array().ok_or("Invalid sync key.")?;
        let first = keys[0].as_str().ok_or("Invalid sync key.")?;
        let key = if keys.len() == 1 && first == "id" {
            "r.id".into()
        } else {
            format!(
                "json_array({})",
                keys.iter()
                    .map(|v| format!("r.{}", v.as_str().unwrap_or("")))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        };
        let eligible = spec["eligible"]
            .as_str()
            .ok_or("Invalid privacy registry.")?
            .replace("{a}", "r");
        let ready = spec["ready"]
            .as_str()
            .ok_or("Invalid publication registry.")?
            .replace("{a}", "r");
        let sql = format!(
            "UPDATE {table} SET {first}={first} WHERE rowid IN (SELECT r.rowid FROM {table} r JOIN sync_records s ON s.workspace_id=r.workspace_id AND s.table_name='{table}' AND s.record_key={key} WHERE r.workspace_id=? AND s.operation='put' AND ((NOT ({eligible})) OR (s.wire_format=1 AND ({ready}) AND NOT EXISTS(SELECT 1 FROM sync_outbox o WHERE o.workspace_id=s.workspace_id AND o.table_name=s.table_name AND o.record_key=s.record_key))) LIMIT 100)"
        );
        db::batch(
            &pool,
            &[
                db::Statement {
                    sql: "UPDATE sync_state SET force_capture=1 WHERE workspace_id=?".into(),
                    params: vec![json!(WORKSPACE)],
                },
                db::Statement {
                    sql,
                    params: vec![json!(WORKSPACE)],
                },
                db::Statement {
                    sql: "UPDATE sync_state SET force_capture=0 WHERE workspace_id=?".into(),
                    params: vec![json!(WORKSPACE)],
                },
            ],
        )
        .await?;
    }
    Ok(())
}
