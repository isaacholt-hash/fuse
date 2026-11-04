//! Encrypted, resumable native file/record chunks. Names, hashes and paths stay in ciphertext.
use super::{
    Ctx, USER, WORKSPACE, crypto,
    transport::{self, Blob, BlobId, Change},
    worker::{self, Fault},
};
use crate::{db, files};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use zeroize::Zeroizing;

pub const CHUNK: usize = 1024 * 1024;
pub const MAX_RECORD: usize = 64 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chunk {
    pub id: String,
    pub size: usize,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub sha256: String,
    pub size: usize,
    pub chunks: Vec<Chunk>,
}
impl Manifest {
    pub fn validate(&self, limit: usize) -> Result<(), String> {
        crypto::decode(&self.sha256, 32)?;
        if self.sha256.len() != 64
            || self.size == 0
            || self.size > limit
            || self.chunks.is_empty()
            || self.chunks.len() > limit.div_ceil(CHUNK)
        {
            return Err("Invalid encrypted file manifest.".into());
        }
        let mut total = 0usize;
        let mut ids = BTreeSet::new();
        for chunk in &self.chunks {
            crypto::decode(&chunk.id, 32)?;
            if chunk.id.len() != 64
                || chunk.size == 0
                || chunk.size > CHUNK
                || !ids.insert(&chunk.id)
            {
                return Err("Invalid encrypted chunk manifest.".into());
            }
            total = total
                .checked_add(chunk.size)
                .ok_or("Invalid encrypted file length.")?;
        }
        if total != self.size {
            return Err("Encrypted chunks don't match the declared file length.".into());
        }
        Ok(())
    }
}
fn hash(bytes: &[u8]) -> String {
    crypto::hex(&Sha256::digest(bytes))
}
fn describe(bytes: &[u8]) -> Result<Manifest, String> {
    let chunks = bytes
        .chunks(CHUNK)
        .map(|chunk| {
            Ok(Chunk {
                id: crypto::hex(&crypto::random::<32>()?),
                size: chunk.len(),
            })
        })
        .collect::<Result<_, String>>()?;
    Ok(Manifest {
        sha256: hash(bytes),
        size: bytes.len(),
        chunks,
    })
}
/// References include document snapshots/images retained by completed runs, not repository trees.
pub fn referenced(event: &Change) -> Result<BTreeSet<String>, String> {
    let mut hashes = BTreeSet::new();
    let Some(row) = &event.payload else {
        return Ok(hashes);
    };
    match event.table.as_str() {
        "files" => {
            if let Some(hash) = row.get("sha256").and_then(Value::as_str) {
                hashes.insert(hash.to_owned());
            }
        }
        "run_changes" => {
            for key in ["before_sha", "after_sha"] {
                if let Some(hash) = row.get(key).and_then(Value::as_str) {
                    hashes.insert(hash.to_owned());
                }
            }
        }
        "run_steps" => {
            if let Some(images) = row
                .get("images")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            {
                let images: Vec<Value> = serde_json::from_str(images)
                    .map_err(|_| "A completed run has invalid image references.")?;
                for image in images {
                    if let Some(hash) = image.get("sha256").and_then(Value::as_str) {
                        hashes.insert(hash.to_owned());
                    }
                }
            }
        }
        _ => {}
    }
    for hash in &hashes {
        if hash.len() != 64 {
            return Err("Invalid app-managed file hash.".into());
        }
        crypto::decode(hash, 32)?;
    }
    Ok(hashes)
}

