//! Explicit owner controls. No provider or execution command is invoked here.
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub event_id: String,
    pub device_id: String,
    pub text: String,
    pub kind: String,
    pub rationale: Option<String>,
    pub alternatives: Option<String>,
    pub source_artifact_id: Option<String>,
    pub extraction_model: Option<String>,
    pub authority: Option<String>,
    pub confidence: Option<i64>,
    pub source_thread_id: Option<String>,
    pub source_message_id: Option<String>,
    pub extraction_method: Option<String>,
    pub created_at: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    pub record_id: String,
    pub versions: Vec<Candidate>,
}
pub async fn conflicts(ctx: &Ctx) -> Result<Vec<Conflict>, String> {
    let mut result = Vec::new();
    for row in db::select(&ctx.db.pool()?,"SELECT id,record_key,ours,theirs FROM sync_conflicts WHERE workspace_id=? AND resolved_at IS NULL ORDER BY created_at,id",&[json!(WORKSPACE)]).await? {
        let mut versions=Vec::new();
        for field in ["ours","theirs"] {
            let event:transport::Change=serde_json::from_str(row[field].as_str().ok_or("Invalid conflict revision.")?).map_err(|_|"Invalid conflict revision.")?;
            let payload=event.payload.ok_or("The conflicting revision no longer has content.")?;
            let text=|field:&str|payload.get(field).and_then(Value::as_str).map(str::to_owned);
            versions.push(Candidate{event_id:event.id,device_id:event.device_id,text:text("text").unwrap_or_default(),kind:text("kind").unwrap_or_default(),rationale:text("rationale"),alternatives:text("alternatives"),source_artifact_id:text("source_artifact_id"),extraction_model:text("extraction_model"),authority:text("authority"),confidence:payload.get("confidence").and_then(Value::as_i64),source_thread_id:text("source_thread_id"),source_message_id:text("source_message_id"),extraction_method:text("extraction_method"),created_at:event.created_at});
        }
        result.push(Conflict{id:row["id"].as_str().ok_or("Invalid conflict identity.")?.into(),record_id:row["record_key"].as_str().ok_or("Invalid conflict identity.")?.into(),versions});
    }
    Ok(result)
}
pub async fn disable(ctx: &Ctx) -> Result<Status, String> {
    db::execute(
        &ctx.db.pool()?,
        "UPDATE sync_state SET enabled=0,error=NULL WHERE workspace_id=?",
        &[json!(WORKSPACE)],
    )
    .await?;
    ctx.sync.wake.notify_one();
    status(ctx).await
}
/// The HTTP handler revokes the bearer token first. Block the membership before waiting for
/// an in-flight worker, then rotate under the same lock as transport/enrollment/recovery.
#[cfg(any(feature = "server", test))]
pub async fn revoke_auth(ctx: &Ctx, auth_id: &str) -> Result<(), String> {
    if !ctx.sync.host {
        return Err("Revoke devices in HULK's signed-in Settings.".into());
    }
    db::db_open(ctx).await?;
    let rows = db::select(
        &ctx.db.pool()?,
        "SELECT id FROM sync_devices WHERE workspace_id=? AND auth_id=? AND revoked_at IS NULL",
        &[json!(WORKSPACE), json!(auth_id)],
    )
    .await?;
    if rows.is_empty() {
        return Ok(());
    }
    db::batch(&ctx.db.pool()?,&[
        db::Statement{sql:"UPDATE sync_state SET rotation_prior_paused=CASE WHEN rotation_pending=0 THEN paused ELSE rotation_prior_paused END,rotation_epoch=CASE WHEN rotation_pending=0 THEN epoch+1 ELSE rotation_epoch END,rotation_pending=1,paused=1,error='Finishing device revocation and key rotation.' WHERE workspace_id=?".into(),params:vec![json!(WORKSPACE)]},
        db::Statement{sql:"UPDATE sync_devices SET revoked_at=?,updated_at=? WHERE workspace_id=? AND auth_id=?".into(),params:vec![json!(now()),json!(now()),json!(WORKSPACE),json!(auth_id)]},
    ]).await?;
    finish_rotation(ctx).await
}
pub async fn finish_rotation(ctx: &Ctx) -> Result<(), String> {
    if !ctx.sync.host {
        return Err("Finish revocation in HULK's signed-in Settings.".into());
    }
    let _lock = ctx.sync.administration.lock().await;
    let state=db::select(&ctx.db.pool()?,"SELECT rotation_pending,rotation_prior_paused,rotation_epoch FROM sync_state WHERE workspace_id=?",&[json!(WORKSPACE)]).await?.remove(0);
    if state["rotation_pending"] != json!(1) {
        return Ok(());
    }
    let target = state["rotation_epoch"]
        .as_u64()
        .ok_or("Invalid pending encryption epoch.")?;

    let mut keys = load_keys(ctx.keys.store.as_ref())?
        .ok_or("Recover HULK's keys to finish revocation. Transfers remain paused.")?;
    if target > 1024 || target < keys.epoch {
        return Err("Encryption epoch limit reached; transfers remain paused.".into());
    }
    if keys.epoch < target {
        keys.epoch = target;
        keys.epochs
            .insert(keys.epoch, crypto::hex(&crypto::random::<32>()?));
    }
    save_keys(ctx.keys.store.as_ref(), &keys)?;
    let recovery = Zeroizing::new(crypto::hex(&crypto::random::<32>()?));
    ctx.keys.store.set(RECOVERY, &recovery)?;
    save_recovery(ctx).await?;
    db::execute(
        &ctx.db.pool()?,
        "UPDATE sync_state SET epoch=?,paused=?,rotation_pending=0,rotation_epoch=0,error=NULL WHERE workspace_id=?",
        &[
            json!(keys.epoch),
            state["rotation_prior_paused"].clone(),
            json!(WORKSPACE),
        ],
    )
    .await?;
    ctx.sync.wake.notify_one();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{
        tests::{cleanup, fixture},
        transport::{self, Blob, BlobQuery, Hello},
    };
    async fn member(ctx: &Ctx, id: &str, auth: &str) -> String {
        let seed = crypto::hex(&crypto::random::<32>().unwrap());
        accept(
            ctx,
            auth,
            Enrollment {
                protocol: crypto::PROTOCOL,
                schema: db::schema_version(),
                device_id: id.into(),
                name: id.into(),
                public_key: crypto::public(&seed).unwrap(),
            },
        )
        .await
        .unwrap();
        seed
    }
    #[tokio::test]
    async fn revocation_rotates_keys_and_recovery_without_losing_pending_edits() {
        let ctx = fixture(true);
        setup(&ctx, true).await.unwrap();
        member(&ctx, "deviceA", "pairA").await;
        let seed = member(&ctx, "deviceB", "pairB").await;
        let old = load_keys(ctx.keys.store.as_ref()).unwrap().unwrap();
        let code = recovery_code(&ctx).unwrap();
        db::execute(&ctx.db.pool().unwrap(),"INSERT INTO threads(id,workspace_id,user_id,title,created_at,updated_at) VALUES ('pending',?,?,'Pending',1,1)",&[json!(WORKSPACE),json!(USER)]).await.unwrap();
        let blob_id = crypto::hex(&crypto::random::<32>().unwrap());
        let header = crypto::Header {
            protocol: crypto::PROTOCOL,
            schema: db::schema_version(),
            workspace_id: WORKSPACE.into(),
            user_id: USER.into(),
            dataset_id: old.dataset_id.clone(),
            epoch: 1,
            device_id: "deviceB".into(),
            event_id: format!("blob:{blob_id}"),
            seq: 0,
            clock: 0,
        };
        let envelope = crypto::seal(
            header.clone(),
            b"synthetic encrypted chunk",
            &old.epochs[&1],
            &seed,
        )
        .unwrap();
        transport::put_blob(
            &ctx,
            &old,
            "deviceB",
            Blob {
                id: blob_id.clone(),
                envelope,
            },
        )
        .await
        .unwrap();
        revoke_auth(&ctx, "pairA").await.unwrap();
        let state = status(&ctx).await.unwrap();
        assert_eq!(state.epoch, 2);
        assert_eq!(state.pending, 1);
        assert!(!state.rotation_pending);
        assert!(!state.paused);
        assert!(
            state
                .devices
                .iter()
                .find(|d| d.id == "deviceA")
                .unwrap()
                .revoked_at
                .is_some()
        );
        assert_ne!(code, recovery_code(&ctx).unwrap());
        assert!(recover(&ctx, code).await.is_err());
        let hello = |id: &str| Hello {
            protocol: crypto::PROTOCOL,
            schema: db::schema_version(),
            dataset_id: old.dataset_id.clone(),
            epoch: 1,
            device_id: id.into(),
        };
        assert!(
            transport::authorize(&ctx, "pairA", &hello("deviceA"))
                .await
                .is_err()
        );
        let current = transport::authorize(&ctx, "pairB", &hello("deviceB"))
            .await
            .unwrap();
        assert_eq!(current.epoch, 2);
        assert!(
            transport::probe(
                &ctx,
                BlobQuery {
                    ids: vec![blob_id.clone()]
                }
            )
            .await
            .unwrap()
            .ids
            .is_empty()
        );
        let mut header = header;
        header.epoch = 2;
        let envelope = crypto::seal(
            header,
            b"synthetic encrypted chunk",
            &current.epochs[&2],
            &seed,
        )
        .unwrap();
        transport::put_blob(
            &ctx,
            &current,
            "deviceB",
            Blob {
                id: blob_id.clone(),
                envelope,
            },
        )
        .await
        .unwrap();
        assert_eq!(transport::get_blob(&ctx, &blob_id).unwrap().header.epoch, 2);
        cleanup(&ctx).await;
    }
    #[tokio::test]
    async fn interrupted_rotation_stays_closed_and_resumes_idempotently() {
        let ctx = fixture(true);
        setup(&ctx, true).await.unwrap();
        db::execute(&ctx.db.pool().unwrap(),"UPDATE sync_state SET rotation_pending=1,rotation_epoch=2,rotation_prior_paused=0,paused=1",&[]).await.unwrap();
        assert!(worker::pause(&ctx, false).await.is_err());
        assert!(!worker::active(&ctx).await.unwrap());
        assert!(setup(&ctx, true).await.is_err());
        let mut keys = load_keys(ctx.keys.store.as_ref()).unwrap().unwrap();
        keys.epoch = 2;
        keys.epochs
            .insert(2, crypto::hex(&crypto::random::<32>().unwrap()));
        save_keys(ctx.keys.store.as_ref(), &keys).unwrap();
        finish_rotation(&ctx).await.unwrap();
        assert_eq!(status(&ctx).await.unwrap().epoch, 2);
        finish_rotation(&ctx).await.unwrap();
        assert_eq!(status(&ctx).await.unwrap().epoch, 2);
        disable(&ctx).await.unwrap();
        assert!(!worker::active(&ctx).await.unwrap());
        cleanup(&ctx).await;
    }
}
