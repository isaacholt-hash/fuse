//! M18.3: provider usage and cost reports (CO-06, MM-12).
//!
//! Collection uses a dedicated reporting credential per provider (`report:openai`,
//! `report:anthropic` in the secret store), never a chat key. Only the fixed read-only report
//! URLs below are ever requested; the webview can't name a URL or see the credential. Errors are
//! reduced to fixed messages: no headers, bodies or credentials reach logs or the UI.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::{ctx::Ctx, keys::Provider};

/// fuse-server sets this at startup, so the background collector knows it runs on HULK.
pub static ON_SERVER: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);

const OPENAI: &str = "https://api.openai.com";
const ANTHROPIC: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2026-10-21";
const ANTHROPIC_BETA: &str = "analytics-usage-cost-2026-08-24";
const DAY_MS: i64 = 86_400_000;
/// The last seven UTC days are revisited every time, so late corrections replace old values.
const WINDOW_DAYS: i64 = 7;
const MAX_PAGES: usize = 40;
const MAX_BODY: usize = 4 * 1024 * 1024;
const REFRESH: Duration = Duration::from_secs(6 * 3600);
const TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn account(p: Provider) -> &'static str {
    match p {
        Provider::Openai => "report:openai",
        Provider::Anthropic => "report:anthropic",
    }
}
fn name(p: Provider) -> &'static str {
    match p {
        Provider::Openai => "openai",
        Provider::Anthropic => "anthropic",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Ok,
    Auth,
    RateLimited,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub state: RunState,
    pub pages: usize,
    pub rows: usize,
    pub window_start: i64,
    pub window_end: i64,
    /// A fixed, credential-free sentence.
    pub message: String,
}

/// One normalized report row.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ReportRow {
    pub kind: &'static str,
    pub bucket_start: i64,
    pub bucket_end: i64,
    pub scope: String,
    pub api_key_id: String,
    pub model: String,
    pub line_item: String,
    pub currency: String,
    pub amount_micro: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
    pub requests: Option<i64>,
}

#[derive(Debug)]
enum Failure {
    Auth,
    RateLimited,
    Error(&'static str),
}

// ---- Dates --------------------------------------------------------------------------------

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
/// `2026-11-06T00:00:00Z` for a UTC millisecond time (whole seconds).
pub(crate) fn rfc3339(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        s / 3600,
        (s / 60) % 60,
        s % 60
    )
}
/// Parses `YYYY-MM-DDTHH:MM:SS(.fff)Z` or `+00:00`, the forms the reports use, to UTC ms.
pub(crate) fn parse_rfc3339(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| text.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let rest = &text[19..];
    let zone = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if !(zone == "Z" || zone == "+00:00") || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    Some(((days_from_civil(y, mo, d) * 86_400) + h * 3600 + mi * 60 + s) * 1000)
}

/// The revisit window: the start of the UTC day seven days ago to the start of tomorrow.
pub(crate) fn window(now_ms: i64) -> (i64, i64) {
    let today = now_ms.div_euclid(DAY_MS) * DAY_MS;
    (today - WINDOW_DAYS * DAY_MS, today + DAY_MS)
}

// ---- Amounts ------------------------------------------------------------------------------

/// OpenAI amounts are JSON numbers in dollars.
fn dollars_to_micro(v: &Value) -> Option<i64> {
    let f = v.as_f64()?;
    if !f.is_finite() || f.abs() > 1e12 {
        return None;
    }
    Some((f * 1_000_000.0).round() as i64)
}
/// Anthropic amounts are decimal strings in cents ("41280.000000" is $412.80). Exact parse.
pub(crate) fn cents_to_micro(text: &str) -> Option<i64> {
    let (neg, t) = text
        .strip_prefix('-')
        .map_or((false, text), |rest| (true, rest));
    let (int, frac) = t.split_once('.').unwrap_or((t, ""));
    if int.is_empty()
        || !int.bytes().all(|b| b.is_ascii_digit())
        || !frac.bytes().all(|b| b.is_ascii_digit())
        || int.len() > 14
    {
        return None;
    }
    // micro-dollars = cents × 10,000: the first four fraction digits are whole micro-dollars.
    let mut digits = frac.to_owned();
    while digits.len() < 5 {
        digits.push('0');
    }
    let whole: i64 = digits[..4].parse().ok()?;
    let round = i64::from(digits.as_bytes()[4] >= b'5');
    let micro = int.parse::<i64>().ok()? * 10_000 + whole + round;
    Some(if neg { -micro } else { micro })
}