pub async fn fetch(ctx: &Ctx, id: &str) -> Result<crypto::Envelope, Fault> {
    if ctx.sync.host {
        return Ok(transport::get_blob(ctx, id)?);
    }
    // The encrypted cache is disposable. Authentication/hash verification below still runs.
    if let Ok(envelope) = transport::get_blob(ctx, id) {
        return Ok(envelope);
    }
    let envelope: crypto::Envelope =
        worker::request(ctx, "blob-get", BlobId { id: id.into() }).await?;
    let keys = super::load_keys(ctx.keys.store.as_ref())?.ok_or("Sync keys are missing.")?;
    if envelope.header.event_id != format!("blob:{id}") || envelope.header.seq != 0 {
        return Err("An encrypted chunk has the wrong identity.".into());
    }
    transport::decrypt(ctx, &keys, &envelope).await?;
    transport::cache_blob(ctx, id, &envelope)?;
    Ok(envelope)
}
pub async fn bytes(
    ctx: &Ctx,
    manifest: &Manifest,
    limit: usize,
) -> Result<Zeroizing<Vec<u8>>, Fault> {
    bytes_progress(ctx, manifest, limit, None).await
}
async fn bytes_progress(
    ctx: &Ctx,
    manifest: &Manifest,
    limit: usize,
    progress: Option<&str>,
) -> Result<Zeroizing<Vec<u8>>, Fault> {
    manifest.validate(limit)?;
    let keys = super::load_keys(ctx.keys.store.as_ref())?.ok_or("Sync keys are missing.")?;
    let mut bytes = Zeroizing::new(Vec::with_capacity(manifest.size));
    for (index, chunk) in manifest.chunks.iter().enumerate() {
        if !worker::active(ctx).await? {
            return Err(Fault::Idle);
        }
        let envelope = fetch(ctx, &chunk.id).await?;
        if envelope.header.event_id != format!("blob:{}", chunk.id) || envelope.header.seq != 0 {
            return Err("An encrypted chunk belongs to another transfer.".into());
        }
        let plaintext = transport::decrypt(ctx, &keys, &envelope).await?;
        if plaintext.len() != chunk.size {
            return Err("An encrypted chunk has the wrong length.".into());
        }
        bytes.extend_from_slice(&plaintext);
        if let Some(id) = progress {
            db::execute(
                &ctx.db.pool()?,
                "UPDATE sync_transfers SET completed=?,bytes_done=?,updated_at=? WHERE id=?",
                &[
                    json!(index + 1),
                    json!(bytes.len()),
                    json!(super::now()),
                    json!(id),
                ],
            )
            .await?;
        }
    }
    if bytes.len() != manifest.size || hash(&bytes) != manifest.sha256 {
        return Err("The complete file hash didn't match. No file was installed.".into());
    }
    Ok(bytes)
}

/// Decode either a normal record or a descriptor for a large encrypted structured record.
pub async fn decode(ctx: &Ctx, plaintext: &[u8]) -> Result<Change, String> {
    let value: Value =
        serde_json::from_slice(plaintext).map_err(|_| "Malformed encrypted record.")?;
    if let Some(manifest) = value.get("recordChunks") {
        if value.as_object().is_none_or(|m| m.len() != 1) {
            return Err("Malformed large-record descriptor.".into());
        }
        let manifest: Manifest = serde_json::from_value(manifest.clone())
            .map_err(|_| "Malformed large-record manifest.")?;
        let bytes = bytes(ctx, &manifest, MAX_RECORD)
            .await
            .map_err(|e| match e {
                Fault::Retry(reason) => format!("Sync retry: {reason}"),
                Fault::Pause(reason) => reason,
                Fault::Idle => "Sync is paused.".into(),
            })?;
        serde_json::from_slice(&bytes).map_err(|_| "Malformed large sync record.".into())
    } else {
        serde_json::from_value(value).map_err(|_| "Malformed sync record.".into())
    }
}

