use super::*;
use axum::Router;
use std::io::Write;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::domain::canonical_turn::turn_digest;
use crate::domain::dialog::extract_approval_screen_context;
use crate::protocol::event::{
    AgentEvent, AgentLifecycleState, AgentRole, AgentTurn, AwaitingInput,
};
use crate::protocol::{
    JsonRpcRequest, METHOD_AGENT_OPTIONS, METHOD_CHAT_ANSWER_QUESTION, METHOD_CHAT_INTERRUPT,
    METHOD_CHAT_SET_OPTION, METHOD_DEVICE_LIST, METHOD_DEVICE_REVOKE, METHOD_PUSH_PREFERENCES,
    METHOD_PUSH_REGISTER, METHOD_SURFACE_NEW, METHOD_SURFACE_RENAME, METHOD_TERMINAL_VIEWPORT,
};
use crate::push::PushSubscription;
use crate::services::chat_stream::{apply_delta_or_snapshot, chat_watcher, chat_watcher_stream};
use crate::services::session_state::{ResolvedSession, SessionStateService};
use crate::services::terminal_stream::{apply_terminal_viewport, terminal_replay_fingerprint};
use crate::transport::rpc::dispatch_rpc;

async fn next_event(rx: &mut mpsc::Receiver<String>) -> serde_json::Value {
    let raw = timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("event within 5s")
        .expect("channel open");
    serde_json::from_str(&raw).expect("json frame")
}

