//! The Python runtime for data work (M9 step 5, AG-03). Opt-in: a pinned CPython build from
//! python-build-standalone, checked against its size and SHA-256, unpacked with the system `tar`
//! (Linux, and Windows 10 and later), then the data libraries installed by its own pip from a lock
//! file where every wheel has a hash (`data/python/`). It's built in `python-runtime/staging` and
//! only moved into `python-runtime/python` once everything worked, with a `fuse-runtime.json` note
//! of what's there. A failed install leaves nothing half done. Nothing runs scripts yet (step 6).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Builds come only from python-build-standalone's GitHub releases.
const SOURCE: &str = "https://github.com/astral-sh/python-build-standalone/releases/download/";
/// The note beside the runtime saying what was installed.
const NOTE: &str = "fuse-runtime.json";
/// pip's packages come only from PyPI, whatever the computer's pip settings say.
const INDEX: &str = "https://pypi.org/simple/";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PyMsg {
    Progress { done: u64, total: u64 },
    Verifying,
    Unpacking,
    Libraries,
    Done,
}

/// What's installed, from its note.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub python: String,
    pub release: String,
    pub packages: Vec<String>,
    pub size_bytes: u64,
    pub installed_ms: u64,
}

pub struct Wanted<'a> {
    pub url: &'a str,
    pub sha256: &'a str,
    pub size: u64,
    pub python: &'a str,
    pub release: &'a str,
    /// The requirements lock, every line pinned with hashes; empty installs no libraries.
    pub lock: &'a str,
    pub packages: Vec<String>,
}

/// Only `<SOURCE><release>/cpython-…-install_only.tar.gz`, from the pinned release.
pub fn check_url(url: &str, release: &str) -> Result<(), String> {
    let pinned = !release.is_empty() && release.bytes().all(|b| b.is_ascii_digit());
    let rest = url.strip_prefix(SOURCE).unwrap_or("");
    let ok = pinned
        && rest.starts_with(&format!("{release}/cpython-"))
        && rest.ends_with("-install_only.tar.gz")
        && rest.matches('/').count() == 1
        && !rest.contains("..");
    if ok {
        Ok(())
    } else {
        Err("Python comes only from python-build-standalone at a pinned release.".into())
    }
}

/// Where the runtime's python is, inside the folder it was unpacked to.
pub fn python_exe(python_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        python_dir.join("python.exe")
    } else {
        python_dir.join("bin").join("python3")
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(0))
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map_or(0, |m| m.len()),
            _ => 0,
        })
        .sum()
}

fn remove_if_there(p: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Couldn't remove {}: {e}", p.display())),
    }
}

/// A helper process with no console window on Windows and none of FUSE's environment, so no
/// key or setting leaks into it; only what it needs to find system libraries, temp and a proxy.
fn quiet(program: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.env_clear().kill_on_drop(true);
    for key in [
        "PATH",
        "SystemRoot",
        "windir",
        "TEMP",
        "TMP",
        "HTTPS_PROXY",
        "https_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd
}

/// The last lines of a failed helper's output, for its error.
fn tail(out: &std::process::Output) -> String {
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(4)..].join("\n")
}

async fn download(
    client: &reqwest::Client,
    want: &Wanted<'_>,
    cancel: &AtomicBool,
    emit: &mut impl FnMut(PyMsg),
) -> Result<Vec<u8>, String> {
    let mut resp = client
        .get(want.url)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(format!("GitHub answered {status}."));
    }
    let mut body = Vec::with_capacity(usize::try_from(want.size).unwrap_or(0));
    let mut hasher = Sha256::new();
    let mut last = Instant::now();
    emit(PyMsg::Progress {
        done: 0,
        total: want.size,
    });
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("The download was interrupted ({e}). Install again."))?
    {
        if cancel.load(Ordering::Relaxed) {
            return Err("Stopped. Nothing was installed.".into());
        }
        if (body.len() + chunk.len()) as u64 > want.size {
            return Err("The download was bigger than expected, so it was thrown away.".into());
        }
        hasher.update(&chunk);
        body.extend_from_slice(&chunk);
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            emit(PyMsg::Progress {
                done: body.len() as u64,
                total: want.size,
            });
        }
    }
    emit(PyMsg::Verifying);
    if body.len() as u64 != want.size {
        return Err("The download ended early. Install again.".into());
    }
    if !hex(&hasher.finalize()).eq_ignore_ascii_case(want.sha256) {
        return Err(
            "The download didn't match its checksum, so it was thrown away and nothing was installed."
                .into(),
        );
    }
    Ok(body)
}

