/**
 * cmux-mobile QR Pairing & URI Decoder
 * Inspired by Orca (ref/orca/src/renderer/src/web/web-pairing.ts, ref/orca/src/shared/remote-runtime/pairing/pairing.ts)
 */

export const PAIRING_OFFER_VERSION = 1;
export const PAIRING_URI_SCHEME = "cmux-mobile";
export const PAIRING_INPUT_MAX_CHARACTERS = 8192;

export interface PairingOffer {
  v: number;
  endpoint: string;
  /** Long-lived gateway token. Empty when the offer carries a one-time `ticket`. */
  token: string;
  /** Single-use ticket redeemed at `POST /api/pair/exchange` for a per-device token. */
  ticket?: string;
  host_name?: string;
}

/**
 * Accepts only ws:/wss: URLs so a pairing offer cannot point the client at another scheme.
 */
export function isValidGatewayEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (url.protocol === "ws:" || url.protocol === "wss:") && url.host.length > 0;
  } catch {
    return false;
  }
}

/** `wss://host/ws` -> `https://host`, used for HTTP calls such as ticket redemption. */
export function endpointToHttpBase(endpoint: string): string {
  const url = new URL(endpoint);
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//${url.host}`;
}

/** WebSocket endpoint of the origin serving this page. */
export function sameOriginEndpoint(location: Pick<Location, "protocol" | "host">): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

/**
 * Normalizes URL-safe base64 string for standard atob decoding.
 */
export function normalizeBase64Url(base64url: string): string {
  let normalized = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) {
    normalized += "=";
  }
  return normalized;
}

/**
 * Decodes base64url JSON payload into PairingOffer.
 */
