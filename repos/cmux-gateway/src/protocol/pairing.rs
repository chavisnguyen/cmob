use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

pub const PAIRING_OFFER_VERSION: u32 = 1;
pub const PAIRING_URI_SCHEME: &str = "cmux-mobile";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingOffer {
    pub v: u32,
    pub endpoint: String,
    /// Long-lived gateway token. Empty when the offer carries a one-time `ticket` instead.
    #[serde(default)]
    pub token: String,
    /// Single-use ticket redeemed at `POST /api/pair/exchange` for a per-device token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_name: Option<String>,
}

impl PairingOffer {
    pub fn new(endpoint: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            v: PAIRING_OFFER_VERSION,
            endpoint: endpoint.into(),
            token: token.into(),
            ticket: None,
            host_name: None,
        }
    }

    /// Offer carrying a one-time ticket and no long-lived token.
    pub fn with_ticket(endpoint: impl Into<String>, ticket: impl Into<String>) -> Self {
        Self {
            v: PAIRING_OFFER_VERSION,
            endpoint: endpoint.into(),
            token: String::new(),
            ticket: Some(ticket.into()),
            host_name: None,
        }
    }

    pub fn with_host_name(
        endpoint: impl Into<String>,
        token: impl Into<String>,
        host_name: impl Into<String>,
    ) -> Self {
        Self {
            v: PAIRING_OFFER_VERSION,
            endpoint: endpoint.into(),
            token: token.into(),
            ticket: None,
            host_name: Some(host_name.into()),
        }
    }

    /// Encodes the pairing offer into a base64url string.
    pub fn to_base64url(&self) -> Result<String, serde_json::Error> {
        let json = serde_json::to_string(self)?;
        Ok(URL_SAFE_NO_PAD.encode(json.as_bytes()))
    }

    /// Builds a full deep link URI: `cmux-mobile://pair?code=<base64url>`.
    pub fn to_uri(&self) -> Result<String, serde_json::Error> {
        let code = self.to_base64url()?;
        Ok(format!("{}://pair?code={}", PAIRING_URI_SCHEME, code))
    }

    /// Decodes a pairing offer from a base64url string.
    pub fn from_base64url(base64url: &str) -> Result<Self, String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(base64url.trim())
            .map_err(|e| format!("Invalid base64url: {}", e))?;
        let json_str = std::str::from_utf8(&bytes)
            .map_err(|e| format!("Invalid UTF-8 payload: {}", e))?;
        let offer: Self = serde_json::from_str(json_str)
            .map_err(|e| format!("Invalid JSON payload: {}", e))?;
        if offer.v != PAIRING_OFFER_VERSION {
            return Err(format!("Unsupported pairing version: {}", offer.v));
        }
        Ok(offer)
    }

    /// Parses a pairing code or deep link URL.
    pub fn parse(input: &str) -> Result<Self, String> {
        let trimmed = input.trim();
        if trimmed.starts_with("cmux-mobile://") {
            let code = extract_code_from_uri(trimmed)?;
            Self::from_base64url(&code)
        } else {
            Self::from_base64url(trimmed)
        }
    }
}

fn extract_code_from_uri(uri: &str) -> Result<String, String> {
    if let Some(pos) = uri.find("code=") {
        let rest = &uri[pos + 5..];
        let end = rest.find('&').unwrap_or(rest.len());
        let code = &rest[..end];
        if !code.is_empty() {
            return Ok(code.to_string());
        }
    }
    Err("No pairing code found in URI".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pairing_offer_roundtrip() {
        let offer = PairingOffer::with_host_name("ws://100.64.0.1:8088/ws", "secret_token_123", "my-macbook");
        let uri = offer.to_uri().expect("to_uri");
        assert!(uri.starts_with("cmux-mobile://pair?code="));

        let parsed = PairingOffer::parse(&uri).expect("parse");
        assert_eq!(parsed, offer);
    }

    #[test]
    fn test_ticket_offer_has_no_token_and_roundtrips() {
        let offer = PairingOffer::with_ticket("ws://127.0.0.1:8088/ws", "tkt_1");
        assert!(offer.token.is_empty());
        let json = serde_json::to_string(&offer).unwrap();
        assert!(json.contains("\"ticket\":\"tkt_1\""));
        let parsed = PairingOffer::parse(&offer.to_uri().unwrap()).unwrap();
        assert_eq!(parsed, offer);
    }

    #[test]
    fn test_pairing_offer_bare_base64url() {
        let offer = PairingOffer::new("ws://127.0.0.1:8088/ws", "token_abc");
        let b64 = offer.to_base64url().expect("b64");
        let parsed = PairingOffer::parse(&b64).expect("parse");
        assert_eq!(parsed, offer);
    }
}