pub struct Prepared {
    pub event: Change,
    pub record: Option<Manifest>,
}
impl Prepared {
    pub fn body(&self) -> Result<Zeroizing<Vec<u8>>, String> {
        serde_json::to_vec(&match &self.record {
            Some(manifest) => json!({"recordChunks":manifest}),
            None => {
                serde_json::to_value(&self.event).map_err(|_| "Couldn't encode sync record.")?
            }
        })
        .map(Zeroizing::new)
        .map_err(|_| "Couldn't encode sync packet.".into())
    }
    pub fn size(&self) -> Result<usize, String> {
        Ok(match &self.record {
            Some(record) => record.size,
            None => self.body()?.len(),
        })
    }
    pub fn blob_ids(&self) -> BTreeSet<String> {
        self.event
            .manifests
            .iter()
            .chain(self.record.iter())
            .flat_map(|m| m.chunks.iter().map(|c| c.id.clone()))
            .collect()
    }
}
async fn transfer(
    ctx: &Ctx,
    event: &Change,
    kind: &str,
    manifest: &Manifest,
) -> Result<(), String> {
    let stamp = super::now();
    db::execute(&ctx.db.pool()?,"INSERT INTO sync_transfers(id,workspace_id,user_id,event_id,direction,sha256,total_bytes,manifest,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",&[json!(format!("{}:{kind}:{}",event.id,manifest.sha256)),json!(WORKSPACE),json!(USER),json!(event.id),json!("upload"),json!(manifest.sha256),json!(manifest.size),json!(serde_json::to_string(manifest).map_err(|_|"Couldn't save file transfer.")?),json!(stamp),json!(stamp)]).await?;
    Ok(())
}

pub async fn prepare(ctx: &Ctx, event: Change) -> Result<Prepared, String> {
    let rows = db::select(
        &ctx.db.pool()?,
        "SELECT event,record_manifest FROM sync_prepared WHERE id=?",
        &[json!(event.id)],
    )
    .await?;
    if let Some(row) = rows.first() {
        let event: Change =
            serde_json::from_str(row["event"].as_str().ok_or("Invalid prepared event.")?)
                .map_err(|_| "Prepared sync history is damaged.")?;
        let record = row["record_manifest"]
            .as_str()
            .map(|s| {
                serde_json::from_str::<Manifest>(s)
                    .map_err(|_| "Prepared record chunks are damaged.")
            })
            .transpose()?;
        event.validate()?;
        return Ok(Prepared { event, record });
    }
    let mut event = super::privacy::project(ctx, event).await?;
    if event.format >= 2 && event.operation == transport::Operation::Put {
        for sha in referenced(&event)? {
            let bytes = Zeroizing::new(files::get(&ctx.data_dir, &sha)?);
            if bytes.len() > files::MAX_FILE_BYTES || hash(&bytes) != sha {
                return Err("App-managed file bytes don't match their recorded hash. Pending history was kept.".into());
            }
            let manifest = describe(&bytes)?;
            manifest.validate(files::MAX_FILE_BYTES)?;
            if event.table == "files"
                && event
                    .payload
                    .as_ref()
                    .and_then(|p| p.get("size_bytes"))
                    .and_then(Value::as_u64)
                    != Some(manifest.size as u64)
            {
                return Err("File bytes don't match the recorded length.".into());
            }
            transfer(ctx, &event, "file", &manifest).await?;
            event.manifests.push(manifest);
        }
    }
    event.validate()?;
    let bytes =
        Zeroizing::new(serde_json::to_vec(&event).map_err(|_| "Couldn't prepare sync history.")?);
    if bytes.len() > MAX_RECORD {
        return Err("A sync record exceeds 64 MiB. Pending edits were preserved.".into());
    }
    let record = if bytes.len() > crypto::MAX_PACKET_BYTES {
        let manifest = describe(&bytes)?;
        manifest.validate(MAX_RECORD)?;
        transfer(ctx, &event, "record", &manifest).await?;
        Some(manifest)
    } else {
        None
    };
    let stamp = super::now();
    db::execute(&ctx.db.pool()?,"INSERT INTO sync_prepared(id,workspace_id,user_id,event,record_manifest,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",&[json!(event.id),json!(WORKSPACE),json!(USER),json!(serde_json::to_string(&event).map_err(|_|"Couldn't preserve prepared history.")?),json!(record.as_ref().map(serde_json::to_string).transpose().map_err(|_|"Couldn't preserve record transfer.")?),json!(stamp),json!(stamp)]).await?;
    let prepared = Prepared { event, record };
    let refs=prepared.blob_ids().into_iter().map(|id|db::Statement{sql:"INSERT INTO sync_blob_refs(workspace_id,user_id,event_id,blob_id,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING".into(),params:vec![json!(WORKSPACE),json!(USER),json!(prepared.event.id),json!(id),json!(stamp),json!(stamp)]}).collect::<Vec<_>>();
    db::batch(&ctx.db.pool()?, &refs).await?;
    Ok(prepared)
}

