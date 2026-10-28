//! Provider HTTP transport. The frontend adapters build requests without any key. This command
//! adds the key from the OS keychain, sends the request only to that provider's API host on an
//! allowlisted path, and streams the response back over a Tauri channel.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{State, async_runtime};

use crate::keys::{Keys, Provider};

/// Paths each provider may be called on (docs/providers.md).
fn allowed_path(provider: Provider, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or("");
    match provider {
        Provider::Anthropic => matches!(path, "/v1/messages" | "/v1/models"),
        Provider::Openai => matches!(path, "/v1/responses" | "/v1/models" | "/v1/embeddings"),
    }
}

/// Request headers the frontend may set. Anything auth-related is added here, never there.
fn allowed_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "content-type" | "accept" | "anthropic-version" | "anthropic-beta"
    )
}

/// Response headers passed back to the frontend.
fn allowed_response_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(
        n.as_str(),
        "content-type" | "request-id" | "x-request-id" | "retry-after"
    ) || n.starts_with("anthropic-ratelimit-")
        || n.starts_with("x-ratelimit-")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub provider: Provider,
    pub method: String,
    /// Path and query only, e.g. `/v1/messages`. The host comes from the provider.
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StreamMsg {
    Head {
        status: u16,
        headers: Vec<(String, String)>,
    },
    Chunk {
        data: String,
    },
    End,
    Error {
        message: String,
    },
}

#[derive(Default)]
pub struct Transport {
    next_id: AtomicU32,
    running: Mutex<HashMap<u32, async_runtime::JoinHandle<()>>>,
}

/// Checks a request before any key is touched. Returns the full URL.
pub fn validate(req: &HttpRequest, base: &str) -> Result<String, String> {
    if req.method != "GET" && req.method != "POST" {
        return Err(format!("Method {} not allowed", req.method));
    }
    if !req.path.starts_with('/') || !allowed_path(req.provider, &req.path) {
        return Err(format!("Path {} not allowed for this provider", req.path));
    }
    if let Some((name, _)) = req.headers.iter().find(|(n, _)| !allowed_request_header(n)) {
        return Err(format!("Header {name} not allowed"));
    }
    Ok(format!("{base}{}", req.path))
}

/// Splits bytes into the longest valid UTF-8 prefix and the incomplete tail (a code point
/// split across network chunks), so streamed text is never corrupted.
pub fn take_utf8(buf: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(e) => e.valid_up_to() + e.error_len().unwrap_or(1), // invalid byte: include, replaced below
    };
    let rest = buf.split_off(valid);
    let out = String::from_utf8_lossy(buf).into_owned();
    *buf = rest;
    out
}

pub async fn run_request(
    client: &reqwest::Client,
    url: &str,
    req: &HttpRequest,
    key: &str,
    channel: &Channel<StreamMsg>,
) {
    let mut builder = if req.method == "POST" {
        client.post(url)
    } else {
        client.get(url)
    };
    builder = builder.bearer_auth(key);
    for (name, value) in &req.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &req.body {
        builder = builder.body(body.clone());
    }
    let mut response = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            // reqwest errors carry the URL, never headers, so no key can leak here.
            let _ = channel.send(StreamMsg::Error {
                message: format!("Network error: {}", e.without_url()),
            });
            return;
        }
    };
    let headers = response
        .headers()
        .iter()
        .filter(|(n, _)| allowed_response_header(n.as_str()))
        .filter_map(|(n, v)| v.to_str().ok().map(|v| (n.to_string(), v.to_string())))
        .collect();
    if channel
        .send(StreamMsg::Head {
            status: response.status().as_u16(),
            headers,
        })
        .is_err()
    {
        return;
    }
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(bytes)) => {
                pending.extend_from_slice(&bytes);
                let text = take_utf8(&mut pending);
                if !text.is_empty() && channel.send(StreamMsg::Chunk { data: text }).is_err() {
                    return; // webview went away
                }
            }
            Ok(None) => {
                if !pending.is_empty() {
                    let _ = channel.send(StreamMsg::Chunk {
                        data: String::from_utf8_lossy(&pending).into_owned(),
                    });
                }
                let _ = channel.send(StreamMsg::End);
                return;
            }
            Err(e) => {
                let _ = channel.send(StreamMsg::Error {
                    message: format!("Connection lost: {}", e.without_url()),
                });
                return;
            }
        }
    }
}

pub mod commands {
    use super::*;

    /// Starts a provider request; returns an id for `provider_abort`. Results arrive on `on_event`.
    #[tauri::command]
    pub fn provider_fetch(
        keys: State<'_, Keys>,
        transport: State<'_, Transport>,
        request: HttpRequest,
        on_event: Channel<StreamMsg>,
    ) -> Result<u32, String> {
        // Error prefixes (`forbidden:`, `no_key:`, `keychain:`) let the frontend classify them.
        let url = validate(&request, request.provider.api_base())
            .map_err(|e| format!("forbidden: {e}"))?;
        let key = keys
            .store
            .get(request.provider.account())
            .map_err(|e| format!("keychain: {e}"))?
            .ok_or_else(|| "no_key: No API key saved for this provider.".to_string())?;
        let client = keys.client.clone();
        let id = transport.next_id.fetch_add(1, Ordering::Relaxed);
        let handle = async_runtime::spawn(async move {
            run_request(&client, &url, &request, &key, &on_event).await;
        });
        let mut running = transport.running.lock().map_err(|e| e.to_string())?;
        running.retain(|_, h| !h.inner().is_finished());
        running.insert(id, handle);
        Ok(id)
    }