/// Downloads, checks, unpacks and fills the runtime in `root`, replacing any earlier one only
/// once the new one is complete. `tar` is the system's; `run_pip` false skips the libraries.
pub async fn install(
    client: &reqwest::Client,
    root: &Path,
    want: &Wanted<'_>,
    cancel: &AtomicBool,
    mut emit: impl FnMut(PyMsg),
) -> Result<Runtime, String> {
    let staging = root.join("staging");
    remove_if_there(&staging)?;
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("Couldn't make the Python folder: {e}"))?;
    let result = build(client, &staging, want, cancel, &mut emit).await;
    let runtime = match result {
        Ok(r) => r,
        Err(e) => {
            let _ = remove_if_there(&staging);
            return Err(e);
        }
    };
    let live = root.join("python");
    remove_if_there(&live)?;
    std::fs::rename(staging.join("python"), &live)
        .map_err(|e| format!("Couldn't put Python in place: {e}"))?;
    let _ = remove_if_there(&staging);
    emit(PyMsg::Done);
    Ok(runtime)
}

async fn build(
    client: &reqwest::Client,
    staging: &Path,
    want: &Wanted<'_>,
    cancel: &AtomicBool,
    emit: &mut impl FnMut(PyMsg),
) -> Result<Runtime, String> {
    let body = download(client, want, cancel, emit).await?;
    let archive = staging.join("python.tar.gz");
    std::fs::write(&archive, &body)
        .map_err(|e| format!("Couldn't save the download (is the disk full?): {e}"))?;
    drop(body);

    emit(PyMsg::Unpacking);
    let out = quiet(Path::new("tar"))
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(staging)
        .output()
        .await
        .map_err(|e| format!("Couldn't run tar to unpack Python: {e}"))?;
    if !out.status.success() {
        return Err(format!("Couldn't unpack Python:\n{}", tail(&out)));
    }
    let _ = std::fs::remove_file(&archive);
    let dir = staging.join("python");
    let exe = python_exe(&dir);
    if !exe.is_file() {
        return Err("The download had no Python in it.".into());
    }

    if !want.lock.trim().is_empty() {
        if cancel.load(Ordering::Relaxed) {
            return Err("Stopped. Nothing was installed.".into());
        }
        emit(PyMsg::Libraries);
        let lock = staging.join("requirements.txt");
        std::fs::write(&lock, want.lock).map_err(|e| e.to_string())?;
        // Every wheel must match its hash; no source builds, no other index, no user config.
        let out = quiet(&exe)
            .args(["-I", "-m", "pip", "install", "--isolated", "--no-input"])
            .args(["--disable-pip-version-check", "--no-cache-dir"])
            .args(["--no-warn-script-location", "--require-hashes", "--no-deps"])
            .args(["--only-binary", ":all:", "--index-url", INDEX, "-r"])
            .arg(&lock)
            .output()
            .await
            .map_err(|e| format!("Couldn't run pip: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "Couldn't install the data libraries:\n{}",
                tail(&out)
            ));
        }
        let _ = std::fs::remove_file(&lock);
    }

    let runtime = Runtime {
        python: want.python.into(),
        release: want.release.into(),
        packages: want.packages.clone(),
        size_bytes: dir_size(&dir),
        installed_ms: now_ms(),
    };
    let note = serde_json::to_vec_pretty(&runtime).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(NOTE), note).map_err(|e| e.to_string())?;
    Ok(runtime)
}

