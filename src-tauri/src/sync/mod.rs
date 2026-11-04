//! Opt-in native sync. HULK is a trusted participant, not a blind relay.
pub mod crypto;
pub mod merge;
pub mod transport;
pub mod worker;

use crate::{ctx::Ctx, db, keys::SecretStore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;
use zeroize::{Zeroize, Zeroizing};

const META: &str = "sync:metadata";
const SIGNING: &str = "sync:signing";
const RECOVERY: &str = "sync:recovery";
pub const WORKSPACE: &str = "00000000-0000-7000-8000-000000000001";
pub const USER: &str = "00000000-0000-7000-8000-000000000002";

#[derive(Clone)]
pub struct Sync {
    pub host: bool,
    pub administration: std::sync::Arc<tokio::sync::Mutex<()>>,
    pub client: reqwest::Client,
    pub started: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub wake: std::sync::Arc<tokio::sync::Notify>,
    pub force: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl Default for Sync {
    fn default() -> Self {
        Self {
            host: false,
            administration: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            started: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            wake: std::sync::Arc::new(tokio::sync::Notify::new()),
            force: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("sync HTTP client"),
        }
    }
}

fn fail(error: sqlx::Error) -> String {
    format!("Couldn't update sync's database: {error}")
}

pub fn registry() -> &'static Value {
    static REGISTRY: OnceLock<Value> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        serde_json::from_str(include_str!("../../../data/sync.json"))
            .expect("bundled replication registry")
    })
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|t| t.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    dataset_id: String,
    epoch: u64,
}

/// Only native authenticated enrollment serializes this. Never return it from a UI command.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeySet {
    pub dataset_id: String,
    pub epoch: u64,
    pub epochs: BTreeMap<u64, String>,
}
impl Drop for KeySet {
    fn drop(&mut self) {
        for key in self.epochs.values_mut() {
            key.zeroize();
        }
    }
}

pub fn load_keys(store: &dyn SecretStore) -> Result<Option<KeySet>, String> {
    let Some(metadata) = store.get(META)? else {
        return Ok(None);
    };
    let meta: Metadata =
        serde_json::from_str(&metadata).map_err(|_| "Sync metadata is damaged. Recover sync.")?;
    if meta.dataset_id.len() != 64 || meta.epoch == 0 || meta.epoch > 1024 {
        return Err("Sync metadata is damaged. Recover sync.".into());
    }
    let mut keys = KeySet {
        dataset_id: meta.dataset_id,
        epoch: meta.epoch,
        epochs: BTreeMap::new(),
    };
    for epoch in 1..=meta.epoch {
        let value = store
            .get(&format!("sync:epoch:{epoch}"))?
            .ok_or("A sync key is missing. Recover sync.")?;
        crypto::key(&value)?;
        keys.epochs.insert(epoch, value);
    }
    Ok(Some(keys))
}

fn save_keys(store: &dyn SecretStore, keys: &KeySet) -> Result<(), String> {
    if keys.dataset_id.len() != 64
        || keys.epochs.is_empty()
        || !keys.epochs.contains_key(&keys.epoch)
        || keys.epoch > 1024
        || keys.epochs.len() != keys.epoch as usize
        || keys.epoch == 0
    {
        return Err("HULK returned invalid sync keys. Nothing was enrolled.".into());
    }
    crypto::decode(&keys.dataset_id, 32)?;
    // Validate the entire response before touching a secret-store entry.
    for (epoch, key) in &keys.epochs {
        if *epoch == 0 || *epoch > keys.epoch {
            return Err("HULK returned an invalid sync epoch.".into());
        }
        crypto::key(key)?;
    }
    for (epoch, key) in &keys.epochs {
        crypto::key(key)?;
        let account = format!("sync:epoch:{epoch}");
        store.set(&account, key)?;
        if store.get(&account)?.as_deref() != Some(key) {
            return Err("The secret store didn't keep a sync key. Sync wasn't enabled.".into());
        }
    }
    store.set(
        META,
        &serde_json::to_string(&Metadata {
            dataset_id: keys.dataset_id.clone(),
            epoch: keys.epoch,
        })
        .map_err(|_| "Couldn't encode sync metadata.")?,
    )
}

