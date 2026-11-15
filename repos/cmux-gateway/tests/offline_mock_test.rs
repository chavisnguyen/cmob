use std::collections::HashMap;
use std::path::Path;

// Import gateway modules
use cmux_gateway::scanner::hook_store::HookStoreIndex;
use cmux_gateway::scanner::transcript::TranscriptReader;
use cmux_gateway::scanner::workspace_tree::{SurfaceNode, WorkspaceNode};

#[test]
fn test_offline_fixture_tree_and_hook_merge() {
    let fixture_dir = Path::new("tests/fixtures");
    if !fixture_dir.exists() {
        eprintln!("Skipping: fixture dir not found");
        return;
    }

    // 1. Load Hook Sessions
    let mut hook_index = HookStoreIndex::default();
    let claude_hook_path = fixture_dir.join("claude_hook_sessions.json");
    if claude_hook_path.exists() {
        hook_index.load_file(&claude_hook_path, "claude");
    }

    let agy_hook_path = fixture_dir.join("antigravity_hook_sessions.json");
    if agy_hook_path.exists() {
        hook_index.load_file(&agy_hook_path, "antigravity");
    }

    // Verify hook index liveness & snippet
    let project_a_id = "4EA5F151-84D5-41E3-A92B-D9A082DD1EBC";
    assert_eq!(hook_index.is_workspace_running(project_a_id), false);
    let snippet = hook_index.get_workspace_snippet(project_a_id);
    assert!(snippet.is_some());
    assert!(snippet.unwrap().contains("Đã lưu vào"));

    let tools_id = "1580694D-A6F5-40C2-94AD-E22E60A7855E";
    // Fixture timestamps are from recording time, so wall-clock staleness (live_lifecycle, 30 min)
    // would always decay them; assert the hook-derived state the fixture encodes instead.
    let tools_working = hook_index.sessions_by_workspace[tools_id]
        .iter()
        .any(|s| s.resolved_lifecycle() == cmux_gateway::protocol::event::AgentLifecycleState::Working);
    assert!(tools_working);
    assert_eq!(hook_index.is_workspace_running(tools_id), false, "recorded fixture is stale now");

    // 2. Load Tree and Workspace List fixtures
    let tree_path = fixture_dir.join("cmux_tree.json");
    let tree_content = std::fs::read_to_string(tree_path).expect("read cmux_tree.json");
    let tree_json: serde_json::Value = serde_json::from_str(&tree_content).expect("parse tree");

    let ws_list_path = fixture_dir.join("cmux_workspace_list.json");
    let ws_list_content = std::fs::read_to_string(ws_list_path).expect("read cmux_workspace_list.json");
    let ws_list_json: serde_json::Value = serde_json::from_str(&ws_list_content).expect("parse ws_list");

    let mut dirs_by_id = HashMap::new();
    if let Some(arr) = ws_list_json.get("workspaces").and_then(|w| w.as_array()) {
        for w in arr {
            if let (Some(id), Some(dir)) = (w.get("id").and_then(|i| i.as_str()), w.get("current_directory").and_then(|d| d.as_str())) {
                dirs_by_id.insert(id.to_string(), dir.to_string());
            }
        }
    }

    // 3. Assemble 3-Level hierarchy from fixtures
    let mut workspaces = Vec::new();
    if let Some(windows) = tree_json.get("windows").and_then(|w| w.as_array()) {
        for win in windows {
            if let Some(ws_arr) = win.get("workspaces").and_then(|w| w.as_array()) {
                for raw_ws in ws_arr {
                    let id = raw_ws.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                    let r#ref = raw_ws.get("ref").and_then(|r| r.as_str()).unwrap_or("").to_string();
                    let title = raw_ws.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    let pinned = raw_ws.get("pinned").and_then(|p| p.as_bool()).unwrap_or(false);
                    let selected = raw_ws.get("selected").and_then(|s| s.as_bool()).unwrap_or(false);
                    let cwd = dirs_by_id.get(&id).cloned().unwrap_or_else(|| "~".to_string());

                    // Hook-derived state only: fixture timestamps are stale against the wall clock.
                    let is_running = hook_index.sessions_by_workspace.get(&id).is_some_and(|v| {
                        v.iter().any(|s| s.resolved_lifecycle() == cmux_gateway::protocol::event::AgentLifecycleState::Working)
                    });
                    let status = if is_running { "running".to_string() } else { "idle".to_string() };
                    let snippet = hook_index.get_workspace_snippet(&id);

                    let mut surfaces = Vec::new();
                    if let Some(panes) = raw_ws.get("panes").and_then(|p| p.as_array()) {
                        for pane in panes {
                            if let Some(surf_arr) = pane.get("surfaces").and_then(|s| s.as_array()) {
                                for surf in surf_arr {
                                    let s_id = surf.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                                    let s_ref = surf.get("ref").and_then(|r| r.as_str()).unwrap_or("").to_string();
                                    let s_title = surf.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
                                    let s_type = surf.get("type").and_then(|t| t.as_str()).unwrap_or("terminal").to_string();
                                    let s_tty = surf.get("tty").and_then(|t| t.as_str()).map(|s| s.to_string());
                                    let s_sel = surf.get("selected").and_then(|s| s.as_bool()).unwrap_or(false);
                                    let s_foc = surf.get("focused").and_then(|f| f.as_bool()).unwrap_or(false);

                                    let agent = hook_index.get_active_session_for_surface(&s_id).map(|s| {
                                        cmux_gateway::scanner::workspace_tree::SurfaceAgentInfo {
                                            session_id: s.session_id.clone(),
                                            agent_kind: s.resolved_agent_kind().to_string(),
                                            status: if s.resolved_lifecycle() == cmux_gateway::protocol::event::AgentLifecycleState::Working { "running".to_string() } else { "idle".to_string() },
                                            transcript_path: s.transcript_path.clone(),
                                        }
                                    });

                                    surfaces.push(SurfaceNode {
                                        id: s_id,
                                        r#ref: s_ref,
                                        title: s_title,
                                        surface_type: s_type,
                                        tty: s_tty,
                                        selected: s_sel,
                                        focused: s_foc,
                                        agent,
                                    });
                                }
                            }
                        }
                    }

                    workspaces.push(WorkspaceNode {
                        id,
                        r#ref,
                        title,
                        pinned,
                        selected,
                        status,
                        current_directory: cwd,
                        color: None,
                        snippet,
                        surfaces,
                    });
                }
            }
        }
    }

    // Verify overall tree structure
    assert_eq!(workspaces.len(), 5);

    // Workspace 0: Project A
    let mm = &workspaces[0];
    assert_eq!(mm.title, "Project A workspace");
    assert_eq!(mm.status, "idle");
    assert_eq!(mm.pinned, true);
    assert_eq!(mm.surfaces.len(), 3);
    assert_eq!(mm.surfaces[0].title, "Sync notes to hub");
    assert!(mm.surfaces[0].agent.is_some());
    let mm_agent = mm.surfaces[0].agent.as_ref().unwrap();
    assert_eq!(mm_agent.agent_kind, "claude");
    assert_eq!(mm_agent.status, "idle");

    // Workspace 3: Tools
    let tools = &workspaces[3];
    assert_eq!(tools.title, "Tools");
    assert_eq!(tools.status, "running");
    assert!(tools.surfaces[0].agent.is_some());
    assert_eq!(tools.surfaces[0].agent.as_ref().unwrap().agent_kind, "antigravity");
}

#[test]
fn test_offline_fixture_transcripts() {
    let fixture_dir = Path::new("tests/fixtures");

    // 1. Claude Transcript Fixture
    let claude_tx = fixture_dir.join("claude_transcript.jsonl");
    if claude_tx.exists() {
        let turns = TranscriptReader::read_recent_turns(&claude_tx, "surf-claude", 20).expect("read claude turns");
        assert!(!turns.is_empty(), "Should parse at least 1 turn from claude fixture");
    }

    // 2. Antigravity Transcript Fixture
    let agy_tx = fixture_dir.join("antigravity_transcript.jsonl");
    if agy_tx.exists() {
        let turns = TranscriptReader::read_recent_turns(&agy_tx, "surf-agy", 20).expect("read agy turns");
        assert!(!turns.is_empty(), "Should parse at least 1 turn from agy fixture");
    }
}
