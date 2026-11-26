//! Unified `AwaitingInput` answer receipt normalizer across Antigravity, Claude, Kiro, and OpenCode.

/// Strip leading `Created At: ...` / `Completed At: ...` lines that Antigravity prefixes onto
/// every `GENERIC` tool result (often duplicated twice).
pub fn strip_agy_tool_headers(raw: &str) -> &str {
    let mut rest = raw;
    loop {
        let trimmed = rest.trim_start_matches(['\r', '\n']);
        if let Some(nl) = trimmed.find('\n') {
            let line = trimmed[..nl].trim();
            if line.starts_with("Created At:") || line.starts_with("Completed At:") {
                rest = &trimmed[nl + 1..];
                continue;
            }
        } else {
            let line = trimmed.trim();
            if line.starts_with("Created At:") || line.starts_with("Completed At:") {
                return "";
            }
        }
        return trimmed;
    }
}

fn parse_a_number_line(line: &str) -> Option<&str> {
    let t = line.trim();
    let after_a = t.strip_prefix('A')?;
    let colon = after_a.find(':')?;
    let num = &after_a[..colon];
    if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
        Some(after_a[colon + 1..].trim())
    } else {
        None
    }
}

/// Parses Claude's `"User has answered your questions: \"Q1\"=\"A1\", \"Q2\"=\"A2\". You can now..."`
/// prose receipt into clean answer values.
fn clean_claude_prose_answer(stripped: &str) -> Option<String> {
    let rest = stripped
        .strip_prefix("User has answered your questions:")
        .or_else(|| stripped.strip_prefix("User has answered your question:"))?
        .trim();
    let core = rest
        .strip_suffix("You can now continue with the user's answers in mind.")
        .map(str::trim)
        .map(|s| s.strip_suffix('.').unwrap_or(s).trim())
        .unwrap_or(rest);
    if core.is_empty() {
        return None;
    }

    // Parse `"question"="answer"` pairs when formatted in Claude's standard quoted form.
    let mut answers = Vec::new();
    let mut cursor = core;
    while !cursor.is_empty() {
        cursor = cursor.trim_start_matches([',', ' ']);
        if !cursor.starts_with('"') {
            answers.clear();
            break;
        }
        // Scan quoted question
        let Some((_q, after_q)) = take_quoted(cursor) else {
            answers.clear();
            break;
        };
        let Some(after_eq) = after_q.trim_start().strip_prefix('=') else {
            answers.clear();
            break;
        };
        let after_eq = after_eq.trim_start();
        if after_eq.starts_with('"') {
            let Some((ans, rem)) = take_quoted(after_eq) else {
                answers.clear();
                break;
            };
            if !ans.trim().is_empty() {
                answers.push(ans.trim().to_string());
            }
            cursor = rem.trim();
        } else {
            let end = after_eq.find(',').unwrap_or(after_eq.len());
            let ans = after_eq[..end].trim();
            if !ans.is_empty() {
                answers.push(ans.to_string());
            }
            cursor = &after_eq[end..];
        }
    }
    if !answers.is_empty() {
        return Some(answers.join("\n"));
    }
    Some(core.to_string())
}

fn take_quoted(s: &str) -> Option<(String, &str)> {
    let mut chars = s.strip_prefix('"')?.char_indices();
    let mut out = String::new();
    let mut escaped = false;
    for (idx, ch) in &mut chars {
        if escaped {
            out.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some((out, &s[idx + 2..]));
        } else {
            out.push(ch);
        }
    }
    None
}

/// Normalize question tool answers (`A1..AN:` from Antigravity or `"User has answered..."` from Claude/OpenCode)
/// into clean human-readable answer text for `AwaitingInput.answered`.
pub fn clean_question_answer_text(raw: &str) -> String {
    let stripped = strip_agy_tool_headers(raw).trim();
    if stripped.is_empty() {
        return String::new();
    }

    if let Some(claude_ans) = clean_claude_prose_answer(stripped) {
        return claude_ans;
    }

    // Antigravity single & multi-question `A1: ...` / `A2: ...` blocks.
    let lines: Vec<&str> = stripped.lines().collect();
    if let Some(first_val) = lines.first().and_then(|l| parse_a_number_line(l)) {
        let mut blocks: Vec<String> = vec![first_val.to_string()];
        for line in &lines[1..] {
            if let Some(next_val) = parse_a_number_line(line) {
                blocks.push(next_val.to_string());
            } else if let Some(last) = blocks.last_mut() {
                if last.is_empty() {
                    last.push_str(line.trim());
                } else {
                    last.push('\n');
                    last.push_str(line);
                }
            }
        }
        let non_empty: Vec<String> = blocks
            .into_iter()
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
            .collect();
        return non_empty.join("\n");
    }

    stripped.to_string()
}

fn format_answer_value(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        serde_json::Value::Array(arr) => {
            let items: Vec<String> = arr.iter().filter_map(format_answer_value).collect();
            (!items.is_empty()).then(|| items.join(", "))
        }
        serde_json::Value::Object(map) => {
            if let Some(l) = map
                .get("label")
                .or_else(|| map.get("answer"))
                .or_else(|| map.get("value"))
                .and_then(format_answer_value)
            {
                return Some(l);
            }
            let vals: Vec<String> = map.values().filter_map(format_answer_value).collect();
            (!vals.is_empty()).then(|| vals.join("\n"))
        }
        _ => None,
    }
}

