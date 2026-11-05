//! Bounded, single-attempt transcription. Only Rust handles credentials and settles costs;
//! losing a webview or browser response cannot discard the receipt or replay a paid upload.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tokio::sync::oneshot;

use crate::{
    audio,
    ctx::Ctx,
    egress,
    keys::Provider,
    sync::{USER, WORKSPACE},
};

const PATH: &str = "/v1/audio/transcriptions";
fn storage(_: impl std::fmt::Display) -> String {
    "Couldn't update transcription accounting.".into()
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Deserialize)]
pub struct Price {
    pub model: String,
    pub price_version: String,
    pub micro_usd_per_minute: u64,
}
pub fn price() -> Result<Price, String> {
    serde_json::from_str(include_str!("../../data/speech.json"))
        .map_err(|_| "Transcription pricing is unavailable.".into())
}
pub fn cost(ms: u64, price: &Price) -> Result<i64, String> {
    let value = u128::from(ms)
        .checked_mul(u128::from(price.micro_usd_per_minute))
        .ok_or("Transcription price overflow.")?
        .div_ceil(60_000);
    i64::try_from(value).map_err(|_| "Transcription price overflow.".into())
}

#[derive(Clone, Default)]
pub struct Speech(Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>);

#[derive(Deserialize, Serialize)]
struct Source {
    scope: String,
    project: Option<String>,
}

async fn source(
    pool: &SqlitePool,
    scope: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let (thread, project) = match egress::parse_scope(scope).ok_or("Invalid recording scope.")? {
        egress::Scope::Global => (None, None),
        egress::Scope::Project(id) => (None, Some(id)),
        egress::Scope::Thread(id) => {
            let row = sqlx::query("SELECT project_id FROM threads WHERE id=? AND workspace_id=? AND user_id=? AND deleted_at IS NULL")
                .bind(&id).bind(WORKSPACE).bind(USER).fetch_optional(pool).await.map_err(storage)?.ok_or("The recording's chat is no longer available.")?;
            (
                Some(id),
                row.try_get::<Option<String>, _>("project_id")
                    .map_err(storage)?,
            )
        }
    };
    if let Some(id) = &project
        && sqlx::query("SELECT id FROM projects WHERE id=? AND workspace_id=? AND user_id=? AND deleted_at IS NULL")
            .bind(id).bind(WORKSPACE).bind(USER).fetch_optional(pool).await.map_err(storage)?.is_none() {
            return Err("The recording's project is no longer available.".into());
    }
    egress::check(pool, Provider::Openai, "POST", PATH, Some(scope)).await?;
    Ok((thread, project))
}

// One conditional write serializes reservations with all other SQLite writers. Both hard and
// soft budget crossings need an existing explicit temporary allowance before audio is sent.
// ?1=id ?2=workspace ?3=user ?5=project ?6=bound ?9=now. Exclude this hold on dispatch.
const BUDGET_ALLOWED: &str = "NOT EXISTS (
 SELECT 1 FROM budgets b WHERE b.workspace_id=?2 AND b.user_id=?3
 AND (b.project_id IS NULL OR b.project_id=?5) AND COALESCE(b.allow_until,0)<=?9
 AND b.limit_micro_usd < ?6
 + (SELECT COALESCE(SUM(l.cost_micro_usd),0) FROM request_log l LEFT JOIN threads t ON t.id=l.thread_id AND t.workspace_id=l.workspace_id
    WHERE l.workspace_id=?2 AND l.user_id=?3 AND l.created_at >=
      CASE b.period WHEN 'day' THEN unixepoch(?9/1000,'unixepoch','localtime','start of day','utc')*1000
       ELSE unixepoch(?9/1000,'unixepoch','localtime','start of month','utc')*1000 END
    AND (b.project_id IS NULL OR CASE WHEN t.id IS NOT NULL THEN t.project_id ELSE l.project_id END=b.project_id))
 + (SELECT COALESCE(SUM(MAX(h.bound_micro_usd-COALESCE(l.cost_micro_usd,0),0)),0)
    FROM request_reservations h LEFT JOIN request_log l ON l.id=h.request_id AND l.workspace_id=h.workspace_id
    LEFT JOIN threads t ON t.id=h.thread_id AND t.workspace_id=h.workspace_id
    WHERE h.workspace_id=?2 AND h.user_id=?3 AND h.id!=?1 AND h.state IN ('held','dispatched','unknown')
    AND h.created_at >= CASE b.period WHEN 'day' THEN unixepoch(?9/1000,'unixepoch','localtime','start of day','utc')*1000
       ELSE unixepoch(?9/1000,'unixepoch','localtime','start of month','utc')*1000 END
    AND (b.project_id IS NULL OR CASE WHEN t.id IS NOT NULL THEN t.project_id ELSE h.project_id END=b.project_id)))";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub id: String,
    pub bound_micro_usd: i64,
}

