//! Read-only file preview for markdown/text files referenced from chat (`mobile.file.read`).
//!
//! Mirrors what cmux does when a path in the conversation is clicked (`cmux markdown open <path>`
//! opens a read-only, live-reloading panel; see `.context/cmux_markdown_surface.md`), but returns
//! the content to the phone instead. Safety model: the file must resolve (after symlink
//! canonicalisation) inside the workspace directory, have an allow-listed extension, and is capped.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const MAX_BYTES: u64 = 512 * 1024;
const ALLOWED_EXTENSIONS: [&str; 4] = ["md", "mdx", "markdown", "txt"];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileRead {
    /// Path relative to the workspace directory (falls back to the file name).
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime_ms: u64,
    /// `true` when the caller's `since_mtime_ms` matches: `content` is then empty.
    pub unchanged: bool,
    pub truncated: bool,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FileReadError {
    InvalidPath,
    NotFound,
    OutsideWorkspace,
    UnsupportedType,
    NotAFile,
    Io(String),
}

impl FileReadError {
    pub fn message(&self) -> String {
        match self {
            Self::InvalidPath => "Invalid file path.".into(),
            Self::NotFound => "File not found in this workspace.".into(),
            Self::OutsideWorkspace => "File is outside this workspace.".into(),
            Self::UnsupportedType => "Only markdown and text files can be opened.".into(),
            Self::NotAFile => "Path is not a file.".into(),
            Self::Io(e) => format!("Could not read file: {e}"),
        }
    }
}

/// Resolves `raw` (relative to `root`, absolute, or `file://`) and reads it if allowed.
pub fn read_workspace_file(
    root: &Path,
    raw: &str,
    since_mtime_ms: Option<u64>,
) -> Result<FileRead, FileReadError> {
    let raw = raw.trim();
    let raw = raw.strip_prefix("file://").unwrap_or(raw);
    if raw.is_empty() || raw.contains('\0') || raw.len() > 4096 {
        return Err(FileReadError::InvalidPath);
    }

    let candidate = Path::new(raw);
    let joined: PathBuf = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };

    let root_canon = root.canonicalize().map_err(|e| FileReadError::Io(e.to_string()))?;
    let canon = joined.canonicalize().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => FileReadError::NotFound,
        _ => FileReadError::Io(e.to_string()),
    })?;
    // `canonicalize` resolved `..` and symlinks, so a prefix check is a real containment check.
    if !canon.starts_with(&root_canon) {
        return Err(FileReadError::OutsideWorkspace);
    }

    let ext_ok = canon
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ALLOWED_EXTENSIONS.iter().any(|a| a.eq_ignore_ascii_case(e)));
    if !ext_ok {
        return Err(FileReadError::UnsupportedType);
    }

    let meta = std::fs::metadata(&canon).map_err(|e| FileReadError::Io(e.to_string()))?;
    if !meta.is_file() {
        return Err(FileReadError::NotAFile);
    }
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let name = canon.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let path = canon
        .strip_prefix(&root_canon)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| name.clone());

    if since_mtime_ms == Some(mtime_ms) {
        return Ok(FileRead { path, name, size, mtime_ms, unchanged: true, truncated: false, content: String::new() });
    }

    let mut buf = Vec::new();
    std::fs::File::open(&canon)
        .and_then(|f| f.take(MAX_BYTES).read_to_end(&mut buf))
        .map_err(|e| FileReadError::Io(e.to_string()))?;
    Ok(FileRead {
        path,
        name,
        size,
        mtime_ms,
        unchanged: false,
        truncated: size > MAX_BYTES,
        content: String::from_utf8_lossy(&buf).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cmob-file-read-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn reads_relative_and_absolute_inside_workspace() {
        let root = scratch();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/plan.md"), "# Plan\n").unwrap();
        let rel = read_workspace_file(&root, "docs/plan.md", None).unwrap();
        assert_eq!(rel.content, "# Plan\n");
        assert_eq!(rel.path, "docs/plan.md");
        assert_eq!(rel.name, "plan.md");
        let abs = read_workspace_file(&root, root.join("docs/plan.md").to_str().unwrap(), None).unwrap();
        assert_eq!(abs.content, rel.content);
        let url = format!("file://{}", root.join("docs/plan.md").display());
        assert_eq!(read_workspace_file(&root, &url, None).unwrap().content, rel.content);
    }

    #[test]
    fn rejects_escape_via_dotdot_absolute_and_symlink() {
        let root = scratch();
        let outside = scratch();
        std::fs::write(outside.join("secret.md"), "nope").unwrap();
        let dotdot = format!("../{}/secret.md", outside.file_name().unwrap().to_string_lossy());
        assert_eq!(read_workspace_file(&root, &dotdot, None), Err(FileReadError::OutsideWorkspace));
        assert_eq!(
            read_workspace_file(&root, outside.join("secret.md").to_str().unwrap(), None),
            Err(FileReadError::OutsideWorkspace)
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("secret.md"), root.join("link.md")).unwrap();
            assert_eq!(read_workspace_file(&root, "link.md", None), Err(FileReadError::OutsideWorkspace));
        }
    }

    #[test]
    fn rejects_other_types_missing_dirs_and_bad_input() {
        let root = scratch();
        std::fs::write(root.join("a.rs"), "fn main(){}").unwrap();
        std::fs::create_dir_all(root.join("dir.md")).unwrap();
        assert_eq!(read_workspace_file(&root, "a.rs", None), Err(FileReadError::UnsupportedType));
        assert_eq!(read_workspace_file(&root, "missing.md", None), Err(FileReadError::NotFound));
        assert_eq!(read_workspace_file(&root, "dir.md", None), Err(FileReadError::NotAFile));
        assert_eq!(read_workspace_file(&root, "", None), Err(FileReadError::InvalidPath));
        assert_eq!(read_workspace_file(&root, "a\0.md", None), Err(FileReadError::InvalidPath));
    }

    #[test]
    fn truncates_large_files_and_reports_unchanged() {
        let root = scratch();
        std::fs::write(root.join("big.MD"), vec![b'a'; (MAX_BYTES + 10) as usize]).unwrap();
        let r = read_workspace_file(&root, "big.MD", None).unwrap();
        assert!(r.truncated);
        assert_eq!(r.content.len() as u64, MAX_BYTES);
        assert_eq!(r.size, MAX_BYTES + 10);
        let again = read_workspace_file(&root, "big.MD", Some(r.mtime_ms)).unwrap();
        assert!(again.unchanged && again.content.is_empty());
    }
}
