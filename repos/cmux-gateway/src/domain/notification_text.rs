//! Pure notification text formatting, truncation, placeholder filtering, and Markdown stripping.

/// Max characters for workspace/surface context and subtitle fields.
/// Matches Orca `NOTIFICATION_TITLE_CONTEXT_MAX_LENGTH` (`ref/orca/src/main/ipc/notification-options.ts:9`).
pub const TITLE_MAX_CHARS: usize = 80;

/// Max characters for notification body previews.
/// Matches Orca `NOTIFICATION_BODY_PREVIEW_MAX_LENGTH` (`ref/orca/src/main/ipc/notification-options.ts:10`).
pub const BODY_MAX_CHARS: usize = 180;

/// Maximum topic/tag length permitted by Web Push (RFC 8030 section 5.4).
pub const MAX_PUSH_TAG_LEN: usize = 32;

/// Strip common Markdown syntax from a string so it reads naturally as plain text in a
/// push-notification body or sidebar workspace snippet.
pub fn strip_markdown_for_notification(text: &str) -> String {
    let mut lines_out: Vec<&str> = Vec::new();
    let mut in_fence = false;

    for raw_line in text.lines() {
        let line = raw_line.trim();

        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            lines_out.push(raw_line);
            continue;
        }
        if line.starts_with('|') {
            continue;
        }
        {
            let stripped = line.replace(['-', '*', '_', ' '], "");
            if stripped.is_empty() && !line.is_empty() {
                continue;
            }
        }
        if let Some(rest) = line.strip_prefix('#') {
            let heading = rest.trim_start_matches('#').trim();
            if !heading.is_empty() {
                lines_out.push(heading);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix('>') {
            let content = rest.trim_start_matches('>').trim();
            if !content.is_empty() {
                lines_out.push(content);
            }
            continue;
        }

        lines_out.push(line);
    }

    let joined = lines_out.join(" ");

    fn strip_inline(src: &str) -> String {
        let chars: Vec<char> = src.chars().collect();
        let n = chars.len();
        let mut out = String::with_capacity(src.len());
        let mut i = 0;
        while i < n {
            if chars[i] == '!'
                && i + 1 < n
                && chars[i + 1] == '['
                && let Some((alt, skip)) = find_link_parts(&chars, i + 1)
            {
                if !alt.is_empty() {
                    out.push_str(&alt);
                }
                i += skip + 1;
                continue;
            }
            if chars[i] == '['
                && let Some((label, skip)) = find_link_parts(&chars, i)
            {
                out.push_str(&label);
                i += skip;
                continue;
            }
            if chars[i] == '*' || chars[i] == '_' {
                let marker = chars[i];
                let double = i + 1 < n && chars[i + 1] == marker;
                let fence_len = if double { 2 } else { 1 };
                let search_start = i + fence_len;
                let prev_alnum = i > 0 && chars[i - 1].is_alphanumeric();
                let open_valid = search_start < n
                    && !chars[search_start].is_whitespace()
                    && (marker != '_' || !prev_alnum);
                if open_valid {
                    let close = find_closing_emphasis(&chars, search_start, marker, fence_len);
                    if let Some(end) = close {
                        let inner: String = chars[search_start..end].iter().collect();
                        out.push_str(&inner);
                        i = end + fence_len;
                        continue;
                    }
                }
            }
            if chars[i] == '`' {
                let fence_len = if i + 1 < n && chars[i + 1] == '`' { 2 } else { 1 };
                let search_start = i + fence_len;
                let close = if fence_len == 2 {
                    find_closing(&chars, search_start, &['`', '`'])
                } else {
                    find_closing_single(&chars, search_start, '`')
                };
                if let Some(end) = close {
                    let inner: String = chars[search_start..end].iter().collect();
                    out.push_str(&inner);
                    i = end + fence_len;
                    continue;
                }
            }
            out.push(chars[i]);
            i += 1;
        }
        out
    }

    fn find_link_parts(chars: &[char], pos: usize) -> Option<(String, usize)> {
        if chars.get(pos) != Some(&'[') {
            return None;
        }
        let close_bracket = chars[pos + 1..].iter().position(|&c| c == ']')? + pos + 1;
        if chars.get(close_bracket + 1) != Some(&'(') {
            return None;
        }
        let close_paren =
            chars[close_bracket + 2..].iter().position(|&c| c == ')')? + close_bracket + 2;
        let label: String = chars[pos + 1..close_bracket].iter().collect();
        let consumed = close_paren - pos + 1;
        Some((label, consumed))
    }

    fn find_closing_emphasis(
        chars: &[char],
        from: usize,
        marker: char,
        fence_len: usize,
    ) -> Option<usize> {
        let n = chars.len();
        if from + fence_len > n {
            return None;
        }
        for idx in from..=(n - fence_len) {
            let matches_fence = if fence_len == 2 {
                chars[idx] == marker && chars[idx + 1] == marker
            } else {
                chars[idx] == marker
                    && (idx + 1 >= n || chars[idx + 1] != marker)
                    && (idx == 0 || chars[idx - 1] != marker)
            };
            if !matches_fence {
                continue;
            }
            if idx == from || chars[idx - 1].is_whitespace() {
                continue;
            }
            let after_idx = idx + fence_len;
            if marker == '_' && after_idx < n && chars[after_idx].is_alphanumeric() {
                continue;
            }
            return Some(idx);
        }
        None
    }

    fn find_closing(chars: &[char], from: usize, pat: &[char]) -> Option<usize> {
        let n = chars.len();
        let plen = pat.len();
        if from + plen > n {
            return None;
        }
        for i in from..=(n - plen) {
            if &chars[i..i + plen] == pat {
                return Some(i);
            }
        }
        None
    }

    fn find_closing_single(chars: &[char], from: usize, pat: char) -> Option<usize> {
        chars[from..].iter().position(|&c| c == pat).map(|p| p + from)
    }

    strip_inline(&joined)
}

pub fn normalize_text(value: Option<&str>, max_chars: usize) -> String {
    let Some(raw) = value else {
        return String::new();
    };
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() || max_chars == 0 {
        return String::new();
    }
    let char_count = collapsed.chars().count();
    if char_count <= max_chars {
        return collapsed;
    }
    if max_chars == 1 {
        return "…".to_string();
    }
    let mut truncated: String = collapsed.chars().take(max_chars - 1).collect();
    truncated.push('…');
    truncated
}

pub fn is_generic_placeholder(text: &str) -> bool {
    let lower = text.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return true;
    }
    matches!(
        lower.as_str(),
        "needs input"
            | "permission"
            | "permission required"
            | "needs approval"
            | "approval required"
            | "agent requested approval"
            | "turn finished"
            | "turn complete"
            | "completed"
            | "done"
            | "finished"
            | "waiting for input"
            | "error"
            | "failed"
    )
}