pub async fn prepare(
    ctx: &Ctx,
    scope: String,
    duration_ms: u64,
    consent: bool,
    surface: &str,
) -> Result<Ticket, String> {
    if !consent {
        return Err("Agree to sending this recording to OpenAI before transcription.".into());
    }
    if duration_ms == 0 || duration_ms > audio::MAX_MS {
        return Err("Record between a moment and two minutes of audio.".into());
    }
    if !matches!(surface, "desktop" | "web") {
        return Err("Invalid recording surface.".into());
    }
    let pool = ctx.db.pool()?;
    let (thread, project) = source(&pool, &scope).await?;
    let source = serde_json::to_string(&Source {
        scope,
        project: project.clone(),
    })
    .map_err(storage)?;
    let price = price()?;
    // Providers may report duration rounded to a whole second; reserve that upper amount.
    let bound = cost(duration_ms.div_ceil(1000) * 1000, &price)?;
    let id = audio::id()?;
    let stamp = now();
    sqlx::query("UPDATE request_reservations SET state='released',updated_at=? WHERE workspace_id=? AND user_id=? AND purpose='transcribe' AND state='held' AND created_at<?")
        .bind(stamp).bind(WORKSPACE).bind(USER).bind(stamp-300_000).execute(&pool).await.map_err(storage)?;
    let sql = format!("INSERT INTO request_reservations(id,workspace_id,user_id,run_id,provider,model,purpose,thread_id,project_id,bound_micro_usd,state,source_scope,surface,created_at,updated_at)
       SELECT ?1,?2,?3,NULL,'openai',?10,'transcribe',?4,?5,?6,'held',?7,?8,?9,?9 WHERE {BUDGET_ALLOWED}");
    let inserted = sqlx::query(&sql)
        .bind(&id)
        .bind(WORKSPACE)
        .bind(USER)
        .bind(thread)
        .bind(project)
        .bind(bound)
        .bind(source)
        .bind(surface)
        .bind(stamp)
        .bind(price.model)
        .execute(&pool)
        .await
        .map_err(storage)?
        .rows_affected();
    if inserted != 1 {
        return Err(
            "Transcription would exceed a budget. Review Costs & limits before trying again."
                .into(),
        );
    }
    Ok(Ticket {
        id,
        bound_micro_usd: bound,
    })
}

pub async fn cancel(ctx: &Ctx, id: &str) -> Result<(), String> {
    sqlx::query("UPDATE request_reservations SET state='released',updated_at=? WHERE id=? AND workspace_id=? AND user_id=? AND purpose='transcribe' AND state='held'")
        .bind(now()).bind(id).bind(WORKSPACE).bind(USER).execute(&ctx.db.pool()?).await.map_err(storage)?;
    if let Some(cancel) = ctx.speech.0.lock().map_err(storage)?.remove(id) {
        let _ = cancel.send(());
    }
    Ok(())
}

struct Receipt<'a> {
    state: &'static str,
    cost: i64,
    duration_ms: u64,
    status: Option<u16>,
    code: Option<&'static str>,
    provider_id: Option<&'a str>,
    latency_ms: u64,
}
async fn settle(
    pool: &SqlitePool,
    id: &str,
    receipt: Receipt<'_>,
    price: &Price,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(storage)?;
    sqlx::query("INSERT INTO request_log(id,workspace_id,user_id,thread_id,message_id,purpose,provider,model,attempt,cost_micro_usd,price_version,latency_ms,http_status,error_code,error_message,provider_request_id,surface,project_id,audio_duration_ms,billing_state,attempt_id,created_at,updated_at)
      SELECT id,workspace_id,user_id,thread_id,NULL,'transcribe',provider,model,1,?,?,?, ?,?, ?,?,surface,project_id,?,?,id,created_at,?
      FROM request_reservations WHERE id=? AND workspace_id=? AND user_id=? AND purpose='transcribe' AND state='dispatched' ON CONFLICT(id) DO NOTHING")
        .bind(receipt.cost).bind(if receipt.state=="reported" {Some(price.price_version.as_str())} else {None})
        .bind(receipt.latency_ms as i64).bind(receipt.status.map(i64::from)).bind(receipt.code)
        .bind(receipt.code.map(|_| match receipt.state { "unknown" => "Transcription billing is unresolved.", "not_billed" => "Transcription was refused before billing.", _ => "The transcript could not be used; its charge was retained." }))
        .bind(receipt.provider_id).bind(receipt.duration_ms as i64).bind(receipt.state).bind(now())
        .bind(id).bind(WORKSPACE).bind(USER).execute(&mut *tx).await.map_err(storage)?;
    sqlx::query("UPDATE request_reservations SET state=?,request_id=id,updated_at=? WHERE id=? AND workspace_id=? AND user_id=? AND purpose='transcribe' AND state='dispatched'")
        .bind(if receipt.state=="unknown" {"unknown"} else {"settled"}).bind(now()).bind(id).bind(WORKSPACE).bind(USER)
        .execute(&mut *tx).await.map_err(storage)?;
    tx.commit().await.map_err(storage)
}

/// Called once when the execution owner's database opens, never when a browser/runner reconnects.
pub async fn recover(pool: &SqlitePool) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(storage)?;
    sqlx::query("INSERT INTO request_log(id,workspace_id,user_id,thread_id,purpose,provider,model,attempt,cost_micro_usd,billing_state,attempt_id,project_id,audio_duration_ms,surface,error_code,error_message,created_at,updated_at)
      SELECT id,workspace_id,user_id,thread_id,'transcribe',provider,model,1,0,'unknown',id,project_id,audio_duration_ms,surface,'interrupted','Transcription billing is unresolved.',created_at,?
      FROM request_reservations WHERE workspace_id=? AND user_id=? AND purpose='transcribe' AND state='dispatched' ON CONFLICT(id) DO NOTHING")
        .bind(now()).bind(WORKSPACE).bind(USER).execute(&mut *tx).await.map_err(storage)?;
    sqlx::query("UPDATE request_reservations SET state=CASE state WHEN 'held' THEN 'released' ELSE 'unknown' END,request_id=CASE state WHEN 'dispatched' THEN id ELSE request_id END,updated_at=? WHERE workspace_id=? AND user_id=? AND purpose='transcribe' AND state IN ('held','dispatched')")
        .bind(now()).bind(WORKSPACE).bind(USER).execute(&mut *tx).await.map_err(storage)?;
    tx.commit().await.map_err(storage)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub request_id: String,
    pub text: String,
    pub duration_ms: u64,
    pub billing_state: &'static str,
    pub cost_micro_usd: Option<i64>,
    pub bound_micro_usd: i64,
}

async fn attempt(
    ctx: &Ctx,
    id: &str,
    audio: Vec<u8>,
    mut cancelled: oneshot::Receiver<()>,
    base: &str,
) -> Result<Transcript, String> {
    let duration = audio::wav_duration(&audio)?;
    let pool = ctx.db.pool()?;
    let hold = sqlx::query("SELECT source_scope,bound_micro_usd,surface,model FROM request_reservations WHERE id=? AND workspace_id=? AND user_id=? AND purpose='transcribe' AND state='held' AND created_at>=?")
        .bind(id).bind(WORKSPACE).bind(USER).bind(now()-300_000).fetch_optional(&pool).await.map_err(storage)?.ok_or("This recording was cancelled, expired or already dispatched. It was not retried.")?;
    let source: Source =
        serde_json::from_str(&hold.try_get::<String, _>("source_scope").map_err(storage)?)
            .map_err(|_| "Invalid recording scope.")?;
    let (thread, project) = source_for_hold(&pool, &source).await?;
    let price = price()?;
    let bound = cost(duration.div_ceil(1000) * 1000, &price)?;
    if hold.try_get::<i64, _>("bound_micro_usd").map_err(storage)? < bound
        || hold.try_get::<String, _>("model").map_err(storage)? != price.model
    {
        return Err("Recording exceeds its quote. Prepare a new transcription explicitly.".into());
    }
    let form = reqwest::multipart::Form::new()
        .text("model", price.model.clone())
        .text("response_format", "json")
        .part(
            "file",
            reqwest::multipart::Part::bytes(audio)
                .file_name("recording.wav")
                .mime_str("audio/wav")
                .map_err(|_| "Couldn't prepare audio.")?,
        );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Couldn't prepare transcription transport.")?;
    let key = ctx
        .keys
        .store
        .get(Provider::Openai.account())
        .map_err(|_| "Couldn't use the OpenAI connection.")?
        .ok_or("Add an OpenAI connection in Settings before transcribing.")?;
    let key = zeroize::Zeroizing::new(key);
    let sql = format!("UPDATE request_reservations SET state='dispatched',bound_micro_usd=?6,audio_duration_ms=?11,thread_id=?4,project_id=?5,created_at=?9,updated_at=?9
      WHERE id=?1 AND workspace_id=?2 AND user_id=?3 AND state='held' AND purpose='transcribe' AND {BUDGET_ALLOWED}");
    let claimed = sqlx::query(&sql)
        .bind(id)
        .bind(WORKSPACE)
        .bind(USER)
        .bind(thread)
        .bind(project)
        .bind(bound)
        .bind(Option::<&str>::None)
        .bind(Option::<&str>::None)
        .bind(now())
        .bind(&price.model)
        .bind(duration as i64)
        .execute(&pool)
        .await
        .map_err(storage)?
        .rows_affected();
    if claimed != 1 {
        return Err("Recording cancelled or its budget changed. Nothing was sent.".into());
    }
    let started = Instant::now();
    let mut receipt = Receipt {
        state: "unknown",
        cost: 0,
        duration_ms: duration,
        status: None,
        code: Some("interrupted"),
        provider_id: None,
        latency_ms: 0,
    };
    if crate::audit::credential_use(&pool, Provider::Openai)
        .await
        .is_err()
    {
        receipt.state = "not_billed";
        receipt.code = Some("audit_unavailable");
        settle(&pool, id, receipt, &price).await?;
        return Err("Couldn't record credential use. Nothing was sent.".into());
    }
    let request = async {
        let mut response = client
            .post(format!("{base}{PATH}"))
            .bearer_auth(key.as_str())
            .multipart(form)
            .send()
            .await
            .map_err(|_| "network")?;
        let status = response.status().as_u16();
        let request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|s| s.to_str().ok())
            .filter(|s| s.len() <= 200)
            .map(str::to_owned);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "network")? {
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err("invalid_response");
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((status, request_id, bytes))
    };
    let response = tokio::select! { biased; _ = &mut cancelled => Err("cancelled"), result = request => result };
    receipt.latency_ms = started.elapsed().as_millis() as u64;
    let mut text = None;
    let mut provider_id = None;
    match response {
        Ok((status, request_id, bytes)) => {
            receipt.status = Some(status);
            provider_id = request_id;
            if (200..300).contains(&status) {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    text = value["text"]
                        .as_str()
                        .filter(|s| s.len() <= 256 * 1024)
                        .map(str::to_owned);
                    if value["usage"]["type"] == "duration"
                        && let Some(seconds) = value["usage"]["seconds"].as_f64().filter(|s| {
                            s.is_finite() && *s >= 0.0 && *s <= duration.div_ceil(1000) as f64
                        })
                    {
                        let billed_ms = (seconds * 1000.0).ceil() as u64;
                        receipt.cost = cost(billed_ms, &price)?;
                        receipt.duration_ms = billed_ms;
                        receipt.state = "reported";
                    }
                }
                receipt.code = if text.is_none() {
                    Some("invalid_response")
                } else if receipt.state == "unknown" {
                    Some("unresolved_usage")
                } else {
                    None
                };
            } else {
                receipt.code = Some("provider_refused");
                if [400, 401, 402, 403, 404, 413, 422, 429].contains(&status) {
                    receipt.state = "not_billed";
                }
            }
        }
        Err(code) => receipt.code = Some(code),
    }
    receipt.provider_id = provider_id.as_deref();
    let state = receipt.state;
    let actual = if state == "reported" {
        Some(receipt.cost)
    } else {
        None
    };
    settle(&pool, id, receipt, &price).await?;
    let text=text.ok_or(match state {
        "not_billed" => "OpenAI refused transcription. Check your connection and limits; nothing was retried.",
        "reported" => "OpenAI charged for transcription but returned no usable transcript. Its cost was saved; another attempt requires explicit action.",
        _ => "No transcript was received. Billing is unresolved; review provider usage before explicitly trying again.",
    })?;
    Ok(Transcript {
        request_id: id.to_owned(),
        text,
        duration_ms: duration,
        billing_state: state,
        cost_micro_usd: actual,
        bound_micro_usd: bound,
    })
}

