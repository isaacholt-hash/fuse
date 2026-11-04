//! Content-free deletion barriers. No repository, command, approval or scheduling action runs here.
use super::*;

fn dominates(a: &Vector, b: &Vector) -> bool {
    matches!(relation(a, b), Relation::After | Relation::Equal)
}
fn barriers(event: &Change, tag: &str, version: &Vector) -> bool {
    event
        .barriers
        .get(tag)
        .is_some_and(|seen| dominates(seen, version))
}
fn parse_vector(value: &Value) -> Result<Vector, String> {
    serde_json::from_str(value.as_str().ok_or("Missing deletion causality.")?)
        .map_err(|_| "Invalid deletion causality.".into())
}
async fn markers(
    conn: &mut SqliteConnection,
    table: &str,
    key: &str,
) -> Result<Option<Record>, String> {
    Ok(select(
        conn,
        "SELECT * FROM sync_tombstones WHERE workspace_id=? AND table_name=? AND record_key=?",
        &[json!(WORKSPACE), json!(table), json!(key)],
    )
    .await?
    .into_iter()
    .next())
}

/// None means an explicit public link is waiting for its parent; it must be staged, not lost.
fn public_parent<'a>(
    conn: &'a mut SqliteConnection,
    table: &'a str,
    id: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<bool>, String>> + Send + 'a>>
{
    Box::pin(async move {
        let value = select(
            conn,
            &format!("SELECT * FROM {table} WHERE workspace_id=? AND id=?"),
            &[json!(WORKSPACE), json!(id)],
        )
        .await?
        .into_iter()
        .next();
        let Some(value) = value else {
            return Ok(None);
        };
        let pending=select(conn,"SELECT 1 AS n FROM sync_inbox WHERE applied=0 AND json_extract(event,'$.table')=? AND json_extract(event,'$.key')=? AND json_extract(event,'$.operation')='put' LIMIT 1",&[json!(table),json!(id)]).await?;
        let no = if pending.is_empty() {
            Some(false)
        } else {
            None
        };
        if value.get("deleted_at").is_some_and(|v| !v.is_null())
            || value.get("incognito") == Some(&json!(1))
            || value.get("local_only") == Some(&json!(1))
            || value.get("privacy_mode") == Some(&json!("local_only"))
        {
            return Ok(no);
        }
        if let Some(marker) = markers(conn, table, id).await? {
            let current=select(conn,"SELECT version,operation FROM sync_records WHERE workspace_id=? AND table_name=? AND record_key=?",&[json!(WORKSPACE),json!(table),json!(id)]).await?;
            let marker_version = parse_vector(&marker["version"])?;
            let live = match current.first() {
                Some(m) if m["operation"] == "put" => {
                    relation(&parse_vector(&m["version"])?, &marker_version) == Relation::After
                }
                _ => false,
            };
            if !live {
                return Ok(no);
            }
        }
        let parent = match table {
            "messages" => Some(("threads", "thread_id")),
            "threads" => Some(("projects", "project_id")),
            _ => None,
        };
        if let Some((parent, column)) = parent
            && let Some(id) = value.get(column).and_then(Value::as_str)
        {
            return public_parent(conn, parent, id).await;
        }
        Ok(Some(true))
    })
}
async fn file_share(conn: &mut SqliteConnection, event: &Change) -> Result<Option<bool>, String> {
    let mut waiting = false;
    for (table, column, parent) in [
        ("project_files", "project_id", "projects"),
        ("message_files", "message_id", "messages"),
    ] {
        let links = select(
            conn,
            &format!(
                "SELECT {column} AS parent FROM {table} WHERE workspace_id=? AND file_id=?{}",
                if table == "project_files" {
                    " AND deleted_at IS NULL"
                } else {
                    ""
                }
            ),
            &[json!(WORKSPACE), json!(event.key)],
        )
        .await?;
        let staged=select(conn,"SELECT json_extract(event,?) AS parent FROM sync_inbox WHERE applied=0 AND json_extract(event,'$.operation')='put' AND json_extract(event,'$.table')=? AND json_extract(event,'$.payload.file_id')=?",&[json!(format!("$.payload.{column}")),json!(table),json!(event.key)]).await?;
        for link in links.into_iter().chain(staged) {
            let Some(id) = link["parent"].as_str() else {
                continue;
            };
            match public_parent(conn, parent, id).await? {
                Some(true) => return Ok(Some(true)),
                None => waiting = true,
                _ => {}
            }
        }
    }
    Ok(if waiting { None } else { Some(false) })
}
/// Returns true for old/concurrent puts. Separate lifecycle acknowledgements avoid falsely
/// ordering unrelated record edits merely because their parents were delivered first.
pub(super) async fn stale(conn: &mut SqliteConnection, event: &Change) -> Result<bool, String> {
    if event.table == "$workspace" {
        return Ok(false);
    }
    if let Some(marker) = markers(conn, "$workspace", WORKSPACE).await?
        && !barriers(event, "$workspace", &parse_vector(&marker["version"])?)
    {
        return Ok(true);
    }
    if let Some(marker) = markers(conn, &event.table, &event.key).await? {
        let version = parse_vector(&marker["version"])?;
        let scope = marker["scope"].as_str().unwrap_or("record");
        let tag = if scope == "workspace" {
            Some("$workspace")
        } else {
            scope.strip_prefix("ancestor:")
        };
        let acknowledged = tag.is_some_and(|tag| barriers(event, tag, &version));
        if !acknowledged && !matches!(relation(&event.version, &version), Relation::After) {
            // Concurrent denial remains restrictive even when the other edit removed the rule.
            if event.table == "egress_rules"
                && event
                    .payload
                    .as_ref()
                    .is_some_and(|r| r.get("allow") == Some(&json!(0)))
                && relation(&event.version, &version) == Relation::Concurrent
            {
                return Ok(false);
            }
            return Ok(true);
        }
    }
    let Some(payload) = &event.payload else {
        return Ok(false);
    };
    let mut ancestors = Vec::new();
    let mut seen = BTreeSet::new();

    for reference in registry()["tables"][&event.table]["references"]
        .as_array()
        .ok_or("Invalid ownership registry.")?
    {
        let column = reference["column"]
            .as_str()
            .ok_or("Invalid ownership field.")?;
        let ownership = reference["ownership"] == true;
        // Ledger links survive ordinary conversation deletion, but may not bypass a privacy
        // withdrawal. Shared files are evaluated through their explicit public relationships.
        let privacy_scope = matches!(column, "project_id" | "thread_id" | "run_id");
        if !ownership && !privacy_scope {
            continue;
        }
        if let Some(id) = payload.get(column).and_then(Value::as_str) {
            ancestors.push((
                reference["table"]
                    .as_str()
                    .ok_or("Invalid ownership table.")?
                    .to_owned(),
                id.to_owned(),
                !ownership && event.table != "files",
            ));
        }
    }
    while let Some((table, id, privacy_only)) = ancestors.pop() {
        if !seen.insert((table.clone(), id.clone(), privacy_only)) {
            continue;
        }
        let entity=select(conn,"SELECT record_key FROM sync_entities WHERE workspace_id=? AND table_name=? AND original_id=?",&[json!(WORKSPACE),json!(table),json!(id)]).await?;
        let key = entity
            .first()
            .and_then(|r| r["record_key"].as_str())
            .map(str::to_owned)
            .or_else(|| (keys(&table).ok() == Some(vec!["id".into()])).then_some(id));
        let Some(key) = key else {
            continue;
        };
        if let Some(marker) = markers(conn, &table, &key).await?
            && marker["scope"] != "archive"
            && (!privacy_only || marker["operation"] == "withdraw")
            && !barriers(
                event,
                &format!("{table}:{key}"),
                &parse_vector(&marker["version"])?,
            )
            && (event.table != "files" || file_share(conn, event).await? == Some(false))
        {
            return Ok(true);
        }
        for parent in select(conn,"SELECT column_name,parent_table,parent_id FROM sync_lineage WHERE workspace_id=? AND table_name=? AND record_key=?",&[json!(WORKSPACE),json!(table),json!(key)]).await? {
            let ownership=registry()["tables"][&table]["references"].as_array().is_some_and(|refs|refs.iter().any(|r|r["column"]==parent["column_name"]&&r["ownership"]==true));
            let scope=table!="files" && matches!(parent["column_name"].as_str(),Some("project_id"|"thread_id"|"run_id"));
            if ownership||scope {ancestors.push((parent["parent_table"].as_str().ok_or("Invalid ownership table.")?.into(),parent["parent_id"].as_str().ok_or("Invalid ownership identity.")?.into(),privacy_only||!ownership));}
        }
        // Reordered children must also see the ownership of parents still staged in this page.
        for staged in select(conn,"SELECT event FROM sync_inbox WHERE applied=0 AND json_extract(event,'$.table')=? AND json_extract(event,'$.key')=? AND json_extract(event,'$.operation')='put'",&[json!(table),json!(key)]).await? {
            let parent:Change=serde_json::from_str(staged["event"].as_str().ok_or("Missing staged ancestry.")?).map_err(|_|"Invalid staged ancestry.")?;
            if let Some(payload)=parent.payload {
                for reference in registry()["tables"][&table]["references"].as_array().ok_or("Invalid ownership registry.")? {
                    let column=reference["column"].as_str().ok_or("Invalid ownership field.")?;
                    let ownership=reference["ownership"]==true;
                    if !ownership && !matches!(column,"project_id"|"thread_id"|"run_id"){continue;}
                    if let Some(id)=payload.get(column).and_then(Value::as_str){ancestors.push((reference["table"].as_str().ok_or("Invalid ownership table.")?.into(),id.into(),privacy_only||!ownership));}
                }
            }
        }
    }

    Ok(false)
}

