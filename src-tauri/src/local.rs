//! The app's side of the local model (M7 step 4, LL-02): starts the worker (src/local_worker.rs)
//! as a child process, loads the model file, and streams one answer at a time. A time limit, a
//! Stop, or the worker dying (out of memory, a crash) ends the request with a clear error and
//! leaves the app running; the next request starts a fresh worker.

use crate::local_worker::{Event, Request, Turn, WORKER_FLAG};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

/// Loading a model reads ~2 GB from disk; allow for a slow one.
const LOAD_TIMEOUT: Duration = Duration::from_secs(180);
/// After a cancel, how long the worker has to finish before it's ended.
const CANCEL_GRACE: Duration = Duration::from_secs(3);
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
pub const N_CTX: u32 = 4096;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LocalMsg {
    Text {
        text: String,
    },
    Done {
        input_tokens: u32,
        output_tokens: u32,
        stop: String,
    },
}

struct Worker {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    lines: Lines<BufReader<ChildStdout>>,
    loaded: Option<PathBuf>,
}

/// How the worker is started: FUSE's own executable in the app, a script in tests.
#[derive(Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl Launch {
    pub fn this_app() -> Result<Self, String> {
        Ok(Self {
            program: std::env::current_exe().map_err(|e| e.to_string())?,
            args: vec![WORKER_FLAG.into()],
        })
    }
}

pub struct Local {
    worker: Mutex<Option<Worker>>,
    /// The request under way and the worker's stdin, so Stop can reach it mid-answer.
    current: std::sync::Mutex<Option<(String, Arc<Mutex<ChildStdin>>)>>,
    next_id: AtomicU64,
}

impl Default for Local {
    fn default() -> Self {
        Self {
            worker: Mutex::new(None),
            current: std::sync::Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }
}

/// Threads for llama.cpp: half the logical CPUs (about the physical cores), 1 to 8.
pub fn threads() -> i32 {
    let n = std::thread::available_parallelism().map_or(2, |n| n.get());
    i32::try_from((n / 2).clamp(1, 8)).unwrap_or(1)
}

fn spawn(launch: &Launch) -> Result<Worker, String> {
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args)
        // No inherited environment: the worker never sees a provider key or anything else.
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // Windows needs these to load system libraries; nothing else is passed.
        for key in ["SystemRoot", "windir", "TEMP", "TMP"] {
            if let Ok(v) = std::env::var(key) {
                cmd.env(key, v);
            }
        }
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start the local model: {e}"))?;
    let stdin = child.stdin.take().ok_or("The local model has no input.")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("The local model has no output.")?;
    Ok(Worker {
        child,
        stdin: Arc::new(Mutex::new(stdin)),
        lines: BufReader::new(stdout).lines(),
        loaded: None,
    })
}

async fn write(stdin: &Mutex<ChildStdin>, req: &Request) -> Result<(), String> {
    let line = serde_json::to_string(req).map_err(|e| e.to_string())? + "\n";
    let mut w = stdin.lock().await;
    w.write_all(line.as_bytes())
        .await
        .and(w.flush().await)
        .map_err(|_| STOPPED.to_string())
}

const STOPPED: &str = "The local model stopped unexpectedly (it may have run out of memory). FUSE is fine; it will start it again next time.";

/// Reads the worker's next event; None when it has exited or sent something unreadable.
async fn next(w: &mut Worker) -> Option<Event> {
    match w.lines.next_line().await {
        Ok(Some(line)) => serde_json::from_str(&line).ok(),
        _ => None,
    }
}