pub async fn upload(ctx: &Ctx, prepared: &Prepared) -> Result<(), Fault> {
    for manifest in prepared
        .event
        .manifests
        .iter()
        .chain(prepared.record.iter())
    {
        let data = if prepared
            .record
            .as_ref()
            .is_some_and(|r| r.sha256 == manifest.sha256)
        {
            Zeroizing::new(
                serde_json::to_vec(&prepared.event)
                    .map_err(|_| "Couldn't encode prepared record.")?,
            )
        } else {
            Zeroizing::new(files::get(&ctx.data_dir, &manifest.sha256)?)
        };
        if hash(&data) != manifest.sha256 || data.len() != manifest.size {
            return Err(
                "A pending transfer changed. Its original event and local work were preserved."
                    .into(),
            );
        }
        let query = transport::BlobQuery {
            ids: manifest.chunks.iter().map(|c| c.id.clone()).collect(),
        };
        let present: transport::BlobQuery = if ctx.sync.host {
            transport::probe(ctx, query).await?
        } else {
            worker::request(ctx, "blob-probe", query).await?
        };
        let mut completed = 0usize;
        let mut bytes_done = 0usize;
        for (chunk, bytes) in manifest.chunks.iter().zip(data.chunks(CHUNK)) {
            if !worker::active(ctx).await? {
                return Err(Fault::Idle);
            }
            if prepared.event.operation == transport::Operation::Put {
                let current = super::privacy::live(ctx, &prepared.event).await?;
                if !current.eligible || !current.ready {
                    return Err(Fault::Idle);
                }
            }
            if !present.ids.contains(&chunk.id) {
                let keys =
                    super::load_keys(ctx.keys.store.as_ref())?.ok_or("Sync keys are missing.")?;
                let mut header = prepared.event.header(&keys);
                header.event_id = format!("blob:{}", chunk.id);
                header.seq = 0;
                let envelope = crypto::seal(
                    header,
                    bytes,
                    keys.epochs
                        .get(&keys.epoch)
                        .ok_or("Current sync key is missing.")?,
                    &super::signing(ctx.keys.store.as_ref())?,
                )?;
                let blob = Blob {
                    id: chunk.id.clone(),
                    envelope,
                };
                if ctx.sync.host {
                    transport::put_blob(ctx, &keys, &prepared.event.device_id, blob).await?;
                } else {
                    let _: Value = worker::request(ctx, "blob-put", blob).await?;
                }
            }
            completed += 1;
            bytes_done += chunk.size;
            db::execute(&ctx.db.pool()?,"UPDATE sync_transfers SET completed=?,bytes_done=?,updated_at=? WHERE event_id=? AND sha256=? AND direction='upload'",&[json!(completed),json!(bytes_done),json!(super::now()),json!(prepared.event.id),json!(manifest.sha256)]).await?;
        }
    }
    // Renew/probe the complete set immediately before publication. Abandoned partial uploads
    // may have expired while a later file was transferring; their original IDs remain reusable.
    for manifest in prepared
        .event
        .manifests
        .iter()
        .chain(prepared.record.iter())
    {
        let query = transport::BlobQuery {
            ids: manifest.chunks.iter().map(|c| c.id.clone()).collect(),
        };
        let present: transport::BlobQuery = if ctx.sync.host {
            transport::probe(ctx, query).await?
        } else {
            worker::request(ctx, "blob-probe", query).await?
        };
        if manifest.chunks.iter().any(|c| !present.ids.contains(&c.id)) {
            return Err(Fault::Retry("Some partial file chunks expired during transfer. Sync will resume them with their original IDs.".into()));
        }
    }
    Ok(())
}

