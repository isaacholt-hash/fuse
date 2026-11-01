//! What every command runs with (M10 step 2): the app's folders and the state that lives as
//! long as the app does. The desktop builds one at start from Tauri's paths; fuse-server will
//! build its own. Command bodies take a `Ctx` and send stream messages to an `EventSink`, so
//! they run the same with or without Tauri.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::db::Database;
use crate::exec::Execs;
use crate::keys::Keys;
use crate::local::Local;
use crate::mcp::McpServers;
use crate::model_files::Downloads;
use crate::preview::Previews;
use crate::python_runtime::PyInstall;
use crate::transport::Transport;

pub struct Ctx {
    /// The app's data folder: attachments, the Python runtime, models, MCP servers' folders.
    pub data_dir: PathBuf,
    /// The app's config folder: the database and its backups.
    pub config_dir: PathBuf,
    pub db: Database,
    pub keys: Keys,
    pub transport: Transport,
    pub execs: Execs,
    pub previews: Previews,
    pub local: Local,
    pub downloads: Downloads,
    pub python: PyInstall,
    pub mcp: McpServers,
}

impl Ctx {
    pub fn new(data_dir: PathBuf, config_dir: PathBuf, keys: Keys) -> Self {
        Ctx {
            data_dir,
            config_dir,
            db: Database::default(),
            keys,
            transport: Transport::default(),
            execs: Execs::default(),
            previews: Previews::default(),
            local: Local::default(),
            downloads: Downloads::default(),
            python: PyInstall::default(),
            mcp: McpServers::default(),
        }
    }
}

/// Where a command's stream messages go: a Tauri channel on the desktop, a WebSocket on the
/// server. An error means nobody is listening any more (the window or the socket went away).
pub trait EventSink<T>: Send + Sync {
    fn send(&self, msg: T) -> Result<(), String>;
}

pub type Sink<T> = Arc<dyn EventSink<T>>;

impl<T: serde::Serialize + Send + Sync> EventSink<T> for tauri::ipc::Channel<T> {
    fn send(&self, msg: T) -> Result<(), String> {
        tauri::ipc::Channel::send(self, msg).map_err(|e| e.to_string())
    }
}

/// A Tauri channel as a sink, for the command wrappers.
pub fn channel_sink<T: serde::Serialize + Send + Sync + 'static>(
    channel: tauri::ipc::Channel<T>,
) -> Sink<T> {
    Arc::new(channel)
}

/// A raw-bytes request's body and headers (names lowercase), for the command wrappers.
pub fn request_parts(
    request: &tauri::ipc::Request<'_>,
) -> Result<(Vec<u8>, HashMap<String, String>), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let headers = request
        .headers()
        .iter()
        .filter_map(|(n, v)| Some((n.as_str().to_ascii_lowercase(), v.to_str().ok()?.to_owned())))
        .collect();
    Ok((bytes.clone(), headers))
}
