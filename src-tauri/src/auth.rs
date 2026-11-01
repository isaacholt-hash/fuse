//! Sign-in for fuse-server (M10 step 4). One user, one passphrase set on the first visit and
//! kept only as an argon2id hash. A browser signs in for a session cookie; a desktop or the
//! runner pairs once with a short code from Settings → Devices and then sends its own token.
//! Sessions and device tokens are random 32 bytes, stored only as SHA-256 hashes, in
//! `auth.json` (readable by this user only), so a restart doesn't sign anyone out.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use argon2::Argon2;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MIN_PASSPHRASE: usize = 12;
const SESSION_SECS: u64 = 30 * 24 * 3600;
const PAIR_CODE_SECS: u64 = 10 * 60;
/// Wrong passphrases allowed in `FAIL_WINDOW_SECS` before sign-in pauses.
const MAX_FAILS: usize = 5;
const FAIL_WINDOW_SECS: u64 = 15 * 60;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_hex(n: usize) -> Result<String, String> {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).map_err(|e| format!("No randomness: {e}"))?;
    Ok(hex(&b))
}

fn sha256(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}

/// Compares without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn stretch(passphrase: &str, salt: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = vec![0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| format!("Couldn't hash the passphrase: {e}"))?;
    Ok(out)
}

#[derive(Serialize, Deserialize, Clone)]
struct Passphrase {
    /// argon2id (v19, m=19456 KiB, t=2, p=1: the crate's defaults), hex.
    salt: String,
    hash: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Session {
    hash: String,
    expires: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    hash: String,
    pub created_at: u64,
    pub last_used_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Stored {
    passphrase: Option<Passphrase>,
    #[serde(default)]
    sessions: Vec<Session>,
    #[serde(default)]
    devices: Vec<Device>,
}

struct PairCode {
    code: String,
    expires: u64,
}

pub struct Auth {
    path: PathBuf,
    stored: Mutex<Stored>,
    pair: Mutex<Option<PairCode>>,
    fails: Mutex<VecDeque<u64>>,
}

/// Who a request is from.
#[derive(Debug, PartialEq, Eq)]
pub enum Who {
    Session,
    Device(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum SignInError {
    NotSetUp,
    Wrong,
    /// Too many wrong tries; seconds until the next one is allowed.
    Paused(u64),
    Other(String),
}

impl Auth {
    pub fn open(home: &Path) -> Result<Self, String> {
        let path = home.join("auth.json");
        let stored = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| format!("{} is damaged: {e}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Stored::default(),
            Err(e) => return Err(format!("Couldn't read {}: {e}", path.display())),
        };
        Ok(Auth {
            path,
            stored: Mutex::new(stored),
            pair: Mutex::default(),
            fails: Mutex::default(),
        })
    }

    fn save(&self, stored: &Stored) -> Result<(), String> {
        let text = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Stored> {
        self.stored.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_set_up(&self) -> bool {
        self.lock().passphrase.is_some()
    }

    fn new_session(&self, stored: &mut Stored) -> Result<String, String> {
        let token = random_hex(32)?;
        let t = now();
        stored.sessions.retain(|s| s.expires > t);
        stored.sessions.push(Session {
            hash: sha256(&token),
            expires: t + SESSION_SECS,
        });
        Ok(token)
    }

    /// Sets the passphrase on the first visit and signs in. Refused once one is set.
    pub fn set_up(&self, passphrase: &str) -> Result<String, String> {
        if passphrase.chars().count() < MIN_PASSPHRASE {
            return Err(format!("Use at least {MIN_PASSPHRASE} characters."));
        }
        let mut stored = self.lock();
        if stored.passphrase.is_some() {
            return Err("A passphrase is already set.".into());
        }
        let salt = random_hex(16)?;
        let hash = stretch(passphrase, salt.as_bytes())?;
        stored.passphrase = Some(Passphrase {
            salt,
            hash: hex(&hash),
        });
        let token = self.new_session(&mut stored)?;
        self.save(&stored)?;
        Ok(token)
    }

    /// A session token for the right passphrase.
    pub fn sign_in(&self, passphrase: &str) -> Result<String, SignInError> {
        let t = now();
        {
            let mut fails = self.fails.lock().unwrap_or_else(|e| e.into_inner());
            while fails.front().is_some_and(|&f| f + FAIL_WINDOW_SECS <= t) {
                fails.pop_front();
            }
            if fails.len() >= MAX_FAILS {
                let first = fails.front().copied().unwrap_or(t);
                return Err(SignInError::Paused(first + FAIL_WINDOW_SECS - t));
            }
        }
        let mut stored = self.lock();
        let Some(p) = stored.passphrase.clone() else {
            return Err(SignInError::NotSetUp);
        };
        let hash = stretch(passphrase, p.salt.as_bytes()).map_err(SignInError::Other)?;
        if !same(hex(&hash).as_bytes(), p.hash.as_bytes()) {
            self.fails
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push_back(t);
            return Err(SignInError::Wrong);
        }
        let token = self.new_session(&mut stored).map_err(SignInError::Other)?;
        self.save(&stored).map_err(SignInError::Other)?;
        Ok(token)
    }

    pub fn sign_out(&self, session: &str) -> Result<(), String> {
        let mut stored = self.lock();
        let h = sha256(session);
        stored.sessions.retain(|s| s.hash != h);
        self.save(&stored)
    }

    /// Who a session cookie or device token belongs to, if anyone.
    pub fn check(&self, session: Option<&str>, device: Option<&str>) -> Option<Who> {
        let t = now();
        let mut stored = self.lock();
        if let Some(s) = session {
            let h = sha256(s);
            if stored
                .sessions
                .iter()
                .any(|x| x.expires > t && same(x.hash.as_bytes(), h.as_bytes()))
            {
                return Some(Who::Session);
            }
        }
        let token = device?;
        let h = sha256(token);
        let d = stored
            .devices
            .iter_mut()
            .find(|d| same(d.hash.as_bytes(), h.as_bytes()))?;
        // Recorded to the minute, so a busy runner doesn't rewrite the file on every call.
        let changed = d.last_used_at.is_none_or(|u| t >= u + 60);
        if changed {
            d.last_used_at = Some(t);
        }
        let id = d.id.clone();
        if changed {
            let copy = stored.clone();
            drop(stored);
            let _ = self.save(&copy);
        }
        Some(Who::Device(id))
    }

    /// A new one-time code for pairing a device, replacing any earlier one.
    pub fn pair_code(&self) -> Result<(String, u64), String> {
        // 8 characters from 32 without look-alikes (40 bits), as XXXX-XXXX.
        const SET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).map_err(|e| format!("No randomness: {e}"))?;
        let raw: String = b.iter().map(|v| SET[(v % 32) as usize] as char).collect();
        let code = format!("{}-{}", &raw[..4], &raw[4..]);
        let expires = now() + PAIR_CODE_SECS;
        *self.pair.lock().unwrap_or_else(|e| e.into_inner()) = Some(PairCode {
            code: code.clone(),
            expires,
        });
        Ok((code, expires))
    }

    /// Trades a pairing code for a device token, once. Wrong codes count as wrong passphrases.
    pub fn pair(&self, code: &str, name: &str) -> Result<(Device, String), SignInError> {
        let t = now();
        {
            let fails = self.fails.lock().unwrap_or_else(|e| e.into_inner());
            if fails.iter().filter(|&&f| f + FAIL_WINDOW_SECS > t).count() >= MAX_FAILS {
                return Err(SignInError::Paused(FAIL_WINDOW_SECS));
            }
        }
        let wanted = code.trim().to_ascii_uppercase();
        let ok = {
            let mut pair = self.pair.lock().unwrap_or_else(|e| e.into_inner());
            let ok = pair
                .as_ref()
                .is_some_and(|p| p.expires > t && same(p.code.as_bytes(), wanted.as_bytes()));
            if ok {
                *pair = None;
            }
            ok
        };
        if !ok {
            self.fails
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push_back(t);
            return Err(SignInError::Wrong);
        }
        let token = random_hex(32).map_err(SignInError::Other)?;
        let name = name.trim();
        let device = Device {
            id: random_hex(8).map_err(SignInError::Other)?,
            name: if name.is_empty() {
                "A device".into()
            } else {
                name.chars().take(60).collect()
            },
            hash: sha256(&token),
            created_at: t,
            last_used_at: None,
        };
        let mut stored = self.lock();
        stored.devices.push(device.clone());
        self.save(&stored).map_err(SignInError::Other)?;
        Ok((
            Device {
                hash: String::new(),
                ..device
            },
            token,
        ))
    }

    pub fn devices(&self) -> Vec<Device> {
        self.lock()
            .devices
            .iter()
            .map(|d| Device {
                hash: String::new(),
                ..d.clone()
            })
            .collect()
    }

    pub fn revoke(&self, id: &str) -> Result<bool, String> {
        let mut stored = self.lock();
        let before = stored.devices.len();
        stored.devices.retain(|d| d.id != id);
        let removed = stored.devices.len() != before;
        self.save(&stored)?;
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fuse-auth-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn set_up_once_then_sign_in_and_out() {
        let h = home("signin");
        let auth = Auth::open(&h).unwrap();
        assert!(!auth.is_set_up());
        assert_eq!(auth.sign_in("anything at all"), Err(SignInError::NotSetUp));
        assert!(auth.set_up("short").is_err());
        let first = auth.set_up("correct horse battery").unwrap();
        assert!(auth.set_up("another passphrase!").is_err());
        assert_eq!(auth.check(Some(&first), None), Some(Who::Session));

        // Survives a restart; the file holds hashes, not the passphrase or tokens.
        let auth = Auth::open(&h).unwrap();
        assert_eq!(auth.check(Some(&first), None), Some(Who::Session));
        let file = std::fs::read_to_string(h.join("auth.json")).unwrap();
        assert!(!file.contains("correct horse") && !file.contains(&first));

        assert_eq!(auth.sign_in("wrong passphrase"), Err(SignInError::Wrong));
        let second = auth.sign_in("correct horse battery").unwrap();
        auth.sign_out(&second).unwrap();
        assert_eq!(auth.check(Some(&second), None), None);
        assert_eq!(auth.check(Some("nope"), None), None);
        assert_eq!(auth.check(None, None), None);
        std::fs::remove_dir_all(&h).unwrap();
    }

    #[test]
    fn pauses_after_five_wrong_tries() {
        let h = home("pause");
        let auth = Auth::open(&h).unwrap();
        auth.set_up("correct horse battery").unwrap();
        for _ in 0..MAX_FAILS {
            assert_eq!(auth.sign_in("wrong one"), Err(SignInError::Wrong));
        }
        assert!(matches!(
            auth.sign_in("correct horse battery"),
            Err(SignInError::Paused(_))
        ));
        std::fs::remove_dir_all(&h).unwrap();
    }

    #[test]
    fn pairs_a_device_once_and_revokes_it() {
        let h = home("pair");
        let auth = Auth::open(&h).unwrap();
        auth.set_up("correct horse battery").unwrap();
        let (code, _) = auth.pair_code().unwrap();
        assert!(code.len() == 9 && code.as_bytes()[4] == b'-', "{code}");
        assert_eq!(auth.pair("ABCD-EFGH", "x").unwrap_err(), SignInError::Wrong);
        let (device, token) = auth.pair(&code.to_lowercase(), "TCHALLA").unwrap();
        assert_eq!(device.name, "TCHALLA");
        assert_eq!(auth.pair(&code, "again").unwrap_err(), SignInError::Wrong);
        assert_eq!(
            auth.check(None, Some(&token)),
            Some(Who::Device(device.id.clone()))
        );
        assert!(auth.devices()[0].last_used_at.is_some());
        assert!(
            serde_json::to_string(&auth.devices())
                .unwrap()
                .find("hash")
                .is_none()
        );
        assert!(auth.revoke(&device.id).unwrap());
        assert_eq!(auth.check(None, Some(&token)), None);
        std::fs::remove_dir_all(&h).unwrap();
    }
}
