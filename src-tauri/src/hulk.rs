//! The desktop's link to FUSE on HULK (M10 step 7, CA-15). Settings → HULK pairs this computer
//! with a one-time code; the device token that comes back is kept in the keychain and never
//! reaches the webview. Handing a run over then goes through `hulk_invoke`, which calls only the
//! few server commands a handover needs, and `hulk_put_file`, which uploads the project's export.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ctx::Ctx;

const ADDRESS: &str = "hulk:address";
const TOKEN: &str = "hulk:token";
const TIMEOUT: Duration = Duration::from_secs(60);

/// What a handover may ask the server: open its database, read and write rows (the request and
/// its chat), and see which keys it has.
const ALLOWED: &[&str] = &[
    "db_open",
    "db_select",
    "db_execute",
    "db_batch",
    "key_status",
];

/// What a FUSE build is, for the desktop and HULK to compare (M10 F2). The schema is the count
/// of migrations the build runs: two builds with the same count read the same tables.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    pub schema: i64,
    /// The commit it was built from (short), or "unknown" outside a checkout.
    pub built_from: String,
    /// The day it was built (UTC).
    pub built_on: String,
}

/// This binary's build (src-tauri/build.rs sets the commit and day).
pub fn this_build() -> Build {
    Build {
        schema: crate::db::schema_version(),
        built_from: env!("FUSE_BUILD_COMMIT").to_owned(),
        built_on: env!("FUSE_BUILD_DATE").to_owned(),
    }
}

/// Why this app can't read HULK's database: HULK's build is older or newer than this one.
/// None when they run the same schema.
pub fn mismatch(mine: &Build, hulk: &Build) -> Option<String> {
    if hulk.schema == mine.schema {
        return None;
    }
    let built = if hulk.built_from == "unknown" {
        "a build from before this check existed".to_owned()
    } else {
        format!("built from {} on {}", hulk.built_from, hulk.built_on)
    };
    Some(if hulk.schema < mine.schema {
        format!("HULK runs an older FUSE ({built}). Redeploy it: `bash scripts/deploy-server.sh`")
    } else {
        format!("HULK runs a newer FUSE ({built}). Update this app.")
    })
}

/// HULK's build from the last look (address, when), kept a minute so the polls don't ask again.
#[derive(Default)]
pub struct HulkCache(Mutex<Option<(Instant, String, Build)>>);
const CACHE_FOR: Duration = Duration::from_secs(60);

/// Asks HULK what it runs (`/api/auth/state` needs no sign-in). A server from before F2 says
/// only its crate version; it counts as schema 0, which is older than any desktop.
async fn hulk_build(ctx: &Ctx, address: &str, fresh: bool) -> Result<Build, String> {
    if !fresh
        && let Some((at, a, b)) = ctx.hulk.0.lock().unwrap().as_ref()
        && a == address
        && at.elapsed() < CACHE_FOR
    {
        return Ok(b.clone());
    }
    let r = ctx
        .keys
        .client
        .get(format!("{address}/api/auth/state"))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach HULK: {e}"))?;
    if !r.status().is_success() {
        return Err(server_error(r).await);
    }
    let v: Value = r
        .json()
        .await
        .map_err(|_| "HULK's answer wasn't readable.".to_owned())?;
    let text = |key: &str| {
        v.get(key)
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned()
    };
    let build = Build {
        schema: v.get("schema").and_then(Value::as_i64).unwrap_or(0),
        built_from: text("builtFrom"),
        built_on: text("builtOn"),
    };
    *ctx.hulk.0.lock().unwrap() = Some((Instant::now(), address.to_owned(), build.clone()));
    Ok(build)
}

