//! Provider API keys. Stored only in the OS keychain (Secret Service / Windows Credential Manager).
//! A key enters once, when Isaac pastes it into Settings, and is never sent back to the frontend,
//! written to the database, or included in any log or error message.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Keychain service name; one entry per provider under it.
const SERVICE: &str = "com.isaacholt.fuse";
/// Anthropic API version header, from https://platform.claude.com/docs/en/api/models/list (2026-10-26).
const ANTHROPIC_VERSION: &str = "2026-10-21";
const TEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openai,
    Anthropic,
}

impl Provider {
    pub(crate) fn account(self) -> &'static str {
        match self {
            Provider::Openai => "openai",
            Provider::Anthropic => "anthropic",
        }
    }

    pub(crate) fn api_base(self) -> &'static str {
        match self {
            Provider::Openai => "https://api.openai.com",
            Provider::Anthropic => "https://api.anthropic.com",
        }
    }

    /// Header carrying the provider's request id, shown for support.
    fn request_id_header(self) -> &'static str {
        match self {
            Provider::Openai => "x-request-id",
            Provider::Anthropic => "request-id",
        }
    }
}

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The real store: OS keychain via the `keyring` crate.
pub struct OsKeychain;

fn keychain_error(e: keyring::Error) -> String {
    // keyring errors describe the store, never the secret.
    format!("Couldn't use the OS keychain: {e}")
}

impl SecretStore for OsKeychain {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(keychain_error)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(e)),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, account)
            .and_then(|entry| entry.set_password(secret))
            .map_err(keychain_error)
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(keychain_error)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error(e)),
        }
    }
}

/// In-memory store for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(std::sync::Mutex<std::collections::HashMap<String, String>>);

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .get(account)
            .cloned())
    }
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().map_err(|e| e.to_string())?.remove(account);
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub saved: bool,
    /// e.g. `sk-…3f9a`. Never more than the prefix and last four characters.
    pub masked: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TestStatus {
    Ok,
    Invalid,
    RateLimited,
    ProviderError,
    Network,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub status: TestStatus,
    pub http_status: Option<u16>,
    pub latency_ms: u64,
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub saved: bool,
    pub status: KeyStatus,
    pub test: TestResult,
}

pub fn mask(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let last4: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    if key.starts_with("sk-") {
        format!("sk-…{last4}")
    } else {
        format!("…{last4}")
    }
}

/// Basic shape check before any network call. Deliberately doesn't check prefixes:
/// providers change key formats.
pub fn validate_key_format(key: &str) -> Result<(), String> {
    if key.len() < 20 || key.len() > 512 {
        return Err("That doesn't look like an API key (wrong length).".into());
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The key contains spaces or line breaks. Paste just the key.".into());
    }
    Ok(())
}

pub fn status(store: &dyn SecretStore, provider: Provider) -> Result<KeyStatus, String> {
    let key = store.get(provider.account())?;
    Ok(KeyStatus {
        saved: key.is_some(),
        masked: key.as_deref().map(mask),
    })
}

/// Lists models: authenticated, free, and changes nothing.
/// `base` overrides the API host (tests only).
pub async fn test_key(
    client: &reqwest::Client,
    provider: Provider,
    key: &str,
    base: Option<&str>,
) -> TestResult {
    let url = format!("{}/v1/models", base.unwrap_or(provider.api_base()));
    let mut request = client.get(url).bearer_auth(key).timeout(TEST_TIMEOUT);
    if provider == Provider::Anthropic {
        request = request.header("anthropic-version", ANTHROPIC_VERSION);
    }
    let started = Instant::now();
    let response = request.send().await;
    let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match response {
        Ok(r) => {
            let code = r.status().as_u16();
            let status = match code {
                200..=299 => TestStatus::Ok,
                401 | 403 => TestStatus::Invalid,
                429 => TestStatus::RateLimited,
                _ => TestStatus::ProviderError,
            };
            let request_id = r
                .headers()
                .get(provider.request_id_header())
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            TestResult {
                status,
                http_status: Some(code),
                latency_ms,
                request_id,
            }
        }
        Err(_) => TestResult {
            status: TestStatus::Network,
            http_status: None,
            latency_ms,
            request_id: None,
        },
    }
}

/// Tests a new key first and stores it only if the provider accepted it
/// (a 429 still proves the key authenticates).
pub async fn save_key(
    store: &dyn SecretStore,
    client: &reqwest::Client,
    provider: Provider,
    key: &str,
    base: Option<&str>,
) -> Result<SaveResult, String> {
    let key = key.trim();
    validate_key_format(key)?;
    let test = test_key(client, provider, key, base).await;
    let accept = matches!(test.status, TestStatus::Ok | TestStatus::RateLimited);
    if accept {
        store.set(provider.account(), key)?;
    }
    Ok(SaveResult {
        saved: accept,
        status: status(store, provider)?,
        test,
    })
}