async fn remember(conn: &mut SqliteConnection, event: &Change) -> Result<(), String> {
    let mut version = event.version.clone();
    let mut operation = event.operation.clone();
    let mut previous_scope = None;
    if let Some(previous) = markers(conn, &event.table, &event.key).await? {
        let prior = parse_vector(&previous["version"])?;
        match relation(&event.version, &prior) {
            Relation::Before => {
                operation = if previous["operation"] == "withdraw" {
                    Operation::Withdraw
                } else {
                    Operation::Delete
                };
                previous_scope = previous["scope"].as_str().map(str::to_owned);
            }
            Relation::Concurrent | Relation::Equal if previous["operation"] == "withdraw" => {
                operation = Operation::Withdraw
            }
            _ => {}
        }
        version = union(&version, &prior);
    }
    let scope = previous_scope.unwrap_or_else(|| {
        if operation == Operation::Delete
            && event.table == "projects"
            && event
                .retained
                .as_ref()
                .is_some_and(|r| r.get("mode") == Some(&json!("archive")))
        {
            "archive".into()
        } else {
            "record".into()
        }
    });
    execute(conn,"INSERT INTO sync_tombstones(workspace_id,user_id,table_name,record_key,event_id,operation,version,scope,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET event_id=excluded.event_id,operation=excluded.operation,version=excluded.version,scope=excluded.scope,updated_at=excluded.updated_at",&[json!(WORKSPACE),json!(USER),json!(event.table),json!(event.key),json!(event.id),json!(match operation {Operation::Delete=>"delete",_=>"withdraw"}),json!(serde_json::to_string(&version).map_err(|_|"Couldn't retain deletion causality.")?),json!(scope),json!(now()),json!(now())]).await?;
    if let Some(retained) = &event.retained
        && let Some(ids) = retained.get("ids").and_then(Value::as_array)
    {
        for id in ids {
            execute(conn,"INSERT INTO sync_entities(workspace_id,user_id,table_name,original_id,record_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,table_name,original_id) DO NOTHING",&[json!(WORKSPACE),json!(USER),json!(event.table),id.clone(),json!(event.key),json!(now()),json!(now())]).await?;
        }
    }
    if let Some(parents) = event
        .retained
        .as_ref()
        .and_then(|r| r.get("parents"))
        .and_then(Value::as_array)
    {
        for parent in parents {
            execute(conn,"INSERT INTO sync_lineage(workspace_id,user_id,table_name,record_key,column_name,parent_table,parent_id,parent_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",&[json!(WORKSPACE),json!(USER),json!(event.table),json!(event.key),parent["column"].clone(),parent["table"].clone(),parent["id"].clone(),parent["key"].clone(),json!(now()),json!(now())]).await?;
        }
    }
    Ok(())
}

