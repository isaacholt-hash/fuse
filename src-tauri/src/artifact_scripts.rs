//! M17.3: runs one explicitly approved version of a Python artifact with owner-selected inputs.
//!
//! Everything that runs is read from this device's database and file store, never from the
//! request: the version's exact source (checked against the approved SHA-256) and each input
//! (checked against its recorded SHA-256 and size). The run uses the skill-script sandbox:
//! private scratch, read-only inputs, a writable `out`, no network, no child processes.
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::{
    ctx::{Ctx, Sink},
    db,
    exec::{self, ExecMsg},
    skill_scripts::{self, Execution, Package},
};

const MAX_SCRIPT: usize = 256 * 1024;
const MAX_INPUTS: usize = 16;
const MAX_INPUT: usize = 8 * 1024 * 1024;
const MAX_INPUTS_TOTAL: usize = 16 * 1024 * 1024;
const MAX_SECONDS: u64 = 120;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRunRequest {
    /// The `artifact_runs` row the owner approved (state `requested`).
    pub run_id: String,
    pub version_id: String,
    /// The source the owner saw when approving; the run refuses anything else.
    pub script_sha256: String,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    name: String,
    sha256: String,
    bytes: usize,
}

const ELIGIBLE: &str = "SELECT v.content,r.inputs,r.script_sha256 FROM artifact_runs r JOIN artifact_versions v ON v.id=r.version_id AND v.workspace_id=r.workspace_id AND v.user_id=r.user_id JOIN artifacts a ON a.id=v.artifact_id AND a.id=r.artifact_id AND a.workspace_id=r.workspace_id AND a.user_id=r.user_id JOIN threads t ON t.id=a.thread_id AND t.workspace_id=a.workspace_id WHERE r.id=? AND r.version_id=? AND r.workspace_id=? AND r.user_id=? AND r.state='requested' AND a.deleted_at IS NULL AND t.deleted_at IS NULL AND a.type='code' AND lower(a.language) IN('python','py','python3')";

fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn validate(r: &ArtifactRunRequest) -> Result<(), String> {
    if [&r.run_id, &r.version_id]
        .iter()
        .any(|s| s.is_empty() || s.len() > 160)
        || !hex64(&r.script_sha256)
        || r.timeout_secs.is_some_and(|n| n == 0 || n > MAX_SECONDS)
    {
        return Err("The artifact run request exceeds its bounds.".into());
    }
    Ok(())
}

/// The exact files to run: `script.py` plus `inputs/<name>`, each checked against its record.
async fn prepare(ctx: &Ctx, r: &ArtifactRunRequest) -> Result<Package, String> {
    validate(r)?;
    let rows = db::select(
        &ctx.db.pool()?,
        ELIGIBLE,
        &[
            json!(r.run_id),
            json!(r.version_id),
            json!(crate::sync::WORKSPACE),
            json!(crate::sync::USER),
        ],
    )
    .await?;
    let row = rows.first().ok_or(
        "That run isn't waiting to start, or its Python artifact version was deleted or isn't Python.",
    )?;
    let source = row["content"].as_str().ok_or("Missing artifact source.")?;
    let script = source.as_bytes().to_vec();
    let sha = skill_scripts::digest(&script);
    if script.len() > MAX_SCRIPT || script.contains(&0) {
        return Err("The artifact is too large or isn't Python source.".into());
    }
    if row["script_sha256"].as_str() != Some(sha.as_str()) || sha != r.script_sha256 {
        return Err("This version's source changed after you approved it.".into());
    }
    let inputs: Vec<Input> = serde_json::from_str(row["inputs"].as_str().ok_or("Missing inputs.")?)
        .map_err(|_| "The selected inputs are malformed.")?;
    if inputs.len() > MAX_INPUTS {
        return Err("Select at most 16 input files.".into());
    }
    let mut files = vec![("script.py".to_owned(), script)];
    let mut total = 0usize;
    let mut names = std::collections::BTreeSet::new();
    for input in inputs {
        skill_scripts::portable_path(&input.name)
            .map_err(|_| "An input has an unsafe or private file name.")?;
        if input.name.contains('/')
            || !names.insert(input.name.to_ascii_lowercase())
            || !hex64(&input.sha256)
            || input.bytes > MAX_INPUT
        {
            return Err("Inputs need distinct plain file names of at most 8 MB each.".into());
        }
        let bytes = crate::files::get(&ctx.data_dir, &input.sha256)
            .map_err(|_| "A selected input isn't stored on this device any more.")?;
        if bytes.len() != input.bytes || skill_scripts::digest(&bytes) != input.sha256 {
            return Err("A selected input failed its integrity check.".into());
        }
        total += bytes.len();
        if total > MAX_INPUTS_TOTAL {
            return Err("The selected inputs exceed 16 MB together.".into());
        }
        files.push((format!("inputs/{}", input.name), bytes));
    }
    Ok(Package {
        files,
        script_sha256: sha,
    })
}