/// Percent-encodes a page cursor for a query string (RFC 3986 unreserved characters kept).
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_owned()
}
fn int(v: &Value) -> Option<i64> {
    v.as_i64()
}

// ---- Parsing ------------------------------------------------------------------------------

pub(crate) fn openai_page(kind: &'static str, page: &Value) -> Result<Vec<ReportRow>, ()> {
    let mut out = Vec::new();
    for bucket in page["data"].as_array().ok_or(())? {
        let start = bucket["start_time"].as_i64().ok_or(())? * 1000;
        let end = bucket["end_time"].as_i64().ok_or(())? * 1000;
        for r in bucket["results"].as_array().ok_or(())? {
            let mut row = ReportRow {
                kind,
                bucket_start: start,
                bucket_end: end,
                scope: text(&r["project_id"]),
                api_key_id: text(&r["api_key_id"]),
                currency: "usd".into(),
                ..ReportRow::default()
            };
            if kind == "cost" {
                row.line_item = text(&r["line_item"]);
                row.currency = r["amount"]["currency"]
                    .as_str()
                    .unwrap_or("usd")
                    .to_ascii_lowercase();
                row.amount_micro = Some(dollars_to_micro(&r["amount"]["value"]).ok_or(())?);
            } else {
                row.model = text(&r["model"]);
                // input_tokens already includes cached and cache-write tokens.
                row.input_tokens = int(&r["input_tokens"]);
                row.output_tokens = int(&r["output_tokens"]);
                row.cached_tokens = int(&r["input_cached_tokens"]);
                row.requests = int(&r["num_model_requests"]);
            }
            out.push(row);
        }
    }
    Ok(out)
}

pub(crate) fn anthropic_page(kind: &'static str, page: &Value) -> Result<Vec<ReportRow>, ()> {
    let mut out = Vec::new();
    for r in page["data"].as_array().ok_or(())? {
        let start = parse_rfc3339(r["starting_at"].as_str().ok_or(())?).ok_or(())?;
        let end = parse_rfc3339(r["ending_at"].as_str().ok_or(())?).ok_or(())?;
        let g = &r["group"];
        let mut row = ReportRow {
            kind,
            bucket_start: start,
            bucket_end: end,
            scope: text(&g["workspace_id"]),
            api_key_id: text(&g["api_key_id"]),
            model: text(&g["model"]),
            currency: "usd".into(),
            ..ReportRow::default()
        };
        if kind == "cost" {
            let c = &r["cost"];
            row.currency = c["currency"].as_str().unwrap_or("USD").to_ascii_lowercase();
            row.amount_micro = Some(cents_to_micro(c["amount"].as_str().ok_or(())?).ok_or(())?);
            row.requests = int(&c["requests"]);
        } else {
            let u = &r["usage"];
            let uncached = int(&u["uncached_input_tokens"]).unwrap_or(0);
            let read = int(&u["cache_read_input_tokens"]).unwrap_or(0);
            let created = int(&u["cache_creation"]["ephemeral_5m_input_tokens"]).unwrap_or(0)
                + int(&u["cache_creation"]["ephemeral_1h_input_tokens"]).unwrap_or(0);
            row.input_tokens = Some(uncached + read + created);
            row.cached_tokens = Some(read);
            row.output_tokens = int(&u["output_tokens"]);
            row.requests = int(&u["requests"]);
        }
        out.push(row);
    }
    Ok(out)
}

