//! On-demand image bytes for user prompts in a Claude Code transcript (`mobile.chat.readImage`).
//!
//! Claude stores pasted/attached images inline in the JSONL as
//! `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}` inside a
//! `type:"user"` line (verified on real transcripts, see `.context/image_view.md`). The chat
//! payload only carries an opaque id (`<line uuid>#<image index>`, see `AgentEvent::UserImage`);
//! this module finds that line and returns the one image.

use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// Cap on the base64 payload; stays well under the 2 MiB WebSocket message limit.
pub const MAX_BASE64_CHARS: usize = 1_500_000;
/// `svg` is deliberately absent: it can carry script when opened as a document.
const ALLOWED_MEDIA_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TranscriptImage {
    pub media_type: String,
    /// Base64 without a `data:` prefix.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ImageError {
    InvalidId,
    NotFound,
    TooLarge,
    UnsupportedType,
    Io(String),
}

impl ImageError {
    pub fn message(&self) -> String {
        match self {
            Self::InvalidId => "Invalid image id.".into(),
            Self::NotFound => "Image not found in the session transcript.".into(),
            Self::TooLarge => "Image is too large to preview on the phone.".into(),
            Self::UnsupportedType => "Unsupported image type.".into(),
            Self::Io(e) => format!("Could not read transcript: {e}"),
        }
    }
}

/// Splits `<uuid>#<index>`; the uuid is restricted to `[A-Za-z0-9-]` (it is matched as a substring).
pub fn parse_image_id(id: &str) -> Option<(&str, usize)> {
    let (uuid, idx) = id.split_once('#')?;
    if uuid.is_empty()
        || uuid.len() > 64
        || !uuid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    Some((uuid, idx.parse().ok().filter(|i| *i < 256)?))
}

pub fn read_claude_image(transcript: &Path, image_id: &str) -> Result<TranscriptImage, ImageError> {
    let (uuid, index) = parse_image_id(image_id).ok_or(ImageError::InvalidId)?;
    let needle = format!("\"uuid\":\"{uuid}\"");
    let file = std::fs::File::open(transcript).map_err(|e| ImageError::Io(e.to_string()))?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| ImageError::Io(e.to_string()))?;
        if n == 0 {
            return Err(ImageError::NotFound);
        }
        // `parentUuid` has a capital U, so this only matches a line's own uuid.
        if !line.contains(&needle) {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else { continue };
        if val.get("uuid").and_then(|u| u.as_str()) != Some(uuid)
            || val.get("type").and_then(|t| t.as_str()) != Some("user")
        {
            continue;
        }
        let Some(blocks) = val.pointer("/message/content").and_then(|c| c.as_array()) else {
            continue;
        };
        let Some(img) = blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("image"))
            .nth(index)
        else {
            return Err(ImageError::NotFound);
        };
        let source = img.get("source").ok_or(ImageError::NotFound)?;
        if source.get("type").and_then(|t| t.as_str()) != Some("base64") {
            return Err(ImageError::NotFound);
        }
        let media_type = source.get("media_type").and_then(|m| m.as_str()).unwrap_or("");
        if !ALLOWED_MEDIA_TYPES.contains(&media_type) {
            return Err(ImageError::UnsupportedType);
        }
        let data = source.get("data").and_then(|d| d.as_str()).ok_or(ImageError::NotFound)?;
        if data.len() > MAX_BASE64_CHARS {
            return Err(ImageError::TooLarge);
        }
        return Ok(TranscriptImage { media_type: media_type.to_string(), data: data.to_string() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    fn transcript(lines: &[&str]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "cmob-img-{}-{}.jsonl",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&p, lines.join("\n")).unwrap();
        p
    }

    const USER: &str = r#"{"type":"user","uuid":"aaaa-1","parentUuid":"zzzz-0","message":{"role":"user","content":[{"type":"text","text":"[Image #1]"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"QUJD"}},{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"REVG"}}]}}"#;

    #[test]
    fn parses_ids_strictly() {
        assert_eq!(parse_image_id("aaaa-1#0"), Some(("aaaa-1", 0)));
        assert_eq!(parse_image_id("aaaa-1#12"), Some(("aaaa-1", 12)));
        for bad in ["", "#0", "aaaa", "aaaa#x", "a\"b#0", "a b#0", "aaaa#999", "../x#0"] {
            assert_eq!(parse_image_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn returns_the_nth_image_of_the_matching_line() {
        let p = transcript(&[r#"{"type":"user","uuid":"other","message":{"content":[]}}"#, USER]);
        let a = read_claude_image(&p, "aaaa-1#0").unwrap();
        assert_eq!((a.media_type.as_str(), a.data.as_str()), ("image/png", "QUJD"));
        let b = read_claude_image(&p, "aaaa-1#1").unwrap();
        assert_eq!((b.media_type.as_str(), b.data.as_str()), ("image/jpeg", "REVG"));
        assert_eq!(read_claude_image(&p, "aaaa-1#2"), Err(ImageError::NotFound));
    }

    #[test]
    fn parent_uuid_references_do_not_match() {
        let p = transcript(&[USER]);
        assert_eq!(read_claude_image(&p, "zzzz-0#0"), Err(ImageError::NotFound));
        assert_eq!(read_claude_image(&p, "missing#0"), Err(ImageError::NotFound));
    }

    #[test]
    fn rejects_svg_and_oversize_payloads() {
        let svg = r#"{"type":"user","uuid":"s1","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/svg+xml","data":"PHN2Zz4="}}]}}"#;
        let big = format!(
            r#"{{"type":"user","uuid":"b1","message":{{"content":[{{"type":"image","source":{{"type":"base64","media_type":"image/png","data":"{}"}}}}]}}}}"#,
            "A".repeat(MAX_BASE64_CHARS + 1)
        );
        let p = transcript(&[svg, &big]);
        assert_eq!(read_claude_image(&p, "s1#0"), Err(ImageError::UnsupportedType));
        assert_eq!(read_claude_image(&p, "b1#0"), Err(ImageError::TooLarge));
    }
}