/// The installed runtime, if there's one with its note and its python.
pub fn status(root: &Path) -> Option<Runtime> {
    let dir = root.join("python");
    if !python_exe(&dir).is_file() {
        return None;
    }
    serde_json::from_slice(&std::fs::read(dir.join(NOTE)).ok()?).ok()
}

/// Removes the runtime and anything left from an install.
pub fn remove(root: &Path) -> Result<(), String> {
    remove_if_there(&root.join("staging"))?;
    remove_if_there(&root.join("python"))
}

/// Set while an install is running, so only one runs and it can be stopped.
#[derive(Default)]
pub struct PyInstall {
    cancel: std::sync::Mutex<Option<std::sync::Arc<AtomicBool>>>,
}

pub mod commands {
    use super::*;
    use std::sync::Arc;
    use tauri::ipc::Channel;
    use tauri::{AppHandle, Manager, State};

    fn root(app: &AppHandle) -> Result<PathBuf, String> {
        Ok(app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("python-runtime"))
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn python_install(
        app: AppHandle,
        state: State<'_, PyInstall>,
        url: String,
        sha256: String,
        size_bytes: u64,
        python: String,
        release: String,
        lock: String,
        packages: Vec<String>,
        on_event: Channel<PyMsg>,
    ) -> Result<Runtime, String> {
        check_url(&url, &release)?;
        if !lock
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
            .all(|l| l.starts_with(' ') || l.contains("=="))
        {
            return Err("The library list must pin every version.".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut current = state.cancel.lock().map_err(|e| e.to_string())?;
            if current.is_some() {
                return Err("Python is already being installed.".into());
            }
            *current = Some(flag.clone());
        }
        let client = reqwest::Client::builder()
            .https_only(true)
            .build()
            .map_err(|e| e.to_string())?;
        let want = Wanted {
            url: &url,
            sha256: &sha256,
            size: size_bytes,
            python: &python,
            release: &release,
            lock: &lock,
            packages,
        };
        let result = match root(&app) {
            Ok(dir) => {
                install(&client, &dir, &want, &flag, |m| {
                    let _ = on_event.send(m);
                })
                .await
            }
            Err(e) => Err(e),
        };
        if let Ok(mut current) = state.cancel.lock() {
            *current = None;
        }
        result
    }

    #[tauri::command]
    pub fn python_install_cancel(state: State<'_, PyInstall>) -> Result<(), String> {
        if let Some(flag) = state.cancel.lock().map_err(|e| e.to_string())?.as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    #[tauri::command]
    pub fn python_status(app: AppHandle) -> Result<Option<Runtime>, String> {
        Ok(status(&root(&app)?))
    }

    #[tauri::command]
    pub fn python_remove(app: AppHandle, state: State<'_, PyInstall>) -> Result<(), String> {
        if state.cancel.lock().map_err(|e| e.to_string())?.is_some() {
            return Err("Wait for the install to finish or stop it first.".into());
        }
        remove(&root(&app)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Serves `body` once per connection over plain HTTP.
    async fn serve(body: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                });
            }
        });
        format!("http://{addr}/python.tar.gz")
    }