/// Refuses a read or a handover when HULK's build doesn't match this one. When HULK can't be
/// asked, the request goes ahead and fails (or not) on its own.
async fn check_build(ctx: &Ctx, address: &str) -> Result<(), String> {
    match hulk_build(ctx, address, false).await {
        Ok(build) => mismatch(&this_build(), &build).map_or(Ok(()), Err),
        Err(_) => Ok(()),
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HulkStatus {
    pub address: Option<String>,
    pub paired: bool,
    /// This app's build, for the Settings line beside HULK's.
    pub mine: Build,
    /// HULK's build, from the last look; null when not paired or HULK couldn't be reached.
    pub server: Option<Build>,
    /// Why HULK can't be read right now (its build is older or newer than this app's), or null.
    pub mismatch: Option<String>,
}

/// HTTPS (what `tailscale serve` gives), or this computer for tests. No path, no trailing slash.
fn check_address(address: &str) -> Result<String, String> {
    let a = address.trim().trim_end_matches('/');
    let local = a.starts_with("http://127.0.0.1:") || a.starts_with("http://localhost:");
    if !(a.starts_with("https://") || local) {
        return Err("Use HULK's https address, e.g. https://hulk.tailb7c872.ts.net:4100".into());
    }
    let rest = a.split_once("://").map(|(_, r)| r).unwrap_or("");
    if rest.is_empty() || rest.contains('/') || rest.contains('@') || rest.contains('?') {
        return Err("Just the address, with no path.".into());
    }
    Ok(a.to_owned())
}

pub(crate) async fn hulk_status(ctx: &Ctx) -> Result<HulkStatus, String> {
    status_with(ctx, false).await
}

/// The link's state, and HULK's build when paired (`fresh` asks HULK even if asked lately).
async fn status_with(ctx: &Ctx, fresh: bool) -> Result<HulkStatus, String> {
    let store = &ctx.keys.store;
    let address = store.get(ADDRESS)?;
    let paired = store.get(TOKEN)?.is_some();
    let server = match (&address, paired) {
        (Some(a), true) => hulk_build(ctx, a, fresh).await.ok(),
        _ => None,
    };
    let mine = this_build();
    let mismatch = server.as_ref().and_then(|s| mismatch(&mine, s));
    Ok(HulkStatus {
        address,
        paired,
        mine,
        server,
        mismatch,
    })
}

#[derive(Deserialize)]
struct Paired {
    token: String,
}

pub(crate) async fn hulk_pair(
    ctx: &Ctx,
    address: String,
    code: String,
    name: String,
) -> Result<HulkStatus, String> {
    let address = check_address(&address)?;
    let r = ctx
        .keys
        .client
        .post(format!("{address}/api/auth/pair"))
        .timeout(TIMEOUT)
        .json(&serde_json::json!({ "code": code.trim(), "name": name.trim() }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach HULK: {e}"))?;
    if !r.status().is_success() {
        return Err(server_error(r).await);
    }
    let paired: Paired = r
        .json()
        .await
        .map_err(|_| "HULK's answer wasn't readable.".to_owned())?;
    ctx.keys.store.set(ADDRESS, &address)?;
    ctx.keys.store.set(TOKEN, &paired.token)?;
    // Paired, and told straight away if HULK's build is older or newer than this app's.
    status_with(ctx, true).await
}

/// Forgets HULK here. (Revoke the device in HULK's Settings too, to end its token there.)
pub(crate) async fn hulk_unpair(ctx: &Ctx) -> Result<HulkStatus, String> {
    ctx.keys.store.delete(TOKEN)?;
    ctx.keys.store.delete(ADDRESS)?;
    *ctx.hulk.0.lock().unwrap() = None;
    hulk_status(ctx).await
}

pub(crate) fn paired(ctx: &Ctx) -> Result<(String, String), String> {
    match (ctx.keys.store.get(ADDRESS)?, ctx.keys.store.get(TOKEN)?) {
        (Some(a), Some(t)) => Ok((a, t)),
        _ => Err("This computer isn't paired with HULK yet: Settings → HULK.".into()),
    }
}

/// The server's error value, or what its status means.
async fn server_error(r: reqwest::Response) -> String {
    let status = r.status();
    let v: Option<Value> = r.json().await.ok();
    match v.as_ref().and_then(|v| v.get("error")) {
        Some(Value::String(s)) if s == "signed_out" => {
            "HULK doesn't know this computer any more: pair it again in Settings → HULK.".into()
        }
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => format!("HULK answered {status}."),
    }
}

pub(crate) async fn hulk_invoke(ctx: &Ctx, command: String, args: Value) -> Result<Value, String> {
    if !ALLOWED.contains(&command.as_str()) {
        return Err(format!("{command} isn't something a handover asks HULK."));
    }
    let (address, token) = paired(ctx)?;
    check_build(ctx, &address).await?;
    let r = ctx
        .keys
        .client
        .post(format!("{address}/api/invoke/{command}"))
        .timeout(TIMEOUT)
        .bearer_auth(token)
        .json(&args)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach HULK: {e}"))?;
    if !r.status().is_success() {
        return Err(server_error(r).await);
    }
    r.json()
        .await
        .map_err(|_| "HULK's answer wasn't readable.".to_owned())
}

/// Uploads bytes to HULK's file store; the same answer as `file_put` (sha256 and size).
pub(crate) async fn hulk_put_file(
    ctx: &Ctx,
    body: Vec<u8>,
    _headers: &HashMap<String, String>,
) -> Result<Value, String> {
    let (address, token) = paired(ctx)?;
    check_build(ctx, &address).await?;
    let r = ctx
        .keys
        .client
        .post(format!("{address}/api/invoke/file_put"))
        .timeout(Duration::from_secs(300))
        .bearer_auth(token)
        .header("content-type", "application/octet-stream")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach HULK: {e}"))?;
    if !r.status().is_success() {
        return Err(server_error(r).await);
    }
    r.json()
        .await
        .map_err(|_| "HULK's answer wasn't readable.".to_owned())
}

pub mod commands {
    use tauri::State;

    use super::HulkStatus;
    use crate::ctx::{Ctx, request_parts};

    /// This build's schema, commit and day (M10 step 19: the startup check keys on it).
    #[tauri::command]
    pub fn app_build() -> super::Build {
        super::this_build()
    }

    #[tauri::command]
    pub async fn hulk_status(ctx: State<'_, Ctx>) -> Result<HulkStatus, String> {
        super::hulk_status(&ctx).await
    }

    #[tauri::command]
    pub async fn hulk_pair(
        ctx: State<'_, Ctx>,
        address: String,
        code: String,
        name: String,
    ) -> Result<HulkStatus, String> {
        super::hulk_pair(&ctx, address, code, name).await
    }

    #[tauri::command]
    pub async fn hulk_unpair(ctx: State<'_, Ctx>) -> Result<HulkStatus, String> {
        super::hulk_unpair(&ctx).await
    }

    #[tauri::command]
    pub async fn hulk_invoke(
        ctx: State<'_, Ctx>,
        command: String,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        super::hulk_invoke(&ctx, command, args).await
    }

    #[tauri::command]
    pub async fn hulk_put_file(
        ctx: State<'_, Ctx>,
        request: tauri::ipc::Request<'_>,
    ) -> Result<serde_json::Value, String> {
        let (body, headers) = request_parts(&request)?;
        super::hulk_put_file(&ctx, body, &headers).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{Keys, MemoryStore};

    #[test]
    fn addresses_are_https_or_this_computer() {
        assert_eq!(
            check_address("https://hulk.tailb7c872.ts.net:4100/").unwrap(),
            "https://hulk.tailb7c872.ts.net:4100"
        );
        assert!(check_address("http://127.0.0.1:4100").is_ok());
        assert!(check_address("http://hulk:4100").is_err());
        assert!(check_address("https://hulk/x").is_err());
        assert!(check_address("https://user@hulk").is_err());
        assert!(check_address("file:///etc").is_err());
    }

    fn test_ctx(name: &str) -> Ctx {
        let dir = std::env::temp_dir().join(format!("fuse-hulk-{name}-{}", std::process::id()));
        Ctx::new(
            dir.join("d"),
            dir.join("c"),
            Keys::with_store(Box::new(MemoryStore::default())),
        )
    }

    fn unpaired() -> HulkStatus {
        HulkStatus {
            address: None,
            paired: false,
            mine: this_build(),
            server: None,
            mismatch: None,
        }
    }

    #[tokio::test]
    async fn only_paired_and_only_the_handover_commands() {
        let ctx = test_ctx("paired");
        assert_eq!(hulk_status(&ctx).await.unwrap(), unpaired());
        let e = hulk_invoke(&ctx, "db_open".into(), Value::Null)
            .await
            .unwrap_err();
        assert!(e.contains("isn't paired"), "{e}");
        let e = hulk_invoke(&ctx, "repo_exec".into(), Value::Null)
            .await
            .unwrap_err();
        assert!(e.contains("isn't something a handover asks"), "{e}");
        ctx.keys.store.set(ADDRESS, "http://127.0.0.1:9").unwrap();
        ctx.keys.store.set(TOKEN, "t").unwrap();
        // Paired, with nothing at the address: no build to show, and no refusal of its own.
        let s = hulk_status(&ctx).await.unwrap();
        assert!(s.paired && s.server.is_none() && s.mismatch.is_none());
        assert_eq!(hulk_unpair(&ctx).await.unwrap(), unpaired());
    }

    /// A HULK that answers every request with its state, reporting the given schema.
    fn fake_hulk(schema: i64) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { break };
                let mut buf = [0u8; 8192];
                let _ = s.read(&mut buf);
                let body = serde_json::json!({
                    "setUp": true, "signedIn": false, "version": "0.1.0",
                    "schema": schema, "builtFrom": "a483e9b", "builtOn": "2026-11-01",
                })
                .to_string();
                let _ = s.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
        });
        address
    }

    #[test]
    fn the_sentence_says_which_way_and_what_to_do() {
        let mine = this_build();
        assert_eq!(mismatch(&mine, &mine), None);
        let older = Build {
            schema: mine.schema - 1,
            ..mine.clone()
        };
        let s = mismatch(&mine, &older).unwrap();
        assert!(s.starts_with("HULK runs an older FUSE (built from "), "{s}");
        assert!(
            s.ends_with("Redeploy it: `bash scripts/deploy-server.sh`"),
            "{s}"
        );
        let before_f2 = Build {
            schema: 0,
            built_from: "unknown".into(),
            built_on: "unknown".into(),
        };
        assert_eq!(
            mismatch(&mine, &before_f2).unwrap(),
            "HULK runs an older FUSE (a build from before this check existed). Redeploy it: `bash scripts/deploy-server.sh`"
        );
        let newer = Build {
            schema: mine.schema + 1,
            ..mine
        };
        assert!(
            mismatch(&this_build(), &newer)
                .unwrap()
                .ends_with("Update this app."),
        );
    }

    #[tokio::test]
    async fn an_older_hulk_is_named_and_not_read() {
        let ctx = test_ctx("older");
        ctx.keys.store.set(TOKEN, "t").unwrap();
        ctx.keys
            .store
            .set(ADDRESS, &fake_hulk(this_build().schema - 1))
            .unwrap();
        let s = hulk_status(&ctx).await.unwrap();
        let why = s.mismatch.clone().unwrap();
        assert_eq!(
            why,
            "HULK runs an older FUSE (built from a483e9b on 2026-11-01). Redeploy it: `bash scripts/deploy-server.sh`"
        );
        assert_eq!(s.server.unwrap().built_from, "a483e9b");
        // Reads and uploads stop at the check, with the same sentence.
        let e = hulk_invoke(&ctx, "db_open".into(), Value::Null)
            .await
            .unwrap_err();
        assert_eq!(e, why);
        let e = hulk_put_file(&ctx, vec![1], &HashMap::new())
            .await
            .unwrap_err();
        assert_eq!(e, why);
    }

    #[tokio::test]
    async fn a_newer_hulk_asks_for_an_update_and_a_matching_one_is_read() {
        let ctx = test_ctx("newer");
        ctx.keys.store.set(TOKEN, "t").unwrap();
        ctx.keys
            .store
            .set(ADDRESS, &fake_hulk(this_build().schema + 1))
            .unwrap();
        let why = hulk_status(&ctx).await.unwrap().mismatch.unwrap();
        assert!(why.ends_with("Update this app."), "{why}");

        let ctx = test_ctx("same");
        ctx.keys.store.set(TOKEN, "t").unwrap();
        ctx.keys
            .store
            .set(ADDRESS, &fake_hulk(this_build().schema))
            .unwrap();
        let s = hulk_status(&ctx).await.unwrap();
        assert_eq!(s.mismatch, None);
        assert_eq!(s.server.map(|b| b.schema), Some(this_build().schema));
        // The request goes through to the server (which, being a fake, answers its state).
        let v = hulk_invoke(&ctx, "db_open".into(), Value::Null)
            .await
            .unwrap();
        assert_eq!(v["setUp"], Value::Bool(true));
    }
}