fn signing(store: &dyn SecretStore) -> Result<Zeroizing<String>, String> {
    if let Some(key) = store.get(SIGNING)? {
        crypto::key(&key)?;
        return Ok(Zeroizing::new(key));
    }
    let key = Zeroizing::new(crypto::hex(&crypto::random::<32>()?));
    store.set(SIGNING, &key)?;
    if store.get(SIGNING)?.as_deref() != Some(key.as_str()) {
        return Err("The secret store didn't keep this device's identity.".into());
    }
    Ok(key)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub public_key: String,
    pub revoked_at: Option<i64>,
    pub auth_id: Option<String>,
}

pub async fn devices(ctx: &Ctx) -> Result<Vec<Device>, String> {
    db::select(&ctx.db.pool()?,"SELECT id,name,public_key AS publicKey,revoked_at AS revokedAt,auth_id AS authId FROM sync_devices WHERE workspace_id=? ORDER BY created_at,id",&[json!(WORKSPACE)]).await?
        .into_iter().map(|r|serde_json::from_value(Value::Object(r)).map_err(|_|"Sync device metadata is damaged.".into())).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub host: bool,
    pub enabled: bool,
    pub paused: bool,
    pub device_id: String,
    pub epoch: i64,
    pub pending: i64,
    pub last_success_at: Option<i64>,
    pub error: Option<String>,
    pub devices: Vec<Device>,
}

pub async fn status(ctx: &Ctx) -> Result<Status, String> {
    db::db_open(ctx).await?;
    let pool = ctx.db.pool()?;
    let state=sqlx::query("SELECT *, (SELECT COUNT(*) FROM sync_outbox WHERE workspace_id=sync_state.workspace_id) AS pending FROM sync_state WHERE workspace_id=? AND user_id=?")
        .bind(WORKSPACE).bind(USER).fetch_one(&pool).await.map_err(fail)?;
    Ok(Status {
        host: ctx.sync.host,
        enabled: state.get::<i64, _>("enabled") == 1,
        paused: state.get::<i64, _>("paused") == 1,
        device_id: state.get("device_id"),
        epoch: state.get("epoch"),
        pending: state.get("pending"),
        last_success_at: state.get("last_success_at"),
        error: state.get("error"),
        devices: devices(ctx).await?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Count {
    pub table: String,
    pub records: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub counts: Vec<Count>,
    pub file_bytes: i64,
}

pub async fn preview(ctx: &Ctx) -> Result<Preview, String> {
    db::db_open(ctx).await?;
    let pool = ctx.db.pool()?;
    let tables = registry()["tables"]
        .as_object()
        .ok_or("Invalid replication registry.")?;
    let mut counts = Vec::new();
    let mut file_bytes = 0;
    for (table, spec) in tables {
        let condition = format!(
            "({}) AND ({})",
            spec["eligible"]
                .as_str()
                .ok_or("Invalid replication registry.")?
                .replace("{a}", "r"),
            spec["ready"]
                .as_str()
                .ok_or("Invalid replication registry.")?
                .replace("{a}", "r")
        );
        let records: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*) FROM {table} r WHERE r.workspace_id=? AND r.user_id=? AND {condition}"
        ))
        .bind(WORKSPACE)
        .bind(USER)
        .fetch_one(&pool)
        .await
        .map_err(fail)?;
        if table == "files" {
            file_bytes=sqlx::query_scalar(&format!("SELECT COALESCE(SUM(size_bytes),0) FROM files r WHERE r.workspace_id=? AND r.user_id=? AND {condition}"))
            .bind(WORKSPACE).bind(USER).fetch_one(&pool).await.map_err(fail)?;
        }
        counts.push(Count {
            table: table.clone(),
            records,
        });
    }
    Ok(Preview { counts, file_bytes })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryContents {
    keys: KeySet,
    devices: Vec<Device>,
    identity: IdentityBackup,
    device_id: String,
}

#[derive(Serialize, Deserialize)]
struct IdentityBackup {
    seed: String,
}
impl Drop for IdentityBackup {
    fn drop(&mut self) {
        self.seed.zeroize();
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryBundle {
    public_key: String,
    envelope: crypto::Envelope,
}

fn write_bundle(path: &Path, bundle: &RecoveryBundle) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|_| "Couldn't create sync's storage folder.")?;
    let target = path.join("recovery.json");
    let temp = path.join("recovery.json.tmp");
    let bytes = serde_json::to_vec(bundle).map_err(|_| "Couldn't encode sync recovery data.")?;
    std::fs::write(&temp, bytes).map_err(|_| "Couldn't write sync recovery data.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Couldn't protect sync recovery data.")?;
    }
    std::fs::rename(temp, target).map_err(|_| "Couldn't save sync recovery data.".into())
}

