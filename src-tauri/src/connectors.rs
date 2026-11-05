//! First-party MCP participants. Public registration settings live in SQLite; authorization
//! grants live only in the existing native secret store. No OAuth response is logged or
//! forwarded to a webview. Device codes exist only in this installation's process memory.
use crate::ctx::Ctx;
mod github;
mod graph;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallContext {
    pub thread_id: Option<String>,
    pub project_id: Option<String>,
    pub provider: String,
}
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Microsoft,
    Github,
}
impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Microsoft => "microsoft",
            Self::Github => "github",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registration {
    pub id: String,
    pub workspace_id: String,
    pub user_id: String,
    pub kind: Kind,
    pub client_id: String,
    pub tenant: String,
    pub services: Vec<String>,
}
impl Registration {
    fn validate(&self) -> Result<(), String> {
        for id in [&self.id, &self.workspace_id, &self.user_id] {
            if !valid_id(id) {
                return Err("Use a valid connector and workspace identity.".into());
            }
        }
        if self.client_id.is_empty()
            || self.client_id.len() > 128
            || !self
                .client_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        {
            return Err("Enter the registered public application client ID.".into());
        }
        if self.tenant.is_empty()
            || self.tenant.len() > 253
            || !self
                .tenant
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-.".contains(&c))
        {
            return Err(
                "Use common, consumers, organizations, or a Microsoft tenant ID/domain.".into(),
            );
        }
        let allowed: &[&str] = match self.kind {
            Kind::Microsoft => &["onedrive", "mail", "calendar"],
            Kind::Github => &["github"],
        };
        if self.services.is_empty()
            || self.services.len() > allowed.len()
            || self.services.iter().any(|s| !allowed.contains(&s.as_str()))
            || self
                .services
                .iter()
                .enumerate()
                .any(|(i, s)| self.services[..i].contains(s))
        {
            return Err("Choose the connector services to authorize.".into());
        }
        if self.kind == Kind::Microsoft && !valid_id(&self.client_id) {
            return Err("Microsoft requires its Application (client) UUID.".into());
        }
        if self.kind == Kind::Github
            && (!self.client_id.starts_with("Iv1.") && !self.client_id.starts_with("Iv23."))
        {
            return Err(
                "Use a GitHub App client ID, not an OAuth App or application number.".into(),
            );
        }
        Ok(())
    }
    fn scopes(&self) -> String {
        if self.kind == Kind::Github {
            return "offline_access".into();
        }
        let mut scopes = vec!["offline_access", "User.Read"];
        for (service, scope) in [
            ("onedrive", "Files.Read"),
            ("mail", "Mail.Read"),
            ("calendar", "Calendars.Read"),
        ] {
            if self.services.iter().any(|s| s == service) {
                scopes.push(scope);
            }
        }
        scopes.join(" ")
    }
    fn endpoints(&self) -> Endpoints {
        match self.kind {
            Kind::Microsoft => Endpoints {
                device: format!(
                    "https://login.microsoftonline.com/{}/oauth2/v2.0/devicecode",
                    self.tenant
                ),
                token: format!(
                    "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
                    self.tenant
                ),
                identity:
                    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName"
                        .into(),
            },
            Kind::Github => Endpoints {
                device: "https://github.com/login/device/code".into(),
                token: "https://github.com/login/oauth/access_token".into(),
                identity: "https://api.github.com/user".into(),
            },
        }
    }
}
struct Endpoints {
    device: String,
    token: String,
    identity: String,
}
// Deliberately not Debug or Serialize: no ordinary command can return a flow or credential.
struct Flow {
    id: String,
    registration: Registration,
    device: String,
    user_code: String,
    uri: String,
    until: Instant,
    expires_at: u64,
    next: Instant,
    interval: u64,
}
#[derive(Serialize, Deserialize)]
struct Grant {
    registration: Registration,
    access: String,
    refresh: Option<String>,
    expires_at: Option<u64>,
    identity: String,
    label: String,
}
#[derive(Default)]
pub struct Accounts {
    flows: Mutex<HashMap<String, Flow>>,
    cursors: Mutex<HashMap<String, graph::Cursor>>,
    github_cursors: Mutex<HashMap<String, github::Cursor>>,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub state: &'static str,
    pub identity: Option<String>,
    pub label: Option<String>,
    pub expires_at: Option<u64>,
    pub flow_id: Option<String>,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
    pub poll_after_seconds: Option<u64>,
}
fn status(state: &'static str) -> AccountStatus {
    AccountStatus {
        state,
        identity: None,
        label: None,
        expires_at: None,
        flow_id: None,
        user_code: None,
        verification_uri: None,
        poll_after_seconds: None,
    }
}
fn waiting(f: &Flow) -> AccountStatus {
    AccountStatus {
        state: "pending",
        flow_id: Some(f.id.clone()),
        user_code: Some(f.user_code.clone()),
        verification_uri: Some(f.uri.clone()),
        expires_at: Some(f.expires_at),
        poll_after_seconds: Some(
            f.next
                .saturating_duration_since(Instant::now())
                .as_secs()
                .saturating_add(1),
        ),
        ..status("pending")
    }
}
fn grant_status(g: &Grant) -> AccountStatus {
    let state = if g
        .expires_at
        .is_some_and(|t| t <= crate::mcp_oauth::now_secs() + 60)
        && (g.registration.kind == Kind::Github || g.refresh.is_none())
    {
        "sign_in_required"
    } else {
        "connected"
    };
    AccountStatus {
        identity: Some(g.identity.clone()),
        label: Some(g.label.clone()),
        expires_at: g.expires_at,
        ..status(state)
    }
}
fn valid_id(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "OS randomness is unavailable.".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn secret_id(id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("Invalid connector identity.".into());
    }
    Ok(format!("connector:{id}"))
}
fn load(ctx: &Ctx, r: &Registration) -> Result<Option<Grant>, String> {
    let raw = ctx.keys.store.get(&secret_id(&r.id)?)?;
    raw.map(|raw| {
        serde_json::from_str::<Grant>(&raw)
            .map_err(|_| "Sign in again: the stored connector grant cannot be read.".to_string())
    })
    .transpose()
    .map(|g| g.filter(|g| g.registration == *r))
}
fn save(ctx: &Ctx, g: &Grant) -> Result<(), String> {
    ctx.keys.store.set(
        &secret_id(&g.registration.id)?,
        &serde_json::to_string(g)
            .map_err(|_| "Couldn't save connector authorization.".to_string())?,
    )
}
fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .user_agent("FUSE-connectors/1")
        .build()
        .map_err(|_| "Couldn't initialize connector networking.".into())
}
/// All OAuth/API bodies are capped and errors discard their contents, including malicious echoes.
async fn body(mut response: reqwest::Response) -> Result<Value, String> {
    if response.status().is_redirection() {
        return Err("The account service redirected the request; sign-in stopped.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Account response was interrupted.".to_string())?
    {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Err("Account response exceeded its size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Account service returned a malformed response.".into())
}
async fn post(
    client: &reqwest::Client,
    url: &str,
    pairs: &[(&str, &str)],
) -> Result<Value, String> {
    let response = client
        .post(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(crate::mcp_oauth::form(pairs))
        .send()
        .await
        .map_err(|_| "Couldn't reach the account service. Retry sign-in explicitly.".to_string())?;
    let success = response.status().is_success();
    let value = body(response).await?;
    if !success && value.get("error").is_none() {
        return Err("The account service refused this request.".into());
    }
    Ok(value)
}
fn field(v: &Value, k: &str, max: usize) -> Result<String, String> {
    v.get(k)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .map(str::to_string)
        .ok_or_else(|| "Account service returned incomplete authorization data.".into())
}
fn verification(kind: Kind, uri: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(uri) else {
        return false;
    };
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return false;
    }
    match kind {
        Kind::Github => u.host_str() == Some("github.com") && u.path() == "/login/device",
        Kind::Microsoft => {
            (u.host_str() == Some("microsoft.com") && u.path() == "/devicelogin")
                || (u.host_str() == Some("login.microsoftonline.com")
                    && u.path() == "/common/oauth2/deviceauth")
        }
    }
}
async fn audit(ctx: &Ctx, r: &Registration, event: &str, action: &str) -> Result<(), String> {
    sqlx::query("INSERT INTO security_audit(id,workspace_id,user_id,event_kind,scope_kind,scope_id,action,created_at,updated_at) VALUES(?,?,?,?, 'record',?,?,?,?)")
        .bind(random_id()?).bind(&r.workspace_id).bind(&r.user_id).bind(event).bind(&r.id).bind(action)
        .bind((crate::mcp_oauth::now_secs()*1000) as i64).bind((crate::mcp_oauth::now_secs()*1000) as i64)
        .execute(&ctx.db.pool()?).await.map_err(|_| "Couldn't record connector security activity.".to_string())?;
    Ok(())
}
pub(crate) async fn registration(ctx: &Ctx, id: &str) -> Result<Registration, String> {
    let row=sqlx::query("SELECT a.*,s.builtin_kind FROM connector_accounts a JOIN mcp_servers s ON s.id=a.id AND s.workspace_id=a.workspace_id AND s.user_id=a.user_id WHERE a.id=? AND s.deleted_at IS NULL AND s.builtin_kind IS NOT NULL")
        .bind(id).fetch_optional(&ctx.db.pool()?).await.map_err(|_| "Couldn't read connector settings.".to_string())?.ok_or("Configure this connector on this installation first.")?;
    let kind = match row.get::<String, _>("builtin_kind").as_str() {
        "microsoft" => Kind::Microsoft,
        "github" => Kind::Github,
        _ => return Err("Unsupported connector.".into()),
    };
    let r = Registration {
        id: id.into(),
        workspace_id: row.get("workspace_id"),
        user_id: row.get("user_id"),
        kind,
        client_id: row.get("client_id"),
        tenant: row.get("tenant"),
        services: serde_json::from_str(&row.get::<String, _>("services"))
            .map_err(|_| "Invalid connector services.".to_string())?,
    };
    r.validate()?;
    Ok(r)
}
pub(crate) async fn configure(
    ctx: &Ctx,
    registration: Registration,
) -> Result<AccountStatus, String> {
    registration.validate()?;
    let r = registration;
    let mut flows = ctx.accounts.flows.lock().await;
    // Fail closed even if a subsequent database write fails. Old authorization never follows
    // changed registration settings, and account setup never creates project permissions.
    ctx.keys.store.delete(&secret_id(&r.id)?)?;
    flows.remove(&r.id);
    graph::clear(ctx, &r.id).await;
    github::clear(ctx, &r.id).await;
    let pool = ctx.db.pool()?;
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| "Couldn't save connector settings.".to_string())?;
    let now = (crate::mcp_oauth::now_secs() * 1000) as i64;
    let name = match r.kind {
        Kind::Microsoft => "Microsoft",
        Kind::Github => "GitHub",
    };
    let result=sqlx::query("INSERT INTO mcp_servers(id,workspace_id,user_id,name,transport,builtin_kind,created_at,updated_at) VALUES(?,?,?,?,'http',?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,builtin_kind=excluded.builtin_kind,updated_at=excluded.updated_at WHERE mcp_servers.workspace_id=excluded.workspace_id AND mcp_servers.user_id=excluded.user_id AND mcp_servers.builtin_kind=excluded.builtin_kind AND mcp_servers.deleted_at IS NULL")
        .bind(&r.id).bind(&r.workspace_id).bind(&r.user_id).bind(name).bind(r.kind.as_str()).bind(now).bind(now).execute(&mut *tx).await.map_err(|_| "Couldn't save connector settings.".to_string())?;
    if result.rows_affected() != 1 {
        return Err("That server identity is already used; create a new connector.".into());
    }
    sqlx::query("INSERT INTO connector_accounts(id,workspace_id,user_id,client_id,tenant,services,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,tenant=excluded.tenant,services=excluded.services,updated_at=excluded.updated_at")
        .bind(&r.id).bind(&r.workspace_id).bind(&r.user_id).bind(&r.client_id).bind(&r.tenant).bind(serde_json::to_string(&r.services).unwrap()).bind(now).bind(now).execute(&mut *tx).await.map_err(|_| "Couldn't save connector settings.".to_string())?;
    // Any service/configuration change needs fresh per-project enablement.
    sqlx::query("DELETE FROM project_mcp_servers WHERE server_id=?")
        .bind(&r.id)
        .execute(&mut *tx)
        .await
        .map_err(|_| "Couldn't reset connector permissions.".to_string())?;
    tx.commit()
        .await
        .map_err(|_| "Couldn't save connector settings.".to_string())?;
    audit(ctx, &r, "policy_change", "set").await?;
    Ok(status("signed_out"))
}
pub(crate) async fn account_status(ctx: &Ctx, id: String) -> Result<AccountStatus, String> {
    let flows = ctx.accounts.flows.lock().await;
    let r = registration(ctx, &id).await?;
    if let Some(f) = flows
        .get(&id)
        .filter(|f| f.registration == r && Instant::now() < f.until)
    {
        return Ok(waiting(f));
    }
    Ok(load(ctx, &r)?
        .as_ref()
        .map(grant_status)
        .unwrap_or_else(|| status("signed_out")))
}
pub(crate) async fn begin(ctx: &Ctx, id: String) -> Result<AccountStatus, String> {
    begin_using(ctx, id, None).await
}
async fn begin_using(
    ctx: &Ctx,
    id: String,
    endpoints: Option<&Endpoints>,
) -> Result<AccountStatus, String> {
    let mut flows = ctx.accounts.flows.lock().await;
    let r = registration(ctx, &id).await?;
    if let Some(f) = flows
        .get(&id)
        .filter(|f| f.registration == r && Instant::now() < f.until)
    {
        return Ok(waiting(f));
    }
    audit(ctx, &r, "credential_use", "request").await?;
    let v = post(
        &http()?,
        &endpoints.unwrap_or(&r.endpoints()).device,
        &[("client_id", &r.client_id), ("scope", &r.scopes())],
    )
    .await?;
    let f = parse_flow(r, &v)?;
    let out = waiting(&f);
    flows.insert(id, f);
    Ok(out)
}
fn parse_flow(r: Registration, v: &Value) -> Result<Flow, String> {
    if v.get("error").is_some() {
        return Err("Device sign-in was refused. Check the public client ID, device-flow setting and tenant policy.".into());
    }
    let expires = v
        .get("expires_in")
        .and_then(Value::as_u64)
        .filter(|n| (1..=1800).contains(n))
        .ok_or("Invalid sign-in expiry.")?;
    let interval = v
        .get("interval")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .clamp(5, 1800);
    let uri = field(v, "verification_uri", 256)?;
    if !verification(r.kind, &uri) {
        return Err("The account service returned an unexpected sign-in address.".into());
    }
    Ok(Flow {
        id: random_id()?,
        registration: r,
        device: field(v, "device_code", 8192)?,
        user_code: field(v, "user_code", 32)?,
        uri,
        until: Instant::now() + Duration::from_secs(expires),
        expires_at: crate::mcp_oauth::now_secs() + expires,
        next: Instant::now() + Duration::from_secs(interval),
        interval,
    })
}
fn token_expiry(r: &Registration, v: &Value) -> Result<Option<u64>, String> {
    let expiry = v
        .get("expires_in")
        .and_then(Value::as_u64)
        .filter(|n| (1..=86400 * 7).contains(n));
    if (r.kind == Kind::Microsoft || v.get("expires_in").is_some()) && expiry.is_none() {
        return Err("Missing account token expiry; sign in again.".into());
    }
    Ok(expiry.map(|n| crate::mcp_oauth::now_secs() + n))
}
fn verify_scopes(r: &Registration, v: &Value) -> Result<(), String> {
    if !v
        .get("token_type")
        .and_then(Value::as_str)
        .is_some_and(|s| s.eq_ignore_ascii_case("bearer"))
    {
        return Err("Unsupported authorization token type.".into());
    }
    let scopes = v.get("scope").and_then(Value::as_str).unwrap_or("");
    if r.kind == Kind::Github {
        if !scopes.is_empty() || !field(v, "access_token", 16384)?.starts_with("ghu_") {
            return Err(
                "Sign in with the registered GitHub App, using read-only permissions.".into(),
            );
        }
    } else if r
        .scopes()
        .split_whitespace()
        .filter(|s| *s != "offline_access")
        .any(|s| !scopes.split_whitespace().any(|g| g.eq_ignore_ascii_case(s)))
        || scopes
            .split_whitespace()
            .any(|s| s.to_ascii_lowercase().contains("write"))
    {
        return Err("Required delegated read consent is missing or unexpected write access was returned. Review the application registration.".into());
    }
    Ok(())
}
async fn identity(
    client: &reqwest::Client,
    r: &Registration,
    endpoint: &str,
    access: &str,
) -> Result<(String, String), String> {
    let response = client
        .get(endpoint)
        .header("Accept", "application/json")
        .header("X-GitHub-Api-Version", "2026-03-10")
        .bearer_auth(access)
        .send()
        .await
        .map_err(|_| "Couldn't verify the signed-in account.".to_string())?;
    if !response.status().is_success() {
        return Err(
            "Couldn't verify the signed-in account. Check tenant consent or sign in again.".into(),
        );
    }
    let v = body(response).await?;
    let id = if r.kind == Kind::Github {
        v.get("id")
            .and_then(Value::as_u64)
            .map(|n| n.to_string())
            .ok_or("Missing GitHub account identity.")?
    } else {
        field(&v, "id", 256)?
    };
    let label = field(
        &v,
        if r.kind == Kind::Github {
            "login"
        } else {
            "displayName"
        },
        256,
    )?;
    Ok((id, label))
}
pub(crate) async fn poll(ctx: &Ctx, id: String, flow_id: String) -> Result<AccountStatus, String> {
    poll_using(ctx, id, flow_id, None).await
}
async fn poll_using(
    ctx: &Ctx,
    id: String,
    flow_id: String,
    endpoints: Option<&Endpoints>,
) -> Result<AccountStatus, String> {
    let mut flows = ctx.accounts.flows.lock().await;
    let r = registration(ctx, &id).await?;
    let Some(f) = flows.get_mut(&id) else {
        return Ok(load(ctx, &r)?
            .as_ref()
            .map(grant_status)
            .unwrap_or_else(|| status("signed_out")));
    };
    if f.id != flow_id || f.registration != r {
        return Err("This sign-in was replaced; reopen connector settings.".into());
    }
    if Instant::now() >= f.until {
        flows.remove(&id);
        return Ok(status("expired"));
    }
    if Instant::now() < f.next {
        return Ok(waiting(f));
    }
    // Reserve the poll interval before I/O, including on transport failure.
    f.next = Instant::now() + Duration::from_secs(f.interval);
    let default_endpoints = r.endpoints();
    let endpoints = endpoints.unwrap_or(&default_endpoints);
    let client = http()?;
    audit(ctx, &r, "credential_use", "request").await?;
    let v = post(
        &client,
        &endpoints.token,
        &[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", &r.client_id),
            ("device_code", &f.device),
        ],
    )
    .await?;
    match v.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => return Ok(waiting(f)),
        Some("slow_down") => {
            f.interval = f
                .interval
                .saturating_add(5)
                .max(v.get("interval").and_then(Value::as_u64).unwrap_or(0))
                .min(1800);
            f.next = Instant::now() + Duration::from_secs(f.interval);
            return Ok(waiting(f));
        }
        Some(error) => {
            let state = match error {
                "authorization_declined" | "access_denied" => "denied",
                "expired_token" | "token_expired" => "expired",
                _ => "sign_in_required",
            };
            flows.remove(&id);
            return Ok(status(state));
        }
        None => {}
    }
    // Consume the successful device flow before fallible verification/storage. An uncertain
    // token response or identity failure requires explicit sign-in, never a hidden flow replay.
    flows.remove(&id);
    verify_scopes(&r, &v)?;
    let access = field(&v, "access_token", 16384)?;
    let expires_at = token_expiry(&r, &v)?;
    let (identity, label) = identity(&client, &r, &endpoints.identity, &access).await?;
    let grant = Grant {
        registration: r.clone(),
        access,
        refresh: if r.kind == Kind::Microsoft {
            v.get("refresh_token")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 16384)
                .map(str::to_string)
        } else {
            None
        },
        expires_at,
        identity,
        label,
    };
    // Project consent belongs to the selected account, not just its application registration.
    // A different principal must never inherit the previous principal's enabled projects.
    if load(ctx, &r)?.is_none_or(|old| old.identity != grant.identity) {
        sqlx::query("DELETE FROM project_mcp_servers WHERE server_id=?")
            .bind(&r.id)
            .execute(&ctx.db.pool()?)
            .await
            .map_err(|_| "Couldn't reset connector project consent.".to_string())?;
    }
    audit(ctx, &r, "policy_change", "set").await?;
    save(ctx, &grant)?;
    Ok(grant_status(&grant))
}
pub(crate) async fn disconnect(ctx: &Ctx, id: String) -> Result<AccountStatus, String> {
    let mut flows = ctx.accounts.flows.lock().await;
    let r = registration(ctx, &id).await?;
    flows.remove(&id);
    graph::clear(ctx, &id).await;
    github::clear(ctx, &id).await;
    ctx.keys.store.delete(&secret_id(&id)?)?;
    sqlx::query("DELETE FROM project_mcp_servers WHERE server_id=?")
        .bind(&id)
        .execute(&ctx.db.pool()?)
        .await
        .map_err(|_| "Couldn't clear connector project consent.".to_string())?;
    audit(ctx, &r, "policy_change", "remove").await?;
    Ok(status("signed_out"))
}
/// For native readers only; never exported as a command. Refresh is serialized with sign-out.
pub(crate) async fn access_token(ctx: &Ctx, id: &str) -> Result<String, String> {
    access_using(ctx, id, None).await
}
async fn access_using(
    ctx: &Ctx,
    id: &str,
    endpoints: Option<&Endpoints>,
) -> Result<String, String> {
    let _guard = ctx.accounts.flows.lock().await;
    let r = registration(ctx, id).await?;
    let mut grant =
        load(ctx, &r)?.ok_or("Sign in to this connector on this installation first.")?;
    if grant
        .expires_at
        .is_some_and(|t| t <= crate::mcp_oauth::now_secs() + 60)
    {
        if r.kind == Kind::Github || grant.refresh.is_none() {
            return Err(
                "Account authorization expired. Sign in again in Settings → Connections.".into(),
            );
        }
        audit(ctx, &r, "credential_use", "request").await?;
        let v = post(
            &http()?,
            &endpoints.unwrap_or(&r.endpoints()).token,
            &[
                ("grant_type", "refresh_token"),
                ("client_id", &r.client_id),
                ("refresh_token", grant.refresh.as_deref().unwrap()),
                ("scope", &r.scopes()),
            ],
        )
        .await?;
        if v.get("error").is_some() {
            return Err(
                "Account authorization needs sign-in again; tenant consent may have changed."
                    .into(),
            );
        }
        verify_scopes(&r, &v)?;
        grant.access = field(&v, "access_token", 16384)?;
        grant.expires_at = token_expiry(&r, &v)?;
        if let Some(refresh) = v
            .get("refresh_token")
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 16384)
        {
            grant.refresh = Some(refresh.into());
        }
        save(ctx, &grant)?;
    }
    Ok(grant.access)
}
/// In-process MCP transport: same health/tool/result contract as stdio/HTTP, no downloaded
/// server, shell or generic network tunnel. Both providers use the existing MCP approvals.
pub(crate) async fn builtin(ctx: &Ctx, id: &str) -> Result<bool, String> {
    sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM mcp_servers WHERE id=? AND builtin_kind IS NOT NULL AND deleted_at IS NULL").bind(id).fetch_one(&ctx.db.pool()?).await.map(|n| n>0).map_err(|_| "Couldn't read connector settings.".into())
}
pub(crate) async fn health(ctx: &Ctx, id: &str) -> Result<crate::mcp::McpHealth, String> {
    let r = registration(ctx, id).await?;
    Ok(crate::mcp::McpHealth {
        server_name: format!("FUSE {}", r.kind.as_str()),
        server_version: env!("CARGO_PKG_VERSION").into(),
        protocol: crate::mcp::PROTOCOL.into(),
        tools: match r.kind {
            Kind::Microsoft => graph::tools(&r),
            Kind::Github => github::tools(),
        },
    })
}
pub(crate) async fn call(
    ctx: &Ctx,
    id: &str,
    name: &str,
    arguments: Value,
    context: Option<CallContext>,
) -> Result<crate::mcp::McpCallResult, String> {
    let r = registration(ctx, id).await?;
    let context = context
        .ok_or("Built-in readers require an enabled project and a chosen model provider.")?;
    match r.kind {
        Kind::Microsoft => graph::call(ctx, &r, name, arguments, &context).await,
        Kind::Github => github::call(ctx, &r, name, arguments, &context).await,
    }
}

