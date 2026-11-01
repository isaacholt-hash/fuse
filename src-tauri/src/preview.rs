//! Live previews of HTML artifacts (AR-05). Each page is served from its own `preview:` scheme
//! with a strict Content-Security-Policy: scripts and styles inline, images and fonts from data:
//! URLs, and no network at all. The app shows it in an iframe sandboxed without same-origin, so
//! the page can't reach the app, the keys or the database either.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::http::{Request, Response, StatusCode};

use crate::ctx::Ctx;

/// The policy every preview is served with: nothing leaves the frame.
pub const PREVIEW_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; \
    style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; \
    connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/// The CDNs a preview may load from when its artifact allows them (AR-05's per-artifact switch).
pub const CDNS: &str = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com";

/// The policy with the listed CDNs allowed for scripts, styles, images, fonts and fetches.
pub fn cdn_csp() -> String {
    format!(
        "default-src 'none'; script-src 'unsafe-inline' {CDNS}; style-src 'unsafe-inline' {CDNS}; \
         img-src data: blob: {CDNS}; font-src data: {CDNS}; media-src data: blob:; \
         connect-src {CDNS}; frame-src 'none'; form-action 'none'; base-uri 'none'"
    )
}

/// Pages kept for previews; older ones are dropped.
const KEPT: usize = 20;
/// The largest page served (artifacts are text the model wrote; this is generous).
pub const MAX_BYTES: usize = 5 * 1024 * 1024;

#[derive(Default)]
pub struct Previews {
    next: AtomicU64,
    /// Id, page, and whether it may load the listed CDNs.
    pages: Mutex<VecDeque<(String, String, bool)>>,
}

impl Previews {
    pub fn put(&self, html: String, cdn: bool) -> Result<String, String> {
        if html.len() > MAX_BYTES {
            return Err("This page is too big to preview.".into());
        }
        let id = format!("p{}", self.next.fetch_add(1, Ordering::Relaxed));
        let mut pages = self.pages.lock().map_err(|e| e.to_string())?;
        pages.push_back((id.clone(), html, cdn));
        while pages.len() > KEPT {
            pages.pop_front();
        }
        Ok(id)
    }

    pub fn get(&self, id: &str) -> Option<(String, bool)> {
        let pages = self.pages.lock().ok()?;
        pages
            .iter()
            .find(|(k, _, _)| k == id)
            .map(|(_, v, cdn)| (v.clone(), *cdn))
    }
}

/// Answers `preview://localhost/<id>` (or `http://preview.localhost/<id>` on Windows).
pub fn respond(previews: &Previews, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let id = request.uri().path().trim_start_matches('/');
    match previews.get(id) {
        Some((html, cdn)) => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/html; charset=utf-8")
            .header(
                "content-security-policy",
                if cdn {
                    cdn_csp()
                } else {
                    PREVIEW_CSP.to_string()
                },
            )
            .header("x-content-type-options", "nosniff")
            .header("cache-control", "no-store")
            .body(html.into_bytes())
            .unwrap_or_default(),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap_or_default(),
    }
}

/// Stores a page for preview; returns the id to load as `preview://localhost/<id>`.
/// `cdn` lets this page load the listed CDNs; without it, nothing leaves the frame.
pub(crate) fn preview_put(ctx: &Ctx, html: String, cdn: Option<bool>) -> Result<String, String> {
    ctx.previews.put(html, cdn.unwrap_or(false))
}

pub mod commands {
    use super::*;
    use tauri::State;

    #[tauri::command]
    pub fn preview_put(
        ctx: State<'_, Ctx>,
        html: String,
        cdn: Option<bool>,
    ) -> Result<String, String> {
        super::preview_put(&ctx, html, cdn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_are_served_with_a_no_network_policy_and_old_ones_drop() {
        let previews = Previews::default();
        let id = previews.put("<p>hi</p>".into(), false).unwrap();
        let req = Request::builder()
            .uri(format!("preview://localhost/{id}"))
            .body(Vec::new())
            .unwrap();
        let res = respond(&previews, &req);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"<p>hi</p>");
        let csp = res.headers()["content-security-policy"].to_str().unwrap();
        assert!(csp.contains("default-src 'none'") && csp.contains("connect-src 'none'"));

        for _ in 0..KEPT {
            previews.put("x".into(), false).unwrap();
        }
        assert_eq!(respond(&previews, &req).status(), StatusCode::NOT_FOUND);
        assert!(previews.put("y".repeat(MAX_BYTES + 1), false).is_err());
    }

    #[test]
    fn a_page_allowed_cdns_may_load_only_the_listed_ones() {
        let previews = Previews::default();
        let id = previews.put("<p>cdn</p>".into(), true).unwrap();
        let req = Request::builder()
            .uri(format!("preview://localhost/{id}"))
            .body(Vec::new())
            .unwrap();
        let res = respond(&previews, &req);
        let csp = res.headers()["content-security-policy"].to_str().unwrap();
        assert!(csp.contains("script-src 'unsafe-inline' https://cdnjs.cloudflare.com"));
        assert!(csp.contains("connect-src https://cdnjs.cloudflare.com"));
        assert!(csp.contains("default-src 'none'") && !csp.contains("*"));
    }
}
