//! Secrets on fuse-server (M10): `systemd-creds --user` encrypted credentials, one file per
//! account, sealed to this host and user. The desktop keeps using the OS keychain (keys.rs).
//! A secret goes in on stdin and comes back on stdout; it's never an argument, a file in the
//! clear, or part of an error.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::keys::SecretStore;

pub struct SystemdCreds {
    dir: PathBuf,
}

/// Account names (`openai`, `mcp:<id>:<name>`, …) as file-safe hex.
fn hex(account: &str) -> String {
    account.bytes().map(|b| format!("{b:02x}")).collect()
}

impl SystemdCreds {
    /// Keeps credentials in `dir`, created readable by this user only.
    pub fn new(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Ok(Self {
            dir: dir.to_owned(),
        })
    }

    fn path(&self, account: &str) -> PathBuf {
        self.dir.join(format!("{}.cred", hex(account)))
    }

    /// The name sealed into each credential, so a file can't be swapped for another account's.
    fn name(account: &str) -> String {
        format!("fuse-{}", hex(account))
    }

    /// True if this computer can seal user credentials (systemd 256 or later).
    pub fn available() -> bool {
        let dir = std::env::temp_dir().join(format!("fuse-creds-probe-{}", std::process::id()));
        let ok = Self::new(&dir)
            .and_then(|s| {
                s.set("probe", "x")?;
                s.get("probe")
            })
            .is_ok_and(|v| v.as_deref() == Some("x"));
        let _ = std::fs::remove_dir_all(&dir);
        ok
    }
}

fn failed(what: &str, status: std::process::ExitStatus) -> String {
    format!("Couldn't {what} a secret with systemd-creds ({status}).")
}

impl SecretStore for SystemdCreds {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let path = self.path(account);
        if !path.exists() {
            return Ok(None);
        }
        let out = Command::new("systemd-creds")
            .args([
                "--user",
                "decrypt",
                &format!("--name={}", Self::name(account)),
            ])
            .arg(&path)
            .arg("-")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| format!("Couldn't run systemd-creds: {e}"))?;
        if !out.status.success() {
            return Err(failed("read", out.status));
        }
        String::from_utf8(out.stdout)
            .map(Some)
            .map_err(|_| "A stored secret isn't text.".to_owned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let path = self.path(account);
        let tmp = path.with_extension("cred.tmp");
        let mut child = Command::new("systemd-creds")
            .args([
                "--user",
                "encrypt",
                &format!("--name={}", Self::name(account)),
                "-",
            ])
            .arg(&tmp)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Couldn't run systemd-creds: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(secret.as_bytes())
                .map_err(|_| "Couldn't hand the secret to systemd-creds.".to_owned())?;
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            let _ = std::fs::remove_file(&tmp);
            return Err(failed("store", status));
        }
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match std::fs::remove_file(self.path(account)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_deletes_when_systemd_creds_can() {
        if !SystemdCreds::available() {
            eprintln!("skipped: systemd-creds --user isn't available here");
            return;
        }
        let dir = std::env::temp_dir().join(format!("fuse-creds-test-{}", std::process::id()));
        let store = SystemdCreds::new(&dir).unwrap();
        assert_eq!(store.get("mcp:a b:TOKEN").unwrap(), None);
        store.set("mcp:a b:TOKEN", "not-a-real-secret").unwrap();
        assert_eq!(
            store.get("mcp:a b:TOKEN").unwrap().as_deref(),
            Some("not-a-real-secret")
        );
        // The file is sealed, not the secret in the clear.
        let raw = std::fs::read(store.path("mcp:a b:TOKEN")).unwrap();
        assert!(!raw.windows(17).any(|w| w == b"not-a-real-secret"));
        // A file renamed to another account fails to open, not opens as that account.
        std::fs::copy(store.path("mcp:a b:TOKEN"), store.path("openai")).unwrap();
        assert!(store.get("openai").is_err());
        store.delete("mcp:a b:TOKEN").unwrap();
        store.delete("mcp:a b:TOKEN").unwrap();
        assert_eq!(store.get("mcp:a b:TOKEN").unwrap(), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