pub(super) async fn effective(
    conn: &mut SqliteConnection,
    event: &Change,
) -> Result<Vector, String> {
    let mut version = event.version.clone();
    if let Some(global) = markers(conn, "$workspace", WORKSPACE).await? {
        let marker = parse_vector(&global["version"])?;
        if barriers(event, "$workspace", &marker) {
            version = union(&version, &marker);
        }
    }
    if let Some(marker) = markers(conn, &event.table, &event.key).await? {
        let scope = marker["scope"].as_str().unwrap_or("record");
        let tag = if scope == "workspace" {
            Some("$workspace")
        } else {
            scope.strip_prefix("ancestor:")
        };
        if let Some(tag) = tag {
            let marker = parse_vector(&marker["version"])?;
            if barriers(event, tag, &marker) {
                version = union(&version, &marker);
            }
        }
    }
    Ok(version)
}

async fn private_copy(
    conn: &mut SqliteConnection,
    event: &Change,
    existing: &Record,
    seen: &mut BTreeSet<(String, String)>,
) -> Result<bool, String> {
    if !seen.insert((event.table.clone(), event.key.clone())) {
        return Ok(false);
    }
    let spec = &registry()["tables"][&event.table];
    let eligible = spec["eligible"]
        .as_str()
        .ok_or("Invalid privacy registry.")?
        .replace("{a}", "r");
    let mut params = vec![json!(WORKSPACE), json!(USER)];
    params.extend(key_values(event)?);
    let eligible = select(
        conn,
        &format!(
            "SELECT ({eligible}) AS eligible FROM {} r WHERE workspace_id=? AND user_id=? AND {}",
            event.table,
            predicate(&event.table)?
        ),
        &params,
    )
    .await?;
    if eligible.first().is_some_and(|r| r["eligible"] == json!(1)) {
        return Ok(false);
    }
    if existing.get("privacy_mode") == Some(&json!("local_only"))
        || existing.get("incognito") == Some(&json!(1))
        || existing.get("local_only") == Some(&json!(1))
        || existing.get("may_send") == Some(&json!(0))
        || existing.get("sync_local_only") == Some(&json!(1))
    {
        return Ok(true);
    }
    if event.table == "files" {
        let indexed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM folder_files WHERE workspace_id=? AND file_id=?",
        )
        .bind(WORKSPACE)
        .bind(&event.key)
        .fetch_one(&mut *conn)
        .await
        .map_err(fail)?;
        if indexed > 0 {
            return Ok(true);
        }
    }
    // Follow ownership scopes without treating optional provenance as a private owner.
    let mut parents = vec![(event.table.clone(), existing.clone())];
    while let Some((table, value)) = parents.pop() {
        if value.get("privacy_mode") == Some(&json!("local_only"))
            || value.get("incognito") == Some(&json!(1))
            || value.get("local_only") == Some(&json!(1))
            || value.get("may_send") == Some(&json!(0))
            || value.get("sync_local_only") == Some(&json!(1))
        {
            return Ok(true);
        }
        let refs = registry()["tables"][&table]["references"]
            .as_array()
            .ok_or("Invalid privacy ownership registry.")?;
        for reference in refs {
            let column = reference["column"]
                .as_str()
                .ok_or("Invalid privacy field.")?;
            if reference["ownership"] != true
                && !matches!(column, "project_id" | "thread_id" | "run_id")
            {
                continue;
            }
            let Some(id) = value.get(column).and_then(Value::as_str) else {
                continue;
            };
            let parent = reference["table"]
                .as_str()
                .ok_or("Invalid privacy parent.")?;
            if !seen.insert((parent.into(), id.into())) {
                continue;
            }
            let target = reference["target"]
                .as_str()
                .ok_or("Invalid privacy identity.")?;
            if let Some(value) = select(
                conn,
                &format!("SELECT * FROM {parent} WHERE workspace_id=? AND {target}=?"),
                &[json!(WORKSPACE), json!(id)],
            )
            .await?
            .into_iter()
            .next()
            {
                parents.push((parent.into(), value));
            }
        }
    }
    Ok(false)
}