/// One dispatch per approved row: a second start, or a restart after a crash, is refused.
async fn claim(ctx: &Ctx, r: &ArtifactRunRequest) -> Result<(), String> {
    let done = sqlx::query(
        "UPDATE artifact_runs SET state='running',updated_at=? WHERE id=? AND version_id=? AND workspace_id=? AND user_id=? AND state='requested'",
    )
    .bind(crate::sync::now())
    .bind(&r.run_id)
    .bind(&r.version_id)
    .bind(crate::sync::WORKSPACE)
    .bind(crate::sync::USER)
    .execute(&ctx.db.pool()?)
    .await
    .map_err(|_| "Couldn't record the run.")?;
    if done.rows_affected() != 1 {
        return Err("This run already started. Approve a new attempt to run it again.".into());
    }
    Ok(())
}

pub(crate) async fn run(
    ctx: &Ctx,
    r: ArtifactRunRequest,
    on_event: Sink<ExecMsg>,
) -> Result<u32, String> {
    if !matches!(
        exec::sandbox_kind(),
        exec::SandboxKind::Bubblewrap | exec::SandboxKind::AppContainer
    ) {
        return Err(
            "Running Python artifacts needs the OS sandbox (bubblewrap on Linux, AppContainer on Windows)."
                .into(),
        );
    }
    skill_scripts::cleanup(&ctx.data_dir);
    let pkg = prepare(ctx, &r).await?;
    let runtime = ctx.data_dir.join("python-runtime");
    if crate::python_runtime::status(&runtime).is_none() {
        return Err(
            "Python isn't installed here. Install it in Settings → Code & tools → Python for data work."
                .into(),
        );
    }
    let root = runtime.join("python");
    let id = skill_scripts::digest(format!("artifact-run:{}", r.run_id).as_bytes());
    let scratch = skill_scripts::create_scratch(&ctx.data_dir, &id, &pkg, "script.py", &[], &root)?;
    claim(ctx, &r).await?;
    skill_scripts::execute(
        ctx,
        Execution {
            scratch,
            root,
            timeout: Duration::from_secs(r.timeout_secs.unwrap_or(MAX_SECONDS)),
            pool: ctx.db.pool()?,
            finish: "UPDATE artifact_runs SET state=?,exit_code=?,updated_at=? WHERE id=? AND state='running'",
            claim: r.run_id,
            label: "<artifact scratch>",
        },
        on_event,
    )
}