// ---- Fetching -----------------------------------------------------------------------------

fn urls(p: Provider, base: &str, start: i64, end: i64) -> Vec<(&'static str, String)> {
    match p {
        Provider::Openai => {
            let range = format!(
                "start_time={}&end_time={}&bucket_width=1d",
                start / 1000,
                end / 1000
            );
            vec![
                (
                    "cost",
                    format!(
                        "{base}/v1/organization/costs?{range}&group_by[]=project_id&group_by[]=line_item&group_by[]=api_key_id&limit=31"
                    ),
                ),
                (
                    "usage",
                    format!(
                        "{base}/v1/organization/usage/completions?{range}&group_by[]=project_id&group_by[]=model&group_by[]=api_key_id&limit=31"
                    ),
                ),
            ]
        }
        Provider::Anthropic => {
            let range = format!(
                "starting_at={}&ending_at={}&time_bucket_width=1d&group_by[]=model&group_by[]=workspace_id&group_by[]=api_key_id&limit=1000",
                rfc3339(start),
                rfc3339(end)
            );
            vec![
                (
                    "cost",
                    format!("{base}/v1/organizations/analytics/cost?{range}"),
                ),
                (
                    "usage",
                    format!("{base}/v1/organizations/analytics/usage?{range}"),
                ),
            ]
        }
    }
}

async fn get_page(
    client: &reqwest::Client,
    p: Provider,
    url: &str,
    key: &str,
) -> Result<Value, Failure> {
    let mut req = client.get(url).timeout(TIMEOUT);
    req = match p {
        Provider::Openai => req.bearer_auth(key),
        Provider::Anthropic => req
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("anthropic-beta", ANTHROPIC_BETA),
    };
    let response = req
        .send()
        .await
        .map_err(|_| Failure::Error("Couldn't reach the provider's report service."))?;
    match response.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err(Failure::Auth),
        429 => return Err(Failure::RateLimited),
        400 => return Err(Failure::Error("The provider refused the report request.")),
        _ => {
            return Err(Failure::Error(
                "The provider's report service had a problem.",
            ));
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| Failure::Error("The report was cut off."))?;
    if bytes.len() > MAX_BODY {
        return Err(Failure::Error("A report page was larger than expected."));
    }
    serde_json::from_slice(&bytes).map_err(|_| Failure::Error("The report wasn't readable."))
}

/// Every page of both reports for the window. Pages follow `next_page` until `has_more` is false.
async fn fetch(
    client: &reqwest::Client,
    p: Provider,
    key: &str,
    base: &str,
    start: i64,
    end: i64,
) -> Result<(Vec<ReportRow>, usize, Option<i64>), Failure> {
    let mut rows = Vec::new();
    let mut pages = 0;
    let mut refreshed = None;
    for (kind, first) in urls(p, base, start, end) {
        let mut url = first.clone();
        loop {
            pages += 1;
            if pages > MAX_PAGES {
                return Err(Failure::Error("The report had more pages than expected."));
            }
            let page = get_page(client, p, &url, key).await?;
            let parsed = match p {
                Provider::Openai => openai_page(kind, &page),
                Provider::Anthropic => anthropic_page(kind, &page),
            }
            .map_err(|()| Failure::Error("The report wasn't in the expected shape."))?;
            rows.extend(parsed);
            if let Some(at) = page["data_refreshed_at"].as_str().and_then(parse_rfc3339) {
                refreshed = Some(refreshed.map_or(at, |r: i64| r.min(at)));
            }
            match (page["has_more"].as_bool(), page["next_page"].as_str()) {
                (Some(true), Some(next)) if !next.is_empty() && next.len() < 2048 => {
                    url = format!("{first}&page={}", encode(next));
                }
                (Some(true), _) => {
                    return Err(Failure::Error("The report's next page was missing."));
                }
                _ => break,
            }
        }
    }
    Ok((rows, pages, refreshed))
}

// ---- Storing ------------------------------------------------------------------------------