pub(super) async fn execution_owned(
    conn: &mut SqliteConnection,
    event: &Change,
) -> Result<bool, String> {
    let owned = "(sync_owner IS NULL OR sync_owner=(SELECT device_id FROM sync_state WHERE workspace_id=runs.workspace_id))";
    let (filter, params) = match event.table.as_str() {
        "$workspace" => ("1".to_owned(), vec![json!(WORKSPACE)]),
        "projects" => (
            "project_id=?".into(),
            vec![json!(WORKSPACE), json!(event.key)],
        ),
        "threads" => (
            "thread_id=?".into(),
            vec![json!(WORKSPACE), json!(event.key)],
        ),
        "runs" => ("id=?".into(), vec![json!(WORKSPACE), json!(event.key)]),
        "run_steps" | "run_changes" => {
            let value = if let Some(payload) = &event.payload {
                Some(payload.clone())
            } else {
                row(conn, event).await?
            };
            let Some(id) = value
                .as_ref()
                .and_then(|r| r.get("run_id"))
                .and_then(Value::as_str)
            else {
                return Ok(false);
            };
            ("id=?".into(), vec![json!(WORKSPACE), json!(id)])
        }
        "messages" => (
            "message_id=?".into(),
            vec![json!(WORKSPACE), json!(event.key)],
        ),
        _ => return Ok(false),
    };
    let runs=select(conn,&format!("SELECT * FROM runs WHERE workspace_id=? AND status IN ('running','paused') AND {owned} AND ({filter})"),&params).await?;
    for value in runs {
        let candidate = from_row(event, "runs", &value)?;
        if !private_copy(conn, &candidate, &value, &mut BTreeSet::new()).await? {
            return Ok(true);
        }
    }
    if matches!(
        event.table.as_str(),
        "$workspace" | "projects" | "threads" | "messages"
    ) {
        let mut params = vec![json!(WORKSPACE)];
        let condition = match event.table.as_str() {
            "$workspace" => "1".to_owned(),
            "projects" => {
                params.push(json!(event.key));
                "thread_id IN (SELECT id FROM threads WHERE project_id=?)".into()
            }
            "threads" => {
                params.push(json!(event.key));
                "thread_id=?".into()
            }
            _ => {
                params.push(json!(event.key));
                "id=?".into()
            }
        };
        for value in select(conn,&format!("SELECT * FROM messages WHERE workspace_id=? AND status='streaming' AND ({condition})"),&params).await? {
            let candidate=from_row(event,"messages",&value)?;
            if !private_copy(conn,&candidate,&value,&mut BTreeSet::new()).await? {return Ok(true);}
        }
    }
    if matches!(event.table.as_str(), "$workspace" | "projects") {
        let (sql, params) = if event.table == "projects" {
            (
                "SELECT COUNT(*) AS n FROM schedules WHERE workspace_id=? AND project_id=? AND enabled=1",
                vec![json!(WORKSPACE), json!(event.key)],
            )
        } else {
            (
                "SELECT COUNT(*) AS n FROM schedules WHERE workspace_id=? AND enabled=1",
                vec![json!(WORKSPACE)],
            )
        };
        if select(conn, sql, &params).await?[0]["n"]
            .as_i64()
            .unwrap_or(0)
            > 0
        {
            return Ok(true);
        }
    }
    if matches!(event.table.as_str(), "$workspace" | "projects" | "threads") {
        let mut params = vec![json!(WORKSPACE)];
        let scope = if event.table == "$workspace" {
            "1".into()
        } else {
            params.push(json!(event.key));
            format!(
                "json_extract(CASE WHEN json_valid(input) THEN input ELSE '{{}}' END,'$.{}')=?",
                if event.table == "projects" {
                    "projectId"
                } else {
                    "threadId"
                }
            )
        };
        if select(conn,&format!("SELECT COUNT(*) AS n FROM run_requests WHERE workspace_id=? AND status IN ('queued','taken') AND ({scope})"),&params).await?[0]["n"].as_i64().unwrap_or(0)>0{return Ok(true);}
    }
    Ok(false)
}

fn from_row(root: &Change, table: &str, value: &Record) -> Result<Change, String> {
    let columns = keys(table)?;
    let key = if columns == ["id"] {
        value
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Deleted row has no identity.")?
            .to_owned()
    } else {
        serde_json::to_string(
            &columns
                .iter()
                .map(|c| value.get(c).cloned().unwrap_or(Value::Null))
                .collect::<Vec<_>>(),
        )
        .map_err(|_| "Couldn't identify a deleted row.")?
    };
    let mut event = root.clone();
    event.table = table.into();
    event.key = key;
    event.payload = None;
    event.retained = None;
    event.manifests.clear();
    event.unavailable.clear();
    Ok(event)
}

pub(super) async fn entity(
    conn: &mut SqliteConnection,
    event: &Change,
    value: &Record,
) -> Result<(), String> {
    if let Some(id) = value.get("id").filter(|id| !id.is_null()) {
        execute(conn,"INSERT INTO sync_entities(workspace_id,user_id,table_name,original_id,record_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,table_name,original_id) DO NOTHING",&[json!(WORKSPACE),json!(USER),json!(event.table),id.clone(),json!(event.key),json!(now()),json!(now())]).await?;
    }
    Ok(())
}

async fn derived_marker(
    conn: &mut SqliteConnection,
    event: &Change,
    root: &Change,
) -> Result<(), String> {
    let scope = if root.table == "$workspace" {
        "workspace".into()
    } else {
        format!("ancestor:{}:{}", root.table, root.key)
    };
    execute(conn,"INSERT INTO sync_tombstones(workspace_id,user_id,table_name,record_key,event_id,operation,version,scope,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,table_name,record_key) DO UPDATE SET event_id=excluded.event_id,operation=excluded.operation,version=excluded.version,scope=excluded.scope,updated_at=excluded.updated_at",&[json!(WORKSPACE),json!(USER),json!(event.table),json!(event.key),json!(root.id),json!(match root.operation{Operation::Withdraw=>"withdraw",_=>"delete"}),json!(serde_json::to_string(&root.version).map_err(|_|"Couldn't preserve deletion scope.")?),json!(scope),json!(now()),json!(now())]).await?;
    record_meta(conn, event, &root.version).await?;
    Ok(())
}

