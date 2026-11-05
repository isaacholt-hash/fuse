//! Bounded records over the existing OS secret store. Windows stores passwords as UTF-16
//! in a 2560-byte credential blob: each UTF-8 part is at most 1024 bytes (<=2048 UTF-16 bytes).
//! Two fixed slots and an atomic small manifest preserve the old record until commit. Fixed
//! part names also let explicit deletion clear interrupted writes without enumerating secrets.
use crate::keys::SecretStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
const PART: usize = 1024;
const PARTS: usize = 64;
const BYTES: usize = 60 * 1024;
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    fuse_secret_chunks: u8,
    slot: u8,
    parts: usize,
    bytes: usize,
    sha256: String,
}
fn part(key: &str, slot: u8, n: usize) -> String {
    format!("{key}:part:{slot}:{n}")
}
fn manifest(value: &str) -> Result<Option<Manifest>, String> {
    let value: serde_json::Value = match serde_json::from_str(value) {
        Ok(v) => v,
        Err(_) => return Ok(None), // Legacy records are interpreted by their owning type.
    };
    if value.get("fuseSecretChunks").is_none() {
        return Ok(None);
    }
    let m: Manifest = serde_json::from_value(value)
        .map_err(|_| "Native connector storage is damaged. Sign in again.".to_string())?;
    if m.fuse_secret_chunks != 1
        || m.slot > 1
        || m.parts == 0
        || m.parts > PARTS
        || m.bytes > BYTES
        || m.sha256.len() != 64
    {
        return Err("Native connector storage is damaged. Sign in again.".into());
    }
    Ok(Some(m))
}
pub(super) fn load(store: &dyn SecretStore, key: &str) -> Result<Option<String>, String> {
    let Some(value) = store.get(key)? else {
        return Ok(None);
    };
    let Some(m) = manifest(&value)? else {
        return Ok(Some(value));
    };
    let mut out = String::new();
    for n in 0..m.parts {
        let value = store
            .get(&part(key, m.slot, n))?
            .ok_or("Native connector storage is incomplete. Sign in again.")?;
        if value.len() > PART || out.len() + value.len() > BYTES {
            return Err("Native connector storage exceeds its bounds.".into());
        }
        out.push_str(&value);
    }
    if out.len() != m.bytes || crate::sync::crypto::hex(&Sha256::digest(out.as_bytes())) != m.sha256
    {
        return Err("Native connector storage failed its integrity check. Sign in again.".into());
    }
    Ok(Some(out))
}
fn clear_slot(store: &dyn SecretStore, key: &str, slot: u8) -> Result<(), String> {
    let mut failed = false;
    for n in 0..PARTS {
        failed |= store.delete(&part(key, slot, n)).is_err();
    }
    if failed {
        Err("Couldn't finish clearing native connector storage. Retry explicitly.".into())
    } else {
        Ok(())
    }
}
/// Caller serializes native account writes using Accounts.flows. Record its public ID in
/// the native grant index before writing credential parts, so interrupted writes remain erasable.
pub(super) fn save(store: &dyn SecretStore, key: &str, value: &str) -> Result<(), String> {
    if value.len() > BYTES {
        return Err("This connector grant exceeds the native storage limit.".into());
    }
    let old = store.get(key)?.map(|v| manifest(&v)).transpose()?.flatten();
    let slot = old.as_ref().map(|m| 1 - m.slot).unwrap_or(0);
    clear_slot(store, key, slot)?;
    let mut start = 0;
    let mut count = 0;
    // An empty logical record still has one bounded part.
    loop {
        let mut end = (start + PART).min(value.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        if count >= PARTS {
            return Err("This connector grant exceeds the native part limit.".into());
        }
        store.set(&part(key, slot, count), &value[start..end])?;
        count += 1;
        start = end;
        if start == value.len() {
            break;
        }
    }
    let m = Manifest {
        fuse_secret_chunks: 1,
        slot,
        parts: count,
        bytes: value.len(),
        sha256: crate::sync::crypto::hex(&Sha256::digest(value.as_bytes())),
    };
    let encoded = serde_json::to_string(&m)
        .map_err(|_| "Couldn't encode native connector storage.".to_string())?;
    store.set(key, &encoded)?; // Commit: one small secret-store entry, never a partial grant.
    clear_slot(store, key, 1 - slot)
}
pub(super) fn remove(store: &dyn SecretStore, key: &str) -> Result<(), String> {
    let root = store.delete(key); // Refuse future loads even when a subsequent cleanup fails.
    let a = clear_slot(store, key, 0);
    let b = clear_slot(store, key, 1);
    root.and(a).and(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    #[derive(Default)]
    struct Bounded {
        values: Mutex<HashMap<String, String>>,
        fail_set: Mutex<Option<String>>,
        fail_delete: Mutex<Option<String>>,
    }
    impl SecretStore for Bounded {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            if self.fail_set.lock().unwrap().as_deref() == Some(key) {
                return Err("synthetic store failure".into());
            }
            assert!(
                value.len() <= PART && value.encode_utf16().count() * 2 <= 2560,
                "secret record must fit Windows credential entries"
            );
            self.values.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            if self.fail_delete.lock().unwrap().as_deref() == Some(key) {
                return Err("synthetic cleanup failure".into());
            }
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }
    #[test]
    fn long_unicode_grants_fit_windows_and_are_fully_removed() {
        let store = Bounded::default();
        let value = format!("{}{}", "a".repeat(16000), "€😀".repeat(4000));
        save(&store, "fixture", &value).unwrap();
        assert_eq!(load(&store, "fixture").unwrap(), Some(value));
        remove(&store, "fixture").unwrap();
        assert!(store.values.lock().unwrap().is_empty());
    }
    #[test]
    fn failed_manifest_commit_keeps_old_grant_and_interrupted_parts_remain_erasable() {
        let store = Bounded::default();
        save(&store, "fixture", "old").unwrap();
        *store.fail_set.lock().unwrap() = Some("fixture".into());
        assert!(save(&store, "fixture", &"replacement".repeat(500)).is_err());
        assert_eq!(load(&store, "fixture").unwrap().as_deref(), Some("old"));
        remove(&store, "fixture").unwrap();
        assert!(store.values.lock().unwrap().is_empty());
    }
    #[test]
    fn corrupt_or_missing_parts_never_return_partial_credentials_and_legacy_reads_work() {
        let store = Bounded::default();
        store.set("legacy", "{\"legacy\":true}").unwrap();
        assert_eq!(
            load(&store, "legacy").unwrap().as_deref(),
            Some("{\"legacy\":true}")
        );
        save(&store, "fixture", &"x".repeat(3000)).unwrap();
        store
            .values
            .lock()
            .unwrap()
            .insert(part("fixture", 0, 1), "tampered".into());
        assert!(load(&store, "fixture").is_err());
        store.values.lock().unwrap().remove(&part("fixture", 0, 1));
        assert!(load(&store, "fixture").is_err());
        assert!(save(&store, "too-big", &"x".repeat(BYTES + 1)).is_err());
    }
    #[test]
    fn alternating_slots_commit_before_cleanup_and_shorter_replacements_clear_old_tails() {
        let store = Bounded::default();
        save(&store, "fixture", &"a".repeat(5000)).unwrap();
        *store.fail_delete.lock().unwrap() = Some(part("fixture", 0, 0));
        assert!(save(&store, "fixture", "new").is_err());
        assert_eq!(load(&store, "fixture").unwrap().as_deref(), Some("new"));
        *store.fail_delete.lock().unwrap() = None;
        save(&store, "fixture", "short").unwrap();
        assert_eq!(store.values.lock().unwrap().len(), 2);
        assert_eq!(load(&store, "fixture").unwrap().as_deref(), Some("short"));
        remove(&store, "fixture").unwrap();
        assert!(store.values.lock().unwrap().is_empty());
    }
}