fn row_id(provider: &str, source: &str, r: &ReportRow) -> String {
    crate::skill_scripts::digest(
        format!(
            "{provider}|{}|{source}|{}|{}|{}|{}|{}",
            r.kind, r.bucket_start, r.scope, r.api_key_id, r.model, r.line_item
        )
        .as_bytes(),
    )
}

/// Replaces the window's API rows with this complete report, in one transaction.
async fn store(
    pool: &sqlx::SqlitePool,
    provider: &str,
    run: &str,
    start: i64,
    end: i64,
    rows: &[ReportRow],
) -> Result<(), String> {
    let now = crate::sync::now();
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| "Couldn't save the report.")?;
    for r in rows {
        sqlx::query(
            "INSERT INTO usage_report_rows(id,workspace_id,user_id,provider,kind,source,bucket_start,bucket_end,scope,key_ref,model,line_item,currency,amount_micro,input_tokens,output_tokens,cached_tokens,requests,run_id,created_at,updated_at)
             VALUES (?,?,?,?,?,'api',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(workspace_id,user_id,provider,kind,source,bucket_start,scope,key_ref,model,line_item)
             DO UPDATE SET bucket_end=excluded.bucket_end,currency=excluded.currency,amount_micro=excluded.amount_micro,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,requests=excluded.requests,run_id=excluded.run_id,updated_at=excluded.updated_at",
        )
        .bind(row_id(provider, "api", r))
        .bind(crate::sync::WORKSPACE)
        .bind(crate::sync::USER)
        .bind(provider)
        .bind(r.kind)
        .bind(r.bucket_start)
        .bind(r.bucket_end)
        .bind(&r.scope)
        .bind(&r.api_key_id)
        .bind(&r.model)
        .bind(&r.line_item)
        .bind(&r.currency)
        .bind(r.amount_micro)
        .bind(r.input_tokens)
        .bind(r.output_tokens)
        .bind(r.cached_tokens)
        .bind(r.requests)
        .bind(run)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|_| "Couldn't save the report.")?;
    }
    // Rows the provider no longer reports for the window were corrected away.
    sqlx::query("DELETE FROM usage_report_rows WHERE workspace_id=? AND user_id=? AND provider=? AND source='api' AND bucket_start>=? AND bucket_start<? AND run_id IS NOT ?")
        .bind(crate::sync::WORKSPACE)
        .bind(crate::sync::USER)
        .bind(provider)
        .bind(start)
        .bind(end)
        .bind(run)
        .execute(&mut *tx)
        .await
        .map_err(|_| "Couldn't save the report.")?;
    tx.commit().await.map_err(|_| "Couldn't save the report.")?;
    Ok(())
}

