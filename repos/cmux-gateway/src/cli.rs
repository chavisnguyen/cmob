//! `cmob` command line: setup, start/stop, status, qr, devices, logs, uninstall.
//!
//! The gateway itself runs as `cmob serve`. Every other command talks to it over loopback HTTP with the
//! gateway token, so there is nothing to configure: state lives in `~/.cmux/`.
//!
//! The gateway must be started from inside cmux (cmux only answers socket clients it started, see
//! `cmux socket-status`), which is why autostart is a shell hook and not a launchd service.

use base64::Engine;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 8088;
const HOOK_BEGIN: &str = "# >>> cmob autostart >>>";
const HOOK_END: &str = "# <<< cmob autostart <<<";
/// Markers written by the earlier `cmux-mobile` shell script; stripped so the two hooks never stack.
const LEGACY_HOOK_BEGIN: &str = "# >>> cmux-mobile autostart >>>";
const LEGACY_HOOK_END: &str = "# <<< cmux-mobile autostart <<<";

type Res<T> = Result<T, String>;

// ---------------------------------------------------------------- paths and config

fn home() -> Res<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".to_string())
}

pub fn state_dir() -> Res<PathBuf> {
    Ok(home()?.join(".cmux"))
}

pub fn token_path() -> Res<PathBuf> {
    Ok(state_dir()?.join("gateway-token"))
}

pub fn pid_path() -> Res<PathBuf> {
    Ok(state_dir()?.join("gateway.pid"))
}

pub fn log_path() -> Res<PathBuf> {
    Ok(state_dir()?.join("gateway.log"))
}

fn rc_path() -> Res<PathBuf> {
    match std::env::var_os("CMOB_RC_FILE") {
        Some(p) => Ok(PathBuf::from(p)),
        None => Ok(home()?.join(".zshrc")),
    }
}

pub fn port() -> u16 {
    std::env::var("CMUX_GATEWAY_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT)
}

/// Reads the gateway token, creating a random one (mode 600) on first use.
pub fn read_or_create_token() -> Res<String> {
    let path = token_path()?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let t = existing.trim();
        if !t.is_empty() {
            return Ok(t.to_string());
        }
    }
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("cannot read /dev/urandom: {e}"))?;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    std::fs::create_dir_all(state_dir()?).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    f.write_all(token.as_bytes()).map_err(|e| e.to_string())?;
    Ok(token)
}

// ---------------------------------------------------------------- loopback HTTP

/// Minimal HTTP/1.1 client for the gateway on loopback (avoids pulling in a full HTTP stack).
fn http(method: &str, path: &str, token: Option<&str>) -> Res<(u16, String)> {
    let addr = format!("127.0.0.1:{}", port())
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("no address")?;
    let mut stream =
        TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{auth}Connection: close\r\n\r\n",
        port()
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    parse_response(&raw)
}

fn parse_response(raw: &[u8]) -> Res<(u16, String)> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("malformed HTTP response")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let body = &raw[split + 4..];
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("malformed status line")?;
    let chunked = head.to_ascii_lowercase().contains("transfer-encoding: chunked");
    let body = if chunked { decode_chunked(body) } else { body.to_vec() };
    Ok((status, String::from_utf8_lossy(&body).to_string()))
}

fn decode_chunked(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(eol) = data.windows(2).position(|w| w == b"\r\n") else { break };
        let size_str = String::from_utf8_lossy(&data[..eol]);
        let size_hex = size_str.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_hex, 16) else { break };
        data = &data[eol + 2..];
        if size == 0 || data.len() < size {
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size..];
        if data.starts_with(b"\r\n") {
            data = &data[2..];
        }
    }
    out
}