async fn source_for_hold(
    pool: &SqlitePool,
    saved: &Source,
) -> Result<(Option<String>, Option<String>), String> {
    // Also preserve the original project's restrictions if a chat moves during recording.
    if let Some(project) = &saved.project {
        source(pool, &format!("project:{project}")).await?;
    }
    source(pool, &saved.scope).await
}

pub async fn upload(
    ctx: &Ctx,
    body: Vec<u8>,
    headers: &HashMap<String, String>,
) -> Result<Transcript, String> {
    let id = headers
        .get("x-recording-id")
        .filter(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("Missing recording ID.")?
        .clone();
    if let Err(error) = audio::wav_duration(&body) {
        cancel(ctx, &id).await?;
        return Err(error);
    }
    let view = ctx.sync_view()?;
    let (tx, rx) = oneshot::channel();
    {
        let mut active = ctx.speech.0.lock().map_err(storage)?;
        if active.contains_key(&id) || active.len() >= 2 {
            return Err("Transcription is already in progress. Nothing was retried.".into());
        }
        active.insert(id.clone(), tx);
    }
    // Detached from the calling UI/HTTP connection; costs are committed even if it disappears.
    tokio::spawn(async move {
        let result = attempt(&view, &id, body, rx, Provider::Openai.api_base()).await;
        if result.is_err() {
            let _ = cancel(&view, &id).await;
        }
        if let Ok(mut active) = view.speech.0.lock() {
            active.remove(&id);
        }
        result
    })
    .await
    .map_err(|_| {
        "Transcription was interrupted. Review provider usage before trying again.".to_string()
    })?
}

pub mod commands {
    use super::*;
    use tauri::{State, ipc::Request};
    #[tauri::command]
    pub async fn transcribe_prepare(
        ctx: State<'_, Ctx>,
        scope: String,
        duration_ms: u64,
        consent: bool,
    ) -> Result<Ticket, String> {
        prepare(&ctx, scope, duration_ms, consent, "desktop").await
    }
    #[tauri::command]
    pub async fn transcribe_cancel(ctx: State<'_, Ctx>, id: String) -> Result<(), String> {
        cancel(&ctx, &id).await
    }
    #[tauri::command]
    pub async fn transcribe_audio(
        ctx: State<'_, Ctx>,
        request: Request<'_>,
    ) -> Result<Transcript, String> {
        let (body, headers) = crate::ctx::request_parts(&request)?;
        upload(&ctx, body, &headers).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{Keys, MemoryStore};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    async fn context() -> (Arc<Ctx>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("fuse-speech-test-{}", audio::id().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = Arc::new(Ctx::new(
            dir.join("data"),
            dir.join("config"),
            Keys::with_store(Box::new(MemoryStore::default())),
        ));
        crate::db::db_open(&ctx).await.unwrap();
        // Synthetic in-memory credentials only. The transport fixture never contacts a provider.
        ctx.keys
            .store
            .set("openai", "synthetic-transcription-fixture")
            .unwrap();
        (ctx, dir)
    }
    async fn cleanup(ctx: Arc<Ctx>, dir: std::path::PathBuf) {
        ctx.db.pool().unwrap().close().await;
        drop(ctx);
        let _ = std::fs::remove_dir_all(dir);
    }
    fn audio() -> Vec<u8> {
        audio::wav(&vec![100i16; 8000], 8000).unwrap()
    }

    type FixtureHttp = (
        String,
        mpsc::Receiver<(Vec<u8>, bool)>,
        std::thread::JoinHandle<()>,
    );
    /// One throwaway HTTP responder. Only the body and presence of auth are observed.
    fn provider(status: u16, body: &str, delay: Duration) -> FixtureHttp {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let body = body.to_owned();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let start = Instant::now();
            let mut socket = loop {
                if let Ok((s, _)) = listener.accept() {
                    break s;
                }
                if start.elapsed() > Duration::from_secs(5) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut part = [0u8; 8192];
            let (header_end, len, authorized) = loop {
                let count = socket.read(&mut part).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&part[..count]);
                if let Some(at) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..at]).to_lowercase();
                    let len = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length: "))
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    break (
                        at + 4,
                        len,
                        headers
                            .lines()
                            .any(|l| l.starts_with("authorization: bearer ")),
                    );
                }
            };
            while bytes.len() < header_end + len {
                let count = socket.read(&mut part).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&part[..count]);
            }
            let _ = tx.send((bytes[header_end..header_end + len].to_vec(), authorized));
            std::thread::sleep(delay);
            let response = format!(
                "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nx-request-id: fixture-receipt\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes());
        });
        (base, rx, worker)
    }
    async fn dispatch(ctx: &Ctx, id: &str, base: &str) -> Result<Transcript, String> {
        // Keep the sender alive so the fixture isn't interpreted as cancellation.
        let (_sender, receiver) = oneshot::channel();
        attempt(ctx, id, audio(), receiver, base).await
    }

    #[tokio::test]
    async fn multipart_receipt_is_once_only_and_contains_no_recording_or_transcript() {
        let (ctx, dir) = context().await;
        let ticket = prepare(&ctx, "global".into(), 1000, true, "desktop")
            .await
            .unwrap();
        assert_eq!(ticket.bound_micro_usd, 75);
        let (base, requests, worker) = provider(
            200,
            r#"{"text":"Discard this private transcript","usage":{"type":"duration","seconds":1}}"#,
            Duration::ZERO,
        );
        let result = dispatch(&ctx, &ticket.id, &base).await.unwrap();
        assert_eq!(result.text, "Discard this private transcript");
        assert_eq!(result.cost_micro_usd, Some(75));
        let (body, authorized) = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(authorized);
        assert!(String::from_utf8_lossy(&body).contains("gpt-transcribe"));
        assert!(String::from_utf8_lossy(&body).contains("recording.wav"));
        assert!(body.windows(4).any(|b| b == b"RIFF"));
        worker.join().unwrap();
        assert!(dispatch(&ctx, &ticket.id, &base).await.is_err());
        let rows = crate::db::select(&ctx.db.pool().unwrap(), "SELECT * FROM request_log", &[])
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["cost_micro_usd"], 75);
        assert_eq!(rows[0]["audio_duration_ms"], 1000);
        assert_eq!(rows[0]["surface"], "desktop");
        assert!(
            !serde_json::to_string(&rows)
                .unwrap()
                .contains("private transcript")
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM security_audit WHERE event_kind='credential_use'"
            )
            .fetch_one(&ctx.db.pool().unwrap())
            .await
            .unwrap(),
            1
        );
        cleanup(ctx, dir).await;
    }

    #[tokio::test]
    async fn cancelled_upload_retains_unknown_billing_without_retry() {
        let (ctx, dir) = context().await;
        let ticket = prepare(&ctx, "global".into(), 1000, true, "web")
            .await
            .unwrap();
        let (base, requests, worker) = provider(
            200,
            r#"{"text":"too late","usage":{"type":"duration","seconds":1}}"#,
            Duration::from_millis(250),
        );
        let (cancel, rx) = oneshot::channel();
        let task = {
            let ctx = ctx.clone();
            let id = ticket.id.clone();
            tokio::spawn(async move { attempt(&ctx, &id, audio(), rx, &base).await })
        };
        tokio::task::spawn_blocking(move || requests.recv_timeout(Duration::from_secs(5)).unwrap())
            .await
            .unwrap();
        cancel.send(()).unwrap();
        assert!(task.await.unwrap().is_err());
        worker.join().unwrap();
        let pool = ctx.db.pool().unwrap();
        let row = sqlx::query("SELECT billing_state,cost_micro_usd,surface FROM request_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("billing_state"), "unknown");
        assert_eq!(row.get::<i64, _>("cost_micro_usd"), 0);
        assert_eq!(row.get::<String, _>("surface"), "web");
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT state FROM request_reservations")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "unknown"
        );
        cleanup(ctx, dir).await;
    }

    #[tokio::test]
    async fn refusal_missing_usage_and_invalid_response_have_distinct_receipts() {
        let (ctx, dir) = context().await;
        for (status, body, state, amount, usable) in [
            (
                429,
                r#"{"error":"Never log this response body"}"#,
                "not_billed",
                0,
                false,
            ),
            (
                200,
                r#"{"text":"editable without usage"}"#,
                "unknown",
                0,
                true,
            ),
            (
                200,
                r#"{"usage":{"type":"duration","seconds":1}}"#,
                "reported",
                75,
                false,
            ),
            (
                200,
                r#"{"text":"bad duration","usage":{"type":"duration","seconds":99}}"#,
                "unknown",
                0,
                true,
            ),
            (
                503,
                r#"{"error":"Never persist this either"}"#,
                "unknown",
                0,
                false,
            ),
            (
                200,
                r#"{"text":"","usage":{"type":"duration","seconds":1}}"#,
                "reported",
                75,
                true,
            ),
            (
                200,
                r#"{"text":"no charge","usage":{"type":"duration","seconds":0}}"#,
                "reported",
                0,
                true,
            ),
        ] {
            let ticket = prepare(&ctx, "global".into(), 1000, true, "web")
                .await
                .unwrap();
            let (base, requests, worker) = provider(status, body, Duration::ZERO);
            let result = dispatch(&ctx, &ticket.id, &base).await;
            requests.recv_timeout(Duration::from_secs(5)).unwrap();
            worker.join().unwrap();
            assert_eq!(result.is_ok(), usable);
            let row = sqlx::query(
                "SELECT billing_state,cost_micro_usd,error_message FROM request_log WHERE id=?",
            )
            .bind(&ticket.id)
            .fetch_one(&ctx.db.pool().unwrap())
            .await
            .unwrap();
            assert_eq!(row.get::<String, _>("billing_state"), state);
            assert_eq!(row.get::<i64, _>("cost_micro_usd"), amount);
            assert!(
                !row.get::<Option<String>, _>("error_message")
                    .unwrap_or_default()
                    .contains("response body")
            );
        }
        cleanup(ctx, dir).await;
    }

    #[tokio::test]
    async fn budgets_serialize_quotes_and_recheck_before_dispatch() {
        let (ctx, dir) = context().await;
        let pool = ctx.db.pool().unwrap();
        sqlx::query("INSERT INTO budgets(id,workspace_id,user_id,scope,period,limit_micro_usd,hard_stop,created_at,updated_at) VALUES('budget',?,?,'global','day',100,1,1,1)")
            .bind(WORKSPACE).bind(USER).execute(&pool).await.unwrap();
        let (a, b) = tokio::join!(
            prepare(&ctx, "global".into(), 1000, true, "desktop"),
            prepare(&ctx, "global".into(), 1000, true, "desktop")
        );
        assert_ne!(a.is_ok(), b.is_ok());
        let held = a.or(b).unwrap();
        sqlx::query("UPDATE budgets SET limit_micro_usd=50")
            .execute(&pool)
            .await
            .unwrap();
        // This target cannot receive traffic; the changed budget must refuse dispatch first.
        assert!(
            dispatch(&ctx, &held.id, "http://127.0.0.1:1")
                .await
                .err()
                .unwrap()
                .contains("budget changed")
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM request_log")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        cancel(&ctx, &held.id).await.unwrap();
        sqlx::query("UPDATE budgets SET limit_micro_usd=100")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            prepare(&ctx, "global".into(), 1000, true, "desktop")
                .await
                .is_ok()
        );
        cleanup(ctx, dir).await;
    }

    #[tokio::test]
    async fn malformed_or_underquoted_recordings_never_dispatch() {
        let (ctx, dir) = context().await;
        let ticket = prepare(&ctx, "global".into(), 1000, true, "desktop")
            .await
            .unwrap();
        let (_sender, receiver) = oneshot::channel();
        let longer = audio::wav(&vec![0i16; 16000], 8000).unwrap();
        assert!(
            attempt(&ctx, &ticket.id, longer, receiver, "http://127.0.0.1:1")
                .await
                .err()
                .unwrap()
                .contains("exceeds its quote")
        );
        // The synthetic store is cleared, so even a broken preflight cannot contact a provider.
        ctx.keys.store.delete("openai").unwrap();
        let headers = HashMap::from([("x-recording-id".into(), ticket.id.clone())]);
        assert!(upload(&ctx, vec![1u8, 2], &headers).await.is_err());
        let pool = ctx.db.pool().unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT state FROM request_reservations WHERE id=?")
                .bind(&ticket.id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            "released"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM request_log")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM security_audit WHERE event_kind='credential_use'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        cleanup(ctx, dir).await;
    }

    #[tokio::test]
    async fn policy_or_deleted_scope_cannot_fall_back_to_global_and_recovery_never_dispatches() {
        let (ctx, dir) = context().await;
        let pool = ctx.db.pool().unwrap();
        sqlx::query("INSERT INTO projects(id,workspace_id,user_id,name,created_at,updated_at) VALUES('private',?,?,'Fixture project',1,1)").bind(WORKSPACE).bind(USER).execute(&pool).await.unwrap();
        let ticket = prepare(&ctx, "project:private".into(), 1000, true, "desktop")
            .await
            .unwrap();
        sqlx::query("UPDATE projects SET privacy_mode='local_only'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            dispatch(&ctx, &ticket.id, "http://127.0.0.1:1")
                .await
                .is_err()
        );
        assert!(
            prepare(&ctx, "project:missing".into(), 1000, true, "desktop")
                .await
                .is_err()
        );
        assert!(
            prepare(&ctx, "global".into(), 1000, false, "desktop")
                .await
                .is_err()
        );
        let sent = prepare(&ctx, "global".into(), 1000, true, "web")
            .await
            .unwrap();
        sqlx::query(
            "UPDATE request_reservations SET state='dispatched',audio_duration_ms=1000 WHERE id=?",
        )
        .bind(&sent.id)
        .execute(&pool)
        .await
        .unwrap();
        // A UI reconnect sees the existing pool and must not interrupt native HTTP work.
        crate::db::db_open(&ctx).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT state FROM request_reservations WHERE id=?")
                .bind(&sent.id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            "dispatched"
        );
        recover(&pool).await.unwrap();
        recover(&pool).await.unwrap();
        let rows = crate::db::select(
            &pool,
            "SELECT attempt_id,billing_state,audio_duration_ms FROM request_log",
            &[],
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["attempt_id"], sent.id);
        assert_eq!(rows[0]["billing_state"], "unknown");
        assert_eq!(rows[0]["audio_duration_ms"], 1000);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT state FROM request_reservations WHERE id=?")
                .bind(&ticket.id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            "released"
        );
        cleanup(ctx, dir).await;
    }
}