fn erase<'a>(
    conn: &'a mut SqliteConnection,
    event: Change,
    root: &'a Change,
    visited: &'a mut BTreeSet<(String, String)>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        if !visited.insert((event.table.clone(), event.key.clone())) {
            return Ok(());
        }
        let Some(existing) = row(conn, &event).await? else {
            return Ok(());
        };
        if private_copy(conn, &event, &existing, &mut BTreeSet::new()).await? {
            return Ok(());
        }
        if event.table == "files" && root.table != "$workspace" {
            // A second private owner retains its local copy; public links are withdrawn separately.
            let private:i64=sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM message_files mf JOIN messages m ON m.id=mf.message_id JOIN threads t ON t.id=m.thread_id LEFT JOIN projects p ON p.id=t.project_id WHERE mf.file_id=? AND (t.incognito=1 OR t.local_only=1 OR p.privacy_mode='local_only'))+(SELECT COUNT(*) FROM project_files pf JOIN projects p ON p.id=pf.project_id WHERE pf.file_id=? AND p.privacy_mode='local_only')").bind(&event.key).bind(&event.key).fetch_one(&mut *conn).await.map_err(fail)?;
            if private > 0 {
                execute(conn,"DELETE FROM message_files WHERE file_id=? AND message_id IN(SELECT m.id FROM messages m JOIN threads t ON t.id=m.thread_id LEFT JOIN projects p ON p.id=t.project_id WHERE t.incognito=0 AND t.local_only=0 AND COALESCE(p.privacy_mode,'normal')!='local_only')",&[json!(event.key)]).await?;
                execute(conn,"DELETE FROM project_files WHERE file_id=? AND project_id IN(SELECT id FROM projects WHERE privacy_mode!='local_only')",&[json!(event.key)]).await?;
                execute(
                    conn,
                    "UPDATE files SET thread_id=NULL,project_id=NULL WHERE id=?",
                    &[json!(event.key)],
                )
                .await?;
                record_meta(conn, &event, &event.version).await?;
                return Ok(());
            }
        }
        entity(conn, &event, &existing).await?;
        if metadata_after(conn, &event, root).await? {
            return Ok(());
        }
        // Scope references with surviving public records are detached; ownership children go.
        if let Some(id) = existing.get("id") {
            let tables:Vec<String>=sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx_%'").fetch_all(&mut *conn).await.map_err(fail)?;
            for child in tables {
                if !child
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                {
                    continue;
                }
                for fk in sqlx::query(&format!("PRAGMA foreign_key_list({child})"))
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(fail)?
                {
                    if fk.get::<String, _>("table") != event.table
                        || fk.get::<String, _>("to") != "id"
                    {
                        continue;
                    }
                    let column: String = fk.get("from");
                    if !column
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    {
                        return Err("Invalid local foreign-key schema.".into());
                    }
                    let children = select(
                        conn,
                        &format!("SELECT * FROM {child} WHERE {column}=?"),
                        std::slice::from_ref(id),
                    )
                    .await?;
                    let portable = registry()["tables"].get(&child).is_some();
                    for value in children {
                        if portable {
                            let dependent = from_row(root, &child, &value)?;
                            // Costs stay as content-free ledger rows after a conversation delete.
                            if child == "request_log"
                                && event.table == "threads"
                                && root.operation == Operation::Delete
                                && root.table != "$workspace"
                            {
                                execute(conn,"UPDATE request_log SET message_id=NULL,error_message=NULL,updated_at=? WHERE workspace_id=? AND id=?",&[json!(now()),json!(WORKSPACE),value["id"].clone()]).await?;
                                continue;
                            }
                            let ownership = registry()["tables"][&child]["references"]
                                .as_array()
                                .is_some_and(|refs| {
                                    refs.iter()
                                        .any(|r| r["column"] == column && r["ownership"] == true)
                                });
                            let archive = root.table == "projects"
                                && root
                                    .retained
                                    .as_ref()
                                    .is_some_and(|r| r.get("mode") == Some(&json!("archive")));
                            if ownership && !archive {
                                erase(conn, dependent, root, visited).await?;
                            } else {
                                let optional = registry()["tables"][&child]["references"]
                                    .as_array()
                                    .is_some_and(|refs| {
                                        refs.iter()
                                            .any(|r| r["column"] == column && r["optional"] == true)
                                    });
                                if optional {
                                    execute(
                                        conn,
                                        &format!(
                                            "UPDATE {child} SET {column}=NULL WHERE {}",
                                            predicate(&child)?
                                        ),
                                        &key_values(&dependent)?,
                                    )
                                    .await?;
                                    execute(conn,"INSERT INTO sync_unavailable(workspace_id,user_id,table_name,record_key,column_name,parent_table,parent_id,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'deleted_parent',?,?) ON CONFLICT(workspace_id,table_name,record_key,column_name) DO UPDATE SET parent_id=excluded.parent_id,reason=excluded.reason,updated_at=excluded.updated_at",&[json!(WORKSPACE),json!(USER),json!(child),json!(dependent.key),json!(column),json!(event.table),id.clone(),json!(now()),json!(now())]).await?;
                                }
                            }
                        } else if !matches!(event.table.as_str(), "threads" | "projects") {
                            execute(
                                conn,
                                &format!("DELETE FROM {child} WHERE {column}=?"),
                                std::slice::from_ref(id),
                            )
                            .await?;
                        }
                    }
                }
            }
        }
        if let Some(id) = existing.get("id") {
            let kind = match event.table.as_str() {
                "messages" => Some("message"),
                "memories" => Some("memory"),
                "files" => Some("file"),
                _ => None,
            };
            if let Some(kind) = kind {
                execute(conn,"DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE workspace_id=? AND source_kind=? AND source_id=?)",&[json!(WORKSPACE),json!(kind),id.clone()]).await?;
                execute(
                    conn,
                    "DELETE FROM chunks WHERE workspace_id=? AND source_kind=? AND source_id=?",
                    &[json!(WORKSPACE), json!(kind), id.clone()],
                )
                .await?;
            }
        }
        execute(
            conn,
            "DELETE FROM response_cache WHERE workspace_id=?",
            &[json!(WORKSPACE)],
        )
        .await?;
        if event.table == "threads" {
            execute(conn,"UPDATE threads SET title='',instructions='',active_leaf_id=NULL,web_search=0,memory_injection='off',pinned_provider=NULL,pinned_model=NULL,pinned_tier=NULL,pinned_at=NULL,archived_at=NULL,handoff_from_id=NULL,deleted_at=COALESCE(deleted_at,?),purged_at=?,updated_at=? WHERE workspace_id=? AND id=?",&[json!(now()),json!(now()),json!(now()),json!(WORKSPACE),json!(event.key)]).await?;
        } else if event.table == "projects" {
            execute(conn,"UPDATE projects SET name='',instructions='',deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE workspace_id=? AND id=?",&[json!(now()),json!(now()),json!(WORKSPACE),json!(event.key)]).await?;
        } else {
            let mut params = vec![json!(WORKSPACE), json!(USER)];
            params.extend(key_values(&event)?);
            execute(
                conn,
                &format!(
                    "DELETE FROM {} WHERE workspace_id=? AND user_id=? AND {}",
                    event.table,
                    predicate(&event.table)?
                ),
                &params,
            )
            .await?;
        }
        if event.table == root.table && event.key == root.key {
            record_meta(conn, root, &root.version).await?;
        } else {
            derived_marker(conn, &event, root).await?;
        }
        Ok(())
    })
}

