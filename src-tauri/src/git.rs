//! Git and GitHub for the coding agent (CA-05, M6 step 10). `git` and `gh` run directly with an
//! argument list (no shell, so nothing in a commit message is ever interpreted), in the project's
//! linked folder, which comes from the database. Only the subcommands the agent's tools use are
//! allowed, options that run other programs or change git's config are refused, and prompts are
//! off so nothing waits for input. The app asks you before anything leaves this computer.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

const TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT: usize = 256 * 1024;

const GIT_ALLOWED: &[&str] = &[
    "status",
    "diff",
    "log",
    "add",
    "commit",
    "switch",
    "push",
    "rev-parse",
    "branch",
];
const GH_ALLOWED: &[&str] = &["pr"];

/// Options that would run another program or rewrite git's config for this call.
const REFUSED: &[&str] = &[
    "-c",
    "--config-env",
    "--exec-path",
    "--upload-pack",
    "--receive-pack",
    "--exec",
    "--git-dir",
    "--work-tree",
];

const SCRUBBED: &[&str] = &[
    "FUSE_OPENAI_API_KEY",
    "FUSE_ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
];

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitResult {
    pub output: String,
    pub exit_code: Option<i32>,
}

/// Why these arguments can't run, or None.
pub fn refuse(program: &str, args: &[String]) -> Option<String> {
    let allowed = match program {
        "git" => GIT_ALLOWED,
        "gh" => GH_ALLOWED,
        _ => return Some(format!("{program} isn't one of the tools FUSE runs.")),
    };
    let Some(sub) = args.first() else {
        return Some("No subcommand.".into());
    };
    if !allowed.contains(&sub.as_str()) {
        return Some(format!("{program} {sub} isn't allowed."));
    }
    if program == "gh"
        && args.get(1).map(String::as_str) != Some("create")
        && args.get(1).map(String::as_str) != Some("view")
    {
        return Some("Only gh pr create and gh pr view are allowed.".into());
    }
    if let Some(bad) = args.iter().find(|a| {
        REFUSED
            .iter()
            .any(|r| a.as_str() == *r || a.starts_with(&format!("{r}=")))
    }) {
        return Some(format!("{bad} isn't allowed."));
    }
    None
}

pub async fn run(root: &Path, program: &str, args: &[String]) -> Result<GitResult, String> {
    if let Some(why) = refuse(program, args) {
        return Err(why);
    }
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_EDITOR", "true")
        .kill_on_drop(true);
    for k in SCRUBBED {
        cmd.env_remove(k);
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start {program}: {e}"))?;
    let out = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            format!(
                "{program} took longer than {} s and was stopped.",
                TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("{program}: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&err);
    }
    if text.len() > MAX_OUTPUT {
        let mut end = MAX_OUTPUT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n[output cut]");
    }
    Ok(GitResult {
        output: text,
        exit_code: out.status.code(),
    })
}

pub(crate) async fn repo_git(
    ctx: &crate::ctx::Ctx,
    folder_id: String,
    program: String,
    args: Vec<String>,
) -> Result<GitResult, String> {
    let (root, _) = crate::repo::folder_root(&ctx.db.pool()?, &folder_id).await?;
    let root =
        std::fs::canonicalize(&root).map_err(|e| format!("The linked folder is missing: {e}"))?;
    run(&root, &program, &args).await
}

pub mod commands {
    use super::*;
    use crate::ctx::Ctx;
    use tauri::State;

    #[tauri::command]
    pub async fn repo_git(
        ctx: State<'_, Ctx>,
        folder_id: String,
        program: String,
        args: Vec<String>,
    ) -> Result<GitResult, String> {
        super::repo_git(&ctx, folder_id, program, args).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn only_the_agents_subcommands_and_no_injection() {
        assert_eq!(refuse("git", &a(&["status", "--short"])), None);
        // A run's own branch (CA-05): `-c` is refused anywhere, so FUSE uses --create.
        assert_eq!(
            refuse("git", &a(&["switch", "--create", "fuse/x-1a2b"])),
            None
        );
        assert_eq!(
            refuse("git", &a(&["commit", "-m", "-c is fine inside a message"])),
            None
        );
        assert!(refuse("git", &a(&["config", "core.pager", "x"])).is_some());
        assert!(refuse("git", &a(&["-c", "core.sshCommand=evil", "push"])).is_some());
        assert!(refuse("git", &a(&["push", "--receive-pack=evil"])).is_some());
        assert!(refuse("git", &a(&["status", "--git-dir=/etc"])).is_some());
        assert!(refuse("git", &[]).is_some());
        assert_eq!(
            refuse("gh", &a(&["pr", "create", "--title", "x", "--body", "y"])),
            None
        );
        assert!(refuse("gh", &a(&["pr", "merge", "1"])).is_some());
        assert!(refuse("gh", &a(&["api", "user"])).is_some());
        assert!(refuse("bash", &a(&["-c", "x"])).is_some());
    }

    #[tokio::test]
    async fn commits_in_a_real_repository() {
        let dir = std::env::temp_dir().join(format!(
            "fuse-git-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(&dir)
            .status()
            .unwrap();
        assert!(init.success());
        std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
        run(&dir, "git", &a(&["add", "-A"])).await.unwrap();
        let msg = "Say hello; $(touch pwned) `whoami`";
        let done = run(
            &dir,
            "git",
            &a(&[
                "-c", // refused before anything runs
                "user.name=x",
                "commit",
            ]),
        )
        .await;
        assert!(done.is_err());
        // Identity through the environment, as a test machine may have none set.
        // SAFETY: tests in this module don't read these concurrently.
        unsafe {
            std::env::set_var("GIT_AUTHOR_NAME", "FUSE Test");
            std::env::set_var("GIT_AUTHOR_EMAIL", "test@example.invalid");
            std::env::set_var("GIT_COMMITTER_NAME", "FUSE Test");
            std::env::set_var("GIT_COMMITTER_EMAIL", "test@example.invalid");
        }
        let c = run(&dir, "git", &a(&["commit", "-m", msg])).await.unwrap();
        assert_eq!(c.exit_code, Some(0), "{}", c.output);
        let log = run(&dir, "git", &a(&["log", "--format=%s", "-n", "1"]))
            .await
            .unwrap();
        assert_eq!(log.output.trim(), msg);
        assert!(!dir.join("pwned").exists(), "the message was never run");
        let st = run(&dir, "git", &a(&["status", "--short", "--branch"]))
            .await
            .unwrap();
        assert!(st.output.contains("## main"), "{}", st.output);
    }
}
