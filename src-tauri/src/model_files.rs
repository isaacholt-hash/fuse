//! Local model files (M7 step 6, LL-03, LL-08): download, verify, update and remove. A file comes
//! only from Hugging Face at a pinned revision. It's downloaded to `models/<file>.part` (so an
//! interrupted download resumes), checked against its size and SHA-256, and only then renamed
//! into place, with a `<file>.json` note of what was installed. A bad checksum, a full disk or a
//! dropped connection leaves the app on the cloud path, with no half file in use.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

/// Free disk left over after a download, so the computer doesn't fill up.
const DISK_SPARE: u64 = 1_000_000_000;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstallMsg {
    Progress { done: u64, total: u64 },
    Verifying,
    Done,
}

/// What was installed, kept beside the file.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub file: String,
    pub sha256: String,
    pub revision: String,
    pub size_bytes: u64,
    pub installed_ms: u64,
}

pub struct Wanted<'a> {
    pub url: &'a str,
    pub file: &'a str,
    pub sha256: &'a str,
    pub revision: &'a str,
    pub size: u64,
}

/// Only `https://huggingface.co/<org>/<repo>/resolve/<40 hex>/<file>` (LL-08).
pub fn check_url(url: &str, file: &str, revision: &str) -> Result<(), String> {
    let pinned = revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit());
    let ok = pinned
        && url.starts_with("https://huggingface.co/")
        && url.ends_with(&format!("/resolve/{revision}/{file}"))
        && url.matches('/').count() == 7;
    if ok {
        Ok(())
    } else {
        Err("Model files come only from Hugging Face at a pinned revision.".into())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn note_path(path: &Path) -> PathBuf {
    path.with_extension("gguf.json")
}

fn part_path(path: &Path) -> PathBuf {
    path.with_extension("gguf.part")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(0))
}

/// Hashes what's already downloaded, so a resumed download is checked end to end.
fn hash_existing(part: &Path) -> Result<(Sha256, u64), String> {
    use std::io::Read;
    let mut hasher = Sha256::new();
    let mut f = std::fs::File::open(part).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    let mut n_total = 0u64;
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        n_total += n as u64;
    }
    Ok((hasher, n_total))
}

/// Downloads `want` into `models_dir`, resuming a partial file, then verifies and installs it.
/// `free_disk` is the space free now (None when unknown). Cancelling keeps the partial file.
pub async fn install(
    client: &reqwest::Client,
    models_dir: &Path,
    want: &Wanted<'_>,
    free_disk: Option<u64>,
    cancel: &AtomicBool,
    mut emit: impl FnMut(InstallMsg),
) -> Result<Installed, String> {
    let path = crate::local::model_path(models_dir.parent().unwrap_or(models_dir), want.file)?;
    std::fs::create_dir_all(models_dir)
        .map_err(|e| format!("Couldn't make the models folder: {e}"))?;
    let part = part_path(&path);
    let mut existing = std::fs::metadata(&part).map_or(0, |m| m.len());
    if existing > want.size {
        let _ = std::fs::remove_file(&part);
        existing = 0;
    }
    let needed = want.size - existing + DISK_SPARE;
    if let Some(free) = free_disk
        && free < needed
    {
        return Err(format!(
            "Not enough free disk: this needs {:.1} GB and {:.1} GB is free.",
            needed as f64 / 1e9,
            free as f64 / 1e9
        ));
    }
    let (mut hasher, mut done) = if existing > 0 {
        hash_existing(&part)?
    } else {
        (Sha256::new(), 0)
    };
    let mut req = client.get(want.url);
    if done > 0 {
        req = req.header("Range", format!("bytes={done}-"));
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Hugging Face: {e}"))?;
    let status = resp.status().as_u16();
    let append = match status {
        206 if done > 0 => true,
        200 => {
            // The server sent the whole file: start again.
            hasher = Sha256::new();
            done = 0;
            false
        }
        _ => return Err(format!("Hugging Face answered {status}.")),
    };
    let mut out = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&part)
        .await
        .map_err(|e| format!("Couldn't write the model file: {e}"))?;
    emit(InstallMsg::Progress {
        done,
        total: want.size,
    });
    let mut last = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = out.flush().await;
            return Err("Download paused. Install again to carry on where it stopped.".into());
        }
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                let _ = out.flush().await;
                return Err(format!(
                    "The download was interrupted ({e}). Install again to carry on where it stopped."
                ));
            }
        };
        done += chunk.len() as u64;
        if done > want.size {
            drop(out);
            let _ = std::fs::remove_file(&part);
            return Err("The download was bigger than expected, so it was thrown away.".into());
        }
        hasher.update(&chunk);
        out.write_all(&chunk)
            .await
            .map_err(|e| format!("Couldn't write the model file (is the disk full?): {e}"))?;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            emit(InstallMsg::Progress {
                done,
                total: want.size,
            });
        }
    }
    out.flush().await.map_err(|e| e.to_string())?;
    drop(out);
    emit(InstallMsg::Progress {
        done,
        total: want.size,
    });
    if done != want.size {
        return Err("The download ended early. Install again to carry on where it stopped.".into());
    }
    emit(InstallMsg::Verifying);
    let got = hex(&hasher.finalize());
    if !got.eq_ignore_ascii_case(want.sha256) {
        let _ = std::fs::remove_file(&part);
        return Err(
            "The downloaded file didn't match its checksum, so it was thrown away and nothing was installed."
                .into(),
        );
    }
    std::fs::rename(&part, &path).map_err(|e| format!("Couldn't install the model file: {e}"))?;
    let installed = Installed {
        file: want.file.into(),
        sha256: want.sha256.to_ascii_lowercase(),
        revision: want.revision.into(),
        size_bytes: want.size,
        installed_ms: now_ms(),
    };
    let note = serde_json::to_vec_pretty(&installed).map_err(|e| e.to_string())?;
    std::fs::write(note_path(&path), note).map_err(|e| e.to_string())?;
    emit(InstallMsg::Done);
    Ok(installed)
}