pub mod commands {
    use super::*;
    use tauri::State;
    #[tauri::command]
    pub async fn connector_configure(
        ctx: State<'_, Ctx>,
        registration: Registration,
    ) -> Result<AccountStatus, String> {
        configure(&ctx, registration).await
    }
    #[tauri::command]
    pub async fn connector_status(
        ctx: State<'_, Ctx>,
        id: String,
    ) -> Result<AccountStatus, String> {
        account_status(&ctx, id).await
    }
    #[tauri::command]
    pub async fn connector_begin(ctx: State<'_, Ctx>, id: String) -> Result<AccountStatus, String> {
        begin(&ctx, id).await
    }
    #[tauri::command]
    pub async fn connector_poll(
        ctx: State<'_, Ctx>,
        id: String,
        flow_id: String,
    ) -> Result<AccountStatus, String> {
        poll(&ctx, id, flow_id).await
    }
    #[tauri::command]
    pub async fn connector_disconnect(
        ctx: State<'_, Ctx>,
        id: String,
    ) -> Result<AccountStatus, String> {
        disconnect(&ctx, id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn config(kind: Kind) -> Registration {
        Registration {
            id: "00000000-0000-7000-8000-000000001501".into(),
            workspace_id: "00000000-0000-7000-8000-000000000001".into(),
            user_id: "00000000-0000-7000-8000-000000000002".into(),
            kind,
            client_id: if kind == Kind::Microsoft {
                "10000000-0000-4000-8000-000000000001"
            } else {
                "Iv23.fixture"
            }
            .into(),
            tenant: "common".into(),
            services: vec![
                if kind == Kind::Microsoft {
                    "mail"
                } else {
                    "github"
                }
                .into(),
            ],
        }
    }
    struct Fixture {
        ctx: Ctx,
        dir: std::path::PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    async fn fixture(kind: Kind) -> Fixture {
        let dir = std::env::temp_dir().join(format!("fuse-connectors-{}", random_id().unwrap()));
        let ctx = Ctx::new(
            dir.join("data"),
            dir.join("config"),
            crate::keys::Keys::with_store(Box::<crate::keys::MemoryStore>::default()),
        );
        crate::db::db_open(&ctx).await.unwrap();
        configure(&ctx, config(kind)).await.unwrap();
        Fixture { ctx, dir }
    }
    fn device(kind: Kind) -> Value {
        json!({"device_code":"fixture-device-private","user_code":"FIXT-CODE","verification_uri":if kind==Kind::Github { "https://github.com/login/device" } else { "https://microsoft.com/devicelogin" },"expires_in":900,"interval":5})
    }
    fn token(kind: Kind) -> Value {
        json!({"token_type":"Bearer","scope":if kind==Kind::Github { "" } else { "User.Read Mail.Read" },"access_token":if kind==Kind::Github { "ghu_fixture_only" } else { "fixture-access-private" },"refresh_token":"fixture-refresh-private","expires_in":28800})
    }
    struct Mock {
        endpoints: Endpoints,
        replies: Arc<StdMutex<VecDeque<Value>>>,
        seen: Arc<StdMutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Mock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn mock(replies: Vec<Value>) -> Mock {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let replies = Arc::new(StdMutex::new(VecDeque::from(replies)));
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let (queue, requests) = (replies.clone(), seen.clone());
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buffer).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(at) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..at]).to_ascii_lowercase();
                        let size = header
                            .lines()
                            .find_map(|l| {
                                l.strip_prefix("content-length:")
                                    .and_then(|n| n.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= at + 4 + size {
                            break;
                        }
                    }
                }
                requests
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(bytes).unwrap());
                let out = queue
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("unexpected fixture network request")
                    .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
                    out.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        Mock {
            endpoints: Endpoints {
                device: format!("{base}/device"),
                token: format!("{base}/token"),
                identity: format!("{base}/me"),
            },
            replies,
            seen,
            task,
        }
    }
    async fn ready(ctx: &Ctx, id: &str) {
        ctx.accounts.flows.lock().await.get_mut(id).unwrap().next =
            Instant::now() - Duration::from_secs(1);
    }

    #[test]
    fn registration_bounds_hosts_and_selective_delegated_scopes() {
        let mut r = config(Kind::Microsoft);
        r.validate().unwrap();
        assert_eq!(r.scopes(), "offline_access User.Read Mail.Read");
        r.services = vec!["onedrive".into(), "calendar".into()];
        assert_eq!(
            r.scopes(),
            "offline_access User.Read Files.Read Calendars.Read"
        );
        for tenant in [
            "../common",
            "common?x=1",
            "https://evil.test",
            "common/token",
        ] {
            r.tenant = tenant.into();
            assert!(r.validate().is_err());
        }
        let mut r = config(Kind::Github);
        r.client_id = "oauth-app".into();
        assert!(r.validate().is_err());
        for uri in [
            "http://github.com/login/device",
            "https://github.com.evil.test/login/device",
            "https://evil@github.com/login/device",
            "https://github.com/login/device?token=bad",
            "https://github.com/login/device#bad",
            "https://github.com:8443/login/device",
        ] {
            assert!(!verification(Kind::Github, uri));
        }
        let mut response = device(Kind::Microsoft);
        response["verification_uri"] = json!("https://evil.test");
        assert!(parse_flow(config(Kind::Microsoft), &response).is_err());
        let mut v = token(Kind::Microsoft);
        v["scope"] = json!("User.Read Mail.ReadWrite");
        assert!(verify_scopes(&config(Kind::Microsoft), &v).is_err());
        let mut v = token(Kind::Github);
        v["scope"] = json!("repo");
        assert!(verify_scopes(&config(Kind::Github), &v).is_err());
    }
    #[tokio::test]
    async fn device_flow_polls_once_throttles_and_keeps_all_credentials_native() {
        let f = fixture(Kind::Microsoft).await;
        let id = config(Kind::Microsoft).id;
        let mock = mock(vec![
            device(Kind::Microsoft),
            json!({"error":"authorization_pending","error_description":"fixture-access-private"}),
            json!({"error":"slow_down","interval":15}),
            token(Kind::Microsoft),
            json!({"id":"account-fixture","displayName":"Test owner"}),
        ])
        .await;
        let start = begin_using(&f.ctx, id.clone(), Some(&mock.endpoints))
            .await
            .unwrap();
        let flow = start.flow_id.clone().unwrap();
        assert_eq!(start.state, "pending");
        begin_using(&f.ctx, id.clone(), Some(&mock.endpoints))
            .await
            .unwrap(); // opening Settings twice starts no new flow
        poll_using(&f.ctx, id.clone(), flow.clone(), Some(&mock.endpoints))
            .await
            .unwrap();
        assert_eq!(mock.seen.lock().unwrap().len(), 1);
        ready(&f.ctx, &id).await;
        assert_eq!(
            poll_using(&f.ctx, id.clone(), flow.clone(), Some(&mock.endpoints))
                .await
                .unwrap()
                .state,
            "pending"
        );
        ready(&f.ctx, &id).await;
        let slow = poll_using(&f.ctx, id.clone(), flow.clone(), Some(&mock.endpoints))
            .await
            .unwrap();
        assert!(slow.poll_after_seconds.unwrap() >= 15);
        ready(&f.ctx, &id).await;
        let done = poll_using(&f.ctx, id.clone(), flow.clone(), Some(&mock.endpoints))
            .await
            .unwrap();
        assert_eq!(done.state, "connected");
        assert_eq!(done.label.as_deref(), Some("Test owner"));
        assert!(crate::mcp::mcp_signed_in(&f.ctx, id.clone()).await.unwrap());
        let repeat = poll_using(&f.ctx, id.clone(), flow, Some(&mock.endpoints))
            .await
            .unwrap();
        assert_eq!(repeat.state, "connected");
        assert!(mock.replies.lock().unwrap().is_empty());
        let requests = mock.seen.lock().unwrap().clone();
        assert!(
            requests[0].contains("scope=offline_access+User.Read+Mail.Read")
                || requests[0].contains("scope=offline_access%20User.Read%20Mail.Read")
        );
        assert!(requests.iter().all(|s| !s.contains("client_secret")));
        let status = serde_json::to_string(&done).unwrap();
        let rows: Vec<String> =
            sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table'")
                .fetch_all(&f.ctx.db.pool().unwrap())
                .await
                .unwrap();
        assert!(!rows.join("").contains("access_token TEXT"));
        let audits: Vec<String> = sqlx::query_scalar(
            "SELECT coalesce(scope_id,'')||event_kind||action FROM security_audit",
        )
        .fetch_all(&f.ctx.db.pool().unwrap())
        .await
        .unwrap();
        for secret in [
            "fixture-access-private",
            "fixture-refresh-private",
            "fixture-device-private",
        ] {
            assert!(!status.contains(secret));
            assert!(!audits.join("").contains(secret));
        }
        let permitted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM project_mcp_servers")
            .fetch_one(&f.ctx.db.pool().unwrap())
            .await
            .unwrap();
        assert_eq!(permitted, 0);
        assert!(
            !crate::mcp::mcp_check(&f.ctx, id.clone())
                .await
                .unwrap()
                .tools
                .is_empty()
        );
        assert!(
            crate::mcp::mcp_call(&f.ctx, id.clone(), "execute".into(), json!({}), None)
                .await
                .is_err()
        );
        disconnect(&f.ctx, id.clone()).await.unwrap();
        assert_eq!(
            account_status(&f.ctx, id.clone()).await.unwrap().state,
            "signed_out"
        );
        assert!(
            f.ctx
                .keys
                .store
                .get(&secret_id(&id).unwrap())
                .unwrap()
                .is_none()
        );
    }
    #[tokio::test]
    async fn denial_expiry_cancellation_and_reconfiguration_cannot_complete_old_flows() {
        let f = fixture(Kind::Github).await;
        for error in [
            "access_denied",
            "authorization_declined",
            "expired_token",
            "tenant_refused",
        ] {
            let r = config(Kind::Github);
            let m = mock(vec![
                device(Kind::Github),
                json!({"error":error,"error_description":"fixture-refresh-private"}),
            ])
            .await;
            let flow = begin_using(&f.ctx, r.id.clone(), Some(&m.endpoints))
                .await
                .unwrap()
                .flow_id
                .unwrap();
            ready(&f.ctx, &r.id).await;
            let state = poll_using(&f.ctx, r.id.clone(), flow, Some(&m.endpoints))
                .await
                .unwrap();
            assert!(matches!(
                state.state,
                "denied" | "expired" | "sign_in_required"
            ));
            assert!(
                !serde_json::to_string(&state)
                    .unwrap()
                    .contains("fixture-refresh-private")
            );
            assert!(f.ctx.accounts.flows.lock().await.is_empty());
        }
        let mut r = config(Kind::Github);
        let m = mock(vec![
            device(Kind::Github),
            device(Kind::Github),
            device(Kind::Github),
        ])
        .await;
        let old = begin_using(&f.ctx, r.id.clone(), Some(&m.endpoints))
            .await
            .unwrap()
            .flow_id
            .unwrap();
        disconnect(&f.ctx, r.id.clone()).await.unwrap();
        assert_eq!(
            poll_using(&f.ctx, r.id.clone(), old, Some(&m.endpoints))
                .await
                .unwrap()
                .state,
            "signed_out"
        );
        let old = begin_using(&f.ctx, r.id.clone(), Some(&m.endpoints))
            .await
            .unwrap()
            .flow_id
            .unwrap();
        r.client_id = "Iv23.reconfigured".into();
        configure(&f.ctx, r.clone()).await.unwrap();
        let new = begin_using(&f.ctx, r.id.clone(), Some(&m.endpoints))
            .await
            .unwrap()
            .flow_id
            .unwrap();
        assert_ne!(old, new);
        assert!(
            poll_using(&f.ctx, r.id.clone(), old, Some(&m.endpoints))
                .await
                .unwrap_err()
                .contains("replaced")
        );
        f.ctx
            .accounts
            .flows
            .lock()
            .await
            .get_mut(&r.id)
            .unwrap()
            .until = Instant::now() - Duration::from_secs(1);
        assert_eq!(
            poll_using(&f.ctx, r.id.clone(), new, Some(&m.endpoints))
                .await
                .unwrap()
                .state,
            "expired"
        );
        assert_eq!(m.seen.lock().unwrap().len(), 3);
    }
    #[tokio::test]
    async fn github_app_identity_and_expiry_never_refresh_with_a_client_secret() {
        let f = fixture(Kind::Github).await;
        let r = config(Kind::Github);
        let m = mock(vec![
            device(Kind::Github),
            token(Kind::Github),
            json!({"id":42,"login":"fixture-owner"}),
        ])
        .await;
        let flow = begin_using(&f.ctx, r.id.clone(), Some(&m.endpoints))
            .await
            .unwrap()
            .flow_id
            .unwrap();
        ready(&f.ctx, &r.id).await;
        let connected = poll_using(&f.ctx, r.id.clone(), flow, Some(&m.endpoints))
            .await
            .unwrap();
        assert_eq!(connected.identity.as_deref(), Some("42"));
        let mut grant = load(&f.ctx, &r).unwrap().unwrap();
        assert!(grant.refresh.is_none());
        grant.expires_at = Some(1);
        save(&f.ctx, &grant).unwrap();
        assert_eq!(
            account_status(&f.ctx, r.id.clone()).await.unwrap().state,
            "sign_in_required"
        );
        assert!(
            access_token(&f.ctx, &r.id)
                .await
                .unwrap_err()
                .contains("Sign in again")
        );
        assert_eq!(m.seen.lock().unwrap().len(), 3);
    }
    #[tokio::test]
    async fn malformed_and_oversized_oauth_responses_are_redacted() {
        let m = mock(vec![
            json!({"token":"fixture-access-private"}),
            json!({"token":"a".repeat(300000)}),
        ])
        .await;
        let v = post(&http().unwrap(), &m.endpoints.token, &[])
            .await
            .unwrap();
        let error = field(&v, "access_token", 10).unwrap_err();
        assert!(!error.contains("fixture-access-private"));
        assert!(
            post(&http().unwrap(), &m.endpoints.token, &[])
                .await
                .unwrap_err()
                .contains("size limit")
        );
    }
    #[tokio::test]
    async fn refresh_is_serialized_updates_the_native_grant_and_survives_window_restarts() {
        let f = fixture(Kind::Microsoft).await;
        let r = config(Kind::Microsoft);
        save(
            &f.ctx,
            &Grant {
                registration: r.clone(),
                access: "fixture-old-access".into(),
                refresh: Some("fixture-old-refresh".into()),
                expires_at: Some(1),
                identity: "account-fixture".into(),
                label: "Test owner".into(),
            },
        )
        .unwrap();
        let mut response = token(Kind::Microsoft);
        response["refresh_token"] = json!("fixture-rotated-refresh");
        let m = mock(vec![response]).await;
        let (a, b) = tokio::join!(
            access_using(&f.ctx, &r.id, Some(&m.endpoints)),
            access_using(&f.ctx, &r.id, Some(&m.endpoints))
        );
        assert_eq!(a.unwrap(), "fixture-access-private");
        assert_eq!(b.unwrap(), "fixture-access-private");
        assert_eq!(m.seen.lock().unwrap().len(), 1);
        let grant = load(&f.ctx, &r).unwrap().unwrap();
        assert_eq!(grant.refresh.as_deref(), Some("fixture-rotated-refresh"));
        let mut reopened = Ctx::new(
            f.ctx.data_dir.clone(),
            f.ctx.config_dir.clone(),
            f.ctx.keys.clone(),
        );
        reopened.db = crate::db::Database::from_pool(f.ctx.db.pool().unwrap());
        assert_eq!(
            account_status(&reopened, r.id.clone()).await.unwrap().state,
            "connected"
        );
        assert!(reopened.accounts.flows.lock().await.is_empty());
        disconnect(&reopened, r.id.clone()).await.unwrap();
        assert!(
            access_using(&f.ctx, &r.id, Some(&m.endpoints))
                .await
                .is_err()
        );
        assert_eq!(m.seen.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn unsuccessful_identity_or_scopes_never_install_a_token() {
        for (kind, mut response, identity_response) in [
            (
                Kind::Microsoft,
                token(Kind::Microsoft),
                json!({"error":"tenant_refused","echo":"fixture-access-private"}),
            ),
            (
                Kind::Github,
                token(Kind::Github),
                json!({"id":42,"login":"fixture-owner"}),
            ),
        ] {
            let f = fixture(kind).await;
            let r = config(kind);
            if kind == Kind::Github {
                response["scope"] = json!("repo");
            }
            let m = mock(vec![device(kind), response, identity_response]).await;
            let flow = begin_using(&f.ctx, r.id.clone(), Some(&m.endpoints))
                .await
                .unwrap()
                .flow_id
                .unwrap();
            ready(&f.ctx, &r.id).await;
            let error = poll_using(&f.ctx, r.id.clone(), flow, Some(&m.endpoints))
                .await
                .unwrap_err();
            assert!(!error.contains("fixture-access-private"));
            assert!(load(&f.ctx, &r).unwrap().is_none());
            assert!(f.ctx.accounts.flows.lock().await.is_empty());
        }
    }
    #[tokio::test]
    async fn a_different_account_cannot_inherit_project_enablement() {
        let f = fixture(Kind::Github).await;
        let r = config(Kind::Github);
        let m = mock(vec![
            device(Kind::Github),
            token(Kind::Github),
            json!({"id":42,"login":"first"}),
            device(Kind::Github),
            token(Kind::Github),
            json!({"id":42,"login":"first"}),
            device(Kind::Github),
            token(Kind::Github),
            json!({"id":43,"login":"second"}),
        ])
        .await;
        for (index, principal) in [42, 42, 43].into_iter().enumerate() {
            let flow = begin_using(&f.ctx, r.id.clone(), Some(&m.endpoints))
                .await
                .unwrap()
                .flow_id
                .unwrap();
            ready(&f.ctx, &r.id).await;
            let done = poll_using(&f.ctx, r.id.clone(), flow, Some(&m.endpoints))
                .await
                .unwrap();
            assert_eq!(done.identity, Some(principal.to_string()));
            let links: i64 =
                sqlx::query_scalar("SELECT count(*) FROM project_mcp_servers WHERE server_id=?")
                    .bind(&r.id)
                    .fetch_one(&f.ctx.db.pool().unwrap())
                    .await
                    .unwrap();
            assert_eq!(links, if index == 1 { 1 } else { 0 });
            if index == 0 {
                sqlx::query("INSERT INTO projects(id,workspace_id,user_id,name,created_at,updated_at) VALUES('fixture-project',?,?,'Test project',1,1)").bind(&r.workspace_id).bind(&r.user_id).execute(&f.ctx.db.pool().unwrap()).await.unwrap();
                sqlx::query("INSERT INTO project_mcp_servers(id,workspace_id,user_id,project_id,server_id,created_at) VALUES('fixture-link',?,?,'fixture-project',?,1)").bind(&r.workspace_id).bind(&r.user_id).bind(&r.id).execute(&f.ctx.db.pool().unwrap()).await.unwrap();
            }
        }
    }
}