    /// A tiny stand-in for a python-build-standalone archive: `python/` with a python in it.
    fn fake_archive(dir: &Path) -> Vec<u8> {
        let src = dir.join("src");
        let exe = python_exe(&src.join("python"));
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"not really python").unwrap();
        std::fs::write(src.join("python").join("LICENSE.txt"), b"PSF").unwrap();
        let out = dir.join("a.tar.gz");
        let ok = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&out)
            .arg("-C")
            .arg(&src)
            .arg("python")
            .status()
            .unwrap();
        assert!(ok.success());
        std::fs::read(out).unwrap()
    }

    fn temp(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("fuse-python-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sha(b: &[u8]) -> String {
        hex(&Sha256::digest(b))
    }

    #[test]
    fn urls_only_from_the_pinned_release() {
        let ok = "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.13.16+20261013-x86_64-unknown-linux-gnu-install_only.tar.gz";
        assert!(check_url(ok, "20261013").is_ok());
        assert!(check_url(ok, "20261020").is_err());
        assert!(check_url(&ok.replace("astral-sh", "someone"), "20261013").is_err());
        assert!(check_url(&ok.replace("https://", "http://"), "20261013").is_err());
        assert!(
            check_url(
                &ok.replace("install_only.tar.gz", "install_only.tar.gz/../x"),
                "20261013"
            )
            .is_err()
        );
        assert!(check_url(&ok.replace("20261013/", "20261013/x/"), "20261013").is_err());
    }

    #[tokio::test]
    async fn installs_checks_records_and_removes() {
        let dir = temp("install");
        let body = fake_archive(dir.as_path());
        let url = serve(body.clone()).await;
        let root = dir.as_path().join("python-runtime");
        let want = Wanted {
            url: &url,
            sha256: &sha(&body),
            size: body.len() as u64,
            python: "3.13.16",
            release: "20261013",
            lock: "",
            packages: vec!["numpy==2.5.4".into()],
        };
        let mut msgs = vec![];
        let got = install(
            &reqwest::Client::new(),
            &root,
            &want,
            &AtomicBool::new(false),
            |m| msgs.push(m),
        )
        .await
        .unwrap();
        assert_eq!(got.python, "3.13.16");
        assert!(got.size_bytes > 0);
        assert_eq!(status(&root), Some(got));
        assert!(!root.join("staging").exists());
        assert!(msgs.contains(&PyMsg::Verifying));
        assert!(msgs.contains(&PyMsg::Unpacking));
        assert!(!msgs.contains(&PyMsg::Libraries));
        assert_eq!(msgs.last(), Some(&PyMsg::Done));

        remove(&root).unwrap();
        assert_eq!(status(&root), None);
        assert!(!root.join("python").exists());
    }

    #[tokio::test]
    async fn a_bad_checksum_or_size_installs_nothing_and_keeps_the_old_one() {
        let dir = temp("checksum");
        let body = fake_archive(dir.as_path());
        let url = serve(body.clone()).await;
        let root = dir.as_path().join("python-runtime");
        let (good, bad) = (sha(&body), "0".repeat(64));
        let client = reqwest::Client::new();
        fn want<'a>(url: &'a str, sha256: &'a str, size: u64) -> Wanted<'a> {
            Wanted {
                url,
                sha256,
                size,
                python: "3.13.16",
                release: "20261013",
                lock: "",
                packages: vec![],
            }
        }
        let size = body.len() as u64;
        let stop = AtomicBool::new(false);
        let first = install(&client, &root, &want(&url, &good, size), &stop, |_| {})
            .await
            .unwrap();
        let err = install(&client, &root, &want(&url, &bad, size), &stop, |_| {})
            .await
            .unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        let err = install(&client, &root, &want(&url, &good, size - 1), &stop, |_| {})
            .await
            .unwrap_err();
        assert!(err.contains("bigger than expected"), "{err}");
        // The earlier runtime is untouched, and no staging is left behind.
        assert_eq!(status(&root), Some(first));
        assert!(!root.join("staging").exists());
    }

    #[tokio::test]
    async fn an_archive_without_python_is_refused() {
        let dir = temp("nopython");
        let src = dir.as_path().join("src").join("other");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("x.txt"), b"x").unwrap();
        let out = dir.as_path().join("b.tar.gz");
        assert!(
            std::process::Command::new("tar")
                .arg("-czf")
                .arg(&out)
                .arg("-C")
                .arg(dir.as_path().join("src"))
                .arg("other")
                .status()
                .unwrap()
                .success()
        );
        let body = std::fs::read(out).unwrap();
        let url = serve(body.clone()).await;
        let root = dir.as_path().join("python-runtime");
        let err = install(
            &reqwest::Client::new(),
            &root,
            &Wanted {
                url: &url,
                sha256: &sha(&body),
                size: body.len() as u64,
                python: "3.13.16",
                release: "20261013",
                lock: "",
                packages: vec![],
            },
            &AtomicBool::new(false),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(err.contains("no Python"), "{err}");
        assert_eq!(status(&root), None);
    }
}