pub mod commands {
    use super::*;
    #[tauri::command]
    pub async fn artifact_python_run(
        ctx: tauri::State<'_, Ctx>,
        request: ArtifactRunRequest,
        on_event: tauri::ipc::Channel<ExecMsg>,
    ) -> Result<u32, String> {
        run(&ctx, request, crate::ctx::channel_sink(on_event)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{Keys, MemoryStore};

    const SOURCE: &str = "import os\nprint(open('inputs/data.csv').read().strip())\n";

    async fn fixture() -> (Ctx, std::path::PathBuf, ArtifactRunRequest) {
        let mut tag = [0u8; 16];
        getrandom::fill(&mut tag).unwrap();
        let dir = std::env::temp_dir().join(format!(
            "fuse-artifact-run-{}",
            crate::sync::crypto::hex(&tag)
        ));
        let ctx = Ctx::new(
            dir.join("data"),
            dir.join("config"),
            Keys::with_store(Box::<MemoryStore>::default()),
        );
        crate::db::db_open(&ctx).await.unwrap();
        let pool = ctx.db.pool().unwrap();
        let input = crate::files::put(&ctx.data_dir, b"south,30").unwrap();
        let script_sha = skill_scripts::digest(SOURCE.as_bytes());
        let inputs =
            json!([{ "name": "data.csv", "sha256": input.sha256, "bytes": 8 }]).to_string();
        let (ws, user) = (json!(crate::sync::WORKSPACE), json!(crate::sync::USER));
        for (sql, params) in [
            (
                "INSERT INTO threads(id,workspace_id,user_id,title,created_at,updated_at) VALUES('t',?,?,'Fixture',1,1)",
                vec![ws.clone(), user.clone()],
            ),
            (
                "INSERT INTO artifacts(id,workspace_id,user_id,thread_id,key,title,type,language,created_at,updated_at) VALUES('a',?,?,'t','sum','Sum','code','python',1,1)",
                vec![ws.clone(), user.clone()],
            ),
            (
                "INSERT INTO artifact_versions(id,workspace_id,user_id,artifact_id,version,content,source,created_at,updated_at) VALUES('v1',?,?,'a',1,?,'model',1,1)",
                vec![ws.clone(), user.clone(), json!(SOURCE)],
            ),
            (
                "INSERT INTO artifact_runs(id,workspace_id,user_id,artifact_id,version_id,attempt,script_sha256,inputs,state,created_at,updated_at) VALUES('r1',?,?,'a','v1',1,?,?,'requested',1,1)",
                vec![ws.clone(), user.clone(), json!(script_sha), json!(inputs)],
            ),
        ] {
            db::execute(&pool, sql, &params).await.unwrap();
        }
        let r = ArtifactRunRequest {
            run_id: "r1".into(),
            version_id: "v1".into(),
            script_sha256: script_sha,
            timeout_secs: Some(30),
        };
        (ctx, dir, r)
    }

    #[tokio::test]
    async fn only_the_approved_source_and_checked_inputs_run_once() {
        let (ctx, dir, r) = fixture().await;
        let pool = ctx.db.pool().unwrap();
        let pkg = prepare(&ctx, &r).await.unwrap();
        assert_eq!(
            pkg.files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(),
            vec!["script.py", "inputs/data.csv"]
        );
        assert_eq!(pkg.files[1].1, b"south,30");

        // A different approval hash, or a version edited in place, is refused.
        let mut other = r.clone();
        other.script_sha256 = "0".repeat(64);
        assert!(prepare(&ctx, &other).await.is_err());
        for (bad, restore) in [
            (
                "UPDATE artifact_versions SET content='print(1)'",
                "UPDATE artifact_versions SET content=?",
            ),
            (
                "UPDATE artifacts SET language='javascript'",
                "UPDATE artifacts SET language='python' WHERE ?<>''",
            ),
            (
                "UPDATE artifacts SET deleted_at=1",
                "UPDATE artifacts SET deleted_at=NULL WHERE ?<>''",
            ),
            (
                "UPDATE threads SET deleted_at=1",
                "UPDATE threads SET deleted_at=NULL WHERE ?<>''",
            ),
        ] {
            db::execute(&pool, bad, &[]).await.unwrap();
            assert!(prepare(&ctx, &r).await.is_err(), "{bad}");
            db::execute(&pool, restore, &[json!(SOURCE)]).await.unwrap();
        }
        prepare(&ctx, &r).await.unwrap();

        // A tampered or missing input file fails closed.
        let row = &db::select(
            &pool,
            "SELECT inputs,json_extract(inputs,'$[0].sha256') AS sha FROM artifact_runs",
            &[],
        )
        .await
        .unwrap()[0];
        let inputs = row["inputs"].as_str().unwrap().to_owned();
        let sha = row["sha"].as_str().unwrap().to_owned();
        std::fs::write(ctx.data_dir.join("files").join(&sha), b"north,99").unwrap();
        assert!(prepare(&ctx, &r).await.is_err());
        std::fs::write(ctx.data_dir.join("files").join(&sha), b"south,30").unwrap();
        for name in ["../x.csv", "sub/x.csv", ".env", "CON.csv"] {
            let bad = inputs.replace("data.csv", name);
            db::execute(&pool, "UPDATE artifact_runs SET inputs=?", &[json!(bad)])
                .await
                .unwrap();
            assert!(prepare(&ctx, &r).await.is_err(), "{name}");
        }
        db::execute(&pool, "UPDATE artifact_runs SET inputs=?", &[json!(inputs)])
            .await
            .unwrap();

        // Exactly one start, even when two race; a started row never runs again.
        let (a, b) = tokio::join!(claim(&ctx, &r), claim(&ctx, &r));
        assert_ne!(a.is_ok(), b.is_ok());
        assert!(prepare(&ctx, &r).await.is_err());
        assert!(claim(&ctx, &r).await.is_err());

        // Provenance goes with its conversation.
        db::execute(&pool, "DELETE FROM artifact_versions", &[])
            .await
            .unwrap();
        assert!(
            db::select(&pool, "SELECT id FROM artifact_runs", &[])
                .await
                .unwrap()
                .is_empty()
        );
        drop(ctx);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_artifact_reads_its_inputs_read_only_without_network_and_writes_outputs() {
        use std::time::Instant;
        assert!(
            exec::bwrap_path().is_some(),
            "Install bubblewrap for the isolation tests"
        );
        let (ctx, dir, r) = fixture().await;
        let source = r#"import os,socket
assert open('inputs/data.csv').read()=='south,30'
try:
    open('inputs/data.csv','w').write('x')
    raise AssertionError('writable input')
except OSError: pass
try:
    socket.create_connection(('1.1.1.1',443),.1)
    raise AssertionError('network permitted')
except OSError: pass
assert not os.path.exists('/home')
open(os.path.join(os.environ['FUSE_OUT'],'total.txt'),'w').write('30')
print('ARTIFACT_OK')
"#;
        let mut pkg = prepare(&ctx, &r).await.unwrap();
        pkg.files[0].1 = source.as_bytes().to_vec();
        let scratch = skill_scripts::create_scratch(
            &dir,
            &"b".repeat(64),
            &pkg,
            "script.py",
            &[],
            std::path::Path::new("/usr"),
        )
        .unwrap();
        let cmd = skill_scripts::command(std::path::Path::new("/usr"), &scratch.path).unwrap();
        let (_tx, rx) = tokio::sync::oneshot::channel();
        let mut events = vec![];
        exec::run_process(
            &scratch.path,
            cmd,
            Instant::now(),
            Duration::from_secs(30),
            rx,
            |m| events.push(m),
        )
        .await;
        let out = std::fs::read_to_string(scratch.path.join("out/total.txt")).unwrap();
        drop(scratch);
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                ExecMsg::Out { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(text.contains("ARTIFACT_OK"), "{text}");
        assert_eq!(out, "30");
        assert!(events.iter().any(|e| matches!(
            e,
            ExecMsg::Done {
                exit_code: Some(0),
                ..
            }
        )));
        drop(ctx);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn requests_are_bounded() {
        let ok = ArtifactRunRequest {
            run_id: "r".into(),
            version_id: "v".into(),
            script_sha256: "a".repeat(64),
            timeout_secs: Some(120),
        };
        assert!(validate(&ok).is_ok());
        for bad in [
            ArtifactRunRequest {
                timeout_secs: Some(121),
                ..ok.clone()
            },
            ArtifactRunRequest {
                timeout_secs: Some(0),
                ..ok.clone()
            },
            ArtifactRunRequest {
                script_sha256: "xyz".into(),
                ..ok.clone()
            },
            ArtifactRunRequest {
                run_id: String::new(),
                ..ok.clone()
            },
        ] {
            assert!(validate(&bad).is_err());
        }
    }
}