pub async fn save_recovery(ctx: &Ctx) -> Result<(), String> {
    let keys = load_keys(ctx.keys.store.as_ref())?.ok_or("Set up sync on HULK first.")?;
    let recovery = Zeroizing::new(
        ctx.keys
            .store
            .get(RECOVERY)?
            .ok_or("Sync's recovery key is missing. Recover sync.")?,
    );
    let identity = signing(ctx.keys.store.as_ref())?;
    let device_id = status(ctx).await?.device_id;
    let header = crypto::Header {
        protocol: crypto::PROTOCOL,
        schema: db::schema_version(),
        workspace_id: WORKSPACE.into(),
        user_id: USER.into(),
        dataset_id: keys.dataset_id.clone(),
        epoch: keys.epoch,
        device_id: device_id.clone(),
        event_id: format!("recovery:{}", keys.epoch),
        seq: 0,
        clock: 0,
    };
    let body = Zeroizing::new(
        serde_json::to_vec(&RecoveryContents {
            keys,
            devices: devices(ctx).await?,
            identity: IdentityBackup {
                seed: identity.to_string(),
            },
            device_id,
        })
        .map_err(|_| "Couldn't encode sync recovery data.")?,
    );
    let bundle = RecoveryBundle {
        public_key: crypto::public(&identity)?,
        envelope: crypto::seal(header, &body, &recovery, &identity)?,
    };
    write_bundle(&ctx.data_dir.join("sync"), &bundle)
}

pub async fn setup(ctx: &Ctx, confirmed: bool) -> Result<Status, String> {
    if !ctx.sync.host {
        return Err("Set up sync in HULK's web Settings, then enroll this desktop.".into());
    }
    if !confirmed {
        return Err("Review the sync preview and explicitly enable sync first.".into());
    }
    let _lock = ctx.sync.administration.lock().await;
    db::db_open(ctx).await?;
    if load_keys(ctx.keys.store.as_ref())?.is_none() {
        let epoch = crypto::hex(&crypto::random::<32>()?);
        let keys = KeySet {
            dataset_id: crypto::hex(&crypto::random::<32>()?),
            epoch: 1,
            epochs: BTreeMap::from([(1, epoch)]),
        };
        save_keys(ctx.keys.store.as_ref(), &keys)?;
    }
    if ctx.keys.store.get(RECOVERY)?.is_none() {
        let recovery = Zeroizing::new(crypto::hex(&crypto::random::<32>()?));
        ctx.keys.store.set(RECOVERY, &recovery)?;
    }
    let identity = signing(ctx.keys.store.as_ref())?;
    let status = status(ctx).await?;
    let keys = load_keys(ctx.keys.store.as_ref())?.ok_or("Sync keys weren't saved.")?;
    let epoch = keys.epoch as i64;
    let public = crypto::public(&identity)?;
    let stamp = now();
    db::batch(&ctx.db.pool()?,&[
        db::Statement {sql:"INSERT INTO sync_devices (id,workspace_id,user_id,name,public_key,created_at,updated_at) VALUES (?,?,?,'HULK',?,?,?) ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key,updated_at=excluded.updated_at".into(),params:vec![json!(status.device_id),json!(WORKSPACE),json!(USER),json!(public),json!(stamp),json!(stamp)]},
    ]).await?;
    save_recovery(ctx).await?;
    db::execute(
        &ctx.db.pool()?,
        "UPDATE sync_state SET enabled=1,paused=0,epoch=?,error=NULL WHERE workspace_id=?",
        &[json!(epoch), json!(WORKSPACE)],
    )
    .await?;
    self::status(ctx).await
}

