//! Purge withdrawn/deleted payloads while keeping permanent, content-free replay barriers.
use super::{Ctx, WORKSPACE, crypto, now, transport::Change};
use crate::db;
use serde_json::json;
use sqlx::Row;
use std::collections::{BTreeMap, BTreeSet};

pub async fn collect(ctx: &Ctx) -> Result<(), String> {
    let pool = ctx.db.pool()?;
    let mut events = BTreeMap::new();
    for event in super::worker::pending(ctx).await? {
        events.insert(event.id.clone(), event);
    }
    for table in ["sync_revisions", "sync_prepared", "sync_inbox"] {
        for row in db::select(
            &pool,
            &format!("SELECT event FROM {table} WHERE workspace_id=? AND event IS NOT NULL"),
            &[json!(WORKSPACE)],
        )
        .await?
        {
            let event: Change =
                serde_json::from_str(row["event"].as_str().ok_or("Missing retained sync body.")?)
                    .map_err(|_| "Damaged retained sync body.")?;
            events.insert(event.id.clone(), event);
        }
    }
    let mut doomed = Vec::new();
    let mut hashes = BTreeSet::new();
    for event in events.values() {
        if event.operation != super::transport::Operation::Put {
            continue;
        }
        let stale = super::merge::stale(ctx, event).await?;
        let expired:i64=sqlx::query_scalar("SELECT COUNT(*) FROM sync_revisions r WHERE r.id=? AND r.expires_at<? AND NOT EXISTS(SELECT 1 FROM sync_records s WHERE s.event_id=r.id) AND NOT EXISTS(SELECT 1 FROM sync_outbox o WHERE o.id=r.id) AND NOT EXISTS(SELECT 1 FROM sync_conflicts c WHERE c.resolved_at IS NULL AND (json_extract(c.ours,'$.id')=r.id OR json_extract(c.theirs,'$.id')=r.id))").bind(&event.id).bind(now()).fetch_one(&pool).await.map_err(|e|e.to_string())?;
        if stale || expired > 0 {
            use sha2::{Digest, Sha256};
            let digest = crypto::hex(&Sha256::digest(
                serde_json::to_vec(event).map_err(|_| "Invalid retained revision.")?,
            ));
            db::execute(&pool,"INSERT INTO sync_seen(id,workspace_id,user_id,digest,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",&[json!(event.id),json!(WORKSPACE),json!(super::USER),json!(digest),json!(now()),json!(now())]).await?;
            doomed.push(event.id.clone());
            hashes.extend(super::attachments::referenced(event)?);
        }
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for id in doomed {
        sqlx::query("INSERT INTO sync_releases(id,workspace_id,user_id,created_at,updated_at) SELECT blob_id,workspace_id,user_id,?,? FROM sync_blob_refs WHERE event_id=? ON CONFLICT DO NOTHING").bind(now()).bind(now()).bind(&id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        for table in ["sync_blob_refs", "sync_transfers"] {
            sqlx::query(&format!("DELETE FROM {table} WHERE event_id=?"))
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        for table in [
            "sync_revisions",
            "sync_prepared",
            "sync_inbox",
            "sync_outbox",
            "sync_relay",
        ] {
            sqlx::query(&format!("DELETE FROM {table} WHERE id=?"))
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        sqlx::query("DELETE FROM sync_conflicts WHERE (json_extract(ours,'$.id')=? OR json_extract(theirs,'$.id')=?) AND NOT (resolved_at IS NULL AND table_name='memories' AND EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=sync_conflicts.workspace_id AND m.id=sync_conflicts.record_key AND m.deleted_at IS NULL))").bind(&id).bind(&id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    // Only candidates removed above are considered. Fresh file_put bytes may not yet have a DB row.
    for hash in hashes {
        let refs:i64=sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM files WHERE sha256=?)+(SELECT COUNT(*) FROM run_changes WHERE before_sha=? OR after_sha=?)+(SELECT COUNT(*) FROM run_steps r,json_each(CASE WHEN json_valid(r.images) THEN r.images ELSE '[]' END) i WHERE json_extract(i.value,'$.sha256')=?)").bind(&hash).bind(&hash).bind(&hash).bind(&hash).fetch_one(&pool).await.map_err(|e|e.to_string())?;
        if refs == 0 && hash.len() == 64 && crypto::decode(&hash, 32).is_ok() {
            match std::fs::remove_file(ctx.data_dir.join("files").join(&hash)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("Couldn't remove deleted attachment bytes.".into()),
            }
        }
    }
    // Published references protect shared chunks. Abandoned uploads expire after an hour;
    // an active transfer renews each chunk's lease and probes everything before publication.
    if !ctx.sync.host {
        let queued=db::select(&pool,"SELECT id FROM sync_releases WHERE workspace_id=? AND NOT EXISTS(SELECT 1 FROM sync_blob_refs r WHERE r.blob_id=sync_releases.id) LIMIT 128",&[json!(WORKSPACE)]).await?;
        let ids = queued
            .iter()
            .filter_map(|r| r["id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        if !ids.is_empty() {
            let _: serde_json::Value = super::worker::request(
                ctx,
                "blob-release",
                super::transport::BlobQuery { ids: ids.clone() },
            )
            .await
            .map_err(|e| match e {
                super::worker::Fault::Retry(s) => format!("Sync retry: {s}"),
                super::worker::Fault::Pause(s) => s,
                super::worker::Fault::Idle => "Sync retry: Paused.".into(),
            })?;
            for id in ids {
                let _ = std::fs::remove_file(super::transport::blob_path(ctx, &id)?);
                db::execute(&pool, "DELETE FROM sync_releases WHERE id=?", &[json!(id)]).await?;
            }
        }
    }
    let blobs=sqlx::query("SELECT id FROM sync_blobs b WHERE workspace_id=? AND NOT EXISTS(SELECT 1 FROM sync_blob_refs r WHERE r.blob_id=b.id) AND (updated_at<? OR EXISTS(SELECT 1 FROM sync_releases r WHERE r.id=b.id))").bind(WORKSPACE).bind(now()-3_600_000).fetch_all(&pool).await.map_err(|e|e.to_string())?;
    for blob in blobs {
        let id: String = blob.get("id");
        match std::fs::remove_file(super::transport::blob_path(ctx, &id)?) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Couldn't purge an unreferenced encrypted chunk.".into()),
        }
        db::execute(&pool, "DELETE FROM sync_blobs WHERE id=?", &[json!(id)]).await?;
        db::execute(&pool, "DELETE FROM sync_releases WHERE id=?", &[json!(id)]).await?;
    }
    Ok(())
}
