//! Read-only Git view for a workspace directory (status + diff), the web counterpart of Orca's
//! source-control / diff-review screens (`ref/orca/mobile/app/h/[hostId]/source-control`, `review`).
//!
//! Safety:
//! - The directory is never client-supplied: the server resolves it from the cmux workspace tree.
//! - A client-supplied path is only accepted when it appears in `git status` output, and is passed after
//!   `--` so it can never be read as an option.
//! - Commands are fixed argument lists (no shell). `--no-optional-locks`, `core.fsmonitor=false`,
//!   `--no-ext-diff` and `--no-textconv` keep the repo's own config from running helper programs.
//! - Output is capped and every call has a timeout; on timeout/truncation the whole process group is
//!   killed (so a helper spawned by git does not outlive it) and stderr is drained so a chatty helper
//!   cannot stall git.
//! - Nothing here writes to the repository.
//!
//! Known residual risk: git still runs `filter.<name>.clean` drivers configured in the repo's own
//! `.git/config`/`.gitattributes` when it re-checks a racy file (reproduced by review). That needs write
//! access to the workspace repository, which the agent running there already has; there is no git switch
//! that disables filters generically.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Largest diff returned to the phone.
pub const MAX_DIFF_BYTES: usize = 200_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitFile {
    pub path: String,
    /// Index (staged) status letter, `' '` when unchanged.
    pub index: char,
    /// Working-tree status letter, `' '` when unchanged. `'?'` for untracked.
    pub worktree: char,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

impl GitFile {
    pub fn untracked(&self) -> bool {
        self.index == '?' && self.worktree == '?'
    }
    pub fn staged(&self) -> bool {
        self.index != ' ' && self.index != '?'
    }
    pub fn unstaged(&self) -> bool {
        self.worktree != ' ' && self.worktree != '?'
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}

/// Parses `git status --porcelain=v1 -b -z`.
pub fn parse_status(out: &str) -> GitStatus {
    let mut status = GitStatus::default();
    let mut entries = out.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if let Some(header) = entry.strip_prefix("## ") {
            parse_branch_header(header, &mut status);
            continue;
        }
        let mut chars = entry.chars();
        let (Some(x), Some(y), Some(' ')) = (chars.next(), chars.next(), chars.next()) else {
            continue;
        };
        let path: String = chars.collect();
        // Renames/copies carry the original path as the next NUL-separated entry.
        let orig_path = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            entries.next().map(str::to_string)
        } else {
            None
        };
        status.files.push(GitFile { path, index: x, worktree: y, orig_path });
    }
    status
}

fn parse_branch_header(header: &str, status: &mut GitStatus) {
    // "main...origin/main [ahead 1, behind 2]" | "No commits yet on main" | "HEAD (no branch)" | "main"
    if let Some(rest) = header.strip_prefix("No commits yet on ") {
        status.branch = Some(rest.to_string());
        return;
    }
    let (names, counts) = match header.split_once(" [") {
        Some((n, c)) => (n, c.trim_end_matches(']')),
        None => (header, ""),
    };
    match names.split_once("...") {
        Some((b, u)) => {
            status.branch = Some(b.to_string());
            status.upstream = Some(u.to_string());
        }
        None => status.branch = Some(names.to_string()),
    }
    for part in counts.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            status.ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            status.behind = n.parse().unwrap_or(0);
        }
    }
}

fn base_command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("--no-optional-locks")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-C")
        .arg(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0); // own group, so the whole tree can be killed
    cmd
}

