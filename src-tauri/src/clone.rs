//! Handover (M10 step 7, CA-15): the server's own copy of a repository a desktop hands a run
//! over for. One clone per remote, under the server's data folder (`work/`), fetched again for
//! each handover and set to the branch's tip on the remote; the run then makes its own
//! `fuse/…` branch there and pushes only that. The server's git uses the server user's own
//! credentials for the remote.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::ctx::Ctx;

const GIT_TIMEOUT: Duration = Duration::from_secs(300);

/// A remote git can reach over the network (https, ssh, `user@host:path`), or a repository
/// under this server user's home. Never anything git would read as an option.
fn check_remote(remote: &str, home: Option<&Path>) -> Result<(), String> {
    let r = remote.trim();
    if r.is_empty() || r.starts_with('-') || r.chars().any(char::is_control) {
        return Err("That isn't a git remote.".into());
    }
    if r.starts_with("https://") || r.starts_with("ssh://") {
        return Ok(());
    }
    // scp-like: git@github.com:owner/repo.git
    if let Some((user_host, path)) = r.split_once(':')
        && user_host.contains('@')
        && !user_host.contains('/')
        && !path.is_empty()
    {
        return Ok(());
    }
    let p = Path::new(r);
    if p.is_absolute() {
        let real = std::fs::canonicalize(p).map_err(|_| format!("{r} isn't there."))?;
        if home.is_some_and(|h| real.starts_with(h)) {
            return Ok(());
        }
        return Err(format!("{r} isn't under this server's home."));
    }
    Err("Use the repository's https or ssh address.".into())
}

/// A branch name git accepts and can't mistake for an option or a range.
fn check_branch(branch: &str) -> Result<(), String> {
    let ok = !branch.is_empty()
        && !branch.starts_with('-')
        && !branch.contains("..")
        && !branch.ends_with('/')
        && branch
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
    if ok {
        Ok(())
    } else {
        Err(format!("{branch} isn't a branch name FUSE can use."))
    }
}

/// `work/<name>-<hash of the remote>`: readable, and one per remote.
fn clone_dir(data_dir: &Path, remote: &str) -> PathBuf {
    let name: String = remote
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("repo")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(40)
        .collect();
    let hash: String = Sha256::digest(remote.as_bytes())[..4]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let name = if name.is_empty() { "repo".into() } else { name };
    data_dir.join("work").join(format!("{name}-{hash}"))
}

async fn git(dir: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("git");
    if let Some(d) = dir {
        cmd.arg("-C").arg(d);
    }
    cmd.args(args)
        // Never wait for a password prompt nobody will see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(GIT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "git took too long.".to_owned())?
        .map_err(|e| format!("Couldn't run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

/// Clones `remote` (or fetches it again) and checks out the tip of `branch` on it, detached.
/// Returns the clone's folder. A clone with changes left in it is refused, not overwritten.
pub(crate) async fn repo_clone(
    ctx: &Ctx,
    remote: String,
    branch: String,
) -> Result<String, String> {
    let home = std::env::var_os("HOME").and_then(|h| std::fs::canonicalize(h).ok());
    clone_at(ctx, &remote, &branch, home.as_deref()).await
}

async fn clone_at(
    ctx: &Ctx,
    remote: &str,
    branch: &str,
    home: Option<&Path>,
) -> Result<String, String> {
    let (remote, branch) = (remote.to_owned(), branch.to_owned());
    check_remote(&remote, home)?;
    check_branch(&branch)?;
    let dir = clone_dir(&ctx.data_dir, remote.trim());
    if dir.join(".git").exists() {
        let changed = git(Some(&dir), &["status", "--porcelain"]).await?;
        if !changed.is_empty() {
            return Err(format!(
                "HULK's copy of this repository ({}) has changes an earlier run left; look at them there first.",
                dir.display()
            ));
        }
        git(Some(&dir), &["fetch", "--prune", "origin"])
            .await
            .map_err(|e| format!("Couldn't fetch {remote}: {e}"))?;
    } else {
        std::fs::create_dir_all(dir.parent().unwrap_or(&dir)).map_err(|e| e.to_string())?;
        let target = dir.to_string_lossy().into_owned();
        git(
            None,
            &[
                "clone",
                "--no-recurse-submodules",
                "--",
                remote.trim(),
                &target,
            ],
        )
        .await
        .map_err(|e| format!("Couldn't clone {remote}: {e}"))?;
    }
    git(
        Some(&dir),
        &["checkout", "--detach", &format!("origin/{branch}")],
    )
    .await
    .map_err(|e| format!("{branch} isn't on {remote}: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_network_remotes_and_local_ones_under_home_only() {
        let home = std::env::temp_dir();
        assert!(check_remote("https://github.com/isaacholt-hash/fuse.git", None).is_ok());
        assert!(check_remote("git@github.com:isaacholt-hash/fuse.git", None).is_ok());
        assert!(check_remote("ssh://git@host/x.git", None).is_ok());
        assert!(check_remote("--upload-pack=touch /tmp/x", None).is_err());
        assert!(check_remote("ext::sh -c touch", None).is_err());
        assert!(check_remote("relative/path", None).is_err());
        assert!(
            check_remote(
                home.to_str().unwrap(),
                Some(&std::fs::canonicalize(&home).unwrap())
            )
            .is_ok()
        );
        assert!(check_remote("/etc", Some(Path::new("/home/nobody"))).is_err());
        assert!(check_branch("main").is_ok() && check_branch("feature/x-1").is_ok());
        for bad in ["", "-x", "a..b", "a b", "x/"] {
            assert!(check_branch(bad).is_err(), "{bad}");
        }
        assert!(
            clone_dir(Path::new("/d"), "git@github.com:isaacholt-hash/fuse.git")
                .to_string_lossy()
                .starts_with("/d/work/fuse-")
        );
    }

    #[tokio::test]
    async fn clones_then_fetches_and_refuses_a_changed_copy() {
        let base = std::env::temp_dir().join(format!("fuse-clone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let origin = base.join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        let g = |dir: &Path, args: &[&str]| {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?}");
        };
        g(&origin, &["init", "-q", "-b", "main"]);
        std::fs::write(origin.join("a.txt"), "one").unwrap();
        g(&origin, &["add", "."]);
        g(&origin, &["commit", "-q", "-m", "one"]);

        let ctx = Ctx::new(
            base.join("data"),
            base.join("config"),
            crate::keys::Keys::with_store(Box::new(crate::keys::MemoryStore::default())),
        );
        // A local remote must be under the server's home: here, the test folder.
        let home = std::fs::canonicalize(&base).unwrap();
        let remote = origin.to_string_lossy().into_owned();
        let dir = clone_at(&ctx, &remote, "main", Some(&home)).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&dir).join("a.txt")).unwrap(),
            "one"
        );

        std::fs::write(origin.join("a.txt"), "two").unwrap();
        g(&origin, &["commit", "-q", "-am", "two"]);
        let again = clone_at(&ctx, &remote, "main", Some(&home)).await.unwrap();
        assert_eq!(again, dir);
        assert_eq!(
            std::fs::read_to_string(Path::new(&dir).join("a.txt")).unwrap(),
            "two"
        );

        assert!(clone_at(&ctx, &remote, "nope", Some(&home)).await.is_err());
        std::fs::write(Path::new(&dir).join("left.txt"), "x").unwrap();
        let e = clone_at(&ctx, &remote, "main", Some(&home))
            .await
            .unwrap_err();
        assert!(e.contains("has changes"), "{e}");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
