//! Reads a public web page for a chat (FK-06): GET only, no cookies, no key, no scripts run here.
//! Private, local and link-local addresses are refused, after DNS too and on every redirect, so a
//! pasted link can't reach services on this machine or the local network. Size and time capped.

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;

/// The most of a page that is read; anything longer is cut (FK-06's size cap).
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebPage {
    /// Where the page was read from, after redirects.
    pub url: String,
    pub content_type: String,
    pub body: String,
    pub truncated: bool,
}

/// Only addresses on the public internet.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (64..128).contains(&o[1])) // carrier-grade NAT, Tailscale
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 198 && (18..20).contains(&o[1]))
                || o[0] >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let s = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80) // link local
        }
    }
}

/// Checks a link before anything is sent: http(s), a host name or public IP, no credentials.
pub fn check_url(raw: &str) -> Result<reqwest::Url, String> {
    let url =
        reqwest::Url::parse(raw.trim()).map_err(|_| "That isn't a web address.".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("Only http and https links can be read.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Links with a user name or password aren't read.".into());
    }
    let host = url.host_str().ok_or("That link has no host.")?;
    let lower = host.to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
    {
        return Err("Links to this computer or the local network aren't read.".into());
    }
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>()
        && !is_public(ip)
    {
        return Err("Links to this computer or the local network aren't read.".into());
    }
    Ok(url)
}

/// Resolves the host and refuses it unless every address is public; returns one to connect to.
fn resolve_public(url: &reqwest::Url) -> Result<SocketAddr, String> {
    let host = url.host_str().ok_or("That link has no host.")?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = (host.trim_matches(['[', ']']), port)
        .to_socket_addrs()
        .map_err(|_| format!("Couldn't find {host}."))?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|a| !is_public(a.ip())) {
        return Err("Links to this computer or the local network aren't read.".into());
    }
    Ok(addrs[0])
}

async fn read(start: &str) -> Result<WebPage, String> {
    let mut url = check_url(start)?;
    for _ in 0..=MAX_REDIRECTS {
        let target = url.clone();
        let addr = tauri::async_runtime::spawn_blocking(move || resolve_public(&target))
            .await
            .map_err(|e| e.to_string())??;
        let host = url.host_str().unwrap_or_default().to_string();
        // Pinned to the address just checked, so DNS can't change between check and connect.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .user_agent("FUSE/0.1 (reads one page for a chat)")
            .resolve(&host, addr)
            .build()
            .map_err(|e| e.to_string())?;
        let mut res = client
            .get(url.clone())
            .header(
                "accept",
                "text/html, text/plain, application/xhtml+xml, */*;q=0.5",
            )
            .send()
            .await
            .map_err(|e| format!("Couldn't read the page: {}", e.without_url()))?;
        if res.status().is_redirection() {
            let next = res
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or("The page redirected without saying where.")?;
            url = check_url(url.join(next).map_err(|e| e.to_string())?.as_str())?;
            continue;
        }
        if !res.status().is_success() {
            return Err(format!("The page answered {}.", res.status()));
        }
        let content_type = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let ct = content_type.to_ascii_lowercase();
        if !(ct.is_empty()
            || ct.starts_with("text/")
            || ct.contains("html")
            || ct.contains("xml")
            || ct.contains("json"))
        {
            return Err(format!("That link isn't a web page ({content_type})."));
        }
        let mut body: Vec<u8> = Vec::new();
        let mut truncated = false;
        while let Some(chunk) = res
            .chunk()
            .await
            .map_err(|e| format!("Couldn't read the page: {}", e.without_url()))?
        {
            let room = MAX_BYTES - body.len();
            if chunk.len() > room {
                body.extend_from_slice(&chunk[..room]);
                truncated = true;
                break;
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(WebPage {
            url: url.to_string(),
            content_type,
            body: String::from_utf8_lossy(&body).into_owned(),
            truncated,
        });
    }
    Err("Too many redirects.".into())
}

pub mod commands {
    use super::*;

    #[tauri::command]
    pub async fn url_fetch(url: String) -> Result<WebPage, String> {
        read(&url).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_addresses() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.1.223",
            "172.16.0.1",
            "169.254.1.1",
            "100.93.123.90",
            "0.0.0.0",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn links_are_checked_before_anything_is_sent() {
        assert!(check_url("https://example.com/a?b=c").is_ok());
        assert!(check_url("http://example.com").is_ok());
        for bad in [
            "file:///etc/passwd",
            "ftp://example.com",
            "https://localhost:3000",
            "http://printer.local",
            "http://127.0.0.1/admin",
            "http://[::1]/",
            "http://192.168.1.1",
            "https://user:pass@example.com",
            "not a url",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
    }
}
