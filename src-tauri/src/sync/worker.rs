//! One leased native worker per installation. Only ciphertext crosses the native wire.
use super::{
    Ctx, USER, WORKSPACE, crypto,
    transport::{self, Ack, Change, Hello, KeysReply, Operation, Page, Pull, Push, Pushed, Wire},
};
use crate::db;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

#[derive(Debug)]
pub enum Fault {
    Retry(String),
    Pause(String),
    Idle,
}
impl From<String> for Fault {
    fn from(error: String) -> Self {
        if error.starts_with("Sync retry:")
            || error.contains("database is locked")
            || error.contains("database is busy")
        {
            Self::Retry(error)
        } else {
            Self::Pause(error)
        }
    }
}
impl From<&str> for Fault {
    fn from(error: &str) -> Self {
        Self::Pause(error.to_owned())
    }
}
fn sql(error: sqlx::Error) -> Fault {
    Fault::Retry(format!("Sync database isn't available: {error}"))
}

pub fn start(ctx: &Ctx) -> Result<(), String> {
    if ctx.sync.started.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let view = ctx.sync_view()?;
    tauri::async_runtime::spawn(async move {
        run(view).await;
    });
    Ok(())
}

pub(crate) async fn active(ctx: &Ctx) -> Result<bool, Fault> {
    let enabled: i64 = sqlx::query_scalar(
        "SELECT enabled=1 AND paused=0 AND rotation_pending=0 FROM sync_state WHERE workspace_id=? AND user_id=?",
    )
    .bind(WORKSPACE)
    .bind(USER)
    .fetch_one(&ctx.db.pool()?)
    .await
    .map_err(sql)?;
    Ok(enabled == 1)
}

