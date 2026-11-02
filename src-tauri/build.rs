use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// The civil date of a day count since 1970-01-01 (Howard Hinnant's days_from_civil, inverted).
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn main() {
    // M10 F2: the build's commit and day, so the desktop and HULK can tell each other's builds
    // apart. "unknown" outside a git checkout (a source tarball, say).
    let commit = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_owned());
    let secs = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        });
    let (y, m, d) = civil(secs.div_euclid(86_400));
    println!("cargo:rustc-env=FUSE_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=FUSE_BUILD_DATE={y:04}-{m:02}-{d:02}");
    // Build again when the checkout moves to another commit.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    if let Ok(head) = std::fs::read_to_string("../.git/HEAD")
        && let Some(r) = head.trim().strip_prefix("ref: ")
    {
        println!("cargo:rerun-if-changed=../.git/{r}");
    }
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    tauri_build::build()
}