pub async fn test_saved_key(
    store: &dyn SecretStore,
    client: &reqwest::Client,
    provider: Provider,
    base: Option<&str>,
) -> Result<TestResult, String> {
    let key = store
        .get(provider.account())?
        .ok_or_else(|| "No key saved for this provider.".to_string())?;
    Ok(test_key(client, provider, &key, base).await)
}

pub fn delete_key(store: &dyn SecretStore, provider: Provider) -> Result<KeyStatus, String> {
    store.delete(provider.account())?;
    status(store, provider)
}

/// Shared state for the Tauri commands.
pub struct Keys {
    pub store: Box<dyn SecretStore>,
    pub client: reqwest::Client,
}

impl Default for Keys {
    fn default() -> Self {
        Keys {
            store: Box::new(OsKeychain),
            client: reqwest::Client::new(),
        }
    }
}

/// M9 step 8: where an MCP server's environment variable is kept in the keychain. The server
/// id is FUSE's own (a UUID), the name an environment variable's; anything else is refused.
pub fn mcp_account(server_id: &str, name: &str) -> Result<String, String> {
    let id_ok = !server_id.is_empty()
        && server_id.len() <= 64
        && server_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let name_ok = !name.is_empty()
        && name.len() <= 128
        && !name.as_bytes()[0].is_ascii_digit()
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    if id_ok && name_ok {
        Ok(format!("mcp:{server_id}:{name}"))
    } else {
        Err("That isn't a server id and variable name FUSE can keep.".into())
    }
}

/// M9 step 8: an MCP server's variables, from the keychain, for starting it. Never sent to the
/// webview. A name without a value is left out.
pub(crate) fn mcp_env_for(
    keys: &Keys,
    server_id: &str,
    names: &[String],
) -> Result<Vec<(String, String)>, String> {
    let mut out = vec![];
    for n in names {
        if let Some(v) = keys.store.get(&mcp_account(server_id, n)?)? {
            out.push((n.clone(), v));
        }
    }
    Ok(out)
}

pub mod commands {
    use super::*;
    use tauri::State;

    /// M9 step 8: keeps an MCP server's environment variable in the keychain.
    #[tauri::command]
    pub fn mcp_secret_set(
        keys: State<'_, Keys>,
        server_id: String,
        name: String,
        value: String,
    ) -> Result<(), String> {
        keys.store.set(&mcp_account(&server_id, &name)?, &value)
    }

    /// M9 step 8: removes one; nothing if it wasn't there.
    #[tauri::command]
    pub fn mcp_secret_delete(
        keys: State<'_, Keys>,
        server_id: String,
        name: String,
    ) -> Result<(), String> {
        keys.store.delete(&mcp_account(&server_id, &name)?)
    }

    /// M9 step 8: which of these variables have a value kept (never the values).
    #[tauri::command]
    pub fn mcp_secret_status(
        keys: State<'_, Keys>,
        server_id: String,
        names: Vec<String>,
    ) -> Result<Vec<bool>, String> {
        names
            .iter()
            .map(|n| Ok(keys.store.get(&mcp_account(&server_id, n)?)?.is_some()))
            .collect()
    }

    #[tauri::command]
    pub fn key_status(keys: State<'_, Keys>, provider: Provider) -> Result<KeyStatus, String> {
        status(keys.store.as_ref(), provider)
    }

    #[tauri::command]
    pub async fn key_save(
        keys: State<'_, Keys>,
        provider: Provider,
        key: String,
    ) -> Result<SaveResult, String> {
        save_key(keys.store.as_ref(), &keys.client, provider, &key, None).await
    }

    #[tauri::command]
    pub async fn key_test(keys: State<'_, Keys>, provider: Provider) -> Result<TestResult, String> {
        test_saved_key(keys.store.as_ref(), &keys.client, provider, None).await
    }