pub async fn request<T: Serialize, R: DeserializeOwned>(
    ctx: &Ctx,
    action: &str,
    data: T,
) -> Result<R, Fault> {
    if !active(ctx).await? {
        return Err(Fault::Idle);
    }
    let keys = super::load_keys(ctx.keys.store.as_ref())?.ok_or("Recover sync's missing keys.")?;
    let device_id: String =
        sqlx::query_scalar("SELECT device_id FROM sync_state WHERE workspace_id=?")
            .bind(WORKSPACE)
            .fetch_one(&ctx.db.pool()?)
            .await
            .map_err(sql)?;
    let hello = Hello {
        protocol: crypto::PROTOCOL,
        schema: db::schema_version(),
        dataset_id: keys.dataset_id.clone(),
        epoch: keys.epoch,
        device_id,
    };
    let (address, token) = crate::hulk::paired(ctx)?;
    let mut response = ctx
        .sync
        .client
        .post(format!("{address}/api/sync/{action}"))
        .bearer_auth(&token)
        .json(&Wire { hello, data })
        .send()
        .await
        .map_err(|_| {
            Fault::Retry("Couldn't reach HULK; pending changes are safe on this device.".into())
        })?;
    let status = response.status();
    let mut bytes = Zeroizing::new(Vec::new());
    if response
        .content_length()
        .is_some_and(|n| n > 20 * 1024 * 1024)
    {
        return Err(Fault::Pause("HULK's sync reply was too large.".into()));
    }
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Fault::Retry("HULK's sync reply was interrupted.".into()))?
    {
        if bytes.len() + chunk.len() > 20 * 1024 * 1024 {
            return Err(Fault::Pause("HULK's sync reply was too large.".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let reason = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| {
                "HULK refused sync. Check pairing and matching FUSE versions.".into()
            });
        return Err(
            if status.is_server_error()
                || reason.starts_with("Refresh sync keys")
                || reason.starts_with("Sync host is paused")
                || reason.starts_with("An encrypted file chunk isn't available yet")
            {
                Fault::Retry(reason)
            } else {
                Fault::Pause(reason)
            },
        );
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| Fault::Pause("HULK's sync reply was malformed. Nothing was applied.".into()))
}

async fn refresh(ctx: &Ctx) -> Result<(), Fault> {
    let reply: KeysReply = request(ctx, "keys", json!({})).await?;
    let current = super::load_keys(ctx.keys.store.as_ref())?.ok_or("Sync's keys are missing.")?;
    if reply.protocol != crypto::PROTOCOL
        || reply.schema != db::schema_version()
        || reply.dataset_id != current.dataset_id
        || reply.epoch < current.epoch
    {
        return Err(Fault::Pause(
            "HULK's sync build, workspace or key epoch is incompatible.".into(),
        ));
    }
    let own: String = sqlx::query_scalar("SELECT device_id FROM sync_state WHERE workspace_id=?")
        .bind(WORKSPACE)
        .fetch_one(&ctx.db.pool()?)
        .await
        .map_err(sql)?;
    let public = crypto::public(&super::signing(ctx.keys.store.as_ref())?)?;
    if !reply
        .devices
        .iter()
        .any(|d| d.id == own && d.public_key == public && d.revoked_at.is_none())
    {
        return Err(Fault::Pause("This sync installation was revoked or its identity changed. Enroll a new device identity.".into()));
    }
    let mut roster = std::collections::BTreeSet::new();
    for device in &reply.devices {
        crypto::verifying(&device.public_key)?;
        if !roster.insert(&device.id) || device.id.is_empty() || device.id.len() > 128 {
            return Err(Fault::Pause(
                "HULK returned malformed device membership.".into(),
            ));
        }
    }
    if let Some(keys) = &reply.keys {
        if keys.dataset_id != current.dataset_id
            || keys.epoch != reply.epoch
            || current
                .epochs
                .iter()
                .any(|(epoch, key)| keys.epochs.get(epoch) != Some(key))
        {
            return Err(Fault::Pause("HULK returned inconsistent sync keys. Existing keys and pending changes were kept.".into()));
        }
        super::save_keys(ctx.keys.store.as_ref(), keys)?;
    } else if reply.epoch != current.epoch {
        return Err(Fault::Pause(
            "HULK didn't supply the new sync key epoch.".into(),
        ));
    }
    let mut statements = Vec::new();
    let stamp = super::now();
    for device in reply.devices {
        statements.push(db::Statement {sql:"INSERT INTO sync_devices (id,workspace_id,user_id,name,public_key,auth_id,revoked_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key,auth_id=excluded.auth_id,revoked_at=excluded.revoked_at,name=excluded.name".into(),params:vec![json!(device.id),json!(WORKSPACE),json!(USER),json!(device.name),json!(device.public_key),json!(device.auth_id),json!(device.revoked_at),json!(stamp),json!(stamp)]});
    }
    statements.push(db::Statement {
        sql: "UPDATE sync_state SET epoch=? WHERE workspace_id=?".into(),
        params: vec![json!(reply.epoch), json!(WORKSPACE)],
    });
    db::batch(&ctx.db.pool()?, &statements).await?;
    Ok(())
}

/// Missing eligible rows include pre-enrollment history and files whose links or terminal
/// parent run became eligible later. Force is transaction-scoped; no timestamps are invented.
pub async fn seed(ctx: &Ctx) -> Result<(), String> {
    let pool = ctx.db.pool()?;
    for (table, spec) in super::registry()["tables"]
        .as_object()
        .ok_or("Invalid sync registry.")?
    {
        let key_columns = spec["key"].as_array().ok_or("Invalid sync registry.")?;
        let first = key_columns
            .first()
            .and_then(Value::as_str)
            .ok_or("Invalid sync registry.")?;
        let key = if key_columns.len() == 1 && first == "id" {
            "r.id".into()
        } else {
            format!(
                "json_array({})",
                key_columns
                    .iter()
                    .map(|k| format!("r.{}", k.as_str().unwrap_or("")))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        };
        let eligible = spec["eligible"]
            .as_str()
            .ok_or("Invalid sync registry.")?
            .replace("{a}", "r");
        let ready = spec["ready"]
            .as_str()
            .ok_or("Invalid sync registry.")?
            .replace("{a}", "r");
        let statement = format!(
            "UPDATE {table} SET {first}={first} WHERE rowid IN (SELECT r.rowid FROM {table} r WHERE r.workspace_id=? AND r.user_id=? AND ({eligible}) AND ({ready}) AND NOT EXISTS (SELECT 1 FROM sync_records s WHERE s.workspace_id=r.workspace_id AND s.table_name='{table}' AND s.record_key={key} AND s.operation!='withdraw') LIMIT 100)"
        );
        db::batch(
            &pool,
            &[
                db::Statement {
                    sql: "UPDATE sync_state SET force_capture=1 WHERE workspace_id=?".into(),
                    params: vec![json!(WORKSPACE)],
                },
                db::Statement {
                    sql: statement,
                    params: vec![json!(WORKSPACE), json!(USER)],
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

pub async fn pending(ctx: &Ctx) -> Result<Vec<Change>, String> {
    let rows = db::select(
        &ctx.db.pool()?,
        "SELECT * FROM sync_outbox WHERE workspace_id=? AND user_id=? ORDER BY CASE WHEN table_name='$workspace' THEN 0 ELSE 1 END,seq",
        &[json!(WORKSPACE), json!(USER)],
    )
    .await?;
    let mut changes = Vec::new();
    for row in rows {
        let string = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .ok_or("Invalid pending sync metadata.")
                .map(str::to_owned)
        };
        let number = |key: &str| {
            row.get(key)
                .and_then(Value::as_u64)
                .ok_or("Invalid pending sync counter.")
        };
        let parse = |key: &str| -> Result<Value, String> {
            match row.get(key) {
                Some(Value::String(v)) => {
                    serde_json::from_str(v).map_err(|_| "Pending sync data is damaged.".into())
                }
                Some(Value::Null) | None => Ok(Value::Null),
                _ => Err("Pending sync data is damaged.".into()),
            }
        };
        let event = Change {
            id: string("id")?,
            workspace_id: string("workspace_id")?,
            user_id: string("user_id")?,
            table: string("table_name")?,
            key: string("record_key")?,
            device_id: string("device_id")?,
            seq: number("seq")?,
            clock: number("clock")?,
            version: serde_json::from_value(parse("version")?)
                .map_err(|_| "Invalid causal vector.")?,
            operation: match string("operation")?.as_str() {
                "put" => Operation::Put,
                "delete" => Operation::Delete,
                "withdraw" => Operation::Withdraw,
                _ => return Err("Invalid sync operation.".into()),
            },
            payload: serde_json::from_value(parse("payload")?)
                .map_err(|_| "Invalid pending sync row.")?,
            created_at: row
                .get("created_at")
                .and_then(Value::as_i64)
                .ok_or("Invalid sync timestamp.")?,
            resolves: serde_json::from_value(parse("resolves")?)
                .map_err(|_| "Invalid resolution metadata.")?,
            retained: serde_json::from_value(parse("retained")?)
                .map_err(|_| "Invalid deletion metadata.")?,
            format: number("wire_format")? as u32,
            manifests: Vec::new(),
            unavailable: BTreeMap::new(),
            barriers: serde_json::from_value(parse("barriers")?)
                .map_err(|_| "Invalid lifecycle acknowledgements.")?,
        };
        event.validate()?;
        changes.push(event);
    }
    Ok(changes)
}

/// Receive, authenticate and durably stage a page before advancing its cursor. The merge
/// engine consumes validated inbox records in the next milestone step.
pub async fn receive(ctx: &Ctx, page: Page) -> Result<(), String> {
    let keys = super::load_keys(ctx.keys.store.as_ref())?.ok_or("Sync keys are missing.")?;
    let before: i64 = sqlx::query_scalar("SELECT cursor FROM sync_state WHERE workspace_id=?")
        .bind(WORKSPACE)
        .fetch_one(&ctx.db.pool()?)
        .await
        .map_err(|e| e.to_string())?;
    let mut cursor = 0;
    let empty = page.events.is_empty();
    let compacted = page.compacted;
    let mut statements = Vec::new();
    for packet in page.events {
        if packet.cursor <= cursor {
            return Err("HULK returned a non-monotonic sync cursor.".into());
        }
        cursor = packet.cursor;
        if cursor <= before {
            transport::decrypt(ctx, &keys, &packet.envelope).await?;
            continue;
        }
        let event = transport::decode_change(ctx, &keys, &packet.envelope).await?;
        let stamp = super::now();
        statements.push(db::Statement {sql:"INSERT INTO sync_inbox (id,workspace_id,user_id,envelope,event,cursor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING".into(),params:vec![json!(event.id),json!(WORKSPACE),json!(USER),json!(serde_json::to_string(&packet.envelope).map_err(|_|"Couldn't save received sync packet.")?),json!(serde_json::to_string(&event).map_err(|_|"Couldn't save received sync record.")?),json!(cursor),json!(stamp),json!(stamp)]});
    }
    if (!empty && cursor > page.cursor)
        || page.cursor < 0
        || (!compacted && ((!empty && cursor != page.cursor) || (empty && page.cursor > before)))
    {
        return Err("HULK's sync cursor doesn't match the received page.".into());
    }
    statements.push(db::Statement {sql:"UPDATE sync_state SET cursor=?,clock=MAX(clock,COALESCE((SELECT MAX(CAST(json_extract(event,'$.clock') AS INTEGER)) FROM sync_inbox WHERE workspace_id=?),0)) WHERE workspace_id=?".into(),params:vec![json!(page.cursor.max(before)),json!(WORKSPACE),json!(WORKSPACE)]});
    db::batch(&ctx.db.pool()?, &statements).await?;
    Ok(())
}

// Keep the installation lease alive during slow network/file work. Dropping the guard
// aborts renewal, including on every early error return; a crashed process expires naturally.
struct Lease(tokio::task::JoinHandle<()>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.abort();
    }
}
fn renew_lease(pool: sqlx::SqlitePool, owner: String) -> Lease {
    Lease(tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if pool.is_closed() {
                break;
            }
            let renewed = sqlx::query(
                "UPDATE sync_state SET worker_until=? WHERE workspace_id=? AND worker_owner=?",
            )
            .bind(super::now() + 120_000)
            .bind(WORKSPACE)
            .bind(&owner)
            .execute(&pool)
            .await;
            if renewed.is_ok_and(|result| result.rows_affected() == 0) {
                break;
            }
        }
    }))
}

async fn pull_phase(ctx: &Ctx, own: &str) -> Result<bool, Fault> {
    let pool = ctx.db.pool()?;
    let cursor: i64 = sqlx::query_scalar("SELECT cursor FROM sync_state WHERE workspace_id=?")
        .bind(WORKSPACE)
        .fetch_one(&pool)
        .await
        .map_err(sql)?;
    let page: Page = if ctx.sync.host {
        transport::pull(&pool, cursor).await?
    } else {
        request(ctx, "pull", Pull { after: cursor }).await?
    };
    let more = page.more;
    let received = page.cursor;
    receive(ctx, page).await?;
    super::merge::apply_deletions(ctx).await?;
    super::attachments::receive_pending(ctx).await?;
    super::merge::apply(ctx).await?;
    if ctx.sync.host {
        transport::acknowledge(&pool, own, received).await?;
    } else {
        let _: Value = request(ctx, "ack", Ack { cursor: received }).await?;
    }
    Ok(more)
}

pub async fn cycle(ctx: &Ctx, lease: &str) -> Result<bool, Fault> {
    let _lock = ctx.sync.administration.lock().await;
    if !active(ctx).await? {
        return Ok(false);
    }
    let pool = ctx.db.pool()?;
    let stamp = super::now();
    let lease_ok=sqlx::query("UPDATE sync_state SET worker_owner=?,worker_until=? WHERE workspace_id=? AND user_id=? AND (worker_owner=? OR worker_until<?)").bind(lease).bind(stamp+120_000).bind(WORKSPACE).bind(USER).bind(lease).bind(stamp).execute(&pool).await.map_err(sql)?.rows_affected();
    if lease_ok == 0 {
        return Ok(false);
    }
    let _lease = renew_lease(pool.clone(), lease.to_owned());
    if !ctx.sync.host {
        refresh(ctx).await?;
    }
    if !active(ctx).await? {
        return Ok(false);
    }
    super::merge::finalize(ctx).await?;
    super::privacy::sweep(ctx).await?;
    seed(ctx).await?;
    let own: String = sqlx::query_scalar("SELECT device_id FROM sync_state WHERE workspace_id=?")
        .bind(WORKSPACE)
        .fetch_one(&pool)
        .await
        .map_err(sql)?;
    // Receive deletion/privacy barriers before publishing edits captured while offline.
    let initial_more = pull_phase(ctx, &own).await?;
    let keys = super::load_keys(ctx.keys.store.as_ref())?.ok_or("Recover sync's missing keys.")?;
    let identity = super::signing(ctx.keys.store.as_ref())?;
    let mut packets = Vec::new();
    let mut size = 0;
    let mut sent = BTreeMap::new();
    for event in pending(ctx).await? {
        if packets.len() >= 32 {
            break;
        }
        if event.operation == Operation::Put {
            let current = super::privacy::live(ctx, &event).await?;
            if !current.eligible || !current.ready {
                continue;
            }
        }
        let prepared = super::attachments::prepare(ctx, event).await?;
        let encoded_size = prepared.size()?;
        if !packets.is_empty() && size + encoded_size > 4 * 1024 * 1024 {
            break;
        }
        super::attachments::upload(ctx, &prepared).await?;
        if prepared.event.operation == Operation::Put {
            let current = super::privacy::live(ctx, &prepared.event).await?;
            if !current.eligible || !current.ready {
                return Err(Fault::Idle);
            }
        }
        let body = prepared.body()?;
        size += encoded_size;
        packets.push(crypto::seal(
            prepared.event.header(&keys),
            &body,
            keys.epochs
                .get(&keys.epoch)
                .ok_or("Missing current sync key.")?,
            &identity,
        )?);
        let control = prepared.event.table == "$workspace";
        sent.insert(prepared.event.id.clone(), prepared.event);
        if control {
            break;
        }
    }

    let own: String = sqlx::query_scalar("SELECT device_id FROM sync_state WHERE workspace_id=?")
        .bind(WORKSPACE)
        .fetch_one(&pool)
        .await
        .map_err(sql)?;
    let pushed = !packets.is_empty();
    if pushed {
        let reply: Pushed = if ctx.sync.host {
            transport::append(ctx, &keys, &own, packets).await?
        } else {
            request(ctx, "push", Push { events: packets }).await?
        };
        if reply.accepted.len() != sent.len()
            || reply
                .accepted
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != sent.len()
            || reply.accepted.iter().any(|id| !sent.contains_key(id))
        {
            return Err(Fault::Pause(
                "HULK returned an invalid acknowledgement. Pending edits were preserved.".into(),
            ));
        }
        let mut statements = Vec::new();
        for id in reply.accepted {
            let event = sent.get(&id).ok_or("Invalid acknowledgement.")?;
            let stamp = super::now();
            statements.push(db::Statement {sql:"INSERT INTO sync_revisions (id,workspace_id,user_id,table_name,record_key,event,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING".into(),params:vec![json!(id),json!(WORKSPACE),json!(USER),json!(event.table),json!(event.key),json!(serde_json::to_string(event).map_err(|_|"Couldn't preserve acknowledged revision.")?),json!(stamp+30*24*60*60*1000i64),json!(stamp),json!(stamp)]});
            statements.push(db::Statement {
                sql: "DELETE FROM sync_outbox WHERE workspace_id=? AND id=?".into(),
                params: vec![json!(WORKSPACE), json!(id)],
            });
        }
        db::batch(&pool, &statements).await?;
    }
    if !active(ctx).await? {
        return Ok(false);
    }
    let more = if pushed {
        pull_phase(ctx, &own).await?
    } else {
        initial_more
    };
    super::retention::collect(ctx).await?;
    db::execute(
        &pool,
        "UPDATE sync_state SET last_success_at=?,error=NULL WHERE workspace_id=?",
        &[json!(super::now()), json!(WORKSPACE)],
    )
    .await?;
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_outbox WHERE workspace_id=?")
        .bind(WORKSPACE)
        .fetch_one(&pool)
        .await
        .map_err(sql)?;
    Ok(more || pending > 0)
}

async fn run(ctx: Ctx) {
    let Ok(random) = crypto::random::<16>() else {
        return;
    };
    let lease = crypto::hex(&random);
    let mut failures = 0u32;
    let mut delay = Duration::from_secs(1);
    let mut retry_at = Instant::now();
    let mut last_seq = -1i64;
    let mut changed_at = Instant::now();
    let mut first_change = Instant::now();
    loop {
        tokio::select! {_=tokio::time::sleep(delay)=>{},_=ctx.sync.wake.notified()=>{}}
        let forced = ctx.sync.force.swap(false, Ordering::SeqCst);
        if !forced && Instant::now() < retry_at {
            delay = retry_at.saturating_duration_since(Instant::now());
            continue;
        }
        let pool = match ctx.db.pool() {
            Ok(pool) => pool,
            Err(_) => return,
        };
        if pool.is_closed() {
            return;
        }
        let seq: Result<i64, _> =
            sqlx::query_scalar("SELECT seq FROM sync_state WHERE workspace_id=?")
                .bind(WORKSPACE)
                .fetch_one(&pool)
                .await;
        let Ok(seq) = seq else {
            delay = Duration::from_secs(5);
            continue;
        };
        if seq != last_seq {
            if last_seq < 0 {
                first_change = Instant::now();
            }
            last_seq = seq;
            changed_at = Instant::now();
        }
        if !forced
            && changed_at.elapsed() < Duration::from_secs(1)
            && first_change.elapsed() < Duration::from_secs(5)
        {
            delay = Duration::from_secs(1);
            continue;
        }
        match cycle(&ctx, &lease).await {
            Ok(busy) => {
                failures = 0;
                retry_at = Instant::now();
                delay = Duration::from_secs(if busy { 1 } else { 5 });
                first_change = Instant::now();
            }
            Err(Fault::Idle) => delay = Duration::from_secs(5),
            Err(Fault::Retry(reason)) => {
                failures = failures.saturating_add(1);
                let seconds = 2u64.saturating_pow(failures.min(6)).min(60);
                delay = Duration::from_secs(seconds);
                retry_at = Instant::now() + delay;
                let _ = db::execute(
                    &pool,
                    "UPDATE sync_state SET error=? WHERE workspace_id=?",
                    &[json!(reason), json!(WORKSPACE)],
                )
                .await;
            }
            Err(Fault::Pause(reason)) => {
                let _ = db::execute(
                    &pool,
                    "UPDATE sync_state SET paused=1,error=? WHERE workspace_id=?",
                    &[json!(reason), json!(WORKSPACE)],
                )
                .await;
                delay = Duration::from_secs(5);
            }
        }
    }
}

pub async fn pause(ctx: &Ctx, paused: bool) -> Result<super::Status, String> {
    if !paused && super::status(ctx).await?.rotation_pending {
        return Err("Finish device revocation before resuming sync.".into());
    }
    db::db_open(ctx).await?;
    db::execute(
        &ctx.db.pool()?,
        "UPDATE sync_state SET paused=?,error=NULL WHERE workspace_id=?",
        &[json!(i64::from(paused)), json!(WORKSPACE)],
    )
    .await?;
    ctx.sync.wake.notify_one();
    super::status(ctx).await
}
pub async fn now(ctx: &Ctx) -> Result<super::Status, String> {
    let state = super::status(ctx).await?;
    if !state.enabled || state.paused {
        return Err("Enable and resume sync before syncing now.".into());
    }
    ctx.sync.force.store(true, Ordering::SeqCst);
    ctx.sync.wake.notify_one();
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::tests::{cleanup, fixture};

    async fn title(ctx: &Ctx, id: &str, text: &str) {
        db::execute(&ctx.db.pool().unwrap(), "INSERT INTO threads (id,workspace_id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,1,1)", &[json!(id),json!(WORKSPACE),json!(USER),json!(text)]).await.unwrap();
    }
    async fn count(ctx: &Ctx, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&ctx.db.pool().unwrap())
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn pre_enrollment_history_is_seeded_then_encrypted_and_acknowledged_once() {
        let ctx = fixture(true);
        db::db_open(&ctx).await.unwrap();
        title(&ctx, "before", "Synthetic private-looking title").await;
        assert_eq!(count(&ctx, "sync_outbox").await, 0);
        super::super::setup(&ctx, true).await.unwrap();
        cycle(&ctx, "first-worker").await.unwrap();
        assert_eq!(count(&ctx, "sync_relay").await, 1);
        assert_eq!(count(&ctx, "sync_inbox").await, 1);
        assert_eq!(count(&ctx, "sync_outbox").await, 0);
        let relay: String = sqlx::query_scalar("SELECT envelope FROM sync_relay")
            .fetch_one(&ctx.db.pool().unwrap())
            .await
            .unwrap();
        assert!(!relay.contains("Synthetic private-looking title"));
        title(&ctx, "after", "Second title").await;
        // A second process cannot acquire the live database lease.
        cycle(&ctx, "second-worker").await.unwrap();
        assert_eq!(count(&ctx, "sync_relay").await, 1);
        cycle(&ctx, "first-worker").await.unwrap();
        cycle(&ctx, "first-worker").await.unwrap();
        assert_eq!(count(&ctx, "sync_relay").await, 2);
        assert_eq!(count(&ctx, "sync_revisions").await, 2);
        assert_eq!(count(&ctx, "sync_outbox").await, 0);
        cleanup(&ctx).await;
    }
    #[tokio::test]
    async fn duplicate_delivery_is_safe_and_damaged_pages_do_not_advance_cursors() {
        let ctx = fixture(true);
        super::super::setup(&ctx, true).await.unwrap();
        title(&ctx, "one", "First").await;
        let event = pending(&ctx).await.unwrap().remove(0);
        let keys = super::super::load_keys(ctx.keys.store.as_ref())
            .unwrap()
            .unwrap();
        let identity = super::super::signing(ctx.keys.store.as_ref()).unwrap();
        let seal = |event: &Change| {
            crypto::seal(
                event.header(&keys),
                &serde_json::to_vec(event).unwrap(),
                &keys.epochs[&keys.epoch],
                &identity,
            )
            .unwrap()
        };
        transport::append(&ctx, &keys, &event.device_id, vec![seal(&event)])
            .await
            .unwrap();
        transport::append(&ctx, &keys, &event.device_id, vec![seal(&event)])
            .await
            .unwrap();
        assert_eq!(count(&ctx, "sync_relay").await, 1);
        let mut changed = event.clone();
        changed
            .payload
            .as_mut()
            .unwrap()
            .insert("title".into(), json!("Different"));
        assert!(
            transport::append(&ctx, &keys, &event.device_id, vec![seal(&changed)])
                .await
                .is_err()
        );
        let mut damaged = transport::pull(&ctx.db.pool().unwrap(), 0).await.unwrap();
        damaged.events[0].envelope.header.clock += 1;
        assert!(receive(&ctx, damaged).await.is_err());
        assert_eq!(count(&ctx, "sync_inbox").await, 0);
        let cursor: i64 = sqlx::query_scalar("SELECT cursor FROM sync_state")
            .fetch_one(&ctx.db.pool().unwrap())
            .await
            .unwrap();
        assert_eq!(cursor, 0);
        for _ in 0..2 {
            receive(
                &ctx,
                transport::pull(&ctx.db.pool().unwrap(), 0).await.unwrap(),
            )
            .await
            .unwrap();
        }
        assert_eq!(count(&ctx, "sync_inbox").await, 1);
        transport::acknowledge(&ctx.db.pool().unwrap(), &event.device_id, 1)
            .await
            .unwrap();
        transport::acknowledge(&ctx.db.pool().unwrap(), &event.device_id, 0)
            .await
            .unwrap();
        let cursor: i64 = sqlx::query_scalar("SELECT cursor FROM sync_receipts")
            .fetch_one(&ctx.db.pool().unwrap())
            .await
            .unwrap();
        assert_eq!(cursor, 1);
        cleanup(&ctx).await;
    }
    #[tokio::test]
    async fn paused_and_disabled_workers_preserve_pending_edits_and_start_only_once() {
        let ctx = fixture(true);
        db::db_open(&ctx).await.unwrap();
        assert!(now(&ctx).await.is_err());
        assert!(!cycle(&ctx, "lease").await.unwrap());
        super::super::setup(&ctx, true).await.unwrap();
        title(&ctx, "pending", "Keep me").await;
        pause(&ctx, true).await.unwrap();
        assert!(!cycle(&ctx, "lease").await.unwrap());
        assert_eq!(count(&ctx, "sync_outbox").await, 1);
        start(&ctx).unwrap();
        start(&ctx).unwrap();
        assert!(ctx.sync.started.load(Ordering::SeqCst));
        cleanup(&ctx).await;
    }
}