/// SIGKILLs the process group led by `pid` (git plus anything it spawned).
#[cfg(unix)]
async fn kill_group(pid: u32) {
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

/// Runs `cmd`, returning at most `cap` bytes of stdout, whether it was cut, and the exit code.
async fn run_capped(mut cmd: Command, cap: usize) -> Result<(Vec<u8>, bool, Option<i32>), String> {
    let mut child = cmd.spawn().map_err(|e| format!("could not run git: {e}"))?;
    let pid = child.id();
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    if let Some(mut stderr) = child.stderr.take() {
        // Drain and discard: an undrained pipe blocks the writer once its 64 KB buffer fills.
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
    }
    let work = async {
        let mut buf = Vec::new();
        (&mut stdout)
            .take(cap as u64 + 1)
            .read_to_end(&mut buf)
            .await
            .map_err(|e| e.to_string())?;
        let truncated = buf.len() > cap;
        if truncated {
            buf.truncate(cap);
            #[cfg(unix)]
            if let Some(pid) = pid {
                kill_group(pid).await;
            }
            let _ = child.kill().await;
        }
        let code = child.wait().await.map_err(|e| e.to_string())?.code();
        Ok::<_, String>((buf, truncated, code))
    };
    match tokio::time::timeout(GIT_TIMEOUT, work).await {
        Ok(r) => r,
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = pid {
                kill_group(pid).await;
            }
            Err("git timed out".to_string())
        }
    }
}

/// Top level of the repository containing `dir`. `git status` reports paths relative to it, so every
/// later command must run from there (a workspace may be a subdirectory of the repo).
async fn repo_root(dir: &Path) -> Result<std::path::PathBuf, String> {
    let mut cmd = base_command(dir);
    cmd.args(["rev-parse", "--show-toplevel"]);
    let (out, _, code) = run_capped(cmd, 4096).await?;
    if code != Some(0) {
        return Err("not a git repository".to_string());
    }
    let root = String::from_utf8_lossy(&out).trim().to_string();
    if root.is_empty() {
        return Err("not a git repository".to_string());
    }
    Ok(std::path::PathBuf::from(root))
}

/// `git status` for `dir`. Errors when `dir` is not a repository.
pub async fn status(dir: &Path) -> Result<GitStatus, String> {
    let root = repo_root(dir).await?;
    let mut cmd = base_command(&root);
    cmd.args(["status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal"]);
    let (out, truncated, code) = run_capped(cmd, 2_000_000).await?;
    if truncated {
        // A cut list would look complete (and could end mid-path); say so instead.
        return Err("too many changed files to list".to_string());
    }
    if code != Some(0) {
        return Err("not a git repository".to_string());
    }
    Ok(parse_status(&String::from_utf8_lossy(&out)))
}