    #[tauri::command]
    pub fn key_delete(keys: State<'_, Keys>, provider: Provider) -> Result<KeyStatus, String> {
        delete_key(keys.store.as_ref(), provider)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    const FAKE_KEY: &str = "fake-test-value-0123456789abcd";

    #[test]
    fn mcp_variables_are_kept_by_server_and_name() {
        let id = "019a3b1c-0000-7000-8000-000000000001";
        assert_eq!(
            mcp_account(id, "GITHUB_TOKEN").unwrap(),
            format!("mcp:{id}:GITHUB_TOKEN")
        );
        for (sid, name) in [
            ("", "X"),
            (id, ""),
            (id, "1ABC"),
            (id, "A-B"),
            ("../x", "X"),
            ("a:b", "X"),
            (id, "A B"),
        ] {
            assert!(mcp_account(sid, name).is_err(), "{sid} {name}");
        }
    }

    /// One-shot HTTP server: answers a single request with `status`, returns the raw request text.
    fn serve_once(status: u16, request_id_header: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let header = request_id_header.to_owned();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap();
            let body = "{}";
            write!(
                stream,
                "HTTP/1.1 {status} X\r\n{header}: req_123\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            String::from_utf8_lossy(&buf[..n]).to_lowercase()
        });
        (base, handle)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn anthropic_test_sends_bearer_and_version_to_models() {
        let (base, server) = serve_once(200, "request-id");
        let r = test_key(&client(), Provider::Anthropic, FAKE_KEY, Some(&base)).await;
        let request = server.join().unwrap();
        assert_eq!(r.status, TestStatus::Ok);
        assert_eq!(r.request_id.as_deref(), Some("req_123"));
        assert!(request.starts_with("get /v1/models "));
        assert!(request.contains(&format!("authorization: bearer {FAKE_KEY}")));
        assert!(request.contains(&format!("anthropic-version: {ANTHROPIC_VERSION}")));
    }

    #[tokio::test]
    async fn openai_test_sends_bearer_without_anthropic_header() {
        let (base, server) = serve_once(200, "x-request-id");
        let r = test_key(&client(), Provider::Openai, FAKE_KEY, Some(&base)).await;
        let request = server.join().unwrap();
        assert_eq!(r.status, TestStatus::Ok);
        assert_eq!(r.request_id.as_deref(), Some("req_123"));
        assert!(!request.contains("anthropic-version"));
    }

    #[tokio::test]
    async fn http_statuses_map_to_plain_outcomes() {
        for (code, expected) in [
            (401, TestStatus::Invalid),
            (403, TestStatus::Invalid),
            (429, TestStatus::RateLimited),
            (500, TestStatus::ProviderError),
            (529, TestStatus::ProviderError),
        ] {
            let (base, server) = serve_once(code, "request-id");
            let r = test_key(&client(), Provider::Anthropic, FAKE_KEY, Some(&base)).await;
            server.join().unwrap();
            assert_eq!(r.status, expected, "HTTP {code}");
            assert_eq!(r.http_status, Some(code));
        }
    }

    #[tokio::test]
    async fn unreachable_provider_is_a_network_error() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port(); // listener dropped: nothing listens here
        let base = format!("http://127.0.0.1:{port}");
        let r = test_key(&client(), Provider::Openai, FAKE_KEY, Some(&base)).await;
        assert_eq!(r.status, TestStatus::Network);
        assert_eq!(r.http_status, None);
    }

    #[tokio::test]
    async fn invalid_key_is_not_stored_valid_key_is() {
        let store = MemoryStore::default();

        let (base, server) = serve_once(401, "request-id");
        let r = save_key(
            &store,
            &client(),
            Provider::Anthropic,
            FAKE_KEY,
            Some(&base),
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert!(!r.saved);
        assert_eq!(store.get("anthropic").unwrap(), None);

        let (base, server) = serve_once(200, "request-id");
        let padded = format!("  {FAKE_KEY}\n");
        let r = save_key(&store, &client(), Provider::Anthropic, &padded, Some(&base))
            .await
            .unwrap();
        server.join().unwrap();
        assert!(r.saved);
        assert_eq!(store.get("anthropic").unwrap().as_deref(), Some(FAKE_KEY));
        assert_eq!(r.status.masked.as_deref(), Some("…abcd"));

        assert_eq!(
            delete_key(&store, Provider::Anthropic).unwrap(),
            KeyStatus {
                saved: false,
                masked: None
            }
        );
    }

    #[tokio::test]
    async fn testing_without_a_saved_key_is_an_error() {
        let store = MemoryStore::default();
        let err = test_saved_key(
            &store,
            &client(),
            Provider::Openai,
            Some("http://127.0.0.1:9"),
        )
        .await
        .unwrap_err();
        assert!(err.contains("No key saved"));
    }

    #[test]
    fn results_never_contain_the_key() {
        let status = KeyStatus {
            saved: true,
            masked: Some(mask(FAKE_KEY)),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains(&FAKE_KEY[..8]));
    }

    #[test]
    fn masks_show_only_prefix_and_last_four() {
        // Built at runtime so the repo never holds a key-shaped literal (secret scan).
        let fake = format!("sk-{}3f9a", "x".repeat(24));
        assert_eq!(mask(&fake), "sk-…3f9a");
        assert_eq!(mask("abcdefghijklmnopqrstuvwx"), "…uvwx");
    }

    #[test]
    fn rejects_malformed_keys_before_any_network_call() {
        assert!(validate_key_format("short").is_err());
        assert!(validate_key_format("has space in the middle of it 123").is_err());
        assert!(validate_key_format(FAKE_KEY).is_ok());
    }

    #[test]
    fn provider_names_match_the_frontend() {
        assert_eq!(
            serde_json::to_string(&Provider::Openai).unwrap(),
            "\"openai\""
        );
        assert_eq!(
            serde_json::from_str::<Provider>("\"anthropic\"").unwrap(),
            Provider::Anthropic
        );
        assert_eq!(
            serde_json::to_string(&TestStatus::RateLimited).unwrap(),
            "\"rate_limited\""
        );
    }
}