/// Extracts structured answers from Claude's `toolUseResult.answers` map/array if present.
pub fn extract_claude_tool_use_answers(tool_meta: Option<&serde_json::Value>) -> Option<String> {
    let answers = tool_meta?.get("answers")?;
    match answers {
        serde_json::Value::Object(map) => {
            let vals: Vec<String> = map.values().filter_map(format_answer_value).collect();
            (!vals.is_empty()).then(|| vals.join("\n"))
        }
        serde_json::Value::Array(arr) => {
            let vals: Vec<String> = arr.iter().filter_map(format_answer_value).collect();
            (!vals.is_empty()).then(|| vals.join("\n"))
        }
        serde_json::Value::String(s) => {
            let c = clean_question_answer_text(s);
            (!c.is_empty()).then_some(c)
        }
        _ => None,
    }
}

/// Extracts a human-readable receipt from Kiro's `interaction_resolved` payload.
pub fn extract_kiro_resolved_answer(
    payload: &serde_json::Value,
    options: Option<&[String]>,
) -> String {
    for key in ["selectedOptionName", "optionName", "label", "answer", "selectedOption"] {
        if let Some(val) = payload.get(key) {
            if let Some(s) = val.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                return s.to_string();
            }
            if let Some(name) = val
                .get("name")
                .or_else(|| val.get("label"))
                .and_then(|n| n.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return name.to_string();
            }
        }
    }
    if let Some(idx) = payload.get("optionIndex").and_then(|i| i.as_u64())
        && let Some(opts) = options
        && let Some(found) = opts.get(idx as usize)
    {
        return found.clone();
    }
    if let Some(outcome) = payload.get("outcome").and_then(|o| o.as_str()).map(str::trim) {
        return match outcome {
            "cancelled" | "rejected" | "denied" | "dismissed" => "Rejected".to_string(),
            "selected" | "approved" | "allowed" | "" => options
                .and_then(|o| o.first())
                .cloned()
                .unwrap_or_else(|| "Approved".to_string()),
            other => other.to_string(),
        };
    }
    options
        .and_then(|o| o.first())
        .cloned()
        .unwrap_or_else(|| "Approved".to_string())
}

/// Extracts a human-readable receipt from a completed OpenCode `question` tool's `state`.
pub fn extract_opencode_question_answer(state: Option<&serde_json::Value>) -> Option<String> {
    let state = state?;
    if let Some(ans) = state
        .pointer("/metadata/answers")
        .or_else(|| state.get("answers"))
        .and_then(format_answer_value)
    {
        let cleaned = clean_question_answer_text(&ans);
        if !cleaned.is_empty() {
            return Some(cleaned);
        }
    }
    if let Some(out) = state.get("output").and_then(|o| o.as_str()) {
        let cleaned = clean_question_answer_text(out);
        if !cleaned.is_empty() {
            return Some(cleaned);
        }
    }
    if let Some(content) = state.get("content") {
        let raw = match content {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(items) => items
                .iter()
                .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        let cleaned = clean_question_answer_text(&raw);
        if !cleaned.is_empty() {
            return Some(cleaned);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_antigravity_single_and_multi_question_receipts() {
        let single = "Created At: 2026-11-25T20:53:01+07:00\nCompleted At: 2026-11-25T20:53:20+07:00\nA1: (Recommended) Chốt luôn brew";
        assert_eq!(clean_question_answer_text(single), "(Recommended) Chốt luôn brew");

        let multi = "Created At: 2026-11-25T20:53:01+07:00\nA1: Option Alpha\nA2: Custom write-in\nwith second line\nA3: Option Gamma";
        assert_eq!(
            clean_question_answer_text(multi),
            "Option Alpha\nCustom write-in\nwith second line\nOption Gamma"
        );
    }

    #[test]
    fn cleans_claude_answers_map_and_prose_string() {
        let meta = serde_json::json!({
            "answers": {
                "Which DB?": "SQLite",
                "Features?": ["WAL", "FTS5"]
            }
        });
        let extracted = extract_claude_tool_use_answers(Some(&meta)).unwrap();
        assert!(extracted.contains("SQLite"));
        assert!(extracted.contains("WAL, FTS5"));

        let prose = r#"User has answered your questions: "Scope?"="Gateway only", "Tests?"="cargo test --all". You can now continue with the user's answers in mind."#;
        assert_eq!(clean_question_answer_text(prose), "Gateway only\ncargo test --all");
    }

    #[test]
    fn extracts_kiro_and_opencode_answers() {
        let kiro = serde_json::json!({ "outcome": "selected" });
        let opts = vec!["Allow once".to_string(), "Deny".to_string()];
        assert_eq!(extract_kiro_resolved_answer(&kiro, Some(&opts)), "Allow once");

        let oc_state = serde_json::json!({
            "status": "completed",
            "metadata": { "answers": [["L0 → L1 → L2"]] }
        });
        assert_eq!(
            extract_opencode_question_answer(Some(&oc_state)).as_deref(),
            Some("L0 → L1 → L2")
        );
    }
}