pub async fn receive(ctx: &Ctx, event: &Change) -> Result<bool, Fault> {
    let hashes = referenced(event)?;
    if hashes.is_empty() {
        return Ok(true);
    }
    if event.format < 2 && event.manifests.is_empty() {
        return Ok(false);
    }
    event.validate_complete()?;
    for manifest in &event.manifests {
        let id = format!("{}:download:{}", event.id, manifest.sha256);
        let stamp = super::now();
        db::execute(&ctx.db.pool()?,"INSERT INTO sync_transfers(id,workspace_id,user_id,event_id,direction,sha256,total_bytes,manifest,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",&[json!(id),json!(WORKSPACE),json!(USER),json!(event.id),json!("download"),json!(manifest.sha256),json!(manifest.size),json!(serde_json::to_string(manifest).map_err(|_|"Couldn't preserve incoming file progress.")?),json!(stamp),json!(stamp)]).await?;
        let existing = files::get(&ctx.data_dir, &manifest.sha256).ok();
        if !existing
            .as_ref()
            .is_some_and(|data| data.len() == manifest.size && hash(data) == manifest.sha256)
        {
            // Chunks remain encrypted in the resumable cache until the complete hash verifies.
            let data = bytes_progress(ctx, manifest, files::MAX_FILE_BYTES, Some(&id)).await?;
            if existing.is_some() {
                // The old content-addressed bytes were already corrupt. Never install partial data.
                std::fs::remove_file(ctx.data_dir.join("files").join(&manifest.sha256))
                    .map_err(|_| "Couldn't replace corrupted local file bytes.")?;
            }
            if super::merge::stale(ctx, event).await? {
                return Err(Fault::Idle);
            }
            let current = super::privacy::live(ctx, event).await?;
            if current.present && (!current.eligible || !current.ready) {
                return Err(Fault::Idle);
            }
            if !worker::active(ctx).await? {
                return Err(Fault::Idle);
            }
            let stored = files::put(&ctx.data_dir, &data)?;
            if stored.sha256 != manifest.sha256 || stored.size != manifest.size {
                return Err("Verified file installation didn't match its manifest.".into());
            }
        }
        db::execute(
            &ctx.db.pool()?,
            "UPDATE sync_transfers SET completed=?,bytes_done=?,verified=1,updated_at=? WHERE id=?",
            &[
                json!(manifest.chunks.len()),
                json!(manifest.size),
                json!(super::now()),
                json!(id),
            ],
        )
        .await?;
    }
    Ok(true)
}