export function decodePairingPayload(base64url: string): PairingOffer | null {
  try {
    const base64 = normalizeBase64Url(base64url.trim());
    const jsonStr = atob(base64);
    const parsed = JSON.parse(jsonStr) as Partial<PairingOffer>;

    if (
      parsed.v !== PAIRING_OFFER_VERSION ||
      typeof parsed.endpoint !== "string" ||
      parsed.endpoint.length === 0 ||
      typeof parsed.token !== "string" ||
      (parsed.token.length === 0 &&
        !(typeof parsed.ticket === "string" && parsed.ticket.length > 0))
    ) {
      return null;
    }

    return {
      v: PAIRING_OFFER_VERSION,
      endpoint: parsed.endpoint,
      token: parsed.token,
      ...(parsed.ticket ? { ticket: parsed.ticket } : {}),
      ...(parsed.host_name ? { host_name: parsed.host_name } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Extracts pairing code from deep link URI (e.g. `cmux-mobile://pair?code=...`).
 */
export function extractCodeFromUri(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "cmux-mobile:" && url.protocol !== "orca:") {
      return null;
    }
    const code = url.searchParams.get("code");
    if (code) {
      return code;
    }
    const hash = url.hash.replace(/^#/, "");
    return hash || null;
  } catch {
    return null;
  }
}

/**
 * Parses user input string (either deep-link URI, raw base64url, or JSON).
 */
export function parsePairingInput(input: string): PairingOffer | null {
  if (input.length > PAIRING_INPUT_MAX_CHARACTERS) {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("cmux-mobile://") || trimmed.startsWith("orca://")) {
    const code = extractCodeFromUri(trimmed);
    return code ? decodePairingPayload(code) : null;
  }

  // The CLI's QR (`cmux-mobile qr`) encodes the companion web URL: https://host/#token=...
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return readPairingFromLocation({
        search: url.search,
        hash: url.hash,
        origin: url.origin,
        protocol: url.protocol,
      });
    } catch {
      return null;
    }
  }

  return decodePairingPayload(trimmed);
}

/**
 * Reads pairing offer or token from browser location (query params or hash fragment).
 */
export function readPairingFromLocation(
  location: Pick<Location, "search" | "hash" | "origin" | "protocol">,
): PairingOffer | null {
  // 1. Check URL query parameters (?code= or ?token=)
  if (location.search) {
    const searchParams = new URLSearchParams(location.search);
    const code = searchParams.get("code");
    if (code) {
      const offer = decodePairingPayload(code);
      if (offer) return offer;
    }
    const token = searchParams.get("token");
    if (token) {
      const isHttps = location.protocol === "https:";
      const endpoint = `${isHttps ? "wss" : "ws"}://${location.origin.replace(/^https?:\/\//, "")}/ws`;
      return {
        v: PAIRING_OFFER_VERSION,
        endpoint,
        token,
      };
    }
  }

  // 2. Check URL hash fragment (#code= or #token=)
  if (location.hash) {
    const rawHash = location.hash.replace(/^#/, "").trim();
    if (rawHash.startsWith("code=") || rawHash.startsWith("token=")) {
      const hashParams = new URLSearchParams(rawHash);
      const code = hashParams.get("code");
      if (code) {
        const offer = decodePairingPayload(code);
        if (offer) return offer;
      }
      const token = hashParams.get("token");
      if (token) {
        const isHttps = location.protocol === "https:";
        const endpoint = `${isHttps ? "wss" : "ws"}://${location.origin.replace(/^https?:\/\//, "")}/ws`;
        return {
          v: PAIRING_OFFER_VERSION,
          endpoint,
          token,
        };
      }
    } else {
      // Direct base64url code in hash fragment
      const offer = decodePairingPayload(rawHash);
      if (offer) return offer;
    }
  }

  return null;
}

/**
 * Sanitizes browser address bar:
 * Strips sensitive query parameters (?token=... or ?code=...) to prevent leakage into HTTP server logs,
 * while preserving hash fragments (#token=...) so that iOS Safari & Chrome 'Add to Home Screen'
 * bookmarks retain the pairing session across isolated WebClip sandboxes.
 * Sources:
 * - ref/orca/src/renderer/src/web/web-pairing.ts:107-126
 * - architecture.md: Section 5.1
 */
export function sanitizePairingInAddressBar(token?: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const searchParams = new URLSearchParams(window.location.search);
  const hadSearchToken = searchParams.has("token") || searchParams.has("code");
  const effectiveToken = token || readPairingFromLocation(window.location)?.token;

  const docTitle = typeof document !== "undefined" ? document.title : "";

  if (hadSearchToken) {
    searchParams.delete("token");
    searchParams.delete("code");
    const newSearch = searchParams.toString() ? `?${searchParams.toString()}` : "";
    const hash =
      window.location.hash && window.location.hash !== "#"
        ? window.location.hash
        : effectiveToken
          ? `#token=${encodeURIComponent(effectiveToken)}`
          : "";
    const cleanUrl = `${window.location.origin}${window.location.pathname}${newSearch}${hash}`;
    window.history.replaceState(null, docTitle, cleanUrl);
  } else if (effectiveToken && (!window.location.hash || window.location.hash === "#")) {
    window.history.replaceState(
      null,
      docTitle,
      `${window.location.origin}${window.location.pathname}${window.location.search}#token=${encodeURIComponent(effectiveToken)}`,
    );
  }
}

export function clearPairingFromAddressBar(token?: string): void {
  sanitizePairingInAddressBar(token);
}

/**
 * Exact alias matching Orca's naming convention (ref/orca/src/renderer/src/web/web-pairing.ts:126).
 */
export const clearPairingInputFromAddressBar = clearPairingFromAddressBar;

/**
 * Removes `code=` from both the query string and hash once a pairing offer has been consumed,
 * so a spent ticket is not left in history or screenshots.
 */
export function stripPairingCodeFromAddressBar(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  if (url.searchParams.has("code")) {
    url.searchParams.delete("code");
    changed = true;
  }
  if (/^#code=/.test(url.hash)) {
    url.hash = "";
    changed = true;
  }
  if (changed) {
    window.history.replaceState(null, document.title, url.toString());
  }
}
