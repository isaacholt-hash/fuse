//! Content-free credential-use events. Never accept a body, header, key or arbitrary message.
use crate::keys::Provider;
use sqlx::SqlitePool;

pub async fn credential_use(pool: &SqlitePool, provider: Provider) -> Result<(), String> {
    sqlx::query("INSERT INTO security_audit(id,workspace_id,user_id,event_kind,provider,scope_kind,action,created_at,updated_at) VALUES(lower(hex(randomblob(16))),?,?,'credential_use',?,'global','request',unixepoch()*1000,unixepoch()*1000)")
        .bind(crate::sync::WORKSPACE)
        .bind(crate::sync::USER)
        .bind(provider.account())
        .execute(pool)
        .await
        .map_err(|_| "Couldn't record credential use; no request was sent.".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    #[tokio::test]
    async fn credential_events_have_only_fixed_metadata() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE security_audit(id TEXT,workspace_id TEXT,user_id TEXT,event_kind TEXT,provider TEXT,scope_kind TEXT,action TEXT,created_at INTEGER,updated_at INTEGER)")
            .execute(&pool).await.unwrap();
        credential_use(&pool, Provider::Openai).await.unwrap();
        let row = sqlx::query("SELECT * FROM security_audit")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("provider"), "openai");
        assert_eq!(row.get::<String, _>("event_kind"), "credential_use");
        assert_eq!(row.columns().len(), 9);
    }
}
