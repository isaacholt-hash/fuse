//! Synthetic end-to-end benchmark: two independent native replicas and a real throwaway HULK.
use super::*;
use crate::db;
use crate::sync::{self, USER, WORKSPACE, transport, worker};
use serde_json::json;
use std::time::Instant;

async fn execute(ctx: &Ctx, sql: &str, params: Vec<Value>) {
    db::execute(&ctx.db.pool().unwrap(), sql, &params)
        .await
        .unwrap();
}
async fn scalar(ctx: &Ctx, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&ctx.db.pool().unwrap())
        .await
        .unwrap()
}
async fn rows(ctx: &Ctx, sql: &str) -> Vec<serde_json::Map<String, Value>> {
    db::select(&ctx.db.pool().unwrap(), sql, &[]).await.unwrap()
}
async fn cycle(ctx: &Ctx, id: &str) {
    worker::cycle(ctx, id).await.unwrap();
}
async fn settle(a: &Ctx, b: &Ctx, host: &Ctx) {
    for _ in 0..12 {
        cycle(a, "desktop-a").await;
        cycle(host, "hulk").await;
        cycle(b, "desktop-b").await;
        cycle(host, "hulk").await;
        cycle(a, "desktop-a").await;
        let mut pending = 0;
        for ctx in [a, b, host] {
            pending+=scalar(ctx,"SELECT (SELECT COUNT(*) FROM sync_outbox)+(SELECT COUNT(*) FROM sync_inbox WHERE applied=0)").await;
        }
        if pending == 0 {
            // One extra round delivers the last peer's changes before comparing snapshots.
            cycle(b, "desktop-b").await;
            cycle(host, "hulk").await;
            cycle(a, "desktop-a").await;
            return;
        }
    }
    panic!("The synthetic replicas did not reach quiescence");
}
async fn seed(ctx: &Ctx, label: &str) {
    db::db_open(ctx).await.unwrap();
    execute(ctx,"INSERT INTO projects(id,workspace_id,user_id,name,repo_root,created_at,updated_at) VALUES ('common-project',?,?,'Common project',?,1,1)",vec![json!(WORKSPACE),json!(USER),json!(format!("/synthetic/{label}/repository"))]).await;
    execute(ctx,"INSERT INTO threads(id,workspace_id,user_id,project_id,title,created_at,updated_at) VALUES ('common-thread',?,?,'common-project','Common conversation',1,1)",vec![json!(WORKSPACE),json!(USER)]).await;
    for i in 0..8 {
        execute(ctx,"INSERT INTO messages(id,workspace_id,user_id,thread_id,role,content,status,created_at,updated_at) VALUES (?,?,?,'common-thread','user',?,'complete',1,1)",vec![json!(format!("{label}-message-{i}")),json!(WORKSPACE),json!(USER),json!(format!("Synthetic {label} message {i}"))]).await;
    }
    execute(ctx,"INSERT INTO request_log(id,workspace_id,user_id,thread_id,purpose,provider,model,cost_micro_usd,surface,created_at,updated_at) VALUES ('shared-request',?,?,'common-thread','chat','anthropic','synthetic-model',123456,'desktop',1,1)",vec![json!(WORKSPACE),json!(USER)]).await;
    execute(ctx,"INSERT INTO request_log(id,workspace_id,user_id,thread_id,purpose,provider,model,cost_micro_usd,surface,created_at,updated_at) VALUES (?,?,?,'common-thread','chat','anthropic','synthetic-model',17,?,1,1)",vec![json!(format!("{label}-request")),json!(WORKSPACE),json!(USER),json!(if label=="a" {"runner"} else {"web"})]).await;
    execute(ctx,"INSERT INTO memories(id,workspace_id,user_id,text,kind,authority,scope,confidence,created_at,updated_at) VALUES ('fact',?,?,'Shared synthetic fact','fact','you','global',100,1,1)",vec![json!(WORKSPACE),json!(USER)]).await;
    execute(ctx,"INSERT INTO settings(workspace_id,user_id,key,value,created_at,updated_at) VALUES (?,?,'lock.passcode_hash','synthetic-local-only',1,1)",vec![json!(WORKSPACE),json!(USER)]).await;

    execute(ctx,"INSERT INTO thread_tags(id,workspace_id,user_id,thread_id,tag,created_at,updated_at) VALUES (?,?,?,'common-thread','shared-tag',1,1)",vec![json!(format!("{label}-tag")),json!(WORKSPACE),json!(USER)]).await;
    execute(ctx,"INSERT INTO settings(id,workspace_id,user_id,key,value,created_at,updated_at) VALUES (?,?,?,'memory.suggest','on',1,1)",vec![json!(format!("{label}-setting")),json!(WORKSPACE),json!(USER)]).await;
    assert_eq!(scalar(ctx, "SELECT COUNT(*) FROM sync_outbox").await, 0);
}
async fn enroll(ctx: &Ctx, base: &str, cookie: &str, name: &str) {
    let reply = reqwest::Client::new()
        .post(format!("{base}/api/auth/pair-code"))
        .header("cookie", cookie)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    crate::hulk::hulk_pair(
        ctx,
        base.into(),
        reply["code"].as_str().unwrap().into(),
        name.into(),
    )
    .await
    .unwrap();
    assert!(!sync::status(ctx).await.unwrap().enabled);
    sync::enroll(ctx, name.into(), true).await.unwrap();
}

