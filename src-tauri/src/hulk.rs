//! The desktop's link to FUSE on HULK (M10 step 7, CA-15). Settings → HULK pairs this computer
//! with a one-time code; the device token that comes back is kept in the keychain and never
//! reaches the webview. Handing a run over then goes through `hulk_invoke`, which calls only the
//! few server commands a handover needs, and `hulk_put_file`, which uploads the project's export.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ctx::Ctx;

const ADDRESS: &str = "hulk:address";
const TOKEN: &str = "hulk:token";
const TIMEOUT: Duration = Duration::from_secs(60);

/// What a handover may ask the server: open its database, read and write rows (the request and
/// its chat), and see which keys it has.
const ALLOWED: &[&str] = &["db_open", "db_select", "db_execute", "key_status"];

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HulkStatus {
    pub address: Option<String>,
    pub paired: bool,
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

pub(crate) fn hulk_status(ctx: &Ctx) -> Result<HulkStatus, String> {
    let store = &ctx.keys.store;
    Ok(HulkStatus {
        address: store.get(ADDRESS)?,
        paired: store.get(TOKEN)?.is_some(),
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
    hulk_status(ctx)
}

/// Forgets HULK here. (Revoke the device in HULK's Settings too, to end its token there.)
pub(crate) fn hulk_unpair(ctx: &Ctx) -> Result<HulkStatus, String> {
    ctx.keys.store.delete(TOKEN)?;
    ctx.keys.store.delete(ADDRESS)?;
    hulk_status(ctx)
}

fn paired(ctx: &Ctx) -> Result<(String, String), String> {
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

    #[tauri::command]
    pub fn hulk_status(ctx: State<'_, Ctx>) -> Result<HulkStatus, String> {
        super::hulk_status(&ctx)
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
    pub fn hulk_unpair(ctx: State<'_, Ctx>) -> Result<HulkStatus, String> {
        super::hulk_unpair(&ctx)
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

    #[tokio::test]
    async fn only_paired_and_only_the_handover_commands() {
        let dir = std::env::temp_dir().join(format!("fuse-hulk-{}", std::process::id()));
        let ctx = Ctx::new(
            dir.join("d"),
            dir.join("c"),
            Keys::with_store(Box::new(MemoryStore::default())),
        );
        assert_eq!(
            hulk_status(&ctx).unwrap(),
            HulkStatus {
                address: None,
                paired: false
            }
        );
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
        assert!(hulk_status(&ctx).unwrap().paired);
        assert!(
            hulk_unpair(&ctx).unwrap()
                == HulkStatus {
                    address: None,
                    paired: false
                }
        );
    }
}