/// Collects one provider's reports for the revisit window and records a sanitized run.
pub(crate) async fn collect(
    ctx: &Ctx,
    p: Provider,
    base: Option<&str>,
    now_ms: i64,
) -> Result<RunSummary, String> {
    let key = ctx
        .keys
        .store
        .get(account(p))
        .map_err(|_| "Couldn't read the reporting key.")?
        .ok_or("Add a reporting key for this provider first.")?;
    let (start, end) = window(now_ms);
    let pool = ctx.db.pool()?;
    let run = uuid_like(now_ms);
    let now = crate::sync::now();
    sqlx::query("INSERT INTO usage_report_runs(id,workspace_id,user_id,provider,source,state,window_start,window_end,created_at,updated_at) VALUES (?,?,?,?,'api','running',?,?,?,?)")
        .bind(&run).bind(crate::sync::WORKSPACE).bind(crate::sync::USER).bind(name(p))
        .bind(start).bind(end).bind(now).bind(now)
        .execute(&pool).await.map_err(|_| "Couldn't record the report run.")?;
    let base = base.unwrap_or(match p {
        Provider::Openai => OPENAI,
        Provider::Anthropic => ANTHROPIC,
    });
    let outcome = fetch(&ctx.keys.client, p, &key, base, start, end).await;
    let summary = match outcome {
        Ok((rows, pages, refreshed)) => {
            store(&pool, name(p), &run, start, end, &rows).await?;
            sqlx::query("UPDATE usage_report_runs SET state='ok',pages=?,rows=?,refreshed_at=?,message=?,updated_at=? WHERE id=?")
                .bind(pages as i64).bind(rows.len() as i64).bind(refreshed)
                .bind("Report collected.").bind(crate::sync::now()).bind(&run)
                .execute(&pool).await.map_err(|_| "Couldn't record the report run.")?;
            RunSummary {
                state: RunState::Ok,
                pages,
                rows: rows.len(),
                window_start: start,
                window_end: end,
                message: "Report collected.".into(),
            }
        }
        Err(f) => {
            let (state, db_state, message) = match f {
                Failure::Auth => (
                    RunState::Auth,
                    "auth",
                    "The reporting key was refused. It needs organization admin access.",
                ),
                Failure::RateLimited => (
                    RunState::RateLimited,
                    "rate_limited",
                    "The provider asked to slow down. The next refresh will try again.",
                ),
                Failure::Error(m) => (RunState::Error, "error", m),
            };
            sqlx::query("UPDATE usage_report_runs SET state=?,message=?,updated_at=? WHERE id=?")
                .bind(db_state)
                .bind(message)
                .bind(crate::sync::now())
                .bind(&run)
                .execute(&pool)
                .await
                .map_err(|_| "Couldn't record the report run.")?;
            RunSummary {
                state,
                pages: 0,
                rows: 0,
                window_start: start,
                window_end: end,
                message: message.into(),
            }
        }
    };
    Ok(summary)
}

fn uuid_like(now_ms: i64) -> String {
    let mut b = [0u8; 10];
    let _ = getrandom::fill(&mut b);
    format!("report-{now_ms:x}-{}", crate::sync::crypto::hex(&b))
}

// ---- Credentials and background refresh ---------------------------------------------------

pub(crate) fn key_saved(ctx: &Ctx, p: Provider) -> Result<bool, String> {
    Ok(ctx
        .keys
        .store
        .get(account(p))
        .map_err(|_| "Couldn't read the secret store.")?
        .is_some())
}
pub(crate) fn key_set(ctx: &Ctx, p: Provider, key: String) -> Result<bool, String> {
    let key = key.trim().to_owned();
    if key.len() < 20 || key.len() > 512 || key.chars().any(char::is_whitespace) {
        return Err("That doesn't look like a reporting key.".into());
    }
    ctx.keys
        .store
        .set(account(p), &key)
        .map_err(|_| "Couldn't save the key in the secret store.")?;
    Ok(true)
}
pub(crate) fn key_remove(ctx: &Ctx, p: Provider) -> Result<bool, String> {
    ctx.keys
        .store
        .delete(account(p))
        .map_err(|_| "Couldn't remove the key from the secret store.")?;
    Ok(false)
}

async fn setting(pool: &sqlx::SqlitePool, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM settings WHERE workspace_id=? AND user_id=? AND key=?")
        .bind(crate::sync::WORKSPACE)
        .bind(crate::sync::USER)
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

/// Whether this installation collects `p` now: the owner turned it on, a key is saved, and the
/// desktop defers to HULK when the owner chose HULK as the collector.
async fn due(ctx: &Ctx, p: Provider) -> bool {
    let Ok(pool) = ctx.db.pool() else {
        return false;
    };
    if setting(&pool, &format!("usage_report.{}", name(p)))
        .await
        .as_deref()
        != Some("on")
    {
        return false;
    }
    if !ON_SERVER.load(Ordering::Relaxed)
        && setting(&pool, "usage_report.collector").await.as_deref() == Some("hulk")
    {
        return false;
    }
    key_saved(ctx, p).unwrap_or(false)
}

/// Every six hours while the app runs, for each provider that is due.
pub(crate) fn start(ctx: &Ctx) -> Result<(), String> {
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let view = ctx.sync_view()?;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            for p in [Provider::Openai, Provider::Anthropic] {
                if due(&view, p).await {
                    let _ = collect(&view, p, None, crate::sync::now()).await;
                }
            }
            tokio::time::sleep(REFRESH).await;
        }
    });
    Ok(())
}

