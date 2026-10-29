//! The egress policy, checked in the transport (SE-13). The app checks it first; this is the
//! backstop, so a bug on the frontend can't send a blocked project's content anywhere. Every
//! request that carries content (POST) must say where that content comes from: a chat, a
//! project, or nothing project-bound. The project is looked up here, from the database, never
//! taken from the frontend's word.

use sqlx::Row;
use sqlx::sqlite::SqlitePool;

use crate::keys::Provider;

#[derive(Debug, PartialEq, Eq)]
pub enum Scope {
    Thread(String),
    Project(String),
    Global,
}

/// `thread:<id>`, `project:<id>` or `global`.
pub fn parse_scope(raw: &str) -> Option<Scope> {
    if raw == "global" {
        return Some(Scope::Global);
    }
    let (kind, id) = raw.split_once(':')?;
    if id.is_empty() {
        return None;
    }
    match kind {
        "thread" => Some(Scope::Thread(id.to_string())),
        "project" => Some(Scope::Project(id.to_string())),
        _ => None,
    }
}

fn provider_name(p: Provider) -> &'static str {
    match p {
        Provider::Openai => "OpenAI",
        Provider::Anthropic => "Anthropic",
    }
}

/// Ok when this request may go to `provider`; otherwise the reason, in plain words.
pub async fn check(
    pool: &SqlitePool,
    provider: Provider,
    method: &str,
    path: &str,
    scope: Option<&str>,
) -> Result<(), String> {
    // A GET (the model list) carries no content.
    if method != "POST" {
        return Ok(());
    }
    let scope = scope
        .and_then(parse_scope)
        .ok_or("FUSE didn't say where this request's content comes from, so it wasn't sent.")?;
    let fail = |e: sqlx::Error| format!("Couldn't check your privacy settings: {e}");

    let project_id: Option<String> = match scope {
        Scope::Global => None,
        Scope::Project(id) => Some(id),
        Scope::Thread(id) => {
            let row = sqlx::query("SELECT project_id FROM threads WHERE id = ?")
                .bind(&id)
                .fetch_optional(pool)
                .await
                .map_err(fail)?
                .ok_or("That chat doesn't exist, so nothing was sent.")?;
            row.try_get("project_id").map_err(fail)?
        }
    };

    let mut where_ = "Your settings".to_string();
    if let Some(id) = &project_id {
        let row = sqlx::query(
            "SELECT name, privacy_mode, allow_embeddings FROM projects WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(fail)?;
        if let Some(row) = row {
            let name: String = row.try_get("name").map_err(fail)?;
            let mode: String = row.try_get("privacy_mode").map_err(fail)?;
            let embeddings: i64 = row.try_get("allow_embeddings").map_err(fail)?;
            where_ = format!("The project “{name}”");
            if mode == "local_only" {
                return Err(format!(
                    "{where_} is set to Local only, so nothing is sent to a cloud model."
                ));
            }
            if embeddings == 0 && path.split('?').next() == Some("/v1/embeddings") {
                return Err(format!(
                    "{where_} doesn't allow sending its content to be embedded for search."
                ));
            }
        }
    }

    // The project's own rule wins over the global one; no rule means allowed.
    let rules = sqlx::query(
        "SELECT project_id, allow FROM egress_rules
         WHERE provider = ? AND (project_id IS NULL OR project_id = ?)",
    )
    .bind(provider.account())
    .bind(project_id.as_deref().unwrap_or(""))
    .fetch_all(pool)
    .await
    .map_err(fail)?;
    let mut global = None;
    let mut own = None;
    for r in rules {
        let p: Option<String> = r.try_get("project_id").map_err(fail)?;
        let allow: i64 = r.try_get("allow").map_err(fail)?;
        if p.is_some() {
            own = Some(allow == 1);
        } else {
            global = Some(allow == 1);
        }
    }
    if !own.or(global).unwrap_or(true) {
        return Err(format!(
            "{where_} blocks {}, so nothing was sent to it.",
            provider_name(provider)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Opened, execute, open};
    use crate::keys::MemoryStore;
    use serde_json::Value;

    async fn db() -> SqlitePool {
        let dir = std::env::temp_dir().join(format!(
            "fuse-egress-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let pool = match open(&dir, &MemoryStore::default()).await.unwrap() {
            Opened::Ready(p) => p,
            Opened::NeedsRecoveryKey => panic!("expected the database to open"),
        };
        let seed = [
            "INSERT INTO projects (id, workspace_id, user_id, name, created_at, updated_at)
             SELECT 'health', workspace_id, id, 'Health', 1, 1 FROM users LIMIT 1",
            "INSERT INTO projects (id, workspace_id, user_id, name, created_at, updated_at)
             SELECT 'garden', workspace_id, id, 'Garden', 1, 1 FROM users LIMIT 1",
            "INSERT INTO threads (id, workspace_id, user_id, title, project_id, created_at, updated_at)
             SELECT 'in-health', workspace_id, id, 'Results', 'health', 1, 1 FROM users LIMIT 1",
            "INSERT INTO threads (id, workspace_id, user_id, title, created_at, updated_at)
             SELECT 'loose', workspace_id, id, 'Loose', 1, 1 FROM users LIMIT 1",
            "INSERT INTO egress_rules (id, workspace_id, user_id, project_id, provider, allow, created_at, updated_at)
             SELECT 'r1', workspace_id, id, 'health', 'anthropic', 0, 1, 1 FROM users LIMIT 1",
        ];
        for sql in seed {
            execute(&pool, sql, &[]).await.unwrap();
        }
        pool
    }

    const A: Provider = Provider::Anthropic;
    const O: Provider = Provider::Openai;

    #[test]
    fn scopes_are_parsed_strictly() {
        assert_eq!(parse_scope("global"), Some(Scope::Global));
        assert_eq!(parse_scope("thread:t1"), Some(Scope::Thread("t1".into())));
        assert_eq!(parse_scope("project:p1"), Some(Scope::Project("p1".into())));
        assert_eq!(parse_scope("thread:"), None);
        assert_eq!(parse_scope("other:x"), None);
        assert_eq!(parse_scope(""), None);
    }

    #[tokio::test]
    async fn content_without_a_scope_is_refused_but_model_lists_pass() {
        let pool = db().await;
        assert!(check(&pool, A, "POST", "/v1/messages", None).await.is_err());
        assert!(
            check(&pool, A, "POST", "/v1/messages", Some("nonsense"))
                .await
                .is_err()
        );
        assert!(check(&pool, A, "GET", "/v1/models", None).await.is_ok());
    }

    #[tokio::test]
    async fn a_chat_in_a_blocking_project_cant_reach_that_provider() {
        let pool = db().await;
        let err = check(&pool, A, "POST", "/v1/messages", Some("thread:in-health"))
            .await
            .unwrap_err();
        assert!(err.contains("“Health” blocks Anthropic"), "{err}");
        assert!(
            check(&pool, O, "POST", "/v1/responses", Some("thread:in-health"))
                .await
                .is_ok()
        );
        assert!(
            check(&pool, A, "POST", "/v1/messages", Some("thread:loose"))
                .await
                .is_ok()
        );
        assert!(
            check(&pool, A, "POST", "/v1/messages", Some("thread:missing"))
                .await
                .is_err()
        );
        // The project's knowledge files (indexing) are checked by project.
        assert!(
            check(&pool, A, "POST", "/v1/messages", Some("project:health"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn global_rules_apply_unless_a_project_overrides_them() {
        let pool = db().await;
        execute(
            &pool,
            "INSERT INTO egress_rules (id, workspace_id, user_id, project_id, provider, allow, created_at, updated_at)
             SELECT 'r2', workspace_id, id, NULL, 'openai', 0, 1, 1 FROM users LIMIT 1",
            &[],
        )
        .await
        .unwrap();
        assert!(
            check(&pool, O, "POST", "/v1/responses", Some("global"))
                .await
                .is_err()
        );
        assert!(
            check(&pool, O, "POST", "/v1/responses", Some("project:garden"))
                .await
                .is_err()
        );
        execute(
            &pool,
            "INSERT INTO egress_rules (id, workspace_id, user_id, project_id, provider, allow, created_at, updated_at)
             SELECT 'r3', workspace_id, id, 'garden', 'openai', 1, 1, 1 FROM users LIMIT 1",
            &[],
        )
        .await
        .unwrap();
        assert!(
            check(&pool, O, "POST", "/v1/responses", Some("project:garden"))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn local_only_and_no_embeddings_are_enforced() {
        let pool = db().await;
        execute(
            &pool,
            "UPDATE projects SET allow_embeddings = 0 WHERE id = 'garden'",
            &[],
        )
        .await
        .unwrap();
        let err = check(&pool, O, "POST", "/v1/embeddings", Some("project:garden"))
            .await
            .unwrap_err();
        assert!(err.contains("embedded"), "{err}");
        assert!(
            check(&pool, O, "POST", "/v1/responses", Some("project:garden"))
                .await
                .is_ok()
        );
        execute(
            &pool,
            "UPDATE projects SET privacy_mode = ? WHERE id = 'garden'",
            &[Value::from("local_only")],
        )
        .await
        .unwrap();
        let err = check(&pool, O, "POST", "/v1/responses", Some("project:garden"))
            .await
            .unwrap_err();
        assert!(err.contains("Local only"), "{err}");
    }
}
