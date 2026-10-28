//! "Save as…" for artifact exports (AR-04). The native dialog and the write both happen here, so
//! the webview never picks a path: a page can only offer bytes and a suggested name.

use tauri::AppHandle;
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;

/// The largest export written (artifacts are text; a .docx or .pdf of one stays far below this).
pub const MAX_BYTES: usize = 50 * 1024 * 1024;

/// A file name safe on Windows and Linux: no paths, no reserved characters, never empty.
pub fn safe_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let name: String = trimmed.chars().take(120).collect();
    if name.is_empty() {
        "artifact.txt".into()
    } else {
        name
    }
}

pub mod commands {
    use super::*;

    /// Body: the bytes. Header `x-file-name`: the suggested name. Returns the saved file's name,
    /// or None when the dialog was cancelled.
    #[tauri::command]
    pub async fn save_as(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
        let InvokeBody::Raw(bytes) = request.body() else {
            return Err("expected raw bytes".into());
        };
        if bytes.len() > MAX_BYTES {
            return Err("That's too big to save.".into());
        }
        let name = safe_name(
            request
                .headers()
                .get("x-file-name")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("artifact.txt"),
        );
        let ext = name
            .rsplit_once('.')
            .map(|(_, e)| e.to_string())
            .unwrap_or_default();
        let mut dialog = app.dialog().file().set_file_name(&name);
        if !ext.is_empty() {
            dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
        }
        let Some(path) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, bytes).map_err(|e| format!("Couldn't save: {e}"))?;
        Ok(path.file_name().map(|n| n.to_string_lossy().into_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_made_safe() {
        assert_eq!(safe_name("Lisbon trip.md"), "Lisbon trip.md");
        assert_eq!(safe_name("../../etc/passwd"), "-..-etc-passwd");
        assert_eq!(safe_name("a:b*c?.pdf"), "a-b-c-.pdf");
        assert_eq!(safe_name("  ...  "), "artifact.txt");
        assert_eq!(safe_name(&"x".repeat(300)).len(), 120);
    }
}