async fn metadata_after(
    conn: &mut SqliteConnection,
    event: &Change,
    root: &Change,
) -> Result<bool, String> {
    let Some(current) = meta(conn, event).await? else {
        return Ok(false);
    };
    let seen: BTreeMap<String, Vector> = serde_json::from_str(
        current
            .get("barriers")
            .and_then(Value::as_str)
            .unwrap_or("{}"),
    )
    .map_err(|_| "Invalid stored lifecycle acknowledgements.")?;
    let tag = if root.table == "$workspace" {
        "$workspace".into()
    } else {
        format!("{}:{}", root.table, root.key)
    };
    Ok(seen.get(&tag).is_some_and(|v| dominates(v, &root.version)))
}

pub(super) async fn apply(conn: &mut SqliteConnection, event: &Change) -> Result<bool, String> {
    if event.operation == Operation::Put {
        return Err("Deletion processing accepts markers only.".into());
    }
    // A stale pre-wipe delete cannot delete records deliberately created after that wipe.
    if event.table != "$workspace"
        && let Some(global) = markers(conn, "$workspace", WORKSPACE).await?
        && !barriers(event, "$workspace", &parse_vector(&global["version"])?)
    {
        complete(conn, event).await?;
        return Ok(true);
    }
    remember(conn, event).await?;
    let marker = markers(conn, &event.table, &event.key)
        .await?
        .ok_or("Missing deletion marker.")?;
    let mut root = event.clone();
    root.version = parse_vector(&marker["version"])?;
    if marker["operation"] == "withdraw" {
        root.operation = Operation::Withdraw;
        if let Some(retained) = root.retained.as_mut() {
            retained.remove("mode");
        }
    }

    if execution_owned(conn, event).await? {
        block(conn,event,"Waiting for the execution owner to finish the run or disable its schedule through the existing controls.").await?;
        return Ok(false);
    }
    if event.table == "$workspace" {
        let latest = markers(conn, "$workspace", WORKSPACE)
            .await?
            .ok_or("Missing workspace deletion marker.")?;
        let mut root = event.clone();
        root.version = parse_vector(&latest["version"])?;
        let mut visited = BTreeSet::new();
        for table in registry()["tables"]
            .as_object()
            .ok_or("Invalid deletion registry.")?
            .keys()
        {
            let rows = select(
                conn,
                &format!("SELECT * FROM {table} WHERE workspace_id=? AND user_id=?"),
                &[json!(WORKSPACE), json!(USER)],
            )
            .await?;
            for value in rows {
                let candidate = from_row(&root, table, &value)?;
                if metadata_after(conn, &candidate, &root).await? {
                    continue;
                }
                // Unshared drafts/local-only objects never became replicas to wipe.
                if meta(conn, &candidate).await?.is_none() {
                    let spec = &registry()["tables"][table];
                    let condition = spec["eligible"]
                        .as_str()
                        .ok_or("Invalid deletion registry.")?
                        .replace("{a}", "r");
                    let mut params = vec![json!(WORKSPACE), json!(USER)];
                    params.extend(key_values(&candidate)?);
                    let allowed=select(conn,&format!("SELECT ({condition}) AS eligible FROM {table} r WHERE workspace_id=? AND user_id=? AND {}",predicate(table)?),&params).await?;
                    if allowed.first().is_none_or(|r| r["eligible"] != json!(1)) {
                        continue;
                    }
                }
                erase(conn, candidate, &root, &mut visited).await?;
            }
        }
        let known=select(conn,"SELECT table_name,record_key FROM sync_records WHERE workspace_id=? AND table_name!='$workspace'",&[json!(WORKSPACE)]).await?;
        for known in known {
            let mut candidate = root.clone();
            candidate.table = known["table_name"]
                .as_str()
                .ok_or("Invalid deletion record type.")?
                .into();
            candidate.key = known["record_key"]
                .as_str()
                .ok_or("Invalid deletion identity.")?
                .into();
            if !metadata_after(conn, &candidate, &root).await? {
                derived_marker(conn, &candidate, &root).await?;
            }
        }
        execute(
            conn,
            "UPDATE sync_state SET wipe_version=? WHERE workspace_id=?",
            &[
                json!(
                    serde_json::to_string(&root.version)
                        .map_err(|_| "Couldn't preserve workspace deletion acknowledgement.")?
                ),
                json!(WORKSPACE),
            ],
        )
        .await?;
        record_meta(conn, event, &root.version).await?;
    } else {
        if let Some(current) = meta(conn, event).await? {
            let current_version = parse_vector(&current["version"])?;
            if relation(&event.version, &current_version) == Relation::Before {
                complete(conn, event).await?;
                return Ok(true);
            }
        }
        if event.table == "egress_rules"
            && event.operation == Operation::Delete
            && let (Some(current), Some(value)) =
                (meta(conn, event).await?, row(conn, event).await?)
            && value.get("allow") == Some(&json!(0))
            && relation(&event.version, &parse_vector(&current["version"])?) == Relation::Concurrent
        {
            let joined = union(&event.version, &parse_vector(&current["version"])?);
            execute(conn,"UPDATE sync_records SET version=? WHERE workspace_id=? AND table_name='egress_rules' AND record_key=?",&[json!(serde_json::to_string(&joined).map_err(|_|"Couldn't preserve restrictive policy.")?),json!(WORKSPACE),json!(event.key)]).await?;
            // Queue a new signed causal deny revision after the incoming transaction.
            execute(conn,"INSERT INTO sync_policy_joins(workspace_id,user_id,record_key,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,record_key) DO NOTHING",&[json!(WORKSPACE),json!(USER),json!(event.key),json!(now()),json!(now())]).await?;
            complete(conn, event).await?;
            return Ok(true);
        }
        if let Some(existing) = row(conn, event).await? {
            if private_copy(conn, event, &existing, &mut BTreeSet::new()).await? {
                record_meta(conn, event, &root.version).await?;
                if event.table == "memories" {
                    execute(conn,"UPDATE sync_records SET revision=? WHERE workspace_id=? AND table_name='memories' AND record_key=?",&[existing["revision"].clone(),json!(WORKSPACE),json!(event.key)]).await?;
                }
            } else {
                erase(conn, root.clone(), &root, &mut BTreeSet::new()).await?;
            }
        } else {
            record_meta(conn, event, &root.version).await?;
        }
    }
    archive(conn, event).await?;
    complete(conn, event).await?;
    Ok(true)
}

