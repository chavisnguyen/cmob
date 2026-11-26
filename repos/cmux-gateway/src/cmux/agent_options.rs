//! Agent model / effort option catalog adapter (re-exporting pure domain logic + live `agy models` CLI probe).

pub use crate::domain::agent_options::*;

/// Model list of Antigravity. It depends on the signed-in account (`agy changelog`), so it is asked live
/// rather than kept in a static table.
pub async fn antigravity_options() -> Result<serde_json::Value, String> {
    let mut cmd = tokio::process::Command::new("agy");
    cmd.arg("models").kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output())
        .await
        .map_err(|_| "agy models timed out".to_string())?
        .map_err(|e| format!("could not run agy: {e}"))?;
    if !out.status.success() {
        return Err("agy models failed".into());
    }
    let models = parse_agy_models(&String::from_utf8_lossy(&out.stdout));
    if models.is_empty() {
        return Err("agy returned no models".into());
    }
    Ok(serde_json::json!({ "agent_kind": "antigravity", "models": models, "mid_session": "picker" }))
}