/// Network and file work happens outside the incoming database transaction. A crash after
/// installation reuses verified content-addressed bytes; it cannot leave a partial DB row.
pub async fn receive_pending(ctx: &Ctx) -> Result<(), Fault> {
    let rows = db::select(
        &ctx.db.pool()?,
        "SELECT event FROM sync_inbox WHERE workspace_id=? AND applied=0 ORDER BY cursor,id",
        &[json!(WORKSPACE)],
    )
    .await?;
    for row in rows {
        let event: Change =
            serde_json::from_str(row["event"].as_str().ok_or("Invalid staged event.")?)
                .map_err(|_| "A staged sync event is damaged.")?;
        if event.operation != transport::Operation::Put {
            continue;
        }
        if !super::merge::ready_for_files(ctx, &event).await? {
            continue;
        }
        let local = super::privacy::live(ctx, &event).await?;
        if local.present && (!local.eligible || !local.ready) {
            continue;
        }
        if !receive(ctx, &event).await? {
            db::execute(&ctx.db.pool()?,"UPDATE sync_inbox SET blocked='Waiting for the source installation to upgrade its file manifests.' WHERE id=?",&[json!(event.id)]).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{
        setup,
        tests::{cleanup, fixture},
    };
    async fn execute(ctx: &Ctx, sql: &str, params: &[Value]) {
        db::execute(&ctx.db.pool().unwrap(), sql, params)
            .await
            .unwrap();
    }
    async fn receiver(source: &Ctx) -> Ctx {
        let target = fixture(true);
        db::db_open(&target).await.unwrap();
        let keys = super::super::load_keys(source.keys.store.as_ref())
            .unwrap()
            .unwrap();
        super::super::save_keys(target.keys.store.as_ref(), &keys).unwrap();
        for member in super::super::devices(source).await.unwrap() {
            execute(&target,"INSERT INTO sync_devices(id,workspace_id,user_id,name,public_key,created_at,updated_at) VALUES (?,?,?,?,?,1,1)",&[json!(member.id),json!(WORKSPACE),json!(USER),json!(member.name),json!(member.public_key)]).await;
        }
        execute(&target, "UPDATE sync_state SET enabled=1,epoch=1", &[]).await;
        target
    }
    #[tokio::test]
    async fn interrupted_chunks_resume_and_install_only_after_complete_hash_verification() {
        let source = fixture(true);
        setup(&source, true).await.unwrap();
        execute(&source,"INSERT INTO threads(id,workspace_id,user_id,title,created_at,updated_at) VALUES ('t',?,?,'Synthetic files',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        execute(&source,"INSERT INTO messages(id,workspace_id,user_id,thread_id,role,content,status,created_at,updated_at) VALUES ('m',?,?,'t','user','Synthetic attachment','complete',1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        let content = vec![73u8; CHUNK + 137];
        let stored = files::put(&source.data_dir, &content).unwrap();
        execute(&source,"INSERT INTO files(id,workspace_id,user_id,name,mime,size_bytes,sha256,storage_path,thread_id,created_at,updated_at) VALUES ('f',?,?,'synthetic.bin','application/octet-stream',?,?,'/source-machine-only','t',1,1)",&[json!(WORKSPACE),json!(USER),json!(stored.size),json!(stored.sha256)]).await;
        execute(&source,"INSERT INTO message_files(id,workspace_id,user_id,message_id,file_id,ordinal,created_at,updated_at) VALUES ('link',?,?,'m','f',0,1,1)",&[json!(WORKSPACE),json!(USER)]).await;
        worker::seed(&source).await.unwrap();
        let original = worker::pending(&source)
            .await
            .unwrap()
            .into_iter()
            .find(|e| e.table == "files")
            .unwrap();
        let prepared = prepare(&source, original).await.unwrap();
        let again = prepare(&source, prepared.event.clone()).await.unwrap();
        assert_eq!(prepared.event.manifests, again.event.manifests);
        upload(&source, &prepared).await.unwrap();
        let manifest = &prepared.event.manifests[0];
        assert_eq!(manifest.chunks.len(), 2);
        assert!(
            !prepared
                .event
                .payload
                .as_ref()
                .unwrap()
                .contains_key("storage_path")
        );
        let target = receiver(&source).await;
        let first = transport::get_blob(&source, &manifest.chunks[0].id).unwrap();
        transport::cache_blob(&target, &manifest.chunks[0].id, &first).unwrap();
        assert!(receive(&target, &prepared.event).await.is_err());
        assert!(files::get(&target.data_dir, &stored.sha256).is_err());
        let progress = db::select(
            &target.db.pool().unwrap(),
            "SELECT bytes_done FROM sync_transfers WHERE direction='download'",
            &[],
        )
        .await
        .unwrap();
        assert_eq!(progress[0]["bytes_done"], json!(CHUNK));
        let second = transport::get_blob(&source, &manifest.chunks[1].id).unwrap();
        transport::cache_blob(&target, &manifest.chunks[1].id, &second).unwrap();
        assert!(receive(&target, &prepared.event).await.unwrap());
        assert_eq!(
            files::get(&target.data_dir, &stored.sha256).unwrap(),
            content
        );
        let mut wrong = prepared.event.clone();
        wrong.manifests[0].sha256 = "00".repeat(32);
        wrong
            .payload
            .as_mut()
            .unwrap()
            .insert("sha256".into(), json!(wrong.manifests[0].sha256));
        assert!(receive(&target, &wrong).await.is_err());
        assert!(files::get(&target.data_dir, &wrong.manifests[0].sha256).is_err());
        cleanup(&source).await;
        cleanup(&target).await;
    }
}