pub(super) async fn incoming_guard(
    conn: &mut SqliteConnection,
    event: &Change,
) -> Result<Option<&'static str>, String> {
    if stale(conn, event).await? {
        return Ok(Some("deleted"));
    }
    if event.table == "files" && file_share(conn, event).await?.is_none() {
        return Ok(Some("public_parent"));
    }
    if let Some(payload) = &event.payload
        && private_copy(conn, event, payload, &mut BTreeSet::new()).await?
    {
        return Ok(Some("private"));
    }
    if matches!(
        event.table.as_str(),
        "runs" | "run_steps" | "run_changes" | "messages" | "threads"
    ) && execution_owned(conn, event).await?
    {
        return Ok(Some("owner"));
    }
    if let Some(existing) = row(conn, event).await? {
        if private_copy(conn, event, &existing, &mut BTreeSet::new()).await? {
            return Ok(Some("private"));
        }
        if event.table == "threads"
            && existing.get("deleted_at").is_some_and(|v| !v.is_null())
            && existing.get("purged_at") == Some(&Value::Null)
        {
            return Ok(Some("undo"));
        }
        if execution_owned(conn, event).await?
            && (event.table == "runs" || event.table == "threads")
        {
            return Ok(Some("owner"));
        }
    }
    Ok(None)
}

