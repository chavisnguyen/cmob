use axum::{
    http::{header, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

/// Static assets embedded into the binary at compile time from `assets/`.
/// Sourced from Vite+ React PWA build (`repos/cmux-client/dist/`).
#[derive(RustEmbed)]
#[folder = "assets/"]
pub struct EmbeddedAssets;

pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    let mut response = match EmbeddedAssets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], content.data).into_response()
        }
        None => {
            // SPA fallback: any client-side route falls back to index.html
            match EmbeddedAssets::get("index.html") {
                Some(content) => {
                    ([(header::CONTENT_TYPE, "text/html")], content.data).into_response()
                }
                None => (
                    StatusCode::NOT_FOUND,
                    "404 Not Found - Client PWA assets not embedded",
                )
                    .into_response(),
            }
        }
    };

    let is_html = path == "index.html" || path.is_empty() || EmbeddedAssets::get(path).is_none();
    if is_html || path == "sw.js" || path == "manifest.webmanifest" {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-store, must-revalidate, max-age=0"),
        );
        response.headers_mut().insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
        response.headers_mut().insert(header::EXPIRES, HeaderValue::from_static("0"));
    } else if path.starts_with("assets/") {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }

    // If query string contains ?token=..., set persistent cookie for standalone iOS WebClip cross-hydration
    if let Some(query) = uri.query() {
        for pair in query.split('&') {
            let mut parts = pair.split('=');
            if parts.next() == Some("token") {
                if let Some(token_val) = parts.next() {
                    // Only characters that cannot terminate or inject cookie attributes.
                    if !token_val.is_empty()
                        && token_val
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'~'))
                    {
                        let cookie_header = format!(
                            "cmux_token={}; Path=/; Max-Age=31536000; SameSite=Lax",
                            token_val
                        );
                        if let Ok(val) = HeaderValue::from_str(&cookie_header) {
                            response.headers_mut().insert(header::SET_COOKIE, val);
                        }
                    }
                }
                break;
            }
        }
    }

    response
}
