//! Pure domain models for the 3-level cmux workspace -> surface -> agent hierarchy.

use serde::{Deserialize, Serialize};

/// Level 1: Workspace Node matching cmux macOS Sidebar
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceNode {
    pub id: String,
    pub r#ref: String,
    pub title: String,
    pub pinned: bool,
    pub selected: bool,
    /// Status badge: "running" (⚡ Running), "waiting", or "idle" (⚪ Idle)
    pub status: String,
    pub current_directory: String,
    /// User-chosen sidebar color from cmux (`workspace.list` -> `custom_color`), `#RRGGBB`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Latest notification or turn summary snippet
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    /// Unread notification count for this workspace (from `cmux rpc notification.list`).
    #[serde(default)]
    pub unread_count: usize,
    /// Level 2 surfaces inside this workspace
    pub surfaces: Vec<SurfaceNode>,
}

/// Summary item for mobile.workspace.list
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub r#ref: String,
    pub title: String,
    pub pinned: bool,
    pub selected: bool,
    pub status: String,
    pub current_directory: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(default)]
    pub unread_count: usize,
    pub surface_count: usize,
    pub has_running_agent: bool,
}

/// Level 2: Surface Node (Terminal, Markdown, or Browser tab)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SurfaceNode {
    pub id: String,
    pub r#ref: String,
    pub title: String,
    /// "terminal" | "markdown" | "browser"
    pub surface_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tty: Option<String>,
    pub selected: bool,
    pub focused: bool,
    /// Unread notification count targeting this surface (`cmux rpc notification.list`).
    #[serde(default)]
    pub unread_count: usize,
    /// Level 3 Agent metadata if active on this surface
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<SurfaceAgentInfo>,
}

/// Level 3: Active AI Agent metadata
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SurfaceAgentInfo {
    pub session_id: String,
    pub agent_kind: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
}

/// Accept only `#RRGGBB` (the client puts it into CSS); anything else is dropped.
pub fn sanitize_hex_color(raw: &str) -> Option<String> {
    let t = raw.trim();
    let hex = t.strip_prefix('#')?;
    (hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("#{}", hex.to_uppercase()))
}
