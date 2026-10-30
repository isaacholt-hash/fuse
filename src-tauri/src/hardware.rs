//! What this computer can run (M7 step 5, LL-03): memory, CPU features and free disk, read
//! without elevated rights. The choice of model is made from this in TypeScript
//! (src/local/hardware.ts), so it can be tested and explained in one place.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub os: String,
    pub arch: String,
    pub logical_cpus: usize,
    pub total_memory_bytes: u64,
    pub available_memory_bytes: u64,
    /// AVX2, FMA and F16C: what the local model's build of llama.cpp needs.
    pub cpu_supported: bool,
    /// On the disk that holds the app's data folder; null when it can't be read.
    pub free_disk_bytes: Option<u64>,
}

/// Free space on the disk whose mount point is the longest prefix of `path`.
fn free_disk(path: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| path.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(sysinfo::Disk::available_space)
}

pub fn detect(data_dir: &Path) -> Hardware {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    // The data folder may not exist yet on a first run; its parent is on the same disk.
    let probe = std::iter::successors(Some(data_dir), |p| p.parent())
        .find(|p| p.exists())
        .unwrap_or(data_dir);
    let probe = std::fs::canonicalize(probe).unwrap_or_else(|_| probe.to_path_buf());
    Hardware {
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        logical_cpus: std::thread::available_parallelism().map_or(1, |n| n.get()),
        total_memory_bytes: sys.total_memory(),
        available_memory_bytes: sys.available_memory(),
        cpu_supported: crate::local_worker::cpu_supported(),
        free_disk_bytes: free_disk(&probe),
    }
}

pub mod commands {
    use super::*;
    use tauri::{AppHandle, Manager};

    #[tauri::command]
    pub fn local_hardware(app: AppHandle) -> Result<Hardware, String> {
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        Ok(detect(&data))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_this_computer() {
        let hw = detect(&std::env::temp_dir().join("fuse-hw-test/does/not/exist"));
        assert!(hw.total_memory_bytes > 0);
        assert!(hw.available_memory_bytes <= hw.total_memory_bytes);
        assert!(hw.logical_cpus >= 1);
        assert!(hw.free_disk_bytes.is_some_and(|b| b > 0));
        assert_eq!(hw.os, std::env::consts::OS);
    }
}