fn get_json(path: &str, token: &str) -> Res<serde_json::Value> {
    let (status, body) = http("GET", path, Some(token))?;
    if status == 401 {
        return Err("the gateway rejected the token (was it rotated? run `cmob stop && cmob start`)".into());
    }
    if status != 200 {
        return Err(format!("gateway answered HTTP {status} for {path}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("bad JSON from {path}: {e}"))
}

/// `/health` as JSON when the gateway answers.
fn health() -> Option<serde_json::Value> {
    let (status, body) = http("GET", "/health", None).ok()?;
    if status != 200 {
        return None;
    }
    serde_json::from_str(&body).ok()
}

// ---------------------------------------------------------------- environment probes

fn inside_cmux() -> Res<bool> {
    match Command::new("cmux").arg("ping").stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(s) => Ok(s.success()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err("the `cmux` command was not found. Install cmux (https://cmux.com) first".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn tailscale_bin() -> Option<String> {
    for cand in ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] {
        let ok = Command::new(cand)
            .arg("version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Some(cand.to_string());
        }
    }
    None
}

/// MagicDNS name of this machine, e.g. `mac.tail1234.ts.net`.
fn tailscale_dns() -> Option<String> {
    let bin = tailscale_bin()?;
    let out = Command::new(bin).args(["status", "--json"]).stderr(Stdio::null()).output().ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let name = v.get("Self")?.get("DNSName")?.as_str()?.trim_end_matches('.').to_string();
    (!name.is_empty()).then_some(name)
}

#[derive(Debug, PartialEq)]
enum ServeState {
    /// Tailscale Serve has no configuration, so setting ours replaces nothing.
    Empty,
    /// It already proxies to the gateway.
    Ours,
    /// It serves something else; setting ours would overwrite it.
    Other,
}

/// Classifies `tailscale serve status --json` for our port.
fn serve_state(json: &str, port: u16) -> Res<ServeState> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "could not read the Tailscale Serve configuration".to_string())?;
    if v.is_null() || v.as_object().map(|o| o.is_empty()).unwrap_or(false) {
        return Ok(ServeState::Empty);
    }
    if json.contains(&format!("127.0.0.1:{port}")) || json.contains(&format!("localhost:{port}")) {
        return Ok(ServeState::Ours);
    }
    Ok(ServeState::Other)
}

fn tailscale_serve_state(bin: &str, port: u16) -> Res<ServeState> {
    let out = Command::new(bin)
        .args(["serve", "status", "--json"])
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    serve_state(&String::from_utf8_lossy(&out.stdout), port)
}

fn tailscale_serving(bin: &str, port: u16) -> bool {
    tailscale_serve_state(bin, port).map(|s| s == ServeState::Ours).unwrap_or(false)
}

/// Publishes the gateway over Tailscale HTTPS and returns the `https://` base URL. It never replaces a
/// Serve configuration that belongs to something else.
fn ensure_tailscale_serve() -> Res<String> {
    let bin = tailscale_bin().ok_or("Tailscale was not found. Install it from https://tailscale.com/download")?;
    let dns = tailscale_dns()
        .ok_or("Tailscale is installed but not signed in. Open the Tailscale app and sign in")?;
    match tailscale_serve_state(&bin, port())? {
        ServeState::Ours => {}
        ServeState::Empty => {
            let ok = Command::new(&bin)
                .args(["serve", "--bg", &port().to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok {
                return Err("could not enable Tailscale Serve (try `tailscale serve --bg 8088` yourself)".into());
            }
        }
        ServeState::Other => {
            return Err(
                "Tailscale Serve is already serving something else on this Mac, and cmob will not overwrite it. \
                 See it with `tailscale serve status`; remove it, or point it at 127.0.0.1:8088 yourself"
                    .into(),
            );
        }
    }
    Ok(format!("https://{dns}"))
}

// ---------------------------------------------------------------- shell hook

fn hook_block() -> String {
    format!(
        "{HOOK_BEGIN}\n\
         # Starts the cmob gateway when a terminal opens inside cmux. Remove with: cmob uninstall\n\
         if [ -n \"${{CMUX_SURFACE_ID:-}}\" ] && command -v cmob >/dev/null 2>&1; then\n\
         \x20 ( cmob start --quiet >/dev/null 2>&1 & )\n\
         fi\n\
         {HOOK_END}\n"
    )
}

/// Removes one marked block. Leaves the text untouched unless both markers are present, so a damaged
/// file can never lose the lines after a stray begin marker.
fn strip_block(rc: &str, begin: &str, end: &str) -> String {
    let lines: Vec<&str> = rc.split_inclusive('\n').collect();
    let trimmed = |l: &str| l.trim_end_matches('\n').to_string();
    let Some(b) = lines.iter().position(|l| trimmed(l) == begin) else { return rc.to_string() };
    let Some(e) = lines.iter().skip(b + 1).position(|l| trimmed(l) == end).map(|i| i + b + 1) else {
        return rc.to_string();
    };
    lines[..b].iter().chain(lines[e + 1..].iter()).copied().collect()
}

fn without_hook(rc: &str) -> String {
    strip_block(&strip_block(rc, HOOK_BEGIN, HOOK_END), LEGACY_HOOK_BEGIN, LEGACY_HOOK_END)
}

fn with_hook(rc: &str) -> String {
    let mut s = without_hook(rc);
    if !s.is_empty() && !s.ends_with('\n') {
        s.push('\n');
    }
    s.push_str(&hook_block());
    s
}

fn hook_installed() -> bool {
    rc_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.contains(HOOK_BEGIN))
        .unwrap_or(false)
}

/// Writes `new` to the rc file, saving the previous content once as `<rc>.cmob.bak`.
fn write_rc(old: &str, new: &str) -> Res<()> {
    if old == new {
        return Ok(());
    }
    let rc = rc_path()?;
    if rc.exists() {
        let mut bak = rc.clone().into_os_string();
        bak.push(".cmob.bak");
        std::fs::write(&bak, old).map_err(|e| format!("cannot write backup: {e}"))?;
    }
    std::fs::write(&rc, new).map_err(|e| format!("cannot write {}: {e}", rc.display()))
}

fn install_hook() -> Res<bool> {
    let rc = rc_path()?;
    let old = std::fs::read_to_string(&rc).unwrap_or_default();
    let new = with_hook(&old);
    let changed = old != new;
    write_rc(&old, &new)?;
    Ok(changed)
}

fn remove_hook() -> Res<bool> {
    let rc = rc_path()?;
    let Ok(old) = std::fs::read_to_string(&rc) else { return Ok(false) };
    let new = without_hook(&old);
    let changed = old != new;
    write_rc(&old, &new)?;
    Ok(changed)
}

// ---------------------------------------------------------------- start / stop

fn ok(msg: impl AsRef<str>) {
    println!("✓ {}", msg.as_ref());
}
fn warn(msg: impl AsRef<str>) {
    println!("! {}", msg.as_ref());
}

/// Starts the gateway in the background (from inside cmux). Safe to call when it is already running.
pub fn start(quiet: bool) -> Res<()> {
    if health().is_some() {
        if !quiet {
            ok(format!("Gateway already running on 127.0.0.1:{}", port()));
        }
        return Ok(());
    }
    if !inside_cmux()? {
        return Err("run this from a terminal inside cmux (cmux refuses connections from other processes)".into());
    }
    let token = read_or_create_token()?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let log = log_path()?;
    std::fs::create_dir_all(state_dir()?).map_err(|e| e.to_string())?;
    let out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log)
        .map_err(|e| format!("cannot open {}: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new("nohup");
    cmd.arg(&exe).args(["serve", "--quiet"]);
    // The per-surface ids would make the gateway's cmux calls default to this one terminal.
    for var in ["CMUX_SURFACE_ID", "CMUX_TAB_ID", "CMUX_PANEL_ID", "CMUX_WORKSPACE_ID", "CMUX_TERMINAL_LIFECYCLE_ID"] {
        cmd.env_remove(var);
    }
    // The token travels in the environment, never argv: `ps` shows every user's command line.
    cmd.env("CMUX_GATEWAY_TOKEN", &token)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .process_group(0);
    cmd.spawn().map_err(|e| format!("cannot start the gateway: {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if let Some(h) = health() {
            if !quiet {
                let alive = h.get("cmux_alive").and_then(|v| v.as_bool()).unwrap_or(false);
                ok(format!("Gateway started on 127.0.0.1:{}", port()));
                if !alive {
                    warn("It cannot reach cmux yet. Check `cmob status`.");
                }
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(format!("the gateway did not come up. See `cmob logs` ({})", log.display()))
}

fn is_gateway_process(pid: u32) -> bool {
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .map(|o| {
            let name = String::from_utf8_lossy(&o.stdout);
            name.contains("cmob") || name.contains("cmux-gateway")
        })
        .unwrap_or(false)
}

fn listening_pid() -> Option<u32> {
    let out = Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{}", port()), "-sTCP:LISTEN", "-t"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).lines().next()?.trim().parse().ok()
}

pub fn stop() -> Res<()> {
    let from_file = pid_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse::<u32>().ok());
    let pid = from_file.filter(|p| is_gateway_process(*p)).or_else(|| listening_pid().filter(|p| is_gateway_process(*p)));
    let Some(pid) = pid else {
        ok("Gateway is not running");
        return Ok(());
    };
    let _ = Command::new("kill").arg(pid.to_string()).status();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && health().is_some() {
        std::thread::sleep(Duration::from_millis(100));
    }
    if health().is_some() {
        return Err(format!("the gateway (pid {pid}) did not stop; try `kill -9 {pid}`"));
    }
    if let Ok(p) = pid_path() {
        let _ = std::fs::remove_file(p);
    }
    ok("Gateway stopped");
    Ok(())
}

pub fn restart() -> Res<()> {
    stop()?;
    start(false)
}

/// Records the serving process id. Called by `serve` once it has bound the port.
pub fn write_pid() {
    if let (Ok(dir), Ok(p)) = (state_dir(), pid_path()) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(p, std::process::id().to_string());
    }
}

// ---------------------------------------------------------------- setup / uninstall

pub fn setup() -> Res<()> {
    if !inside_cmux()? {
        return Err("run `cmob setup` from a terminal inside cmux. cmux only answers programs it started".into());
    }
    ok("cmux found and reachable");

    read_or_create_token()?;
    ok(format!("Gateway token ready ({})", token_path()?.display()));

    if install_hook()? {
        ok(format!("Autostart added to {} (backup saved next to it)", rc_path()?.display()));
    } else {
        ok("Autostart already installed");
    }

    start(false)?;

    // Setup only looks at Tailscale. Publishing happens in `cmob qr --tailscale`, when you ask for it.
    match (tailscale_bin(), tailscale_dns()) {
        (Some(_), Some(dns)) => ok(format!("Tailscale is signed in ({dns})")),
        (Some(_), None) => warn("Tailscale is installed but not signed in. Phones need it for HTTPS."),
        _ => warn("Tailscale was not found. Phones need it for HTTPS: https://tailscale.com/download"),
    }

    println!("\nNext: pair your phone with  cmob qr --tailscale");
    Ok(())
}

pub fn uninstall() -> Res<()> {
    if remove_hook()? {
        ok("Autostart removed");
    } else {
        ok("Autostart was not installed");
    }
    stop()?;
    println!("Kept ~/.cmux (token, paired devices). Delete it yourself to forget everything.");
    Ok(())
}

// ---------------------------------------------------------------- qr

/// Link that opens the web app and redeems a single-use ticket for a per-device token.
pub fn pairing_url(base: &str, ticket: &str) -> String {
    let ws = format!(
        "{}://{}/ws",
        if base.starts_with("https") { "wss" } else { "ws" },
        base.split("://").nth(1).unwrap_or(base)
    );
    let offer = serde_json::json!({ "v": 1, "endpoint": ws, "token": "", "ticket": ticket });
    let code = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(offer.to_string());
    format!("{base}/#code={code}")
}

/// Half-block QR with explicit black/white colours, so it scans on light and dark terminal themes.
fn render_qr(data: &str) -> Res<String> {
    let code = qrcode::QrCode::new(data.as_bytes()).map_err(|e| format!("cannot build QR: {e}"))?;
    let width = code.width();
    let colors = code.to_colors();
    let quiet = 2usize;
    let total = width + quiet * 2;
    let dark = |x: usize, y: usize| -> bool {
        x >= quiet
            && y >= quiet
            && x < quiet + width
            && y < quiet + width
            && colors[(y - quiet) * width + (x - quiet)] == qrcode::Color::Dark
    };
    let mut out = String::new();
    let mut y = 0;
    while y < total {
        for x in 0..total {
            let top = dark(x, y);
            let bottom = y + 1 < total && dark(x, y + 1);
            let fg = if top { 30 } else { 97 };
            let bg = if bottom { 40 } else { 107 };
            out.push_str(&format!("\x1b[{fg};{bg}m▀\x1b[0m"));
        }
        out.push('\n');
        y += 2;
    }
    Ok(out)
}

pub fn qr(tailscale: bool) -> Res<()> {
    if health().is_none() {
        return Err("the gateway is not running. Start it with `cmob start` (inside cmux)".into());
    }
    let token = read_or_create_token()?;
    let pairing = get_json("/api/pairing", &token)?;
    let ticket = pairing
        .pointer("/offer/ticket")
        .and_then(|v| v.as_str())
        .ok_or("the gateway did not return a pairing ticket")?;
    let base = if tailscale {
        ensure_tailscale_serve()?
    } else {
        format!("http://127.0.0.1:{}", port())
    };
    let url = pairing_url(&base, ticket);
    println!();
    print!("{}", render_qr(&url)?);
    println!("\nScan with the camera in the app: menu → Hosts & devices → Scan.");
    println!("Single-use link, expires in 10 minutes. Run `cmob qr` again for another phone.");
    println!("\n{url}\n");
    if !tailscale {
        warn("This link only works on this Mac. Use `cmob qr --tailscale` for a phone.");
    }
    Ok(())
}

// ---------------------------------------------------------------- status / devices / logs

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn human_age(secs: u64) -> String {
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m", secs / 60),
        3600..=86399 => format!("{}h{:02}m", secs / 3600, secs % 3600 / 60),
        _ => format!("{}d", secs / 86400),
    }
}

/// "Safari · iPhone" instead of a 150-character User-Agent.
fn short_agent(ua: &str) -> String {
    let os = if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Macintosh") {
        "macOS"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        return if ua.is_empty() { "unknown".into() } else { ua.chars().take(30).collect() };
    };
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("Firefox/") {
        "Firefox"
    } else if ua.contains("CriOS") || ua.contains("Chrome/") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        "Browser"
    };
    format!("{browser} · {os}")
}

pub fn status() -> Res<()> {
    let Some(h) = health() else {
        println!("Gateway     ✗ not running on 127.0.0.1:{}", port());
        println!("            start it from a cmux terminal: cmob start   (first time: cmob setup)");
        return Err(String::new());
    };
    let version = h.get("version").and_then(|v| v.as_str()).unwrap_or("?");
    println!("Gateway     ✓ running on 127.0.0.1:{} (v{version})", port());
    if h.get("cmux_alive").and_then(|v| v.as_bool()).unwrap_or(false) {
        println!("cmux        ✓ connected");
    } else {
        println!("cmux        ✗ not reachable. The gateway must be started from a cmux terminal (cmob stop && cmob start)");
    }
    println!(
        "Autostart   {}",
        if hook_installed() { "✓ installed" } else { "– not installed (run cmob setup)" }
    );
    match (tailscale_bin(), tailscale_dns()) {
        (Some(bin), Some(dns)) if tailscale_serving(&bin, port()) => println!("Tailscale   ✓ https://{dns}"),
        (Some(_), Some(dns)) => println!("Tailscale   – signed in as {dns}, not serving yet (run cmob qr --tailscale)"),
        (Some(_), None) => println!("Tailscale   – installed but not signed in"),
        _ => println!("Tailscale   – not found (phones need it for HTTPS)"),
    }

    let token = read_or_create_token()?;
    match get_json("/api/clients", &token) {
        Ok(v) => {
            let clients = v.get("clients").and_then(|c| c.as_array()).cloned().unwrap_or_default();
            println!("Connected   {} client{}", clients.len(), if clients.len() == 1 { "" } else { "s" });
            for c in &clients {
                let label = c.get("label").and_then(|v| v.as_str()).unwrap_or("?");
                let ua = c.get("user_agent").and_then(|v| v.as_str()).unwrap_or("");
                let at = c.get("connected_at").and_then(|v| v.as_u64()).unwrap_or(0);
                println!("  - {label:<14} {:<18} up {}", short_agent(ua), human_age(now_secs().saturating_sub(at)));
            }
        }
        Err(e) => println!("Connected   ? {e}"),
    }
    if let Ok(v) = get_json("/api/devices", &token) {
        let n = v.get("devices").and_then(|d| d.as_array()).map(|d| d.len()).unwrap_or(0);
        println!("Paired      {n} device{} (cmob devices)", if n == 1 { "" } else { "s" });
    }
    Ok(())
}

fn list_devices(token: &str) -> Res<Vec<serde_json::Value>> {
    let v = get_json("/api/devices", token)?;
    Ok(v.get("devices").and_then(|d| d.as_array()).cloned().unwrap_or_default())
}

pub fn devices_list() -> Res<()> {
    if health().is_none() {
        return Err("the gateway is not running".into());
    }
    let devices = list_devices(&read_or_create_token()?)?;
    if devices.is_empty() {
        println!("No paired devices. Pair one with: cmob qr --tailscale");
        return Ok(());
    }
    println!("{:<10} {:<24} LAST SEEN", "ID", "NAME");
    for d in &devices {
        let id = d.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let label = d.get("label").and_then(|v| v.as_str()).filter(|l| !l.is_empty()).unwrap_or("device");
        let seen = d.get("last_seen").and_then(|v| v.as_u64()).unwrap_or(0);
        println!("{:<10} {:<24} {} ago", id.chars().take(8).collect::<String>(), label, human_age(now_secs().saturating_sub(seen)));
    }
    println!("\nRevoke one with: cmob devices revoke <ID>");
    Ok(())
}

pub fn devices_revoke(prefix: &str) -> Res<()> {
    if health().is_none() {
        return Err("the gateway is not running".into());
    }
    let token = read_or_create_token()?;
    let devices = list_devices(&token)?;
    let matches: Vec<&serde_json::Value> = devices
        .iter()
        .filter(|d| d.get("id").and_then(|v| v.as_str()).map(|i| i.starts_with(prefix)).unwrap_or(false))
        .collect();
    let id = match matches.as_slice() {
        [one] => one.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        [] => return Err(format!("no device id starts with `{prefix}` (see `cmob devices`)")),
        _ => return Err(format!("`{prefix}` matches more than one device; type more of the id")),
    };
    let (status, _) = http("DELETE", &format!("/api/devices/{id}"), Some(&token))?;
    if status == 200 {
        ok("Device revoked. Its phone is disconnected and gets no more notifications.");
        Ok(())
    } else {
        Err(format!("revoke failed (HTTP {status})"))
    }
}

pub fn logs(follow: bool) -> Res<()> {
    let path = log_path()?;
    if !path.exists() {
        return Err(format!("no log yet ({})", path.display()));
    }
    let mut cmd = Command::new("tail");
    if follow {
        cmd.arg("-f");
    }
    cmd.args(["-n", "50"]).arg(&path);
    cmd.status().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_install_is_idempotent_and_removal_restores_the_file() {
        let original = "export FOO=1\nalias ll='ls -l'\n";
        let once = with_hook(original);
        assert!(once.contains("cmob start --quiet"));
        assert_eq!(with_hook(&once), once, "installing twice must not stack blocks");
        assert_eq!(without_hook(&once), original);
    }

    #[test]
    fn hook_handles_files_without_trailing_newline() {
        let once = with_hook("export A=1");
        assert!(once.starts_with("export A=1\n# >>> cmob autostart >>>"));
        assert_eq!(without_hook(&once), "export A=1\n");
    }

    #[test]
    fn a_lone_begin_marker_never_deletes_the_rest_of_the_file() {
        let damaged = format!("a\n{HOOK_BEGIN}\nkeep me\n");
        assert_eq!(without_hook(&damaged), damaged);
    }

    #[test]
    fn the_legacy_script_block_is_replaced_not_duplicated() {
        let legacy = format!("x\n{LEGACY_HOOK_BEGIN}\nold stuff\n{LEGACY_HOOK_END}\ny\n");
        let out = with_hook(&legacy);
        assert!(!out.contains("old stuff"));
        assert!(out.contains("x\ny\n"));
        assert_eq!(out.matches(HOOK_BEGIN).count(), 1);
    }

    #[test]
    fn pairing_url_carries_a_ticket_and_no_token() {
        let url = pairing_url("https://mac.tail.ts.net", "tk1");
        let code = url.split("#code=").nth(1).unwrap();
        let json = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(code).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&json).unwrap();
        assert_eq!(v["endpoint"], "wss://mac.tail.ts.net/ws");
        assert_eq!(v["ticket"], "tk1");
        assert_eq!(v["token"], "");
        assert!(url.starts_with("https://mac.tail.ts.net/#code="));
        let local = pairing_url("http://127.0.0.1:8088", "t");
        let v: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(local.split("#code=").nth(1).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(v["endpoint"], "ws://127.0.0.1:8088/ws");
    }

    #[test]
    fn parses_plain_and_chunked_http_responses() {
        let plain = b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}";
        assert_eq!(parse_response(plain).unwrap(), (200, "{}".to_string()));
        let chunked = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        assert_eq!(parse_response(chunked).unwrap(), (200, "hello world".to_string()));
        assert_eq!(parse_response(b"HTTP/1.1 401 Unauthorized\r\n\r\n").unwrap().0, 401);
        assert!(parse_response(b"garbage").is_err());
    }

    #[test]
    fn user_agents_are_shortened() {
        let iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
        assert_eq!(short_agent(iphone), "Safari · iPhone");
        let chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
        assert_eq!(short_agent(chrome), "Chrome · macOS");
        assert_eq!(short_agent(""), "unknown");
    }

    #[test]
    fn serve_state_never_mistakes_someone_elses_config_for_ours() {
        assert_eq!(serve_state("{}", 8088).unwrap(), ServeState::Empty);
        assert_eq!(serve_state("null", 8088).unwrap(), ServeState::Empty);
        let ours = r#"{"Web":{"m.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8088"}}}}}"#;
        assert_eq!(serve_state(ours, 8088).unwrap(), ServeState::Ours);
        let other = r#"{"Web":{"m.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#;
        assert_eq!(serve_state(other, 8088).unwrap(), ServeState::Other);
        assert_eq!(serve_state(other, 3000).unwrap(), ServeState::Ours);
        assert!(serve_state("not json", 8088).is_err(), "unreadable config must not count as empty");
    }

    #[test]
    fn ages_are_compact() {
        assert_eq!(human_age(5), "5s");
        assert_eq!(human_age(125), "2m");
        assert_eq!(human_age(3725), "1h02m");
        assert_eq!(human_age(200_000), "2d");
    }

    #[test]
    fn qr_renders_for_a_realistic_pairing_link() {
        let url = pairing_url("https://mac-machine.tail811605.ts.net", &"a".repeat(32));
        let art = render_qr(&url).unwrap();
        assert!(art.lines().count() > 10);
        assert!(art.contains('▀'));
    }
}