pub(super) async fn replaces_lifecycle(
    conn: &mut SqliteConnection,
    event: &Change,
    current: &Record,
) -> Result<bool, String> {
    let seen: BTreeMap<String, Vector> = serde_json::from_str(
        current
            .get("barriers")
            .and_then(Value::as_str)
            .unwrap_or("{}"),
    )
    .map_err(|_| "Invalid lifecycle metadata.")?;
    if let Some(global) = markers(conn, "$workspace", WORKSPACE).await? {
        let version = parse_vector(&global["version"])?;
        if barriers(event, "$workspace", &version)
            && !seen
                .get("$workspace")
                .is_some_and(|v| dominates(v, &version))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The deadline is stamped by SQLite, so client clock skew cannot shorten Undo.
pub(super) async fn finalize(ctx: &Ctx) -> Result<(), String> {
    let pool = ctx.db.pool()?;
    let mut tx = pool.begin().await.map_err(fail)?;
    execute(&mut tx, "PRAGMA defer_foreign_keys=ON", &[]).await?;
    let rows=select(&mut tx,"SELECT t.* FROM threads t JOIN sync_pending_deletes d ON d.id=t.id AND d.table_name='threads' WHERE d.deadline<=? AND t.deleted_at IS NOT NULL AND t.purged_at IS NULL AND t.incognito=0 AND t.local_only=0 AND EXISTS(SELECT 1 FROM sync_records r WHERE r.workspace_id=t.workspace_id AND r.table_name='threads' AND r.record_key=t.id AND r.operation='put')",&[json!(now())]).await?;
    for value in rows {
        let id = value["id"].as_str().ok_or("Invalid deletion identity.")?;
        let own: String =
            sqlx::query_scalar("SELECT device_id FROM sync_state WHERE workspace_id=?")
                .bind(WORKSPACE)
                .fetch_one(&mut *tx)
                .await
                .map_err(fail)?;
        let mut event = Change {
            id: format!("{own}:1"),
            workspace_id: WORKSPACE.into(),
            user_id: USER.into(),
            table: "threads".into(),
            key: id.into(),
            device_id: own.clone(),
            seq: 1,
            clock: 1,
            version: BTreeMap::from([(own, 1)]),
            operation: Operation::Delete,
            payload: None,
            created_at: now(),
            resolves: vec![],
            retained: None,
            format: 2,
            manifests: vec![],
            unavailable: BTreeMap::new(),
            barriers: BTreeMap::new(),
        };
        if execution_owned(&mut tx, &event).await? {
            continue;
        }
        execute(
            &mut tx,
            "UPDATE threads SET purged_at=?,updated_at=? WHERE id=?",
            &[json!(now()), json!(now()), json!(id)],
        )
        .await?;
        let current = meta(&mut tx, &event)
            .await?
            .ok_or("Final deletion wasn't captured.")?;
        event.id = current["event_id"]
            .as_str()
            .ok_or("Missing deletion event.")?
            .into();
        event.seq = event
            .id
            .rsplit(':')
            .next()
            .ok_or("Missing deletion sequence.")?
            .parse()
            .map_err(|_| "Invalid deletion sequence.")?;
        event.clock = current["clock"].as_u64().ok_or("Missing deletion clock.")?;
        event.version = parse_vector(&current["version"])?;
        event.barriers = serde_json::from_str(current["barriers"].as_str().unwrap_or("{}"))
            .map_err(|_| "Invalid deletion barriers.")?;
        event.retained = Some(BTreeMap::from([
            ("project_id".into(), value["project_id"].clone()),
            ("kind".into(), value["kind"].clone()),
        ]));
        execute(
            &mut tx,
            "UPDATE sync_state SET applying=1 WHERE workspace_id=?",
            &[json!(WORKSPACE)],
        )
        .await?;
        apply(&mut tx, &event).await?;
        execute(
            &mut tx,
            "UPDATE sync_state SET applying=0 WHERE workspace_id=?",
            &[json!(WORKSPACE)],
        )
        .await?;
    }
    let messages=select(&mut tx,"SELECT m.* FROM messages m JOIN sync_pending_deletes d ON d.id=m.id AND d.table_name='messages' WHERE d.deadline<=? AND m.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM sync_records r WHERE r.workspace_id=m.workspace_id AND r.table_name='messages' AND r.record_key=m.id)",&[json!(now())]).await?;
    for value in messages {
        let id = value["id"]
            .as_str()
            .ok_or("Invalid message deletion identity.")?;
        let state = select(
            &mut tx,
            "SELECT device_id,seq+1 AS seq,clock+1 AS clock FROM sync_state WHERE workspace_id=?",
            &[json!(WORKSPACE)],
        )
        .await?
        .remove(0);
        let own = state["device_id"]
            .as_str()
            .ok_or("Missing device identity.")?;
        let seq = state["seq"].as_u64().ok_or("Missing device sequence.")?;
        let mut event = Change {
            id: format!("{own}:{seq}"),
            workspace_id: WORKSPACE.into(),
            user_id: USER.into(),
            table: "messages".into(),
            key: id.into(),
            device_id: own.into(),
            seq,
            clock: state["clock"].as_u64().ok_or("Missing logical clock.")?,
            version: BTreeMap::new(),
            operation: Operation::Delete,
            payload: None,
            created_at: now(),
            resolves: vec![],
            retained: None,
            format: 2,
            manifests: vec![],
            unavailable: BTreeMap::new(),
            barriers: BTreeMap::new(),
        };
        if execution_owned(&mut tx, &event).await?
            || private_copy(&mut tx, &event, &value, &mut BTreeSet::new()).await?
        {
            continue;
        }
        if let Some(current) = meta(&mut tx, &event).await? {
            event.version = parse_vector(&current["version"])?;
            event.barriers = serde_json::from_str(current["barriers"].as_str().unwrap_or("{}"))
                .map_err(|_| "Invalid deletion barriers.")?;
        }
        event.version.insert(own.into(), seq);
        execute(
            &mut tx,
            "UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=?",
            &[json!(WORKSPACE)],
        )
        .await?;
        execute(&mut tx,"INSERT INTO sync_outbox(id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'delete',NULL,?,?)",&[json!(event.id),json!(WORKSPACE),json!(USER),json!(event.table),json!(event.key),json!(own),json!(seq),json!(event.clock),json!(serde_json::to_string(&event.version).map_err(|_|"Invalid deletion vector.")?),json!(now()),json!(now())]).await?;
        execute(
            &mut tx,
            "UPDATE sync_state SET applying=1 WHERE workspace_id=?",
            &[json!(WORKSPACE)],
        )
        .await?;
        apply(&mut tx, &event).await?;
        execute(
            &mut tx,
            "UPDATE sync_state SET applying=0 WHERE workspace_id=?",
            &[json!(WORKSPACE)],
        )
        .await?;
    }
    tx.commit().await.map_err(fail)?;
    Ok(())
}