    #[tauri::command]
    pub fn provider_abort(transport: State<'_, Transport>, id: u32) -> Result<(), String> {
        if let Some(handle) = transport
            .running
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&id)
        {
            handle.abort();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(provider: Provider, method: &str, path: &str, headers: &[(&str, &str)]) -> HttpRequest {
        HttpRequest {
            provider,
            method: method.into(),
            path: path.into(),
            headers: headers
                .iter()
                .map(|(n, v)| ((*n).to_string(), (*v).to_string()))
                .collect(),
            body: None,
        }
    }

    #[test]
    fn only_allowlisted_paths_per_provider() {
        let base = "https://api.anthropic.com";
        assert_eq!(
            validate(&req(Provider::Anthropic, "POST", "/v1/messages", &[]), base).unwrap(),
            "https://api.anthropic.com/v1/messages"
        );
        assert!(
            validate(
                &req(Provider::Anthropic, "GET", "/v1/models?limit=5", &[]),
                base
            )
            .is_ok()
        );
        assert!(
            validate(
                &req(Provider::Anthropic, "POST", "/v1/responses", &[]),
                base
            )
            .is_err()
        );
        assert!(validate(&req(Provider::Openai, "POST", "/v1/responses", &[]), base).is_ok());
        assert!(validate(&req(Provider::Openai, "POST", "/v1/files", &[]), base).is_err());
        assert!(validate(&req(Provider::Openai, "POST", "/v1/embeddings", &[]), base).is_ok());
        assert!(validate(&req(Provider::Anthropic, "POST", "/v1/embeddings", &[]), base).is_err());
        // No way to point the key at another host.
        assert!(
            validate(
                &req(Provider::Openai, "POST", "@evil.example/v1/responses", &[]),
                base
            )
            .is_err()
        );
        assert!(validate(&req(Provider::Openai, "DELETE", "/v1/models", &[]), base).is_err());
    }

    #[test]
    fn frontend_cannot_set_auth_headers() {
        let base = "https://api.openai.com";
        for h in [
            "authorization",
            "Authorization",
            "x-api-key",
            "cookie",
            "host",
        ] {
            let r = req(Provider::Openai, "POST", "/v1/responses", &[(h, "x")]);
            assert!(validate(&r, base).is_err(), "{h} must be rejected");
        }
        let ok = req(
            Provider::Anthropic,
            "POST",
            "/v1/messages",
            &[
                ("anthropic-version", "2026-10-21"),
                ("content-type", "application/json"),
            ],
        );
        assert!(validate(&ok, base).is_ok());
    }

    #[test]
    fn response_header_allowlist() {
        assert!(allowed_response_header("request-id"));
        assert!(allowed_response_header("x-ratelimit-remaining-tokens"));
        assert!(allowed_response_header("Retry-After"));
        assert!(!allowed_response_header("set-cookie"));
        assert!(!allowed_response_header("anthropic-organization-id"));
        assert!(!allowed_response_header("openai-organization"));
    }

    #[tokio::test]
    async fn streams_head_chunks_and_end_with_bearer_auth() {
        use std::io::{Read, Write};
        use std::sync::Arc;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let n = s.read(&mut buf).unwrap();
            let body = "data: a\n\ndata: é\n\n";
            write!(
                s,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nrequest-id: req_1\r\nset-cookie: x=1\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            String::from_utf8_lossy(&buf[..n]).to_lowercase()
        });

        let got: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
        let sink = got.clone();
        let channel = Channel::new(move |msg: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = msg {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        let mut r = req(
            Provider::Anthropic,
            "POST",
            "/v1/messages",
            &[("anthropic-version", "2026-10-21")],
        );
        r.body = Some("{}".into());
        let url = validate(&r, &base).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        run_request(&client, &url, &r, "fake-test-value", &channel).await;

        let request = server.join().unwrap();
        assert!(request.starts_with("post /v1/messages "));
        assert!(request.contains("authorization: bearer fake-test-value"));
        assert!(request.contains("anthropic-version: 2026-10-21"));

        let msgs = got.lock().unwrap().clone();
        assert_eq!(msgs[0]["kind"], "head");
        assert_eq!(msgs[0]["status"], 200);
        let headers = msgs[0]["headers"].to_string();
        assert!(headers.contains("request-id"));
        assert!(!headers.contains("set-cookie"));
        let text: String = msgs
            .iter()
            .filter(|m| m["kind"] == "chunk")
            .map(|m| m["data"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(text, "data: a\n\ndata: é\n\n");
        assert_eq!(msgs.last().unwrap()["kind"], "end");
    }

    #[tokio::test]
    async fn unreachable_host_reports_a_network_error() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let got: std::sync::Arc<Mutex<Vec<String>>> = std::sync::Arc::default();
        let sink = got.clone();
        let channel = Channel::new(move |msg: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = msg {
                sink.lock().unwrap().push(json);
            }
            Ok(())
        });
        let r = req(Provider::Openai, "GET", "/v1/models", &[]);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        run_request(
            &client,
            &format!("http://127.0.0.1:{port}/v1/models"),
            &r,
            "k",
            &channel,
        )
        .await;
        let msgs = got.lock().unwrap().clone();
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].contains("\"kind\":\"error\""));
        assert!(!msgs[0].contains("\"k\""));
    }

    #[test]
    fn utf8_split_across_chunks_is_reassembled() {
        let text = "héllo → 世界";
        let bytes = text.as_bytes();
        for split in 0..bytes.len() {
            let mut buf = bytes[..split].to_vec();
            let mut out = take_utf8(&mut buf);
            buf.extend_from_slice(&bytes[split..]);
            out.push_str(&take_utf8(&mut buf));
            assert_eq!(out, text, "split at {split}");
            assert!(buf.is_empty());
        }
    }
}
