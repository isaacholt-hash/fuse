//! Signing in to a remote MCP server (M9 step 10, AG-02): OAuth 2.1 as the MCP spec has it. The
//! server's 401 (or the well-known paths) names its authorization server; FUSE registers itself
//! there as a public client, opens the sign-in page in the system browser with PKCE (S256) and a
//! random state, and takes the code on a loopback redirect (`http://127.0.0.1:<port>/callback`).
//! The tokens are kept in the OS keychain and refreshed before they expire. Every endpoint must be
//! https (or http to this computer); no redirects are followed by FUSE's own requests.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::mcp::check_remote_url;

/// How long the browser sign-in may take.
const SIGN_IN_TIME: Duration = Duration::from_secs(300);
/// A token this close to expiring is refreshed first.
const EARLY: u64 = 60;

/// What's kept in the keychain for a server.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub client_id: String,
    pub token_endpoint: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Seconds since 1970; none when the server didn't say.
    pub expires_at: Option<u64>,
}

impl Tokens {
    /// Whether to refresh before using it.
    pub fn stale(&self, now: u64) -> bool {
        self.expires_at.is_some_and(|t| now + EARLY >= t)
    }
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Base64url without padding (RFC 4648 §5), as PKCE wants.
pub fn b64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        let take = c.len() + 1;
        for i in 0..take {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn random(n: usize) -> Result<String, String> {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    Ok(b64url(&b))
}

/// PKCE: a verifier, and its S256 challenge.
pub fn pkce() -> Result<(String, String), String> {
    let verifier = random(32)?;
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    Ok((verifier, challenge))
}

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// `resource_metadata="…"` from a `WWW-Authenticate` header.
pub fn resource_metadata(www_authenticate: &str) -> Option<String> {
    let at = www_authenticate.find("resource_metadata=")? + "resource_metadata=".len();
    let rest = www_authenticate[at..].trim_start_matches('"');
    let end = rest.find(['"', ',', ' ']).unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// The authorization server's endpoints.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthServer {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub scopes: Vec<String>,
}

async fn get_json(http: &reqwest::Client, url: &str) -> Option<Value> {
    check_remote_url(url).ok()?;
    let r = http.get(url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json().await.ok()
}

/// Where a URL's well-known document is: `<origin>/.well-known/<name><path>` (RFC 8414 and 9728).
fn well_known(url: &reqwest::Url, name: &str) -> String {
    let path = url.path().trim_end_matches('/');
    format!(
        "{}/.well-known/{name}{path}",
        url.origin().ascii_serialization()
    )
}

/// The server's authorization server, from its 401's resource metadata or the well-known
/// paths, then that server's metadata.
pub async fn discover(
    http: &reqwest::Client,
    server: &str,
    hint: Option<String>,
) -> Result<AuthServer, String> {
    let url = check_remote_url(server)?;
    let mut prm = None;
    let origin_prm = format!(
        "{}/.well-known/oauth-protected-resource",
        url.origin().ascii_serialization()
    );
    for c in hint
        .into_iter()
        .chain([well_known(&url, "oauth-protected-resource"), origin_prm])
    {
        if let Some(v) = get_json(http, &c).await {
            prm = Some(v);
            break;
        }
    }
    let issuer = prm
        .as_ref()
        .and_then(|p| p.get("authorization_servers"))
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| url.origin().ascii_serialization());
    let scopes: Vec<String> = prm
        .as_ref()
        .and_then(|p| p.get("scopes_supported"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let iss = check_remote_url(&issuer)?;
    let mut meta = None;
    for c in [
        well_known(&iss, "oauth-authorization-server"),
        well_known(&iss, "openid-configuration"),
        format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        ),
    ] {
        if let Some(v) = get_json(http, &c).await {
            meta = Some(v);
            break;
        }
    }
    let meta = meta.ok_or("The server's sign-in service didn't describe itself.")?;
    let s = |k: &str| meta.get(k).and_then(Value::as_str).map(str::to_string);
    let methods_ok = meta
        .get("code_challenge_methods_supported")
        .and_then(Value::as_array)
        .is_none_or(|a| a.iter().any(|m| m.as_str() == Some("S256")));
    if !methods_ok {
        return Err("The server's sign-in service doesn't support PKCE (S256).".into());
    }
    let auth = AuthServer {
        authorization_endpoint: s("authorization_endpoint")
            .ok_or("The sign-in service has no authorization endpoint.")?,
        token_endpoint: s("token_endpoint").ok_or("The sign-in service has no token endpoint.")?,
        registration_endpoint: s("registration_endpoint"),
        scopes,
    };
    for u in [&auth.authorization_endpoint, &auth.token_endpoint]
        .into_iter()
        .chain(auth.registration_endpoint.as_ref())
    {
        check_remote_url(u)?;
    }
    Ok(auth)
}

/// Registers FUSE as a public client with this redirect (RFC 7591).
async fn register(
    http: &reqwest::Client,
    endpoint: &str,
    redirect: &str,
) -> Result<String, String> {
    let r = http
        .post(endpoint)
        .json(&serde_json::json!({
            "client_name": "FUSE",
            "redirect_uris": [redirect],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }))
        .send()
        .await
        .map_err(|e| format!("Couldn't register with the sign-in service: {e}"))?;
    if !r.status().is_success() {
        return Err(format!(
            "The sign-in service refused FUSE's registration ({}).",
            r.status()
        ));
    }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    v.get("client_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or("The sign-in service gave no client id.".into())
}

async fn token(
    http: &reqwest::Client,
    endpoint: &str,
    body: String,
    client_id: &str,
) -> Result<Tokens, String> {
    let r = http
        .post(endpoint)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the sign-in service: {e}"))?;
    if !r.status().is_success() {
        return Err(format!(
            "The sign-in service refused the token request ({}).",
            r.status()
        ));
    }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    Ok(Tokens {
        client_id: client_id.to_string(),
        token_endpoint: endpoint.to_string(),
        access_token: v
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or("The sign-in service gave no access token.")?
            .to_string(),
        refresh_token: v
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_at: v
            .get("expires_in")
            .and_then(Value::as_u64)
            .map(|s| now_secs() + s),
    })
}

/// A fresh access token from the refresh token; the old refresh token stays if no new one comes.
pub async fn refresh(http: &reqwest::Client, t: &Tokens, resource: &str) -> Result<Tokens, String> {
    let rt = t
        .refresh_token
        .as_deref()
        .ok_or("Sign in again: there's no refresh token.")?;
    let body = form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", rt),
        ("client_id", &t.client_id),
        ("resource", resource),
    ]);
    let mut n = token(http, &t.token_endpoint, body, &t.client_id).await?;
    if n.refresh_token.is_none() {
        n.refresh_token = t.refresh_token.clone();
    }
    Ok(n)
}

/// The whole sign-in. `open` shows the sign-in page (the system browser; a test's fetch).
pub async fn sign_in(
    http: &reqwest::Client,
    server: &str,
    hint: Option<String>,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Result<Tokens, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Couldn't listen for the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let auth = discover(http, server, hint).await?;
    let client_id = match &auth.registration_endpoint {
        Some(r) => register(http, r, &redirect).await?,
        None => {
            return Err(
                "The sign-in service doesn't let apps register; FUSE can't sign in to it.".into(),
            );
        }
    };
    let (verifier, challenge) = pkce()?;
    let state = random(24)?;
    let scope = auth.scopes.join(" ");
    let mut params = vec![
        ("response_type", "code"),
        ("client_id", client_id.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("state", state.as_str()),
        ("resource", server),
    ];
    if !scope.is_empty() {
        params.push(("scope", scope.as_str()));
    }
    let sep = if auth.authorization_endpoint.contains('?') {
        '&'
    } else {
        '?'
    };
    open(&format!(
        "{}{sep}{}",
        auth.authorization_endpoint,
        form(&params)
    ))?;

    // The browser comes back with ?code=…&state=…
    let code = tokio::time::timeout(SIGN_IN_TIME, async {
        loop {
            let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let target = req.split_whitespace().nth(1).unwrap_or_default().to_string();
            let Some(query) = target.strip_prefix("/callback?") else {
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                continue;
            };
            let get = |k: &str| {
                query.split('&').find_map(|p| {
                    let (a, b) = p.split_once('=')?;
                    (a == k).then(|| decode(b))
                })
            };
            let ok = get("state").as_deref() == Some(state.as_str()) && get("code").is_some();
            let page = if ok {
                "Signed in. You can close this window and go back to FUSE."
            } else {
                "The sign-in didn't work. Go back to FUSE and try again."
            };
            let _ = sock
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
                        page.len()
                    )
                    .as_bytes(),
                )
                .await;
            if let Some(e) = get("error") {
                return Err(format!("The sign-in was refused: {e}"));
            }
            if ok {
                return Ok::<String, String>(get("code").unwrap_or_default());
            }
            return Err("The sign-in came back without a matching state, so it was ignored.".into());
        }
    })
    .await
    .map_err(|_| "The sign-in wasn't finished in time.".to_string())??;

    let body = form(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &redirect),
        ("client_id", &client_id),
        ("code_verifier", &verifier),
        ("resource", server),
    ]);
    token(http, &auth.token_endpoint, body, &client_id).await
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16)
                {
                    Ok(v) => {
                        out.push(v);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[test]
    fn base64url_pkce_and_headers() {
        assert_eq!(b64url(b"hi"), "aGk");
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
        // RFC 7636 appendix B.
        assert_eq!(
            b64url(&Sha256::digest(
                b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
            )),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let (v, c) = pkce().unwrap();
        assert!(v.len() >= 43);
        assert_eq!(c, b64url(&Sha256::digest(v.as_bytes())));
        assert_eq!(
            resource_metadata(
                r#"Bearer error="invalid_token", resource_metadata="https://x/.well-known/oauth-protected-resource""#
            ),
            Some("https://x/.well-known/oauth-protected-resource".into())
        );
        assert_eq!(decode("a%20b+c%2Fd"), "a b c/d");
        assert!(
            Tokens {
                client_id: "c".into(),
                token_endpoint: "t".into(),
                access_token: "a".into(),
                refresh_token: None,
                expires_at: Some(100)
            }
            .stale(50)
        );
    }

    /// One server playing the MCP server (401 without a token) and its authorization server.
    async fn auth_server() -> (String, Arc<Mutex<HashMap<String, String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen: Arc<Mutex<HashMap<String, String>>> = Arc::default();
        let (b, s) = (base.clone(), seen.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let (base, seen) = (b.clone(), s.clone());
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let (line, head, body) = loop {
                        let n = sock.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        let t = String::from_utf8_lossy(&buf).to_string();
                        if let Some(at) = t.find("\r\n\r\n") {
                            let head = t[..at].to_lowercase();
                            let len = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            if buf.len() >= at + 4 + len {
                                break (
                                    t.lines().next().unwrap_or_default().to_string(),
                                    head,
                                    String::from_utf8_lossy(&buf[at + 4..at + 4 + len]).to_string(),
                                );
                            }
                        }
                    };
                    let target = line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .to_string();
                    let q = |src: &str, k: &str| {
                        src.split('&').find_map(|p| {
                            let (a, v) = p.split_once('=')?;
                            (a == k).then(|| decode(v))
                        })
                    };
                    let json = |v: Value| {
                        (
                            "200 OK".to_string(),
                            "application/json".to_string(),
                            String::new(),
                            v.to_string(),
                        )
                    };
                    let (status, ctype, extra, out) = if target == "/mcp" {
                        if head.contains("authorization: bearer tok-2") {
                            json(
                                serde_json::json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"locked","version":"1"}}}),
                            )
                        } else {
                            (
                                "401 Unauthorized".into(),
                                "text/plain".into(),
                                format!(
                                    "WWW-Authenticate: Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\"\r\n"
                                ),
                                String::new(),
                            )
                        }
                    } else if target == "/.well-known/oauth-protected-resource/mcp" {
                        json(
                            serde_json::json!({"resource": format!("{base}/mcp"), "authorization_servers": [base.clone()], "scopes_supported": ["notes"]}),
                        )
                    } else if target == "/.well-known/oauth-authorization-server" {
                        json(
                            serde_json::json!({"issuer": base.clone(), "authorization_endpoint": format!("{base}/authorize"), "token_endpoint": format!("{base}/token"), "registration_endpoint": format!("{base}/register"), "code_challenge_methods_supported": ["S256"]}),
                        )
                    } else if target == "/register" {
                        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                        seen.lock().unwrap().insert(
                            "redirect".into(),
                            v["redirect_uris"][0]
                                .as_str()
                                .unwrap_or_default()
                                .to_string(),
                        );
                        json(serde_json::json!({"client_id": "c1"}))
                    } else if let Some(query) = target.strip_prefix("/authorize?") {
                        {
                            let mut m = seen.lock().unwrap();
                            for k in [
                                "code_challenge",
                                "code_challenge_method",
                                "resource",
                                "scope",
                                "client_id",
                            ] {
                                m.insert(k.into(), q(query, k).unwrap_or_default());
                            }
                        }
                        let to = format!(
                            "{}?code=code1&state={}",
                            q(query, "redirect_uri").unwrap_or_default(),
                            enc(&q(query, "state").unwrap_or_default())
                        );
                        (
                            "302 Found".into(),
                            "text/plain".into(),
                            format!("Location: {to}\r\n"),
                            String::new(),
                        )
                    } else if target == "/token" {
                        let challenge = seen
                            .lock()
                            .unwrap()
                            .get("code_challenge")
                            .cloned()
                            .unwrap_or_default();
                        match q(&body, "grant_type").as_deref() {
                            Some("authorization_code")
                                if b64url(&Sha256::digest(
                                    q(&body, "code_verifier").unwrap_or_default().as_bytes(),
                                )) == challenge
                                    && q(&body, "code").as_deref() == Some("code1") =>
                            {
                                json(
                                    serde_json::json!({"access_token": "tok-1", "refresh_token": "r1", "expires_in": 1}),
                                )
                            }
                            Some("refresh_token")
                                if q(&body, "refresh_token").as_deref() == Some("r1") =>
                            {
                                json(
                                    serde_json::json!({"access_token": "tok-2", "expires_in": 3600}),
                                )
                            }
                            _ => (
                                "400 Bad Request".into(),
                                "application/json".into(),
                                String::new(),
                                "{}".into(),
                            ),
                        }
                    } else {
                        (
                            "404 Not Found".into(),
                            "text/plain".into(),
                            String::new(),
                            String::new(),
                        )
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{out}",
                        out.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (base, seen)
    }

    #[tokio::test]
    async fn signs_in_with_pkce_refreshes_and_reaches_the_server() {
        let (base, seen) = auth_server().await;
        let server = format!("{base}/mcp");
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        // The 401 says where the resource metadata is.
        let r = http.post(&server).body("{}").send().await.unwrap();
        assert_eq!(r.status().as_u16(), 401);
        let hint = r
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .and_then(resource_metadata);
        // The "browser": follows the sign-in page's redirect back to FUSE's loopback.
        let browser = reqwest::Client::new();
        let t = sign_in(&http, &server, hint, |url| {
            let (b, u) = (browser.clone(), url.to_string());
            tokio::spawn(async move {
                let _ = b.get(u).send().await;
            });
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            (
                t.client_id.as_str(),
                t.access_token.as_str(),
                t.refresh_token.as_deref()
            ),
            ("c1", "tok-1", Some("r1"))
        );
        {
            let m = seen.lock().unwrap();
            assert_eq!(m["code_challenge_method"], "S256");
            assert_eq!(m["resource"], server);
            assert_eq!(m["scope"], "notes");
            assert!(
                m["redirect"].starts_with("http://127.0.0.1:")
                    && m["redirect"].ends_with("/callback")
            );
        }
        assert!(t.stale(now_secs()), "it expires in a second");
        let t2 = refresh(&http, &t, &server).await.unwrap();
        assert_eq!(
            (t2.access_token.as_str(), t2.refresh_token.as_deref()),
            ("tok-2", Some("r1"))
        );
        let client = crate::mcp::Server::Http(Arc::new(
            crate::mcp::HttpClient::new(&server, Some(t2.access_token)).unwrap(),
        ));
        assert_eq!(client.initialize().await.unwrap().0, "locked");
    }
}