impl Local {
    /// One answer from the model in `path`, streamed to `emit`. Requests run one at a time.
    #[allow(clippy::too_many_arguments)]
    pub async fn generate(
        &self,
        launch: &Launch,
        path: &Path,
        system: String,
        messages: Vec<Turn>,
        max_tokens: u32,
        timeout: Duration,
        mut emit: impl FnMut(LocalMsg),
    ) -> Result<(), String> {
        let mut guard = self.worker.lock().await;
        // A worker that exited (crashed, or ended after a time limit) is replaced.
        if let Some(w) = guard.as_mut()
            && !matches!(w.child.try_wait(), Ok(None))
        {
            *guard = None;
        }
        if guard.is_none() {
            *guard = Some(spawn(launch)?);
        }
        let w = guard.as_mut().ok_or(STOPPED)?;
        if w.loaded.as_deref() != Some(path) {
            w.loaded = None;
            let load = Request::Load {
                path: path.to_string_lossy().into_owned(),
                n_ctx: N_CTX,
                threads: threads(),
            };
            if let Err(e) = write(&w.stdin, &load).await {
                *guard = None;
                return Err(e);
            }
            match tokio::time::timeout(LOAD_TIMEOUT, next(w)).await {
                Ok(Some(Event::Loaded { .. })) => w.loaded = Some(path.to_path_buf()),
                Ok(Some(Event::Error { message, .. })) => return Err(message),
                Ok(_) => {
                    *guard = None;
                    return Err(STOPPED.into());
                }
                Err(_) => {
                    *guard = None;
                    return Err("The local model took too long to load.".into());
                }
            }
        }
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        if let Ok(mut c) = self.current.lock() {
            *c = Some((id.clone(), w.stdin.clone()));
        }
        let result = self
            .stream(w, &id, system, messages, max_tokens, timeout, &mut emit)
            .await;
        if let Ok(mut c) = self.current.lock() {
            *c = None;
        }
        if result
            .as_ref()
            .err()
            .is_some_and(|e| e == STOPPED || e.starts_with(TIMED_OUT))
        {
            // Ended or broken: drop it (kill_on_drop) so the next request starts clean.
            *guard = None;
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn stream(
        &self,
        w: &mut Worker,
        id: &str,
        system: String,
        messages: Vec<Turn>,
        max_tokens: u32,
        timeout: Duration,
        emit: &mut impl FnMut(LocalMsg),
    ) -> Result<(), String> {
        let req = Request::Generate {
            id: id.to_string(),
            system,
            messages,
            max_tokens,
        };
        write(&w.stdin, &req).await?;
        let deadline = tokio::time::Instant::now() + timeout;
        let mut cancelled_at: Option<tokio::time::Instant> = None;
        loop {
            let until = cancelled_at.map_or(deadline, |t| t + CANCEL_GRACE);
            match tokio::time::timeout_at(until, next(w)).await {
                Ok(Some(Event::Text { id: got, text })) if got == id => {
                    emit(LocalMsg::Text { text });
                }
                Ok(Some(Event::Done {
                    id: got,
                    input_tokens,
                    output_tokens,
                    stop,
                })) if got == id => {
                    emit(LocalMsg::Done {
                        input_tokens,
                        output_tokens,
                        stop,
                    });
                    return Ok(());
                }
                Ok(Some(Event::Error { message, .. })) => return Err(message),
                Ok(Some(_)) => {} // a late event from an earlier request
                Ok(None) => return Err(STOPPED.into()),
                Err(_) if cancelled_at.is_none() => {
                    // Over the time limit: ask it to stop, then give it a moment.
                    let _ = write(&w.stdin, &Request::Cancel { id: id.to_string() }).await;
                    cancelled_at = Some(tokio::time::Instant::now());
                }
                Err(_) => {
                    return Err(format!(
                        "{TIMED_OUT} ({}s) and was stopped.",
                        timeout.as_secs()
                    ));
                }
            }
        }
    }

    /// Stop: ends the answer under way; what's been said so far stays.
    pub async fn cancel(&self) {
        let current = self.current.lock().ok().and_then(|c| c.clone());
        if let Some((id, stdin)) = current {
            let _ = write(&stdin, &Request::Cancel { id }).await;
        }
    }

    /// Ends the worker and frees its memory; the next request starts it again.
    pub async fn unload(&self) {
        self.cancel().await;
        if let Some(mut w) = self.worker.lock().await.take() {
            let _ = w.child.kill().await;
        }
    }

    pub async fn loaded(&self) -> Option<PathBuf> {
        let mut guard = self.worker.lock().await;
        let w = guard.as_mut()?;
        if matches!(w.child.try_wait(), Ok(None)) {
            w.loaded.clone()
        } else {
            None
        }
    }
}

const TIMED_OUT: &str = "The local model went over its time limit";

/// Model files live in the app's data folder, `models/<file>`; only a plain .gguf name is taken.
pub fn model_path(data_dir: &Path, file: &str) -> Result<PathBuf, String> {
    let ok = file.ends_with(".gguf")
        && !file.starts_with('.')
        && file
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok {
        return Err(format!("{file}: not a model file name."));
    }
    Ok(data_dir.join("models").join(file))
}

pub mod commands {
    use super::*;
    use tauri::ipc::Channel;
    use tauri::{AppHandle, Manager, State};

    #[derive(serde::Deserialize)]
    pub struct TurnIn {
        role: String,
        content: String,
    }

    /// Streams one local answer on `on_event` (Text pieces, then Done); errors are returned.
    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn local_generate(
        app: AppHandle,
        local: State<'_, Local>,
        file: String,
        system: String,
        messages: Vec<TurnIn>,
        max_tokens: u32,
        timeout_secs: Option<u64>,
        on_event: Channel<LocalMsg>,
    ) -> Result<(), String> {
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let path = model_path(&data, &file)?;
        if !path.is_file() {
            return Err(
                "The local model isn't installed. Install it in Settings → Local model.".into(),
            );
        }
        if !crate::local_worker::cpu_supported() {
            return Err(
                "This computer's processor lacks AVX2, which the local model needs.".into(),
            );
        }
        let turns = messages
            .into_iter()
            .map(|t| Turn {
                role: t.role,
                content: t.content,
            })
            .collect();
        local
            .generate(
                &Launch::this_app()?,
                &path,
                system,
                turns,
                max_tokens.clamp(1, N_CTX),
                timeout_secs.map_or(DEFAULT_TIMEOUT, Duration::from_secs),
                |m| {
                    let _ = on_event.send(m);
                },
            )
            .await
    }

    #[tauri::command]
    pub async fn local_cancel(local: State<'_, Local>) -> Result<(), String> {
        local.cancel().await;
        Ok(())
    }

    /// The model file the worker has loaded (its name only), or null when none is.
    #[tauri::command]
    pub async fn local_status(local: State<'_, Local>) -> Result<Option<String>, String> {
        Ok(local
            .loaded()
            .await
            .and_then(|p| p.file_name().map(|f| f.to_string_lossy().into_owned())))
    }

    #[tauri::command]
    pub async fn local_unload(local: State<'_, Local>) -> Result<(), String> {
        local.unload().await;
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A stand-in worker: a shell script speaking the protocol, so the process handling is
    /// tested without llama.cpp or a model file.
    fn script(body: &str) -> Launch {
        Launch {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), body.into()],
        }
    }

    const LOADS: &str = r#"read l; echo '{"ev":"loaded","n_ctx":4096}'; read g; "#;

    async fn run(launch: &Launch, timeout: Duration) -> (Vec<LocalMsg>, Result<(), String>) {
        let local = Local::default();
        let mut got = Vec::new();
        let r = local
            .generate(
                launch,
                Path::new("/m/a.gguf"),
                "s".into(),
                vec![],
                16,
                timeout,
                |m| got.push(m),
            )
            .await;
        (got, r)
    }

    #[tokio::test]
    async fn streams_text_then_done() {
        let w = script(&format!(
            "{LOADS}echo '{{\"ev\":\"text\",\"id\":\"r1\",\"text\":\"hi\"}}'; echo '{{\"ev\":\"done\",\"id\":\"r1\",\"input_tokens\":5,\"output_tokens\":1,\"stop\":\"stop\"}}'; read x"
        ));
        let (got, r) = run(&w, DEFAULT_TIMEOUT).await;
        assert_eq!(r, Ok(()));
        assert_eq!(
            got,
            vec![
                LocalMsg::Text { text: "hi".into() },
                LocalMsg::Done {
                    input_tokens: 5,
                    output_tokens: 1,
                    stop: "stop".into()
                }
            ]
        );
    }

    #[tokio::test]
    async fn a_worker_that_dies_mid_answer_is_an_error_not_a_crash() {
        let w = script(&format!(
            "{LOADS}echo '{{\"ev\":\"text\",\"id\":\"r1\",\"text\":\"par\"}}'; exit 137"
        ));
        let (got, r) = run(&w, DEFAULT_TIMEOUT).await;
        assert_eq!(got, vec![LocalMsg::Text { text: "par".into() }]);
        assert_eq!(r, Err(STOPPED.into()));
    }

    #[tokio::test]
    async fn a_load_error_is_returned() {
        let w = script(
            r#"read l; echo '{"ev":"error","id":null,"message":"Couldn'"'"'t load the local model: bad file"}'; read x"#,
        );
        let (_, r) = run(&w, DEFAULT_TIMEOUT).await;
        assert_eq!(r, Err("Couldn't load the local model: bad file".into()));
    }

    #[tokio::test]
    async fn over_the_time_limit_it_asks_to_stop_then_ends_the_worker() {
        // Ignores the cancel and never answers.
        let w = script(&format!("{LOADS}read c; read d"));
        let started = std::time::Instant::now();
        let (_, r) = run(&w, Duration::from_millis(300)).await;
        assert!(r.unwrap_err().starts_with(TIMED_OUT));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn the_worker_gets_no_environment() {
        // HOME is set for the tests; the worker mustn't see it, or anything else (keys included).
        assert!(std::env::var("HOME").is_ok());
        let w = script(&format!(
            "{LOADS}echo \"{{\\\"ev\\\":\\\"text\\\",\\\"id\\\":\\\"r1\\\",\\\"text\\\":\\\"[$HOME]\\\"}}\"; echo '{{\"ev\":\"done\",\"id\":\"r1\",\"input_tokens\":1,\"output_tokens\":1,\"stop\":\"stop\"}}'; read x"
        ));
        let (got, r) = run(&w, DEFAULT_TIMEOUT).await;
        assert_eq!(r, Ok(()));
        assert_eq!(got[0], LocalMsg::Text { text: "[]".into() });
    }

    #[test]
    fn model_files_are_plain_gguf_names_in_the_models_folder() {
        let d = Path::new("/data");
        assert_eq!(
            model_path(d, "Qwen3-1.7B-Q8_0.gguf"),
            Ok(PathBuf::from("/data/models/Qwen3-1.7B-Q8_0.gguf"))
        );
        for bad in ["../x.gguf", "a/b.gguf", "x.bin", ".hidden.gguf", "x .gguf"] {
            assert!(model_path(d, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn threads_are_between_one_and_eight() {
        assert!((1..=8).contains(&threads()));
    }
}
