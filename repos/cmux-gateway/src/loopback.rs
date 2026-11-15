use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// Error types for host binding and loopback validation.
/// Source: ref/cmux-pocket/crates/cmux-pocket-macos/src/loopback.rs:72-120
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LoopbackError {
    #[error("Wildcard bind is strictly forbidden for security: {0}")]
    WildcardBindForbidden(String),

    #[error("Non-loopback IP address rejected: {0}")]
    NonLoopbackIp(IpAddr),

    #[error("Host string cannot be empty")]
    EmptyHost,

    #[error("Invalid IP or host address: {0}")]
    InvalidAddress(String),
}

/// Checks if an IPv4 address belongs to the Tailscale CGNAT subnet (100.64.0.0/10).
pub fn is_tailscale_ipv4(v4: &Ipv4Addr) -> bool {
    let octets = v4.octets();
    octets[0] == 100 && (octets[1] >= 64 && octets[1] <= 127)
}

/// Returns true if the given IP address is loopback or Tailscale interface.
pub fn is_allowed_bind_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || is_tailscale_ipv4(v4),
        IpAddr::V6(v6) => {
            if v6.is_loopback() {
                return true;
            }
            if let Some(v4) = v6.to_ipv4_mapped() {
                return v4.is_loopback() || is_tailscale_ipv4(&v4);
            }
            // Tailscale IPv6 ULA fd7a:115c:a1e0::/48
            let segs = v6.segments();
            segs[0] == 0xfd7a && segs[1] == 0x115c && segs[2] == 0xa1e0
        }
    }
}

/// Validates that a host string is a safe loopback or Tailscale host.
pub fn validate_bind_host(host: &str) -> Result<(), LoopbackError> {
    let clean = host.trim().trim_start_matches('[').trim_end_matches(']');
    if clean.is_empty() {
        return Err(LoopbackError::EmptyHost);
    }

    if clean == "0.0.0.0" || clean == "::" {
        return Err(LoopbackError::WildcardBindForbidden(host.to_string()));
    }

    if clean.eq_ignore_ascii_case("localhost") {
        return Ok(());
    }

    match clean.parse::<IpAddr>() {
        Ok(ip) => {
            if is_allowed_bind_ip(&ip) {
                Ok(())
            } else {
                Err(LoopbackError::NonLoopbackIp(ip))
            }
        }
        Err(_) => Err(LoopbackError::InvalidAddress(host.to_string())),
    }
}

/// Parses and validates a bind host and port into a `SocketAddr`.
pub fn parse_and_validate_bind(host: &str, port: u16) -> Result<SocketAddr, LoopbackError> {
    validate_bind_host(host)?;

    let clean = host.trim().trim_start_matches('[').trim_end_matches(']');
    if clean.eq_ignore_ascii_case("localhost") {
        return Ok(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            port,
        ));
    }

    let ip = clean
        .parse::<IpAddr>()
        .map_err(|_| LoopbackError::InvalidAddress(format!("Cannot parse IP: {host}")))?;

    Ok(SocketAddr::new(ip, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_loopback_allowed() {
        assert!(validate_bind_host("127.0.0.1").is_ok());
        assert!(validate_bind_host("localhost").is_ok());
        assert!(validate_bind_host("::1").is_ok());
        assert!(validate_bind_host("127.0.0.2").is_ok());
    }

    #[test]
    fn test_tailscale_allowed() {
        assert!(validate_bind_host("100.64.0.1").is_ok());
        assert!(validate_bind_host("100.100.50.2").is_ok());
        assert!(validate_bind_host("100.127.255.254").is_ok());
    }

    #[test]
    fn test_wildcard_denied() {
        assert!(matches!(
            validate_bind_host("0.0.0.0"),
            Err(LoopbackError::WildcardBindForbidden(_))
        ));
        assert!(matches!(
            validate_bind_host("::"),
            Err(LoopbackError::WildcardBindForbidden(_))
        ));
    }

    #[test]
    fn test_public_and_lan_denied() {
        assert!(matches!(
            validate_bind_host("192.168.1.1"),
            Err(LoopbackError::NonLoopbackIp(_))
        ));
        assert!(matches!(
            validate_bind_host("8.8.8.8"),
            Err(LoopbackError::NonLoopbackIp(_))
        ));
    }
}