/// Explicitly displayed in Settings, like the separate database recovery key. Never in status.
pub fn recovery_code(ctx: &Ctx) -> Result<String, String> {
    if !ctx.sync.host {
        return Err("Manage the sync recovery code in HULK's Settings.".into());
    }
    let value = Zeroizing::new(
        ctx.keys
            .store
            .get(RECOVERY)?
            .ok_or("Set up sync on HULK first.")?,
    );
    Ok(value
        .as_bytes()
        .chunks(8)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join("-"))
}

pub async fn recover(ctx: &Ctx, code: String) -> Result<Status, String> {
    if !ctx.sync.host {
        return Err(
            "Recover the sync workspace in HULK's web Settings, then enroll this desktop.".into(),
        );
    }
    let _lock = ctx.sync.administration.lock().await;
    db::db_open(ctx).await?;
    let code = Zeroizing::new(code);
    let clean = Zeroizing::new(
        code.chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .collect::<String>()
            .to_ascii_lowercase(),
    );
    crypto::key(&clean)?;
    let path = ctx.data_dir.join("sync/recovery.json");
    if std::fs::metadata(&path)
        .map_err(|_| "Sync's recovery bundle is missing. Restore the encrypted sync store first.")?
        .len()
        > crypto::MAX_PACKET_BYTES as u64 * 3
    {
        return Err("Sync's recovery bundle is too large.".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Couldn't read sync's recovery bundle.")?;
    let bundle: RecoveryBundle =
        serde_json::from_slice(&bytes).map_err(|_| "Sync's recovery bundle is damaged.")?;
    let h = &bundle.envelope.header;
    if h.workspace_id != WORKSPACE
        || h.user_id != USER
        || h.schema > db::schema_version()
        || h.event_id != format!("recovery:{}", h.epoch)
    {
        return Err("This recovery bundle belongs to a different workspace or newer FUSE.".into());
    }
    let plaintext = crypto::open(&bundle.envelope, h, &clean, &bundle.public_key)?;
    let contents: RecoveryContents =
        serde_json::from_slice(&plaintext).map_err(|_| "Sync's recovery bundle is damaged.")?;
    if contents.keys.dataset_id != h.dataset_id || contents.keys.epoch != h.epoch {
        return Err("Sync's recovery bundle doesn't match its metadata.".into());
    }
    if let Some(metadata) = ctx.keys.store.get(META)?
        && let Ok(old) = serde_json::from_str::<Metadata>(&metadata)
        && old.dataset_id != contents.keys.dataset_id
    {
        return Err("This recovery bundle belongs to another sync workspace.".into());
    }
    if contents.device_id != h.device_id
        || !contents.devices.iter().any(|d| {
            d.id == contents.device_id
                && crypto::public(&contents.identity.seed).ok().as_deref()
                    == Some(d.public_key.as_str())
        })
    {
        return Err("Sync's recovery identity doesn't match its device registry.".into());
    }
    for device in &contents.devices {
        crypto::verifying(&device.public_key)?;
    }
    let pool = ctx.db.pool()?;
    db::execute(&pool,"UPDATE sync_state SET paused=1,error='Sync recovery did not finish. Retry recovery before syncing.' WHERE workspace_id=?",&[json!(WORKSPACE)]).await?;
    save_keys(ctx.keys.store.as_ref(), &contents.keys)?;
    ctx.keys.store.set(RECOVERY, &clean)?;
    ctx.keys.store.set(SIGNING, &contents.identity.seed)?;
    let stamp = now();
    let mut statements = Vec::new();
    for device in contents.devices {
        statements.push(db::Statement {sql:"INSERT INTO sync_devices (id,workspace_id,user_id,name,public_key,auth_id,revoked_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key,auth_id=excluded.auth_id,revoked_at=excluded.revoked_at".into(),params:vec![json!(device.id),json!(WORKSPACE),json!(USER),json!(device.name),json!(device.public_key),json!(device.auth_id),json!(device.revoked_at),json!(stamp),json!(stamp)]});
    }
    statements.push(db::Statement {sql:"UPDATE sync_state SET enabled=1,paused=0,epoch=?,device_id=?,error=NULL WHERE workspace_id=?".into(),params:vec![json!(contents.keys.epoch),json!(contents.device_id),json!(WORKSPACE)]});
    db::batch(&pool, &statements).await?;
    status(ctx).await
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Enrollment {
    pub protocol: u32,
    pub schema: i64,
    pub device_id: String,
    pub name: String,
    pub public_key: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Enrolled {
    pub protocol: u32,
    pub schema: i64,
    pub keys: KeySet,
    pub devices: Vec<Device>,
}

/// Called only by the bearer-authenticated native route, not the web command dispatcher.
#[cfg_attr(not(all(feature = "server", target_os = "linux")), allow(dead_code))]
pub async fn accept(ctx: &Ctx, auth_id: &str, request: Enrollment) -> Result<Enrolled, String> {
    if !ctx.sync.host {
        return Err("Only HULK can enroll sync participants.".into());
    }
    let _lock = ctx.sync.administration.lock().await;
    if request.protocol != crypto::PROTOCOL || request.schema != db::schema_version() {
        return Err(
            "FUSE versions differ. Update this app and redeploy HULK before enabling sync.".into(),
        );
    }
    if request.device_id.is_empty()
        || request.device_id.len() > 64
        || !request
            .device_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid sync device identity.".into());
    }
    crypto::verifying(&request.public_key)?;
    let state = status(ctx).await?;
    if !state.enabled || state.paused {
        return Err("Enable sync in HULK's Settings first.".into());
    }
    if request.device_id == state.device_id {
        return Err("A copied installation needs a new device identity before enrolling.".into());
    }
    let existing = db::select(
        &ctx.db.pool()?,
        "SELECT public_key,auth_id,revoked_at FROM sync_devices WHERE id=?",
        &[json!(request.device_id)],
    )
    .await?;
    if let Some(row) = existing.first()
        && (row.get("revoked_at") != Some(&Value::Null)
            || row.get("public_key") != Some(&json!(request.public_key))
            || row.get("auth_id") != Some(&json!(auth_id)))
    {
        return Err("This device's identity changed or was revoked. Pair a fresh installation before enrolling.".into());
    }
    let stamp = now();
    db::execute(&ctx.db.pool()?,"INSERT INTO sync_devices (id,workspace_id,user_id,name,auth_id,public_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at",&[json!(request.device_id),json!(WORKSPACE),json!(USER),json!(request.name.chars().take(60).collect::<String>()),json!(auth_id),json!(request.public_key),json!(stamp),json!(stamp)]).await?;
    save_recovery(ctx).await?;
    Ok(Enrolled {
        protocol: crypto::PROTOCOL,
        schema: db::schema_version(),
        keys: load_keys(ctx.keys.store.as_ref())?
            .ok_or("Sync's keys are missing. Recover sync.")?,
        devices: devices(ctx).await?,
    })
}

pub async fn enroll(ctx: &Ctx, name: String, confirmed: bool) -> Result<Status, String> {
    if ctx.sync.host {
        return Err(
            "This browser already uses HULK's database. Enroll desktops separately.".into(),
        );
    }
    if !confirmed {
        return Err("Review the sync preview and explicitly enroll this desktop first.".into());
    }
    let _lock = ctx.sync.administration.lock().await;
    db::db_open(ctx).await?;
    let (address, token) = crate::hulk::paired(ctx)?;
    let state = status(ctx).await?;
    let identity = signing(ctx.keys.store.as_ref())?;
    let request = Enrollment {
        protocol: crypto::PROTOCOL,
        schema: db::schema_version(),
        device_id: state.device_id.clone(),
        name,
        public_key: crypto::public(&identity)?,
    };
    let mut response = ctx
        .sync
        .client
        .post(format!("{address}/api/sync/enroll"))
        .bearer_auth(&token)
        .timeout(std::time::Duration::from_secs(30))
        .json(&request)
        .send()
        .await
        .map_err(|_| "Couldn't reach HULK. This desktop wasn't enrolled.")?;
    if !response.status().is_success() {
        return Err("HULK refused sync enrollment. Check pairing, enable sync on HULK, and use matching FUSE versions.".into());
    }
    if response.content_length().is_some_and(|n| n > 1024 * 1024) {
        return Err("HULK's sync enrollment reply is too large.".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Couldn't read HULK's enrollment reply.")?
    {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("HULK's sync enrollment reply is too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let response: Enrolled = serde_json::from_slice(&bytes)
        .map_err(|_| "HULK's sync enrollment reply wasn't readable.")?;
    if response.protocol != crypto::PROTOCOL || response.schema != db::schema_version() {
        return Err("FUSE versions differ. Update this app and redeploy HULK.".into());
    }
    if let Some(old) = load_keys(ctx.keys.store.as_ref())? {
        if old.dataset_id != response.keys.dataset_id {
            return Err("HULK has a different sync workspace. Local history was preserved; sync wasn't changed.".into());
        }
        if old.epoch > response.keys.epoch
            || old
                .epochs
                .iter()
                .any(|(epoch, key)| response.keys.epochs.get(epoch) != Some(key))
        {
            return Err("HULK's sync keys are older or inconsistent. Recover HULK before syncing; local edits were preserved.".into());
        }
    }
    if !response.devices.iter().any(|d| {
        d.id == state.device_id && d.public_key == request.public_key && d.revoked_at.is_none()
    }) {
        return Err("HULK didn't confirm this device's identity.".into());
    }
    for device in &response.devices {
        crypto::verifying(&device.public_key)?;
    }
    save_keys(ctx.keys.store.as_ref(), &response.keys)?;
    let stamp = now();
    let mut statements = Vec::new();
    for device in response.devices {
        statements.push(db::Statement {sql:"INSERT INTO sync_devices (id,workspace_id,user_id,name,public_key,revoked_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key,revoked_at=excluded.revoked_at,name=excluded.name".into(),params:vec![json!(device.id),json!(WORKSPACE),json!(USER),json!(device.name),json!(device.public_key),json!(device.revoked_at),json!(stamp),json!(stamp)]});
    }
    statements.push(db::Statement {
        sql: "UPDATE sync_state SET enabled=1,paused=0,epoch=?,error=NULL WHERE workspace_id=?"
            .into(),
        params: vec![json!(response.keys.epoch), json!(WORKSPACE)],
    });
    db::batch(&ctx.db.pool()?, &statements).await?;
    status(ctx).await
}

pub mod commands {
    use super::*;
    use tauri::State;
    #[tauri::command]
    pub async fn sync_resolve(
        ctx: State<'_, Ctx>,
        id: String,
        choice: String,
    ) -> Result<(), String> {
        merge::resolve(&ctx, id, choice).await
    }
    #[tauri::command]
    pub async fn sync_pause(ctx: State<'_, Ctx>, paused: bool) -> Result<Status, String> {
        worker::pause(&ctx, paused).await
    }
    #[tauri::command]
    pub async fn sync_now(ctx: State<'_, Ctx>) -> Result<Status, String> {
        worker::now(&ctx).await
    }
    #[tauri::command]
    pub async fn sync_status(ctx: State<'_, Ctx>) -> Result<Status, String> {
        status(&ctx).await
    }
    #[tauri::command]
    pub async fn sync_preview(ctx: State<'_, Ctx>) -> Result<Preview, String> {
        preview(&ctx).await
    }
    #[tauri::command]
    pub async fn sync_setup(ctx: State<'_, Ctx>, confirmed: bool) -> Result<Status, String> {
        setup(&ctx, confirmed).await
    }
    #[tauri::command]
    pub async fn sync_enroll(
        ctx: State<'_, Ctx>,
        name: String,
        confirmed: bool,
    ) -> Result<Status, String> {
        enroll(&ctx, name, confirmed).await
    }
    #[tauri::command]
    pub fn sync_recovery_code(ctx: State<'_, Ctx>) -> Result<String, String> {
        recovery_code(&ctx)
    }
    #[tauri::command]
    pub async fn sync_recover(ctx: State<'_, Ctx>, code: String) -> Result<Status, String> {
        recover(&ctx, code).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{Keys, MemoryStore};

    pub(crate) fn fixture(host: bool) -> Ctx {
        let root = std::env::temp_dir().join(format!(
            "fuse-sync-fixture-{}-{}",
            std::process::id(),
            crypto::hex(&crypto::random::<8>().unwrap())
        ));
        let mut ctx = Ctx::new(
            root.join("data"),
            root.join("config"),
            Keys::with_store(Box::new(MemoryStore::default())),
        );
        ctx.sync.host = host;
        ctx
    }
    pub(crate) async fn cleanup(ctx: &Ctx) {
        ctx.db.pool().unwrap().close().await;
        std::fs::remove_dir_all(ctx.config_dir.parent().unwrap()).unwrap();
    }
    #[tokio::test]
    async fn explicit_opt_in_is_required_and_ui_status_never_exposes_keys() {
        let host = fixture(true);
        assert!(!status(&host).await.unwrap().enabled);
        assert!(host.keys.store.get(META).unwrap().is_none());
        assert!(host.keys.store.get(SIGNING).unwrap().is_none());
        assert!(setup(&host, false).await.is_err());
        let status = setup(&host, true).await.unwrap();
        assert!(status.enabled);
        assert_eq!(status.devices.len(), 1);
        let public_reply = serde_json::to_string(&status).unwrap();
        for account in [SIGNING, RECOVERY, "sync:epoch:1"] {
            let secret = Zeroizing::new(host.keys.store.get(account).unwrap().unwrap());
            assert!(!public_reply.contains(secret.as_str()));
            assert!(
                !std::fs::read_to_string(host.data_dir.join("sync/recovery.json"))
                    .unwrap()
                    .contains(secret.as_str())
            );
        }
        let desktop = fixture(false);
        assert!(setup(&desktop, true).await.is_err());
        assert!(enroll(&desktop, "Fixture".into(), false).await.is_err());
        assert!(host.keys.store.get(META).unwrap().is_some());
        cleanup(&host).await;
    }
    #[tokio::test]
    async fn recovery_restores_encryption_and_signing_identity_after_sync_secrets_are_lost() {
        let host = fixture(true);
        let initial = setup(&host, true).await.unwrap();
        let code = Zeroizing::new(recovery_code(&host).unwrap());
        let dataset = load_keys(host.keys.store.as_ref())
            .unwrap()
            .unwrap()
            .dataset_id
            .clone();
        let public = initial.devices[0].public_key.clone();
        for account in [META, RECOVERY, SIGNING, "sync:epoch:1"] {
            host.keys.store.delete(account).unwrap();
        }
        db::execute(
            &host.db.pool().unwrap(),
            "UPDATE sync_state SET enabled=0,paused=1",
            &[],
        )
        .await
        .unwrap();
        assert!(recover(&host, "00".repeat(32)).await.is_err());
        assert!(host.keys.store.get(META).unwrap().is_none());
        let restored = recover(&host, code.to_string()).await.unwrap();
        assert!(restored.enabled);
        assert_eq!(restored.device_id, initial.device_id);
        assert_eq!(
            load_keys(host.keys.store.as_ref())
                .unwrap()
                .unwrap()
                .dataset_id,
            dataset
        );
        assert_eq!(
            crypto::public(&signing(host.keys.store.as_ref()).unwrap()).unwrap(),
            public
        );
        cleanup(&host).await;
    }
    #[tokio::test]
    async fn native_enrollment_requires_matching_versions_and_stable_unrevoked_identity() {
        let host = fixture(true);
        setup(&host, true).await.unwrap();
        let identity = Zeroizing::new(crypto::hex(&crypto::random::<32>().unwrap()));
        let request = || Enrollment {
            protocol: crypto::PROTOCOL,
            schema: db::schema_version(),
            device_id: "fixture-native".into(),
            name: "Fixture desktop".into(),
            public_key: crypto::public(&identity).unwrap(),
        };
        let mut mismatch = request();
        mismatch.schema -= 1;
        assert!(accept(&host, "fixture-auth", mismatch).await.is_err());
        let enrolled = accept(&host, "fixture-auth", request()).await.unwrap();
        assert_eq!(enrolled.devices.len(), 2);
        assert!(accept(&host, "other-auth", request()).await.is_err());
        db::execute(
            &host.db.pool().unwrap(),
            "UPDATE sync_devices SET revoked_at=1 WHERE id='fixture-native'",
            &[],
        )
        .await
        .unwrap();
        assert!(accept(&host, "fixture-auth", request()).await.is_err());
        let recovered_file =
            std::fs::read_to_string(host.data_dir.join("sync/recovery.json")).unwrap();
        assert!(!recovered_file.contains(identity.as_str()));
        cleanup(&host).await;
    }
}