/// Unified diff of one file from `status`. `staged` selects index-vs-HEAD instead of worktree-vs-index.
/// Untracked files are shown as a full addition. Returns `(diff, truncated)`.
pub async fn diff(dir: &Path, status: &GitStatus, path: &str, staged: bool) -> Result<(String, bool), String> {
    let file = status
        .files
        .iter()
        .find(|f| f.path == path)
        .ok_or_else(|| "path is not a changed file".to_string())?;
    let root = repo_root(dir).await?;
    if file.untracked() {
        // `diff --no-index` prints the content of whatever the path is. A symlink only shows its target
        // string, but a hardlink to a file elsewhere would show that file's content, so only plain
        // single-link regular files are allowed.
        let meta = std::fs::symlink_metadata(root.join(path)).map_err(|_| "cannot read file".to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.is_file() && meta.nlink() > 1 {
                return Err("refusing to show a hard-linked file".to_string());
            }
        }
        if meta.is_dir() {
            return Err("path is a directory".to_string());
        }
    }
    let mut cmd = base_command(&root);
    cmd.args(["diff", "--no-color", "--no-ext-diff", "--no-textconv"]);
    if file.untracked() {
        cmd.args(["--no-index", "--", "/dev/null", path]);
    } else {
        if staged {
            cmd.arg("--cached");
        }
        cmd.args(["--", path]);
    }
    let (out, truncated, code) = run_capped(cmd, MAX_DIFF_BYTES).await?;
    // `--no-index` exits 1 when files differ, which is the normal case.
    if !matches!(code, Some(0) | Some(1)) && !truncated {
        return Err("git diff failed".to_string());
    }
    Ok((String::from_utf8_lossy(&out).into_owned(), truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_counts_and_entries() {
        let raw = "## main...origin/main [ahead 2, behind 1]\0 M src/a.rs\0A  new file.txt\0?? notes.md\0";
        let s = parse_status(raw);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert_eq!(s.files.len(), 3);
        assert!(s.files[0].unstaged() && !s.files[0].staged());
        assert!(s.files[1].staged() && !s.files[1].unstaged());
        assert_eq!(s.files[1].path, "new file.txt", "-z keeps spaces unquoted");
        assert!(s.files[2].untracked());
    }

    #[test]
    fn parses_rename_with_original_path() {
        let s = parse_status("## main\0R  new.rs\0old.rs\0 M other.rs\0");
        assert_eq!(s.files[0].path, "new.rs");
        assert_eq!(s.files[0].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(s.files[1].path, "other.rs");
    }

    #[test]
    fn parses_unusual_headers() {
        assert_eq!(parse_status("## No commits yet on trunk\0").branch.as_deref(), Some("trunk"));
        let detached = parse_status("## HEAD (no branch)\0");
        assert_eq!(detached.branch.as_deref(), Some("HEAD (no branch)"));
        assert!(detached.upstream.is_none());
    }

    fn temp_repo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gitview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-C", dir.to_str().unwrap()])
                .args(args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        run(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        run(&["add", "a.txt"]);
        run(&["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
        dir
    }

    #[tokio::test]
    async fn status_and_diff_on_a_real_repo() {
        let dir = temp_repo();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("new.txt"), "hello\n").unwrap();

        let st = status(&dir).await.unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.files.len(), 2);

        let (d, cut) = diff(&dir, &st, "a.txt", false).await.unwrap();
        assert!(!cut);
        assert!(d.contains("+two"), "{d}");

        let (d, _) = diff(&dir, &st, "new.txt", false).await.unwrap();
        assert!(d.contains("+hello"), "untracked file shown as addition: {d}");

        // Only changed files may be diffed; option-like and traversal paths are rejected.
        assert!(diff(&dir, &st, "--output=/tmp/x", false).await.is_err());
        assert!(diff(&dir, &st, "../../etc/passwd", false).await.is_err());
        assert!(diff(&dir, &st, "a.txt\0", false).await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn non_repo_is_an_error() {
        let dir = std::env::temp_dir().join(format!("notrepo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(status(&dir).await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn large_diff_is_truncated() {
        let dir = temp_repo();
        std::fs::write(dir.join("a.txt"), "x\n".repeat(300_000)).unwrap();
        let st = status(&dir).await.unwrap();
        let (d, cut) = diff(&dir, &st, "a.txt", false).await.unwrap();
        assert!(cut);
        assert!(d.len() <= MAX_DIFF_BYTES);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn subdirectory_workspace_diffs_correctly() {
        let dir = temp_repo();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/b.txt"), "base\n").unwrap();
        let g = |args: &[&str]| {
            std::process::Command::new("git")
                .args(["-C", dir.to_str().unwrap()])
                .args(args)
                .env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t")
                .output().unwrap();
        };
        g(&["add", "sub/b.txt"]);
        g(&["-c", "commit.gpgsign=false", "commit", "-q", "-m", "sub"]);
        std::fs::write(dir.join("sub/b.txt"), "base\nchanged\n").unwrap();

        // The cmux workspace points at the subdirectory, not the repo root.
        let sub = dir.join("sub");
        let st = status(&sub).await.unwrap();
        assert_eq!(st.files[0].path, "sub/b.txt", "porcelain paths are root-relative");
        let (d, _) = diff(&sub, &st, "sub/b.txt", false).await.unwrap();
        assert!(d.contains("+changed"), "diff must not be empty: {d:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn untracked_hardlink_is_refused_but_plain_file_works() {
        let dir = temp_repo();
        let outside = std::env::temp_dir().join(format!("secret-{}", uuid::Uuid::new_v4()));
        std::fs::write(&outside, "SECRET\n").unwrap();
        std::fs::hard_link(&outside, dir.join("linked.txt")).unwrap();
        std::fs::write(dir.join("plain.txt"), "ok\n").unwrap();
        let st = status(&dir).await.unwrap();
        let err = diff(&dir, &st, "linked.txt", false).await.unwrap_err();
        assert!(err.contains("hard-linked"), "{err}");
        assert!(diff(&dir, &st, "plain.txt", false).await.unwrap().0.contains("+ok"));
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(dir);
    }
}