static HOOK_ENV_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn chat_watcher_pushes_on_transcript_change_and_in_place_mutations() {
    let _env_guard = HOOK_ENV_TEST_LOCK.lock().await;
    let dir = std::env::temp_dir().join(format!("cmux-sub-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let transcript = dir.join("t.jsonl");
    std::fs::write(&transcript, "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n").unwrap();
    let hook = serde_json::json!({
        "sessions": { "s1": {
            "sessionId": "s1", "surfaceId": "surf-watch", "workspaceId": "ws",
            "transcriptPath": transcript.to_string_lossy(), "updatedAt": 1.0
        }},
        "activeSessionsBySurface": {}
    });
    std::fs::write(dir.join("claude-hook-sessions.json"), hook.to_string()).unwrap();
    unsafe { std::env::set_var("CMUX_HOOK_SESSIONS_DIR", &dir) };

    let state = AppState::new("127.0.0.1".into(), 0, "tok".into());
    let (tx, mut rx) = mpsc::channel(8);
    let handle = tokio::spawn(chat_watcher(
        state, tx, "surf-watch".into(), String::new(), "claude".into(), 20,
    ));

    let first = next_event(&mut rx).await;
    assert_eq!(first["event"], EVENT_CHAT_UPDATE);
    assert_eq!(first["data"]["surface_id"], "surf-watch");
    assert_eq!(first["data"]["turns"].as_array().unwrap().len(), 1);
    assert!(timeout(Duration::from_millis(1300), rx.recv()).await.is_err());

    let mut f = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
    writeln!(f, "{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"hi\"}}]}}}}").unwrap();
    drop(f);

    let second = next_event(&mut rx).await;
    assert_eq!(second["data"]["turns"].as_array().unwrap().len(), 2);
    handle.abort();

    let state_delta = AppState::new("127.0.0.1".into(), 0, "tok".into());
    let (dtx, mut drx) = mpsc::channel(8);
    let dhandle = tokio::spawn(chat_watcher_stream(
        state_delta, dtx, "surf-watch".into(), String::new(), "claude".into(), 20, true,
    ));
    let d_first = next_event(&mut drx).await;
    assert_eq!(d_first["data"]["update_kind"], "snapshot");
    assert_eq!(d_first["data"]["turns"].as_array().unwrap().len(), 2);

    let mut f = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
    writeln!(f, "{{\"type\":\"user\",\"message\":{{\"content\":\"next prompt\"}}}}").unwrap();
    drop(f);

    let d_second = next_event(&mut drx).await;
    assert_eq!(d_second["data"]["update_kind"], "delta");
    assert_eq!(d_second["data"]["after_turn_id"], "turn-2");
    assert!(d_second["data"].get("turns").is_none());
    assert_eq!(d_second["data"]["tail_turns"].as_array().unwrap().len(), 1);

    dhandle.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn turn_digest_delta_detects_in_place_middle_and_turn_zero_mutations() {
    let mk_turn = |id: &str, text: &str, answered: Option<&str>| AgentTurn {
        id: id.into(),
        surface_id: "s".into(),
        role: AgentRole::Assistant,
        timestamp: None,
        events: vec![
            AgentEvent::Assistant { text: text.into() },
            AgentEvent::AwaitingInput(AwaitingInput {
                tool_id: Some("ask-1".into()),
                input_kind: "question".into(),
                prompt: "Pick".into(),
                options: None,
                default_choice: None,
                multi_select: None,
                questions: None,
                answered: answered.map(str::to_string),
            }),
        ],
    };

    let prev = [mk_turn("t1", "first", None), mk_turn("t2", "second", None)];
    let prev_digests: Vec<(String, u64)> = prev.iter().map(|t| (t.id.clone(), turn_digest(t))).collect();

    let next_mid = vec![mk_turn("t1", "first", None), mk_turn("t2", "second", Some("Option A"))];
    let next_mid_digests: Vec<(String, u64)> =
        next_mid.iter().map(|t| (t.id.clone(), turn_digest(t))).collect();
    let mut snap = serde_json::json!({ "update_kind": "snapshot", "turns": next_mid });
    apply_delta_or_snapshot(&mut snap, &next_mid, &prev_digests, &next_mid_digests, true);
    assert_eq!(snap["update_kind"], "delta");
    assert_eq!(snap["after_turn_id"], "t1");
    assert_eq!(snap["tail_turns"].as_array().unwrap().len(), 1);

    let next_zero = vec![mk_turn("t1", "first-mutated", Some("Yes")), mk_turn("t2", "second", None)];
    let next_zero_digests: Vec<(String, u64)> =
        next_zero.iter().map(|t| (t.id.clone(), turn_digest(t))).collect();
    let mut snap0 = serde_json::json!({ "update_kind": "snapshot", "turns": next_zero });
    apply_delta_or_snapshot(&mut snap0, &next_zero, &prev_digests, &next_zero_digests, true);
    assert_eq!(snap0["update_kind"], "snapshot");
    assert!(snap0.get("turns").is_some());
}

async fn http(router: &mut Router, method: &str, uri: &str, body: &str) -> (u16, serde_json::Value) {
    http_with(router, method, uri, body, &[]).await
}

async fn http_with(
    router: &mut Router,
    method: &str,
    uri: &str,
    body: &str,
    headers: &[(&str, &str)],
) -> (u16, serde_json::Value) {
    use tower::Service;
    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    for (k, v) in headers {
        builder = builder.header(*k, *v);
    }
    let req = builder.body(axum::body::Body::from(body.to_string())).unwrap();
    let resp = router.call(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
}

#[tokio::test]
async fn pairing_ticket_exchange_and_guard_flows() {
    let devices = std::env::temp_dir().join(format!("devs-{}.json", uuid::Uuid::new_v4()));
    let mut state = AppState::new("127.0.0.1".into(), 8088, "master-secret".into());
    state.devices = DeviceRegistry::new(Some(devices.clone()));
    let mut router = create_router(state.clone());

    assert_eq!(http(&mut router, "GET", "/api/pairing", "").await.0, 401);
    assert_eq!(
        http_with(&mut router, "GET", "/api/pairing", "", &[("authorization", "Bearer wrong")]).await.0,
        401
    );

    let auth = ("authorization", "Bearer master-secret");
    assert_eq!(http_with(&mut router, "GET", "/api/pairing", "", &[auth, ("host", "evil.test")]).await.0, 403);
    assert_eq!(
        http_with(&mut router, "GET", "/api/pairing", "", &[auth, ("host", "127.0.0.1:8088"), ("origin", "https://evil.test")]).await.0,
        403
    );

    let (st, body) = http_with(
        &mut router,
        "GET",
        "/api/pairing",
        "",
        &[auth, ("host", "127.0.0.1:8088"), ("origin", "https://chavisnguyen.github.io")],
    )
    .await;
    assert_eq!(st, 200);
    assert_eq!(body["offer"]["token"], "");
    let ticket = body["offer"]["ticket"].as_str().unwrap().to_string();

    let req = serde_json::json!({ "ticket": ticket }).to_string();
    let (st, body) = http(&mut router, "POST", "/api/pair/exchange", &req).await;
    assert_eq!(st, 200);
    let device = body["token"].as_str().unwrap().to_string();
    assert!(state.token_valid(&device));
    assert_eq!(http(&mut router, "POST", "/api/pair/exchange", &req).await.0, 401);
    let _ = std::fs::remove_file(devices);
}

#[test]
fn terminal_fingerprint_and_allowlists() {
    let base = serde_json::json!({
        "size_state": { "cols": 45, "rows": 24 },
        "render_grid": {
            "render_epoch": "ep-1", "render_revision": 10, "row_space_revision": 4, "state_seq": 77,
            "columns": 45, "rows": 24, "active_screen": "primary", "scrollback_rows": 12,
            "cursor": { "row": 3, "column": 5, "visible": true }
        }
    });
    assert_ne!(terminal_replay_fingerprint(&base, "mobile"), terminal_replay_fingerprint(&base, "desktop"));
    assert!(host_allowed("127.0.0.1:8088") && host_allowed("mac.tail1234.ts.net") && !host_allowed("evil.test"));
    assert!(origin_allowed("https://chavisnguyen.github.io", Some("127.0.0.1:8088")));
    assert!(!origin_allowed("https://attacker.github.io", None));
}

#[tokio::test]
async fn rpc_validation_push_devices_and_options() {
    let mut state = AppState::new("127.0.0.1".into(), 0, "tok".into());
    state.devices = DeviceRegistry::new(None);
    let ask = |m: &str, p: serde_json::Value| {
        serde_json::from_value::<JsonRpcRequest>(serde_json::json!({ "id": "1", "method": m, "params": p })).unwrap()
    };

    assert_eq!(
        dispatch_rpc(&ask(METHOD_SURFACE_RENAME, serde_json::json!({ "surface_id": "s", "title": "  " })), &state).await.error.unwrap().code,
        -32602
    );
    assert_eq!(
        apply_terminal_viewport("sess-1", &ask(METHOD_TERMINAL_VIEWPORT, serde_json::json!({ "surface_id": "s", "mode": "mobile", "columns": 0, "rows": 24 })), &state, None).await.error.unwrap().code,
        -32602
    );
    assert_eq!(
        dispatch_rpc(&ask(METHOD_CHAT_ANSWER_QUESTION, serde_json::json!({ "surface_id": "s", "answers": [{ "indices": [] }] })), &state).await.error.unwrap().code,
        -32602
    );
    assert_eq!(
        dispatch_rpc(&ask(METHOD_PUSH_REGISTER, serde_json::json!({ "endpoint": "https://evil.example/x", "keys": { "p256dh": "a", "auth": "b" } })), &state).await.error.unwrap().code,
        -32602
    );

    let ticket = state.devices.issue_ticket();
    let token = state.devices.redeem_labeled(&ticket, "Test phone").unwrap();
    let list_resp = dispatch_rpc(&ask(METHOD_DEVICE_LIST, serde_json::json!({})), &state).await;
    let id = list_resp.result.unwrap()["devices"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(
        dispatch_rpc(&ask(METHOD_DEVICE_REVOKE, serde_json::json!({ "device_id": id })), &state).await.result.unwrap()["revoked"],
        true
    );
    assert!(!state.token_valid(&token));

    let ep = "https://fcm.googleapis.com/fcm/send/xyz";
    state.push_service.register(PushSubscription {
        endpoint: ep.into(),
        keys: crate::push::PushSubscriptionKeys { p256dh: "p".into(), auth: "a".into() },
        device_id: None,
        muted_categories: vec![],
    });
    assert_eq!(
        dispatch_rpc(&ask(METHOD_PUSH_PREFERENCES, serde_json::json!({ "endpoint": ep, "muted_categories": ["turn-finished", "bad"] })), &state).await.result.unwrap()["muted_categories"],
        serde_json::json!(["turn-finished"])
    );

    assert_eq!(
        dispatch_rpc(&ask(METHOD_AGENT_OPTIONS, serde_json::json!({ "agent_kind": "claude" })), &state).await.result.unwrap()["models"][1]["id"],
        "opus"
    );
    for (m, bad) in [
        (METHOD_CHAT_SET_OPTION, serde_json::json!({ "surface_id": "s", "agent_kind": "claude", "option": "model", "value": "opus\n/exit" })),
        (METHOD_SURFACE_NEW, serde_json::json!({ "command": "bash -c evil", "launch": { "agent_kind": "claude", "model": "opus" } })),
    ] {
        assert_eq!(dispatch_rpc(&ask(m, bad), &state).await.error.unwrap().code, -32602);
    }
}

#[test]
fn client_registry_and_awaiting_prompt_derivation() {
    let reg = ClientRegistry::default();
    let a = reg.register(ClientInfo {
        session_id: "a".into(), device_id: Some("dev-a".into()), label: "phone".into(),
        user_agent: String::new(), connected_at: 2, viewing_surface: None, client_visible: false,
    });
    reg.set_viewing("a", Some("surf-1".into()), true);
    assert!(reg.is_session_viewing("a", "surf-1"));
    drop(a);
    assert!(reg.list().is_empty());

    let base = ResolvedSession {
        session_id: "s1".into(), surface_id: "surf-1".into(), agent_kind: "antigravity".into(),
        transcript_path: None, lifecycle: AgentLifecycleState::Waiting,
        last_event: Some("PreInvocation".into()), last_subtitle: Some("Completed".into()),
        last_body: Some("Stale previous turn reply".into()), tool_name: None,
        live_activity: None,
        epoch: crate::domain::child_work_fsm::SurfaceRunEpoch::RemoteOrUnknown,
        from_tree: false,
    };
    let turns = vec![AgentTurn {
        id: "t1".into(), surface_id: "surf-1".into(), role: AgentRole::Assistant, timestamp: None,
        events: vec![
            AgentEvent::ToolStart { tool_id: "done-1".into(), name: "read_file".into(), detail: None },
            AgentEvent::ToolEnd { tool_id: "done-1".into(), name: Some("read_file".into()), ok: true, detail: None },
            AgentEvent::AwaitingInput(AwaitingInput {
                tool_id: Some("ask-1".into()), input_kind: "question".into(),
                prompt: "Which database adapter?".into(), options: None, default_choice: None,
                multi_select: None, questions: None, answered: None,
            }),
        ],
    }];
    assert_eq!(
        SessionStateService::derive_awaiting_prompt(&base, &turns, None).as_deref(),
        Some("Which database adapter?")
    );
    let codex_screen = "╭───────────────────────────╮\n│ Would you like to run git? │\n│ › 1. Yes, proceed (y)     │\n│   2. No (esc)             │\n╰───────────────────────────╯";
    assert_eq!(extract_approval_screen_context(codex_screen).as_deref(), Some("Would you like to run git?"));
}

#[tokio::test]
async fn interrupt_rpc_sends_single_escape_or_double_escape_for_opencode() {
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let short_id = &uuid::Uuid::new_v4().simple().to_string()[..10];
    let dir = std::path::PathBuf::from(format!("/tmp/cmux-int-{short_id}"));
    std::fs::create_dir_all(&dir).unwrap();
    let sock_path = dir.join("s.sock");
    let listener = UnixListener::bind(&sock_path).unwrap();
    let recorded: Arc<StdMutex<Vec<serde_json::Value>>> = Arc::new(StdMutex::new(Vec::new()));
    let rec_cl = recorded.clone();
    let uds_srv = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let rec = rec_cl.clone();
            tokio::spawn(async move {
                let (r, mut w) = stream.into_split();
                let mut reader = BufReader::new(r);
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    let req: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
                    let id = req["id"].clone();
                    rec.lock().unwrap().push(req);
                    let resp = serde_json::json!({ "id": id, "ok": true, "result": {} });
                    let _ = w.write_all(format!("{resp}\n").as_bytes()).await;
                    line.clear();
                }
            });
        }
    });

    let mut state = AppState::new("127.0.0.1".into(), 0, "tok".into());
    state.cmux_bridge = DualTransportCmuxBridge::with_socket_path(&sock_path);

    let claude_int: JsonRpcRequest = serde_json::from_value(serde_json::json!({
        "id": "1", "method": METHOD_CHAT_INTERRUPT, "params": { "surface_id": "surf-1", "agent_kind": "claude" }
    }))
    .unwrap();
    assert!(dispatch_rpc(&claude_int, &state).await.error.is_none());
    {
        let calls = recorded.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["method"], "surface.send_key");
        assert_eq!(calls[0]["params"]["key"], "escape");
    }

    recorded.lock().unwrap().clear();
    let t0 = std::time::Instant::now();
    let oc_int: JsonRpcRequest = serde_json::from_value(serde_json::json!({
        "id": "2", "method": METHOD_CHAT_INTERRUPT, "params": { "surface_id": "surf-2", "agent_kind": "opencode" }
    }))
    .unwrap();
    assert!(dispatch_rpc(&oc_int, &state).await.error.is_none());
    assert!(t0.elapsed() >= Duration::from_millis(55));
    assert_eq!(recorded.lock().unwrap().len(), 2);

    uds_srv.abort();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn ws_handshake_tolerates_leading_ping_and_pong_before_auth_frame() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let state = AppState::new("127.0.0.1".into(), 0, "ws-tok".into());
    let router = create_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let srv = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let upgrade_req = format!(
        "GET /ws HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream.write_all(upgrade_req.as_bytes()).await.unwrap();

    let mut hdr = vec![0u8; 512];
    let n = stream.read(&mut hdr).await.unwrap();
    let hdr_str = String::from_utf8_lossy(&hdr[..n]);
    assert!(hdr_str.starts_with("HTTP/1.1 101"), "unexpected upgrade: {hdr_str}");

    let write_masked_frame = |opcode: u8, payload: &[u8]| -> Vec<u8> {
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        let mut frame = vec![0x80 | opcode];
        assert!(payload.len() < 126);
        frame.push(0x80 | (payload.len() as u8));
        frame.extend_from_slice(&mask);
        for (i, b) in payload.iter().enumerate() {
            frame.push(b ^ mask[i % 4]);
        }
        frame
    };

    // Send a masked Ping frame (opcode 0x9) + masked Pong frame (opcode 0xA) BEFORE the auth Text frame!
    stream.write_all(&write_masked_frame(0x9, b"hi")).await.unwrap();
    stream.write_all(&write_masked_frame(0xA, b"ok")).await.unwrap();

    let auth_json = br#"{"type":"auth","token":"ws-tok","client_id":"safari-test"}"#;
    stream.write_all(&write_masked_frame(0x1, auth_json)).await.unwrap();

    // Read server frames until we observe the `auth_ok` Text frame (opcode 0x1).
    let mut saw_pong = false;
    let mut auth_ok_body = String::new();
    for _ in 0..4 {
        let mut head = [0u8; 2];
        stream.read_exact(&mut head).await.unwrap();
        let opcode = head[0] & 0x0f;
        let len = (head[1] & 0x7f) as usize;
        let actual_len = if len == 126 {
            let mut ext = [0u8; 2];
            stream.read_exact(&mut ext).await.unwrap();
            u16::from_be_bytes(ext) as usize
        } else {
            len
        };
        let mut body = vec![0u8; actual_len];
        stream.read_exact(&mut body).await.unwrap();
        if opcode == 0xA {
            saw_pong = true;
        } else if opcode == 0x1 {
            auth_ok_body = String::from_utf8_lossy(&body).into_owned();
            break;
        }
    }
    assert!(saw_pong, "expected gateway to reply with Pong");
    assert!(auth_ok_body.contains("\"auth_ok\""), "expected auth_ok, got: {auth_ok_body}");

    srv.abort();
}

#[tokio::test]
async fn ws_1rtt_auth_bootstrap_pushes_workspaces_and_initial_chat_update() {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let _env_guard = HOOK_ENV_TEST_LOCK.lock().await;
    let short_id = &uuid::Uuid::new_v4().simple().to_string()[..10];
    let dir = std::path::PathBuf::from(format!("/tmp/cmob-boot-{short_id}"));
    std::fs::create_dir_all(&dir).unwrap();
    let sock_path = dir.join("cmux.sock");
    let transcript = dir.join("boot.jsonl");
    std::fs::write(
        &transcript,
        "{\"type\":\"user\",\"message\":{\"content\":\"boot prompt\"}}\n",
    )
    .unwrap();
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64();
    let hook = serde_json::json!({
        "sessions": { "s-boot": {
            "sessionId": "s-boot",
            "surfaceId": "surf-boot-1",
            "workspaceId": "ws-boot-1",
            "agentKind": "claude",
            "agentLifecycle": "idle",
            "transcriptPath": transcript.to_string_lossy(),
            "updatedAt": now_secs
        }},
        "activeSessionsBySurface": {}
    });
    std::fs::write(dir.join("claude-hook-sessions.json"), hook.to_string()).unwrap();
    unsafe { std::env::set_var("CMUX_HOOK_SESSIONS_DIR", &dir) };

    let uds_listener = UnixListener::bind(&sock_path).unwrap();
    let uds_srv = tokio::spawn(async move {
        while let Ok((stream, _)) = uds_listener.accept().await {
            tokio::spawn(async move {
                let (r, mut w) = stream.into_split();
                let mut reader = BufReader::new(r);
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    let req: serde_json::Value = serde_json::from_str(&line).unwrap();
                    let id = req["id"].clone();
                    let method = req["method"].as_str().unwrap_or("");
                    let result = match method {
                        "system.tree" => serde_json::json!({
                            "windows": [{
                                "workspaces": [{
                                    "id": "ws-boot-1",
                                    "ref": "workspace:1",
                                    "title": "Boot WS",
                                    "selected": true,
                                    "panes": [{
                                        "surfaces": [{
                                            "id": "surf-boot-1",
                                            "ref": "surface:1",
                                            "title": "Claude",
                                            "type": "terminal",
                                            "selected": true,
                                            "focused": true
                                        }]
                                    }]
                                }]
                            }]
                        }),
                        "workspace.list" => serde_json::json!({
                            "workspaces": [{ "id": "ws-boot-1", "current_directory": "/tmp" }]
                        }),
                        "notification.list" => serde_json::json!({ "notifications": [] }),
                        _ => serde_json::json!({}),
                    };
                    let resp = serde_json::json!({ "id": id, "ok": true, "result": result });
                    let _ = w.write_all(format!("{resp}\n").as_bytes()).await;
                    line.clear();
                }
            });
        }
    });

    let mut state = AppState::new("127.0.0.1".into(), 0, "boot-tok".into());
    state.cmux_bridge = DualTransportCmuxBridge::with_socket_path(&sock_path);
    let router = create_router(state);
    let tcp_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = tcp_listener.local_addr().unwrap();
    let ws_srv = tokio::spawn(async move {
        let _ = axum::serve(tcp_listener, router).await;
    });

    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let upgrade_req = format!(
        "GET /ws HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream.write_all(upgrade_req.as_bytes()).await.unwrap();
    let mut hdr = vec![0u8; 512];
    let n = stream.read(&mut hdr).await.unwrap();
    assert!(String::from_utf8_lossy(&hdr[..n]).starts_with("HTTP/1.1 101"));

    // Send ONLY a single `auth` frame with `bootstrap` (1 RTT total!).
    let auth_payload = br#"{"type":"auth","token":"boot-tok","bootstrap":{"workspace_tree":true,"is_desktop":true,"max_turns":10,"delta":true}}"#;
    let mask = [0x21u8, 0x43, 0x65, 0x87];
    let mut frame = vec![0x81u8];
    if auth_payload.len() < 126 {
        frame.push(0x80 | (auth_payload.len() as u8));
    } else {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(auth_payload.len() as u16).to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    for (i, b) in auth_payload.iter().enumerate() {
        frame.push(b ^ mask[i % 4]);
    }
    stream.write_all(&frame).await.unwrap();

    let mut frames = Vec::new();
    for _ in 0..3 {
        let mut head = [0u8; 2];
        stream.read_exact(&mut head).await.unwrap();
        let len_code = (head[1] & 0x7f) as usize;
        let actual_len = if len_code == 126 {
            let mut ext = [0u8; 2];
            stream.read_exact(&mut ext).await.unwrap();
            u16::from_be_bytes(ext) as usize
        } else if len_code == 127 {
            let mut ext = [0u8; 8];
            stream.read_exact(&mut ext).await.unwrap();
            u64::from_be_bytes(ext) as usize
        } else {
            len_code
        };
        let mut body = vec![0u8; actual_len];
        stream.read_exact(&mut body).await.unwrap();
        frames.push(serde_json::from_slice::<serde_json::Value>(&body).unwrap());
    }

    assert_eq!(frames[0]["type"], "auth_ok");
    assert!(
        frames[0]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == "bootstrap.v1")
    );
    assert_eq!(frames[1]["event"], "mobile.workspace.bootstrap");
    assert_eq!(frames[1]["data"]["subscribed_surface_id"], "surf-boot-1");
    assert_eq!(frames[2]["event"], "mobile.chat.update");
    assert_eq!(frames[2]["data"]["surface_id"], "surf-boot-1");
    assert_eq!(frames[2]["data"]["turns"].as_array().unwrap().len(), 1);

    ws_srv.abort();
    uds_srv.abort();
    let _ = std::fs::remove_dir_all(&dir);
}
