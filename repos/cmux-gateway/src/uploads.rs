//! Image uploads from the phone.
//!
//! Orca saves a phone-picked image as a temporary file on the host and pastes its path into the agent:
//! terminal TUIs treat a pasted image file path as an attachment, the same as a clipboard screenshot
//! (`ref/orca/src/shared/image-path-paste.ts:9`, `ref/orca/src/main/runtime/rpc/methods/clipboard/clipboard.ts:105-122`).
//! This is the gateway half of that.
//!
//! Safety: the file name is generated here (UUID + extension chosen from the *content*, never from client
//! input), the type is decided by magic bytes, size and file count are capped, the directory is private
//! (0700, files 0600) and old files are deleted on every upload.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Largest accepted image after base64 decoding. The WebSocket frame cap is 2 MiB and base64 adds a third,
/// so the client downsizes photos before uploading.
pub const MAX_IMAGE_BYTES: usize = 1_400_000;
const MAX_FILES: usize = 50;
/// Long enough that an image attached to a queued message is still there when the agent finally frees up.
const MAX_AGE: Duration = Duration::from_secs(72 * 3600);

/// `CMUX_UPLOAD_DIR`, else `~/.cmux/uploads`.
pub fn default_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CMUX_UPLOAD_DIR") {
        return Some(PathBuf::from(p));
    }
    std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".cmux").join("uploads"))
}

/// Extension for the image type the bytes really are (PNG, JPEG, GIF, WebP), or None.
pub fn sniff_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// True for names this module generates (32 hex chars + a known image extension). Pruning only touches
/// these, so pointing `CMUX_UPLOAD_DIR` at a directory with other files never deletes them.
fn is_our_file(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else { return false };
    stem.len() == 32 && stem.bytes().all(|b| b.is_ascii_hexdigit()) && matches!(ext, "png" | "jpg" | "gif" | "webp")
}

/// Deletes our files older than `MAX_AGE` and, if still over `MAX_FILES`, the oldest ones.
fn prune(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    let mut files: Vec<(PathBuf, SystemTime)> = read
        .flatten()
        .filter_map(|e| {
            if !is_our_file(&e.file_name().to_string_lossy()) {
                return None;
            }
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| (e.path(), meta.modified().unwrap_or(now)))
        })
        .collect();
    files.retain(|(p, t)| {
        if now.duration_since(*t).unwrap_or_default() > MAX_AGE {
            let _ = std::fs::remove_file(p);
            false
        } else {
            true
        }
    });
    files.sort_by_key(|(_, t)| *t);
    while files.len() >= MAX_FILES {
        let (p, _) = files.remove(0);
        let _ = std::fs::remove_file(p);
    }
}

/// Saves `bytes` as a new image file in `dir` and returns its absolute path.
pub fn save_image(dir: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("empty image".into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("image too large (max {} bytes)", MAX_IMAGE_BYTES));
    }
    let ext = sniff_extension(bytes).ok_or("unsupported image type (PNG, JPEG, GIF or WebP only)")?;

    if dir.as_os_str().is_empty() || !dir.is_absolute() {
        return Err("upload directory must be an absolute path".into());
    }
    let existed = dir.exists();
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create upload dir: {e}"))?;
    #[cfg(unix)]
    if !existed {
        // Only lock down a directory we created; never chmod one the operator pointed us at.
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    prune(dir);

    let path = dir.join(format!("{}.{ext}", uuid::Uuid::new_v4().simple()));
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("cannot write image: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("cannot write image: {e}"))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, bytes).map_err(|e| format!("cannot write image: {e}"))?;

    // Canonicalize so the path pasted into the agent is the real one (no symlinked temp dirs).
    Ok(std::fs::canonicalize(&path).unwrap_or(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

    fn tmp() -> PathBuf {
        std::env::temp_dir().join(format!("uploads-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn sniffs_real_image_types_only() {
        assert_eq!(sniff_extension(PNG), Some("png"));
        assert_eq!(sniff_extension(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(sniff_extension(b"GIF89a...."), Some("gif"));
        assert_eq!(sniff_extension(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_extension(b"#!/bin/sh\necho hi"), None);
        assert_eq!(sniff_extension(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None, "SVG is not accepted");
        assert_eq!(sniff_extension(b""), None);
    }

    #[test]
    fn saves_with_generated_name_and_private_mode() {
        let dir = tmp();
        let p = save_image(&dir, PNG).unwrap();
        assert_eq!(p.extension().unwrap(), "png");
        assert!(p.starts_with(std::fs::canonicalize(&dir).unwrap()));
        assert_eq!(std::fs::read(&p).unwrap(), PNG);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_non_images_empty_and_oversize() {
        let dir = tmp();
        assert!(save_image(&dir, b"not an image").is_err());
        assert!(save_image(&dir, b"").is_err());
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(save_image(&dir, &big).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn file_count_is_bounded() {
        let dir = tmp();
        for _ in 0..MAX_FILES + 5 {
            save_image(&dir, PNG).unwrap();
        }
        let n = std::fs::read_dir(&dir).unwrap().count();
        assert!(n <= MAX_FILES, "{n} files kept");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prune_leaves_foreign_files_alone() {
        let dir = tmp();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.txt"), "keep me").unwrap();
        std::fs::write(dir.join("photo.png"), "keep me too").unwrap();
        for _ in 0..MAX_FILES + 3 {
            save_image(&dir, PNG).unwrap();
        }
        assert!(dir.join("notes.txt").exists());
        assert!(dir.join("photo.png").exists(), "name is not ours (not 32 hex)");
        assert!(is_our_file("0123456789abcdef0123456789abcdef.jpg"));
        assert!(!is_our_file("0123456789abcdef.jpg"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn relative_or_empty_dir_is_refused() {
        assert!(save_image(Path::new(""), PNG).is_err());
        assert!(save_image(Path::new("relative/dir"), PNG).is_err());
    }
}