/// Installed model files: each `.gguf` with its note. A file without a note is left out.
pub fn list(models_dir: &Path) -> Vec<Installed> {
    let Ok(entries) = std::fs::read_dir(models_dir) else {
        return vec![];
    };
    let mut out: Vec<Installed> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "gguf"))
        .filter_map(|e| {
            let note = std::fs::read(note_path(&e.path())).ok()?;
            serde_json::from_slice(&note).ok()
        })
        .collect();
    out.sort_by(|a, b| a.file.cmp(&b.file));
    out
}

/// Removes a model file, its note and any partial download.
pub fn remove(models_dir: &Path, file: &str) -> Result<(), String> {
    let path = crate::local::model_path(models_dir.parent().unwrap_or(models_dir), file)?;
    for p in [path.clone(), note_path(&path), part_path(&path)] {
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Couldn't remove {}: {e}", p.display())),
        }
    }
    Ok(())
}

/// The download under way, so it can be paused.
#[derive(Default)]
pub struct Downloads {
    cancel: std::sync::Mutex<Option<Arc<AtomicBool>>>,
}

pub mod commands {
    use super::*;
    use tauri::ipc::Channel;
    use tauri::{AppHandle, Manager, State};

    fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
        Ok(app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("models"))
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn local_install(
        app: AppHandle,
        downloads: State<'_, Downloads>,
        url: String,
        file: String,
        sha256: String,
        revision: String,
        size_bytes: u64,
        on_event: Channel<InstallMsg>,
    ) -> Result<Installed, String> {
        check_url(&url, &file, &revision)?;
        let dir = models_dir(&app)?;
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut current = downloads.cancel.lock().map_err(|e| e.to_string())?;
            if current.is_some() {
                return Err("A model is already downloading.".into());
            }
            *current = Some(flag.clone());
        }
        let free = crate::hardware::detect(&dir).free_disk_bytes;
        let client = reqwest::Client::builder()
            .https_only(true)
            .build()
            .map_err(|e| e.to_string())?;
        let want = Wanted {
            url: &url,
            file: &file,
            sha256: &sha256,
            revision: &revision,
            size: size_bytes,
        };
        let result = install(&client, &dir, &want, free, &flag, |m| {
            let _ = on_event.send(m);
        })
        .await;
        if let Ok(mut current) = downloads.cancel.lock() {
            *current = None;
        }
        result
    }

    #[tauri::command]
    pub fn local_install_cancel(downloads: State<'_, Downloads>) -> Result<(), String> {
        if let Some(flag) = downloads.cancel.lock().map_err(|e| e.to_string())?.as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    #[tauri::command]
    pub fn local_installed(app: AppHandle) -> Result<Vec<Installed>, String> {
        Ok(list(&models_dir(&app)?))
    }

    /// Removes a model file; the worker is ended first so the file isn't in use.
    #[tauri::command]
    pub async fn local_remove(
        app: AppHandle,
        local: State<'_, crate::local::Local>,
        file: String,
    ) -> Result<(), String> {
        local.unload().await;
        remove(&models_dir(&app)?, &file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A one-file HTTP server that honours `Range: bytes=N-`, closes after `cut` bytes of the
    /// first response when set, and counts requests.
    async fn serve(
        body: Vec<u8>,
        cut: Option<usize>,
    ) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let n = counter.fetch_add(1, Ordering::Relaxed);
                let mut buf = vec![0u8; 4096];
                let len = sock.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..len]).to_lowercase();
                let start = head
                    .split("range: bytes=")
                    .nth(1)
                    .and_then(|r| r.split('-').next())
                    .and_then(|s| s.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                let rest = &body[start.min(body.len())..];
                let status = if start > 0 {
                    "206 Partial Content"
                } else {
                    "200 OK"
                };
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    rest.len()
                );
                let _ = sock.write_all(header.as_bytes()).await;
                let send = match cut {
                    Some(c) if n == 0 => &rest[..c.min(rest.len())],
                    _ => rest,
                };
                let _ = sock.write_all(send).await;
                let _ = sock.shutdown().await;
            }
        });
        (format!("http://{addr}/m.gguf"), hits)
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fuse-model-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d.join("models")
    }

    const REV: &str = "90862c4b9d2787eaed51d12237eafdfe7c5f6077";

    async fn go(
        url: &str,
        models: &Path,
        body: &[u8],
        sha: &str,
    ) -> (Result<Installed, String>, Vec<InstallMsg>) {
        let want = Wanted {
            url,
            file: "m.gguf",
            sha256: sha,
            revision: REV,
            size: body.len() as u64,
        };
        let mut msgs = vec![];
        let r = install(
            &reqwest::Client::new(),
            models,
            &want,
            None,
            &AtomicBool::new(false),
            |m| msgs.push(m),
        )
        .await;
        (r, msgs)
    }

    fn sha(body: &[u8]) -> String {
        hex(&Sha256::digest(body))
    }

    #[tokio::test]
    async fn downloads_verifies_installs_and_lists() {
        let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let (url, _) = serve(body.clone(), None).await;
        let models = dir("ok");
        let (r, msgs) = go(&url, &models, &body, &sha(&body)).await;
        let installed = r.unwrap();
        assert_eq!(installed.sha256, sha(&body));
        assert_eq!(std::fs::read(models.join("m.gguf")).unwrap(), body);
        assert!(!models.join("m.gguf.part").exists());
        assert_eq!(msgs.last(), Some(&InstallMsg::Done));
        assert!(msgs.contains(&InstallMsg::Verifying));
        assert_eq!(list(&models), vec![installed]);
        remove(&models, "m.gguf").unwrap();
        assert!(list(&models).is_empty() && !models.join("m.gguf").exists());
    }

    #[tokio::test]
    async fn an_interrupted_download_resumes_where_it_stopped() {
        let body: Vec<u8> = (0..300_000u32).map(|i| (i % 253) as u8).collect();
        let (url, hits) = serve(body.clone(), Some(120_000)).await;
        let models = dir("resume");
        let (first, _) = go(&url, &models, &body, &sha(&body)).await;
        assert!(first.unwrap_err().contains("carry on where it stopped"));
        assert_eq!(
            std::fs::metadata(models.join("m.gguf.part")).unwrap().len(),
            120_000
        );
        let (second, msgs) = go(&url, &models, &body, &sha(&body)).await;
        second.unwrap();
        assert_eq!(hits.load(Ordering::Relaxed), 2);
        // The second request started at the first's end.
        assert_eq!(
            msgs.first(),
            Some(&InstallMsg::Progress {
                done: 120_000,
                total: 300_000
            })
        );
        assert_eq!(std::fs::read(models.join("m.gguf")).unwrap(), body);
    }

    #[tokio::test]
    async fn a_bad_checksum_installs_nothing() {
        let body = vec![7u8; 50_000];
        let (url, _) = serve(body.clone(), None).await;
        let models = dir("bad");
        let (r, _) = go(&url, &models, &body, &"0".repeat(64)).await;
        assert!(r.unwrap_err().contains("didn't match its checksum"));
        assert!(!models.join("m.gguf").exists() && !models.join("m.gguf.part").exists());
        assert!(list(&models).is_empty());
    }

    #[tokio::test]
    async fn a_full_disk_is_refused_before_downloading() {
        let body = vec![1u8; 10];
        let (url, hits) = serve(body.clone(), None).await;
        let want = Wanted {
            url: &url,
            file: "m.gguf",
            sha256: &sha(&body),
            revision: REV,
            size: 2_000_000_000,
        };
        let r = install(
            &reqwest::Client::new(),
            &dir("full"),
            &want,
            Some(500_000_000),
            &AtomicBool::new(false),
            |_| {},
        )
        .await;
        assert!(r.unwrap_err().starts_with("Not enough free disk"));
        assert_eq!(hits.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn only_pinned_hugging_face_urls() {
        let good = format!(
            "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/{REV}/Qwen3-1.7B-Q8_0.gguf"
        );
        assert!(check_url(&good, "Qwen3-1.7B-Q8_0.gguf", REV).is_ok());
        for bad in [
            good.replace("https://huggingface.co", "https://evil.example"),
            good.replace("https://", "http://"),
            good.replace(REV, "main"),
            good.replace("/Qwen/", "/Qwen/x/"),
        ] {
            assert!(
                check_url(&bad, "Qwen3-1.7B-Q8_0.gguf", REV).is_err(),
                "{bad}"
            );
        }
        assert!(check_url(&good, "other.gguf", REV).is_err());
        assert!(check_url(&good.replace(REV, "main"), "Qwen3-1.7B-Q8_0.gguf", "main").is_err());
    }
}