async fn wipe(ctx: &Ctx) {
    db::batch(&ctx.db.pool().unwrap(),&[
        db::Statement{sql:"UPDATE sync_state SET seq=seq+1,clock=clock+1 WHERE workspace_id=?".into(),params:vec![json!(WORKSPACE)]},
        db::Statement{sql:r#"INSERT INTO sync_outbox(id,workspace_id,user_id,table_name,record_key,device_id,seq,clock,version,operation,payload,created_at,updated_at) SELECT device_id||':'||seq,workspace_id,user_id,'$workspace',workspace_id,device_id,seq,clock,json_set(wipe_version,'$."'||device_id||'"',seq),'delete',NULL,1,1 FROM sync_state WHERE workspace_id=?"#.into(),params:vec![json!(WORKSPACE)]},
    ]).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn encrypted_sync_benchmark() {
    let started = Instant::now();
    let host_fixture = sync::tests::fixture(true);
    let root = host_fixture.config_dir.parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&root).unwrap();
    let ui = root.join("ui");
    std::fs::create_dir_all(&ui).unwrap();
    std::fs::write(ui.join("index.html"), "Synthetic sync fixture").unwrap();
    let server = Server::new(host_fixture, Auth::open(&root).unwrap());
    db::db_open(&server.ctx).await.unwrap();
    let host = server.ctx.sync_view().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = router(server.clone(), &ui);
    let serving = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let response = reqwest::Client::new()
        .post(format!("{base}/api/auth/set-up"))
        .json(&json!({"passphrase":"synthetic-sync-fixture-passphrase"}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let a = sync::tests::fixture(false);
    let b = sync::tests::fixture(false);
    seed(&a, "a").await;
    seed(&b, "b").await;
    db::db_open(&host).await.unwrap();
    execute(&host,"INSERT INTO threads(id,workspace_id,user_id,title,created_at,updated_at) VALUES ('hulk-history',?,?,'Existing HULK history',1,1)",vec![json!(WORKSPACE),json!(USER)]).await;
    // Local bytes exist before explicit enrollment, just as selected app attachments do.
    let bytes = vec![42u8; 2 * 1024 * 1024 + 17];
    let stored = crate::files::put(&a.data_dir, &bytes).unwrap();
    execute(&a,"INSERT INTO files(id,workspace_id,user_id,name,mime,size_bytes,sha256,storage_path,thread_id,created_at,updated_at) VALUES ('file',?,?,'Synthetic attachment.txt','text/plain',?,?,?,'common-thread',1,1)",vec![json!(WORKSPACE),json!(USER),json!(bytes.len()),json!(stored.sha256),json!(format!("files/{}",stored.sha256))]).await;
    execute(&a,"INSERT INTO runs(id,workspace_id,user_id,thread_id,project_id,task,mode,provider,model,status,cap_micro_usd,created_at,updated_at) VALUES ('completed-run',?,?,'common-thread','common-project','Synthetic completed run','plan','anthropic','synthetic-model','done',100,1,1)",vec![json!(WORKSPACE),json!(USER)]).await;
    sync::setup(&host, true).await.unwrap();
    enroll(&a, &base, &cookie, "Desktop A").await;
    enroll(&b, &base, &cookie, "Desktop B").await;
    let union_started = Instant::now();
    settle(&a, &b, &host).await;
    let union_ms = union_started.elapsed().as_millis();
    for ctx in [&a, &b, &host] {
        assert_eq!(scalar(ctx, "SELECT COUNT(*) FROM messages").await, 16);
        assert_eq!(
            scalar(
                ctx,
                "SELECT COUNT(*) FROM threads WHERE id IN ('common-thread','hulk-history')"
            )
            .await,
            2
        );
        assert_eq!(
            scalar(ctx, "SELECT SUM(cost_micro_usd) FROM request_log").await,
            123490
        );
        assert_eq!(scalar(ctx, "SELECT COUNT(*) FROM request_log").await, 3);
        assert_eq!(scalar(ctx,"SELECT COUNT(*) FROM request_log WHERE (id='shared-request' AND surface='desktop' AND cost_micro_usd=123456) OR (id='a-request' AND surface='runner' AND cost_micro_usd=17) OR (id='b-request' AND surface='web' AND cost_micro_usd=17)").await,3);
        assert_eq!(
            scalar(
                ctx,
                "SELECT COUNT(*) FROM thread_tags WHERE tag='shared-tag'"
            )
            .await,
            1
        );
        assert_eq!(
            scalar(
                ctx,
                "SELECT COUNT(*) FROM settings WHERE key='memory.suggest'"
            )
            .await,
            1
        );
        assert_eq!(scalar(ctx, "SELECT COUNT(*) FROM run_requests").await, 0);
        assert_eq!(
            scalar(
                ctx,
                "SELECT COUNT(*) FROM runs WHERE id='completed-run' AND status='done'"
            )
            .await,
            1
        );
        assert_eq!(
            crate::files::get(&ctx.data_dir, &stored.sha256).unwrap(),
            bytes
        );
    }
    assert_eq!(
        rows(
            &a,
            "SELECT repo_root FROM projects WHERE id='common-project'"
        )
        .await[0]["repo_root"],
        "/synthetic/a/repository"
    );
    assert_eq!(
        rows(
            &b,
            "SELECT repo_root FROM projects WHERE id='common-project'"
        )
        .await[0]["repo_root"],
        "/synthetic/b/repository"
    );
    assert!(
        rows(
            &host,
            "SELECT repo_root FROM projects WHERE id='common-project'"
        )
        .await[0]["repo_root"]
            .is_null()
    );
    assert_eq!(
        scalar(
            &host,
            "SELECT COUNT(*) FROM settings WHERE key='lock.passcode_hash'"
        )
        .await,
        0
    );
    assert_eq!(
        scalar(&b, "SELECT COUNT(*) FROM runs WHERE sync_owner IS NOT NULL").await,
        1
    );
    // Both replicas edit without exchanging the intervening revisions; timestamps are skewed.
    execute(
        &a,
        "UPDATE threads SET title='Offline A',updated_at=9999999999999 WHERE id='common-thread'",
        vec![],
    )
    .await;
    execute(
        &b,
        "UPDATE threads SET title='Offline B',updated_at=1 WHERE id='common-thread'",
        vec![],
    )
    .await;
    execute(
        &a,
        "UPDATE memories SET text='Concurrent fact A',updated_at=10 WHERE id='fact'",
        vec![],
    )
    .await;
    execute(
        &b,
        "UPDATE memories SET text='Concurrent fact B',updated_at=20 WHERE id='fact'",
        vec![],
    )
    .await;
    settle(&a, &b, &host).await;
    let expected = rows(&a, "SELECT title FROM threads WHERE id='common-thread'").await;
    for ctx in [&b, &host] {
        assert_eq!(
            rows(ctx, "SELECT title FROM threads WHERE id='common-thread'").await,
            expected
        );
        assert!(sync::status(ctx).await.unwrap().conflicts > 0);
    }
    let conflicts = sync::management::conflicts(&a).await.unwrap();
    let choice = conflicts[0].versions[0].event_id.clone();
    sync::merge::resolve(&a, "fact".into(), choice)
        .await
        .unwrap();
    settle(&a, &b, &host).await;
    for ctx in [&a, &b, &host] {
        assert_eq!(sync::status(ctx).await.unwrap().conflicts, 0);
    }
    // Deliver an already committed page twice, simulating a lost acknowledgement.
    let page = transport::pull(&host.db.pool().unwrap(), 0).await.unwrap();
    worker::receive(&b, page).await.unwrap();
    let page = transport::pull(&host.db.pool().unwrap(), 0).await.unwrap();
    worker::receive(&b, page).await.unwrap();
    settle(&a, &b, &host).await;
    for ctx in [&a, &b, &host] {
        assert_eq!(
            scalar(ctx, "SELECT SUM(cost_micro_usd) FROM request_log").await,
            123490
        );
    }

    // Final deletion beats a concurrent offline edit; Undo before the deadline emits no marker.
    execute(&a,"INSERT INTO threads(id,workspace_id,user_id,project_id,title,created_at,updated_at) VALUES ('delete-target',?,?,'common-project','Delete target',1,1)",vec![json!(WORKSPACE),json!(USER)]).await;
    execute(&a,"INSERT INTO messages(id,workspace_id,user_id,thread_id,role,content,status,created_at,updated_at) VALUES ('delete-message',?,?,'delete-target','user','Delete this content','complete',1,1)",vec![json!(WORKSPACE),json!(USER)]).await;
    execute(&a,"INSERT INTO message_files(id,workspace_id,user_id,message_id,file_id,ordinal,created_at,updated_at) VALUES ('shared-link',?,?,'delete-message','file',0,1,1)",vec![json!(WORKSPACE),json!(USER)]).await;
    execute(
        &a,
        "UPDATE request_log SET thread_id='delete-target' WHERE id='a-request'",
        vec![],
    )
    .await;
    settle(&a, &b, &host).await;
    execute(
        &a,
        "UPDATE threads SET deleted_at=1 WHERE id='delete-target'",
        vec![],
    )
    .await;
    cycle(&a, "desktop-a").await;
    assert_eq!(
        scalar(
            &a,
            "SELECT COUNT(*) FROM threads WHERE id='delete-target' AND purged_at IS NULL"
        )
        .await,
        1
    );
    execute(
        &a,
        "UPDATE threads SET deleted_at=NULL WHERE id='delete-target'",
        vec![],
    )
    .await;
    settle(&a, &b, &host).await;
    execute(
        &b,
        "UPDATE threads SET title='Offline stale title' WHERE id='delete-target'",
        vec![],
    )
    .await;
    execute(
        &a,
        "UPDATE threads SET deleted_at=2 WHERE id='delete-target'",
        vec![],
    )
    .await;
    execute(&a,"UPDATE sync_pending_deletes SET deadline=0 WHERE table_name='threads' AND id='delete-target'",vec![]).await;
    sync::merge::finalize(&a).await.unwrap();
    settle(&a, &b, &host).await;
    for ctx in [&a, &b, &host] {
        assert_eq!(
            scalar(
                ctx,
                "SELECT COUNT(*) FROM messages WHERE id='delete-message'"
            )
            .await,
            0
        );
        assert_eq!(scalar(ctx,"SELECT COUNT(*) FROM threads WHERE id='delete-target' AND title='' AND purged_at IS NOT NULL").await,1);
        assert_eq!(
            scalar(ctx, "SELECT SUM(cost_micro_usd) FROM request_log").await,
            123490
        );
        assert_eq!(
            crate::files::get(&ctx.data_dir, &stored.sha256).unwrap(),
            bytes
        );
    }
    // A content-free workspace barrier covers unseen offline IDs; shared private bytes survive.
    execute(&b,"INSERT INTO threads(id,workspace_id,user_id,title,created_at,updated_at) VALUES ('offline-unseen',?,?,'Unseen offline history',1,1)",vec![json!(WORKSPACE),json!(USER)]).await;
    execute(&b,"INSERT INTO files(id,workspace_id,user_id,name,mime,size_bytes,sha256,storage_path,may_send,created_at,updated_at) VALUES ('private-file',?,?,'Keep this copy','text/plain',?,?,?,0,1,1)",vec![json!(WORKSPACE),json!(USER),json!(bytes.len()),json!(stored.sha256),json!(format!("files/{}",stored.sha256))]).await;
    wipe(&a).await;
    settle(&a, &b, &host).await;
    for ctx in [&a, &b, &host] {
        assert_eq!(scalar(ctx, "SELECT COUNT(*) FROM messages").await, 0);
        assert_eq!(scalar(ctx, "SELECT COUNT(*) FROM request_log").await, 0);
        assert_eq!(
            scalar(
                ctx,
                "SELECT COUNT(*) FROM threads WHERE id='offline-unseen' AND purged_at IS NULL"
            )
            .await,
            0
        );
        assert_eq!(
            scalar(
                ctx,
                "SELECT COUNT(*) FROM sync_tombstones WHERE table_name='$workspace'"
            )
            .await,
            1
        );
    }
    assert!(crate::files::get(&a.data_dir, &stored.sha256).is_err());
    assert!(crate::files::get(&host.data_dir, &stored.sha256).is_err());
    assert_eq!(
        crate::files::get(&b.data_dir, &stored.sha256).unwrap(),
        bytes
    );
    assert_eq!(
        scalar(
            &b,
            "SELECT COUNT(*) FROM files WHERE id='private-file' AND may_send=0"
        )
        .await,
        1
    );
    execute(&a,"INSERT INTO threads(id,workspace_id,user_id,title,created_at,updated_at) VALUES ('post-wipe',?,?,'New after wipe',1,1)",vec![json!(WORKSPACE),json!(USER)]).await;
    settle(&a, &b, &host).await;
    for ctx in [&a, &b, &host] {
        assert_eq!(
            scalar(
                ctx,
                "SELECT COUNT(*) FROM threads WHERE id='post-wipe' AND purged_at IS NULL"
            )
            .await,
            1
        );
    }
    // Revocation rotates the host, while another offline active device keeps its pending work.
    execute(
        &a,
        "UPDATE threads SET title='Pending across rotation' WHERE id='post-wipe'",
        vec![],
    )
    .await;
    let b_id = sync::status(&b).await.unwrap().device_id;
    let member = sync::devices(&host)
        .await
        .unwrap()
        .into_iter()
        .find(|d| d.id == b_id)
        .unwrap();
    let response = reqwest::Client::new()
        .post(format!("{base}/api/auth/revoke"))
        .header("cookie", &cookie)
        .json(&json!({"id":member.auth_id}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    assert!(matches!(
        worker::cycle(&b, "desktop-b").await,
        Err(worker::Fault::Pause(_))
    ));
    cycle(&a, "desktop-a").await;
    cycle(&host, "hulk").await;
    cycle(&a, "desktop-a").await;
    assert_eq!(sync::status(&a).await.unwrap().epoch, 2);
    assert_eq!(sync::status(&a).await.unwrap().pending, 0);
    assert_eq!(
        rows(&host, "SELECT title FROM threads WHERE id='post-wipe'").await[0]["title"],
        "Pending across rotation"
    );
    let report = json!({"benchmark":"M11 encrypted sync","schema":db::schema_version(),"desktopReplicas":2,"hulkServers":1,"synthetic":true,"secrets":"in-memory only","initialMessages":16,"initialThreads":2,"initialCostRequests":3,"initialCostMicroUsd":123490,"postWipeCostRequests":0,"fileBytes":bytes.len(),"fileChunks":3,"initialUnionMs":union_ms,"totalMs":started.elapsed().as_millis(),"passed":["populated union and stable IDs","encrypted file round trip","machine paths and lock exclusion","cost deduplication and attribution","natural-key settings and tags","read-only completed history without execution queue","offline edits and clock skew","fact conflict review and replicated resolution","duplicate delivery after commit","undo before final deletion","deletion wins against offline edits while preserving costs","workspace deletion covers unseen offline IDs","shared private file bytes survive remote deletion","new records after acknowledged workspace deletion","revoked token rejection","active offline key refresh with pending preservation"]});
    if let Some(path) = std::env::var_os("FUSE_SYNC_BENCH_OUTPUT") {
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    println!(
        "FUSE_SYNC_BENCHMARK {}",
        serde_json::to_string(&report).unwrap()
    );
    serving.abort();
    let _ = serving.await;
    sync::tests::cleanup(&a).await;
    sync::tests::cleanup(&b).await;
    drop(server);
    sync::tests::cleanup(&host).await;
}
