//! DNS-rebinding (`Host`) and cross-origin (`Origin`) HTTP/WebSocket middleware guards.

use axum::{
    extract::Request,
    http::{header, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use tracing::warn;

/// Host names a legitimate client can use: loopback, IP literals, `*.ts.net` (Tailscale MagicDNS), and
/// anything in `CMUX_ALLOWED_HOSTS`. Anything else is a DNS-rebinding attempt.
pub fn host_allowed(host_header: &str) -> bool {
    let host = host_header.trim().to_ascii_lowercase();
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("").to_string()
    } else {
        host.rsplit_once(':')
            .map(|(h, _)| h)
            .unwrap_or(&host)
            .to_string()
    };
    if name.parse::<std::net::IpAddr>().is_ok()
        || name == "localhost"
        || name.ends_with(".localhost")
    {
        return true;
    }
    if name.ends_with(".ts.net") {
        return true;
    }
    std::env::var("CMUX_ALLOWED_HOSTS")
        .unwrap_or_default()
        .split(',')
        .map(|h| h.trim().to_ascii_lowercase())
        .any(|h| !h.is_empty() && h == name)
}

/// Origins permitted to connect via WebSocket or REST API.
pub fn origin_allowed(origin_str: &str, host_header: Option<&str>) -> bool {
    let origin_str = origin_str.trim();
    if origin_str.is_empty() {
        return false;
    }
    let lower = origin_str.to_ascii_lowercase();

    let authority = lower
        .split("://")
        .nth(1)
        .unwrap_or(&lower)
        .split('/')
        .next()
        .unwrap_or("");

    if authority.is_empty() {
        return false;
    }

    if let Some(host) = host_header {
        let host_lower = host.trim().to_ascii_lowercase();
        if authority == host_lower {
            return true;
        }
    }

    let host_name = authority
        .strip_prefix('[')
        .and_then(|r| r.split(']').next())
        .unwrap_or_else(|| authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority));

    if host_name.is_empty() {
        return false;
    }

    if host_name == "localhost"
        || host_name.ends_with(".localhost")
        || host_name
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
    {
        return true;
    }

    if host_name.ends_with(".ts.net") {
        return true;
    }

    if host_name == "chavisnguyen.github.io" {
        return true;
    }

    if let Ok(allowed) = std::env::var("CMUX_ALLOWED_ORIGINS") {
        for a in allowed.split(',') {
            let a = a.trim().to_ascii_lowercase();
            if a.is_empty() {
                continue;
            }
            if a == lower || a == authority || a == host_name {
                return true;
            }
        }
    }

    if let Ok(allowed_hosts) = std::env::var("CMUX_ALLOWED_HOSTS") {
        for h in allowed_hosts.split(',') {
            let h = h.trim().to_ascii_lowercase();
            if !h.is_empty() && h == host_name {
                return true;
            }
        }
    }

    false
}

pub async fn host_and_origin_guard(req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if let Some(h) = host.as_deref()
        && !host_allowed(h)
    {
        warn!("Rejected request with unexpected Host header: {h}");
        return (StatusCode::FORBIDDEN, "forbidden host").into_response();
    }
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }
    if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok())
        && !origin_allowed(origin, host.as_deref())
    {
        warn!("Rejected cross-origin request from Origin: {origin}");
        return (StatusCode::FORBIDDEN, "forbidden origin").into_response();
    }
    next.run(req).await
}