pub mod commands {
    use super::*;
    use tauri::State;

    #[tauri::command]
    pub fn report_key_status(ctx: State<'_, Ctx>, provider: Provider) -> Result<bool, String> {
        key_saved(&ctx, provider)
    }
    #[tauri::command]
    pub fn report_key_save(
        ctx: State<'_, Ctx>,
        provider: Provider,
        key: String,
    ) -> Result<bool, String> {
        key_set(&ctx, provider, key)
    }
    #[tauri::command]
    pub fn report_key_delete(ctx: State<'_, Ctx>, provider: Provider) -> Result<bool, String> {
        key_remove(&ctx, provider)
    }
    #[tauri::command]
    pub async fn report_refresh(
        ctx: State<'_, Ctx>,
        provider: Provider,
    ) -> Result<RunSummary, String> {
        collect(&ctx, provider, None, crate::sync::now()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dates_and_windows_are_utc_days() {
        let ms = parse_rfc3339("2026-11-06T13:45:10Z").unwrap();
        assert_eq!(rfc3339(ms), "2026-11-06T13:45:10Z");
        assert_eq!(
            parse_rfc3339("2026-11-06T00:00:00.000+00:00"),
            Some(ms - 49_510_000)
        );
        assert_eq!(parse_rfc3339("2026-11-06T00:00:00+02:00"), None);
        assert_eq!(parse_rfc3339("garbage"), None);
        let (start, end) = window(ms);
        assert_eq!(rfc3339(start), "2026-10-30T00:00:00Z");
        assert_eq!(rfc3339(end), "2026-11-07T00:00:00Z");
        assert_eq!(
            rfc3339(parse_rfc3339("2024-02-29T00:00:00Z").unwrap()),
            "2024-02-29T00:00:00Z"
        );
    }

    #[test]
    fn amounts_convert_exactly_to_micro_dollars() {
        assert_eq!(cents_to_micro("41280.000000"), Some(412_800_000));
        assert_eq!(cents_to_micro("123.45"), Some(1_234_500));
        assert_eq!(cents_to_micro("0.000050"), Some(1)); // half a micro-dollar rounds up
        assert_eq!(cents_to_micro("0.000049"), Some(0));
        assert_eq!(cents_to_micro("-5"), Some(-50_000));
        for bad in ["", "1e3", "12,5", "abc", ".5"] {
            assert_eq!(cents_to_micro(bad), None, "{bad}");
        }
        assert_eq!(dollars_to_micro(&json!(0.123456)), Some(123_456));
        assert_eq!(dollars_to_micro(&json!("1")), None);
    }

    #[test]
    fn both_providers_parse_into_normalized_rows() {
        let openai = json!({"object":"page","data":[{"object":"bucket","start_time":1793923200,"end_time":1794009600,"results":[
            {"object":"organization.costs.result","amount":{"value":1.25,"currency":"usd"},"line_item":"gpt-6-astra, input_tokens","project_id":"proj_1","api_key_id":"key_1"}
        ]}],"has_more":false,"next_page":null});
        let rows = openai_page("cost", &openai).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].amount_micro, Some(1_250_000));
        assert_eq!(rows[0].scope, "proj_1");
        assert_eq!(rows[0].bucket_start, 1_793_923_200_000);

        let usage = json!({"data":[{"start_time":1,"end_time":2,"results":[
            {"input_tokens":1000,"output_tokens":200,"input_cached_tokens":400,"num_model_requests":3,"model":"gpt-6-luna","project_id":null}
        ]}],"has_more":false});
        let u = &openai_page("usage", &usage).unwrap()[0];
        assert_eq!(
            (u.input_tokens, u.cached_tokens, u.requests),
            (Some(1000), Some(400), Some(3))
        );
        assert_eq!(u.scope, "");

        let anthropic = json!({"data":[{"starting_at":"2026-11-05T00:00:00Z","ending_at":"2026-11-06T00:00:00Z",
            "group":{"model":"claude-sonnet-5-5","workspace_id":"wrkspc_1","api_key_id":"apikey_1"},
            "cost":{"amount":"250.500000","list_amount":"300.000000","currency":"USD","requests":7}}],
            "has_more":false,"next_page":null,"data_refreshed_at":"2026-11-06T02:00:00Z"});
        let a = &anthropic_page("cost", &anthropic).unwrap()[0];
        assert_eq!(a.amount_micro, Some(2_505_000));
        assert_eq!((a.currency.as_str(), a.requests), ("usd", Some(7)));
        let au = json!({"data":[{"starting_at":"2026-11-05T00:00:00Z","ending_at":"2026-11-06T00:00:00Z","group":{},
            "usage":{"uncached_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":5},"cache_read_input_tokens":50,"output_tokens":20,"requests":2}}]});
        let au = &anthropic_page("usage", &au).unwrap()[0];
        assert_eq!(
            (au.input_tokens, au.cached_tokens, au.output_tokens),
            (Some(165), Some(50), Some(20))
        );
        assert!(openai_page("cost", &json!({"data":"nope"})).is_err());
        assert!(anthropic_page("cost", &json!({"data":[{"starting_at":"x"}]})).is_err());
    }

    /// Serves canned responses in order on 127.0.0.1, recording each request line and whether
    /// the expected credential header arrived.
    fn serve(
        responses: Vec<(u16, String)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = vec![0u8; 16384];
                let n = s.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = req.lines().next().unwrap_or_default().to_owned();
                let auth = req.lines().any(|l| {
                    let l = l.to_ascii_lowercase();
                    l.starts_with("authorization: bearer fake-report")
                        || l.starts_with("x-api-key: fake-report")
                });
                log.lock().unwrap().push(format!("{line} auth={auth}"));
                let _ = write!(
                    s,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        (base, seen)
    }

    async fn ctx_with_key(p: Provider) -> (Ctx, std::path::PathBuf) {
        use crate::keys::{Keys, MemoryStore};
        let mut tag = [0u8; 8];
        getrandom::fill(&mut tag).unwrap();
        let dir =
            std::env::temp_dir().join(format!("fuse-reports-{}", crate::sync::crypto::hex(&tag)));
        let ctx = Ctx::new(
            dir.join("data"),
            dir.join("config"),
            Keys::with_store(Box::<MemoryStore>::default()),
        );
        crate::db::db_open(&ctx).await.unwrap();
        key_set(&ctx, p, "fake-report-key-0123456789".into()).unwrap();
        (ctx, dir)
    }

    #[tokio::test]
    async fn collection_pages_replaces_corrections_and_reports_failures_without_secrets() {
        let (ctx, dir) = ctx_with_key(Provider::Openai).await;
        let pool = ctx.db.pool().unwrap();
        let now = parse_rfc3339("2026-11-06T12:00:00Z").unwrap();
        let day = parse_rfc3339("2026-11-05T00:00:00Z").unwrap() / 1000;
        let cost = |v: f64, more: bool| {
            json!({"data":[{"start_time":day,"end_time":day+86400,"results":[
            {"amount":{"value":v,"currency":"usd"},"line_item":"x, input","project_id":"proj_1","api_key_id":"k"}]}],
            "has_more":more,"next_page":if more {json!("cursor/2")} else {json!(null)}}).to_string()
        };
        let empty = json!({"data":[],"has_more":false,"next_page":null}).to_string();
        let (base, seen) = serve(vec![
            (200, cost(1.0, true)),
            (200, json!({"data":[{"start_time":day+86400,"end_time":day+172800,"results":[{"amount":{"value":0.5,"currency":"usd"},"line_item":"y","project_id":"proj_1","api_key_id":"k"}]}],"has_more":false}).to_string()),
            (200, empty.clone()),
            // A later run: the provider corrected day 1 and dropped day 2.
            (200, cost(2.0, false)),
            (200, empty.clone()),
            (401, "{\"error\":\"secret detail\"}".into()),
            (429, empty.clone()),
        ]);
        let first = collect(&ctx, Provider::Openai, Some(&base), now)
            .await
            .unwrap();
        assert_eq!((first.state, first.pages, first.rows), (RunState::Ok, 3, 2));
        let log = seen.lock().unwrap().clone();
        assert!(
            log[0].starts_with("GET /v1/organization/costs?start_time="),
            "{log:?}"
        );
        assert!(log[1].contains("&page=cursor%2F2"), "{log:?}");
        assert!(
            log[2].starts_with("GET /v1/organization/usage/completions?"),
            "{log:?}"
        );
        assert!(log.iter().all(|l| l.ends_with("auth=true")), "{log:?}");

        let second = collect(&ctx, Provider::Openai, Some(&base), now)
            .await
            .unwrap();
        assert_eq!(second.rows, 1);
        let rows = crate::db::select(&pool, "SELECT amount_micro FROM usage_report_rows", &[])
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["amount_micro"], json!(2_000_000));

        let refused = collect(&ctx, Provider::Openai, Some(&base), now)
            .await
            .unwrap();
        assert_eq!(refused.state, RunState::Auth);
        assert!(!refused.message.contains("secret"));
        let limited = collect(&ctx, Provider::Openai, Some(&base), now)
            .await
            .unwrap();
        assert_eq!(limited.state, RunState::RateLimited);
        // Failed runs leave the last good report alone.
        assert_eq!(
            crate::db::select(&pool, "SELECT COUNT(*) AS n FROM usage_report_rows", &[])
                .await
                .unwrap()[0]["n"],
            json!(1)
        );
        let runs = crate::db::select(
            &pool,
            "SELECT state,message FROM usage_report_runs ORDER BY created_at,rowid",
            &[],
        )
        .await
        .unwrap();
        let states: Vec<_> = runs
            .iter()
            .map(|r| r["state"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(states, ["ok", "ok", "auth", "rate_limited"]);
        assert!(
            runs.iter()
                .all(|r| !r["message"].as_str().unwrap().contains("fake-report"))
        );
        // The report never becomes request_log spend.
        assert_eq!(
            crate::db::select(&pool, "SELECT COUNT(*) AS n FROM request_log", &[])
                .await
                .unwrap()[0]["n"],
            json!(0)
        );
        drop(ctx);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn anthropic_uses_its_admin_headers_and_no_key_means_no_request() {
        let (ctx, dir) = ctx_with_key(Provider::Anthropic).await;
        let empty = json!({"data":[],"has_more":false,"next_page":null}).to_string();
        let (base, seen) = serve(vec![(200, empty.clone()), (200, empty)]);
        let now = parse_rfc3339("2026-11-06T12:00:00Z").unwrap();
        let ok = collect(&ctx, Provider::Anthropic, Some(&base), now)
            .await
            .unwrap();
        assert_eq!(ok.state, RunState::Ok);
        let log = seen.lock().unwrap().clone();
        assert!(log[0].starts_with("GET /v1/organizations/analytics/cost?starting_at=2026-10-30T00:00:00Z&ending_at=2026-11-07T00:00:00Z"), "{log:?}");
        assert!(log.iter().all(|l| l.ends_with("auth=true")));
        key_remove(&ctx, Provider::Anthropic).unwrap();
        assert!(
            collect(&ctx, Provider::Anthropic, Some(&base), now)
                .await
                .is_err()
        );
        // A chat key is never used for reports.
        ctx.keys
            .store
            .set("anthropic", "fake-chat-key-0123456789")
            .unwrap();
        assert!(
            collect(&ctx, Provider::Anthropic, Some(&base), now)
                .await
                .is_err()
        );
        drop(ctx);
        let _ = std::fs::remove_dir_all(dir);
    }
}
