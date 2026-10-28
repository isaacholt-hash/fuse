//! Global quick capture (CH-08, PL-07): a system-wide shortcut brings FUSE forward on a new chat.
//! The shortcut is registered here; the app is told through a "quick-capture" event.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Brings the main window forward and tells the app to open a new chat.
pub fn capture(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("quick-capture", ());
}

/// Wayland compositors don't let apps grab keys system-wide (it's an X11 feature), so the
/// shortcut may never fire there; Settings says so.
pub fn wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"))
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    /// The shortcut now active, or None when turned off.
    pub shortcut: Option<String>,
    /// The desktop may not deliver global shortcuts (Wayland).
    pub may_not_work: bool,
}

pub mod commands {
    use super::*;

    /// Replaces the quick-capture shortcut; None turns it off.
    #[tauri::command]
    pub fn quick_capture_set(
        app: AppHandle,
        shortcut: Option<String>,
    ) -> Result<ShortcutStatus, String> {
        let gs = app.global_shortcut();
        gs.unregister_all().map_err(|e| e.to_string())?;
        if let Some(text) = &shortcut {
            let parsed: Shortcut = text
                .parse()
                .map_err(|_| format!("\"{text}\" isn't a shortcut FUSE understands."))?;
            gs.on_shortcut(parsed, |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    capture(app);
                }
            })
            .map_err(|e| format!("Couldn't use {text}: {e} (another app may have it)."))?;
        }
        Ok(ShortcutStatus {
            shortcut,
            may_not_work: wayland(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_and_common_shortcuts_parse() {
        // The app's default (src/app/quickCapture.ts) and other common ones.
        for s in ["Ctrl+Alt+Space", "Ctrl+Shift+Space", "Alt+F", "Super+J"] {
            assert!(s.parse::<Shortcut>().is_ok(), "{s}");
        }
        assert!("Ctrl+Nonsense".parse::<Shortcut>().is_err());
    }
}
