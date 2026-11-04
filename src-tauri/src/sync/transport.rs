//! Authenticated native wire protocol. No SQL is accepted from a sync peer.
// Native desktop consumes the shared wire types; only the server exposes dispatch endpoints.
#![cfg_attr(not(feature = "server"), allow(dead_code))]
use super::{Ctx, Device, KeySet, USER, WORKSPACE, crypto, devices, load_keys, now, registry};
use crate::db;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Put,
    Delete,
    Withdraw,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub id: String,
    pub workspace_id: String,
    pub user_id: String,
    pub table: String,
    pub key: String,
    pub device_id: String,
    pub seq: u64,
    pub clock: u64,
    pub version: BTreeMap<String, u64>,
    pub operation: Operation,
    pub payload: Option<BTreeMap<String, Value>>,
    pub created_at: i64,
    #[serde(default)]
    pub resolves: Vec<String>,
    #[serde(default)]
    pub retained: Option<BTreeMap<String, Value>>,
}

impl Change {
    pub fn validate(&self) -> Result<(), String> {
        if self.workspace_id != WORKSPACE
            || self.user_id != USER
            || self.seq == 0
            || self.seq > i64::MAX as u64
            || self.clock > i64::MAX as u64
            || self.id != format!("{}:{}", self.device_id, self.seq)
            || self.key.len() > 16384
            || self.version.len() > 4096
            || self.version.get(&self.device_id) != Some(&self.seq)
            || self.version.values().any(|v| *v > i64::MAX as u64)
        {
            return Err(
                "Sync record identity or causality is invalid. Nothing was applied.".into(),
            );
        }
        let spec = registry()["tables"]
            .get(&self.table)
            .ok_or("Sync record type is not portable.")?;
        if let Some(retained) = &self.retained
            && (self.table != "threads"
                || self.operation != Operation::Delete
                || retained.keys().any(|k| k != "project_id" && k != "kind")
                || !retained.get("kind").is_some_and(|k| {
                    ["chat", "code", "work"]
                        .iter()
                        .any(|kind| k.as_str() == Some(kind))
                })
                || !retained
                    .get("project_id")
                    .is_some_and(|v| v.is_null() || v.as_str().is_some_and(|s| s.len() <= 128)))
        {
            return Err("A deletion marker contains nonportable data.".into());
        }
        match (&self.operation, &self.payload) {
            (Operation::Put, Some(row)) => {
                let columns = spec["columns"]
                    .as_array()
                    .ok_or("Invalid replication registry.")?;
                if row.iter().any(|(k, v)| {
                    !columns.iter().any(|c| c.as_str() == Some(k))
                        || !(v.is_null() || v.is_string() || v.is_number())
                }) || row.get("workspace_id") != Some(&json!(WORKSPACE))
                    || row.get("user_id") != Some(&json!(USER))
                {
                    return Err(
                        "Sync record contains unrecognized fields or nonportable values.".into(),
                    );
                }
                let keys = spec["key"]
                    .as_array()
                    .ok_or("Invalid replication registry.")?;
                let values: Vec<Value> = keys
                    .iter()
                    .map(|key| {
                        row.get(key.as_str().unwrap_or(""))
                            .cloned()
                            .ok_or("A sync record key is missing.")
                    })
                    .collect::<Result<_, _>>()?;
                let key = if keys.len() == 1 && keys[0] == "id" {
                    values[0]
                        .as_str()
                        .ok_or("Invalid sync record ID.")?
                        .to_owned()
                } else {
                    serde_json::to_string(&values).map_err(|_| "Invalid sync record key.")?
                };
                if key != self.key {
                    return Err("Sync record doesn't match its logical key.".into());
                }
            }
            (Operation::Delete | Operation::Withdraw, None) => {}
            _ => return Err("A deleted/withdrawn sync record cannot contain content.".into()),
        }
        Ok(())
    }
    pub fn header(&self, keys: &KeySet) -> crypto::Header {
        crypto::Header {
            protocol: crypto::PROTOCOL,
            schema: db::schema_version(),
            workspace_id: WORKSPACE.into(),
            user_id: USER.into(),
            dataset_id: keys.dataset_id.clone(),
            epoch: keys.epoch,
            device_id: self.device_id.clone(),
            event_id: self.id.clone(),
            seq: self.seq,
            clock: self.clock,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub protocol: u32,
    pub schema: i64,
    pub dataset_id: String,
    pub epoch: u64,
    pub device_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Wire<T> {
    pub hello: Hello,
    pub data: T,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeysReply {
    pub protocol: u32,
    pub schema: i64,
    pub dataset_id: String,
    pub epoch: u64,
    pub keys: Option<KeySet>,
    pub devices: Vec<Device>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stamped {
    pub cursor: i64,
    pub envelope: crypto::Envelope,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pull {
    pub after: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    pub cursor: i64,
    pub events: Vec<Stamped>,
    pub more: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Push {
    pub events: Vec<crypto::Envelope>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pushed {
    pub accepted: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ack {
    pub cursor: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Blob {
    pub id: String,
    pub envelope: crypto::Envelope,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlobId {
    pub id: String,
}

fn error(e: sqlx::Error) -> String {
    format!("Sync storage failed: {e}")
}

pub async fn authorize(ctx: &Ctx, auth_id: &str, hello: &Hello) -> Result<KeySet, String> {
    if !ctx.sync.host || hello.protocol != crypto::PROTOCOL || hello.schema != db::schema_version()
    {
        return Err("Sync versions differ. Update this app and redeploy HULK.".into());
    }
    let state = super::status(ctx).await?;
    if !state.enabled {
        return Err("Enable sync in HULK's Settings first.".into());
    }
    if state.paused {
        return Err("Sync host is paused; resume it in HULK's Settings.".into());
    }
    let keys =
        load_keys(ctx.keys.store.as_ref())?.ok_or("Recover HULK's sync keys before continuing.")?;
    if keys.dataset_id != hello.dataset_id
        || keys.epoch as i64 != state.epoch
        || hello.epoch == 0
        || hello.epoch > keys.epoch
    {
        return Err("The sync workspace or key state doesn't match. Recover or re-enroll before continuing.".into());
    }
    let member = sqlx::query(
        "SELECT auth_id,revoked_at FROM sync_devices WHERE id=? AND workspace_id=? AND user_id=?",
    )
    .bind(&hello.device_id)
    .bind(WORKSPACE)
    .bind(USER)
    .fetch_optional(&ctx.db.pool()?)
    .await
    .map_err(error)?
    .ok_or("This device isn't enrolled in sync.")?;
    if member.get::<Option<i64>, _>("revoked_at").is_some()
        || member.get::<Option<String>, _>("auth_id").as_deref() != Some(auth_id)
    {
        return Err("This sync device was revoked or its pairing changed.".into());
    }
    Ok(keys)
}

pub async fn decrypt(
    ctx: &Ctx,
    keys: &KeySet,
    envelope: &crypto::Envelope,
) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    let h = &envelope.header;
    if h.workspace_id != WORKSPACE
        || h.user_id != USER
        || h.dataset_id != keys.dataset_id
        || h.protocol != crypto::PROTOCOL
        || h.schema < 57
        || h.schema > db::schema_version()
    {
        return Err("Sync packet belongs to another workspace or incompatible build.".into());
    }
    let key = keys
        .epochs
        .get(&h.epoch)
        .ok_or("A historical sync key is missing. Recover sync.")?;
    let member = sqlx::query(
        "SELECT public_key FROM sync_devices WHERE workspace_id=? AND user_id=? AND id=?",
    )
    .bind(WORKSPACE)
    .bind(USER)
    .bind(&h.device_id)
    .fetch_optional(&ctx.db.pool()?)
    .await
    .map_err(error)?
    .ok_or("Unknown sync signer. Refresh device membership before continuing.")?;
    // Revoked members' already-accepted historical signatures remain verifiable; fresh
    // appends below require active membership and the current epoch.
    crypto::open(envelope, h, key, &member.get::<String, _>("public_key"))
}

pub async fn decode_change(
    ctx: &Ctx,
    keys: &KeySet,
    envelope: &crypto::Envelope,
) -> Result<Change, String> {
    let bytes = decrypt(ctx, keys, envelope).await?;
    let event: Change = serde_json::from_slice(&bytes)
        .map_err(|_| "Malformed sync record. Nothing was applied.")?;
    event.validate()?;
    let h = &envelope.header;
    if event.id != h.event_id
        || event.device_id != h.device_id
        || event.seq != h.seq
        || event.clock != h.clock
    {
        return Err("Sync record doesn't match its authenticated header.".into());
    }
    Ok(event)
}

pub async fn append(
    ctx: &Ctx,
    keys: &KeySet,
    actor: &str,
    events: Vec<crypto::Envelope>,
) -> Result<Pushed, String> {
    if events.len() > 32 {
        return Err("Too many sync packets in one request.".into());
    }
    let pool = ctx.db.pool()?;
    let mut validated = Vec::new();
    for envelope in events {
        if envelope.header.epoch != keys.epoch || envelope.header.device_id != actor {
            return Err("Refresh sync keys before sending pending changes.".into());
        }
        let event = decode_change(ctx, keys, &envelope).await?;
        validated.push((event, envelope));
    }
    let mut tx = pool.begin().await.map_err(error)?;
    let mut accepted = Vec::new();
    for (event, envelope) in validated {
        let existing: Option<String> =
            sqlx::query_scalar("SELECT envelope FROM sync_relay WHERE workspace_id=? AND id=?")
                .bind(WORKSPACE)
                .bind(&event.id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(error)?;
        if let Some(existing) = existing {
            let stored: crypto::Envelope = serde_json::from_str(&existing)
                .map_err(|_| "An accepted sync packet is damaged.")?;
            // Use the pool for signature checking, without holding another write transaction.
            let original = decode_change(ctx, keys, &stored).await?;
            if original != event {
                return Err("A sync event ID was reused for different content. Pending work was preserved; enroll this installation with a new identity.".into());
            }
        } else {
            sqlx::query("UPDATE sync_state SET relay_seq=relay_seq+1 WHERE workspace_id=?")
                .bind(WORKSPACE)
                .execute(&mut *tx)
                .await
                .map_err(error)?;
            let cursor: i64 =
                sqlx::query_scalar("SELECT relay_seq FROM sync_state WHERE workspace_id=?")
                    .bind(WORKSPACE)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(error)?;
            let stamp = now();
            let packet =
                serde_json::to_string(&envelope).map_err(|_| "Couldn't encode sync packet.")?;
            sqlx::query("INSERT INTO sync_relay (id,workspace_id,user_id,device_id,epoch,cursor,envelope,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(&event.id).bind(WORKSPACE).bind(USER).bind(actor).bind(envelope.header.epoch as i64).bind(cursor).bind(packet).bind(stamp).bind(stamp).execute(&mut *tx).await.map_err(error)?;
        }
        accepted.push(event.id);
    }
    tx.commit().await.map_err(error)?;
    Ok(Pushed { accepted })
}

pub async fn pull(pool: &SqlitePool, after: i64) -> Result<Page, String> {
    if after < 0 {
        return Err("Invalid sync cursor.".into());
    }
    let mut events = Vec::new();
    let mut cursor = after;
    let mut bytes = 0;
    for _ in 0..64 {
        let row=sqlx::query("SELECT cursor,envelope FROM sync_relay WHERE workspace_id=? AND user_id=? AND cursor>? ORDER BY cursor LIMIT 1").bind(WORKSPACE).bind(USER).bind(cursor).fetch_optional(pool).await.map_err(error)?;
        let Some(row) = row else { break };
        let packet: String = row.get("envelope");
        if !events.is_empty() && bytes + packet.len() > 12 * 1024 * 1024 {
            break;
        }
        bytes += packet.len();
        cursor = row.get("cursor");
        events.push(Stamped {
            cursor,
            envelope: serde_json::from_str(&packet).map_err(|_| "A sync packet is damaged.")?,
        });
    }
    let latest: i64 = sqlx::query_scalar("SELECT relay_seq FROM sync_state WHERE workspace_id=?")
        .bind(WORKSPACE)
        .fetch_one(pool)
        .await
        .map_err(error)?;
    Ok(Page {
        cursor,
        events,
        more: cursor < latest,
    })
}

pub async fn acknowledge(pool: &SqlitePool, device: &str, cursor: i64) -> Result<(), String> {
    let latest: i64 = sqlx::query_scalar("SELECT relay_seq FROM sync_state WHERE workspace_id=?")
        .bind(WORKSPACE)
        .fetch_one(pool)
        .await
        .map_err(error)?;
    if cursor < 0 || cursor > latest {
        return Err("Invalid sync acknowledgement.".into());
    }
    sqlx::query("INSERT INTO sync_receipts (id,workspace_id,user_id,cursor,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cursor=MAX(sync_receipts.cursor,excluded.cursor),updated_at=excluded.updated_at").bind(device).bind(WORKSPACE).bind(USER).bind(cursor).bind(now()).bind(now()).execute(pool).await.map_err(error)?;
    Ok(())
}

fn blob_path(ctx: &Ctx, id: &str) -> Result<std::path::PathBuf, String> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid encrypted blob identity.".into());
    }
    Ok(ctx.data_dir.join("sync/blobs").join(format!("{id}.json")))
}

pub async fn put_blob(ctx: &Ctx, keys: &KeySet, actor: &str, blob: Blob) -> Result<(), String> {
    let path = blob_path(ctx, &blob.id)?;
    if blob.envelope.header.epoch != keys.epoch
        || blob.envelope.header.device_id != actor
        || blob.envelope.header.event_id != format!("blob:{}", blob.id)
        || blob.envelope.header.seq != 0
    {
        return Err("Invalid encrypted blob metadata.".into());
    }
    let plaintext = decrypt(ctx, keys, &blob.envelope).await?;
    if plaintext.len() > 1024 * 1024 {
        return Err("Encrypted file chunks are limited to 1 MiB.".into());
    }
    let bytes = serde_json::to_vec(&blob.envelope)
        .map_err(|_| "Couldn't encode an encrypted file chunk.")?;
    if path.exists() {
        let original: crypto::Envelope = serde_json::from_slice(
            &std::fs::read(&path).map_err(|_| "Couldn't read encrypted chunk.")?,
        )
        .map_err(|_| "An encrypted chunk is damaged.")?;
        if *decrypt(ctx, keys, &original).await? != *plaintext {
            return Err("An encrypted blob ID was reused for different content.".into());
        }
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().ok_or("Invalid chunk location.")?)
        .map_err(|_| "Couldn't create encrypted chunk storage.")?;
    let temp = path.with_extension(format!("{}.tmp", crypto::hex(&crypto::random::<8>()?)));
    std::fs::write(&temp, &bytes).map_err(|_| "Couldn't store encrypted file chunk.")?;
    std::fs::rename(&temp, &path).map_err(|_| "Couldn't finish storing encrypted file chunk.")?;
    db::execute(&ctx.db.pool()?,"INSERT INTO sync_blobs (id,workspace_id,user_id,device_id,epoch,bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",&[json!(blob.id),json!(WORKSPACE),json!(USER),json!(actor),json!(blob.envelope.header.epoch),json!(bytes.len()),json!(now()),json!(now())]).await?;
    Ok(())
}

pub fn get_blob(ctx: &Ctx, id: &str) -> Result<crypto::Envelope, String> {
    let path = blob_path(ctx, id)?;
    if std::fs::metadata(&path)
        .map_err(|_| "An encrypted file chunk isn't available yet.")?
        .len()
        > 3 * 1024 * 1024
    {
        return Err("An encrypted file chunk is too large.".into());
    }
    serde_json::from_slice(
        &std::fs::read(path).map_err(|_| "Couldn't read an encrypted file chunk.")?,
    )
    .map_err(|_| "An encrypted file chunk is damaged.".into())
}

pub async fn dispatch(
    ctx: &Ctx,
    auth: &str,
    action: &str,
    wire: Wire<Value>,
) -> Result<Value, String> {
    let _lock = ctx.sync.administration.lock().await;
    let keys = authorize(ctx, auth, &wire.hello).await?;
    let result = match action {
        "keys" => serde_json::to_value(KeysReply {
            protocol: crypto::PROTOCOL,
            schema: db::schema_version(),
            dataset_id: keys.dataset_id.clone(),
            epoch: keys.epoch,
            devices: devices(ctx).await?,
            keys: if keys.epoch == wire.hello.epoch {
                None
            } else {
                Some(keys)
            },
        }),
        "push" => {
            let push: Push = serde_json::from_value(wire.data).map_err(|_| "Invalid sync push.")?;
            serde_json::to_value(append(ctx, &keys, &wire.hello.device_id, push.events).await?)
        }
        "pull" => {
            let request: Pull =
                serde_json::from_value(wire.data).map_err(|_| "Invalid sync pull.")?;
            serde_json::to_value(pull(&ctx.db.pool()?, request.after).await?)
        }
        "ack" => {
            let request: Ack =
                serde_json::from_value(wire.data).map_err(|_| "Invalid sync acknowledgement.")?;
            acknowledge(&ctx.db.pool()?, &wire.hello.device_id, request.cursor).await?;
            Ok(json!({"ok":true}))
        }
        "blob-put" => {
            let request: Blob =
                serde_json::from_value(wire.data).map_err(|_| "Invalid encrypted chunk.")?;
            put_blob(ctx, &keys, &wire.hello.device_id, request).await?;
            Ok(json!({"ok":true}))
        }
        "blob-get" => {
            let request: BlobId = serde_json::from_value(wire.data)
                .map_err(|_| "Invalid encrypted chunk request.")?;
            serde_json::to_value(get_blob(ctx, &request.id)?)
        }
        _ => return Err("Unknown sync operation.".into()),
    };
    result.map_err(|_| "Couldn't encode sync reply.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{
        Enrollment, accept, setup,
        tests::{cleanup, fixture},
    };

    #[tokio::test]
    async fn authenticated_membership_versions_and_blob_integrity_are_enforced() {
        let ctx = fixture(true);
        setup(&ctx, true).await.unwrap();
        let identity = zeroize::Zeroizing::new(crypto::hex(&crypto::random::<32>().unwrap()));
        let enrolled = accept(
            &ctx,
            "paired-native",
            Enrollment {
                protocol: crypto::PROTOCOL,
                schema: db::schema_version(),
                device_id: "native-one".into(),
                name: "Synthetic desktop".into(),
                public_key: crypto::public(&identity).unwrap(),
            },
        )
        .await
        .unwrap();
        let hello = Hello {
            protocol: crypto::PROTOCOL,
            schema: db::schema_version(),
            dataset_id: enrolled.keys.dataset_id.clone(),
            epoch: enrolled.keys.epoch,
            device_id: "native-one".into(),
        };
        assert!(authorize(&ctx, "another-token", &hello).await.is_err());
        let mut wrong = hello.clone();
        wrong.schema -= 1;
        assert!(authorize(&ctx, "paired-native", &wrong).await.is_err());
        wrong = hello.clone();
        wrong.dataset_id = "other-workspace".into();
        assert!(authorize(&ctx, "paired-native", &wrong).await.is_err());
        let keys = authorize(&ctx, "paired-native", &hello).await.unwrap();
        let id = crypto::hex(&crypto::random::<32>().unwrap());
        let header = crypto::Header {
            protocol: crypto::PROTOCOL,
            schema: db::schema_version(),
            workspace_id: WORKSPACE.into(),
            user_id: USER.into(),
            dataset_id: keys.dataset_id.clone(),
            epoch: keys.epoch,
            device_id: hello.device_id.clone(),
            event_id: format!("blob:{id}"),
            seq: 0,
            clock: 0,
        };
        let seal = |data: &[u8]| {
            crypto::seal(header.clone(), data, &keys.epochs[&keys.epoch], &identity).unwrap()
        };
        for _ in 0..2 {
            put_blob(
                &ctx,
                &keys,
                &hello.device_id,
                Blob {
                    id: id.clone(),
                    envelope: seal(b"synthetic file bytes"),
                },
            )
            .await
            .unwrap();
        }
        assert_eq!(
            &*decrypt(&ctx, &keys, &get_blob(&ctx, &id).unwrap())
                .await
                .unwrap(),
            b"synthetic file bytes"
        );
        assert!(
            put_blob(
                &ctx,
                &keys,
                &hello.device_id,
                Blob {
                    id: id.clone(),
                    envelope: seal(b"different bytes")
                }
            )
            .await
            .is_err()
        );
        assert!(get_blob(&ctx, "../escape").is_err());
        let mut corrupt = seal(b"bytes");
        corrupt.header.clock += 1;
        assert!(
            put_blob(
                &ctx,
                &keys,
                &hello.device_id,
                Blob {
                    id: id.clone(),
                    envelope: corrupt
                }
            )
            .await
            .is_err()
        );
        db::execute(
            &ctx.db.pool().unwrap(),
            "UPDATE sync_devices SET revoked_at=1 WHERE id=?",
            &[json!(hello.device_id)],
        )
        .await
        .unwrap();
        assert!(authorize(&ctx, "paired-native", &hello).await.is_err());
        cleanup(&ctx).await;
    }
}
