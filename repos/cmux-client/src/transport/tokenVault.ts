import {
  collectTokenCandidates,
  isStaticHostOrigin,
  isValidGatewayEndpoint,
  readPairingFromLocation,
  sameOriginEndpoint,
  sanitizePairingInAddressBar,
  type PairingOffer,
} from "../protocol/pairing";

const ENDPOINT_KEY = "cmux_endpoint";

export function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function setCookie(name: string, value: string, days = 365): void {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

/**
 * An offer that points at a different host than the one serving this page. It is never applied
 * silently: the user must confirm it first.
 */
export function isForeignOffer(offer: PairingOffer | null): boolean {
  if (!offer || typeof window === "undefined") return false;
  return (
    isValidGatewayEndpoint(offer.endpoint) && offer.endpoint !== sameOriginEndpoint(window.location)
  );
}

/** Every token this browser could use, best guess first (URL offer first, then remembered). */
export function readTokenCandidates(): string[] {
  if (typeof window === "undefined") return [];
  const offer = readPairingFromLocation(window.location);
  const urlToken = offer?.token && !isForeignOffer(offer) ? offer.token : undefined;
  let local: string | null = null;
  let session: string | null = null;
  try {
    local = localStorage.getItem("cmux_token");
  } catch {
    // Ignore storage access errors
  }
  try {
    session = sessionStorage.getItem("cmux_token");
  } catch {
    // Ignore
  }
  return collectTokenCandidates(urlToken, [local, session, getCookie("cmux_token")]);
}

export function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem("cmux_token");
    sessionStorage.removeItem("cmux_token");
  } catch {
    // Ignore
  }
  setCookie("cmux_token", "", -1);
}

export function getStoredEndpoint(): string | null {
  try {
    const v = localStorage.getItem(ENDPOINT_KEY);
    return v && isValidGatewayEndpoint(v) ? v : null;
  } catch {
    return null;
  }
}

export function persistEndpoint(endpoint: string | null): void {
  try {
    if (endpoint) localStorage.setItem(ENDPOINT_KEY, endpoint);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function persistStoredToken(token: string): void {
  if (typeof window === "undefined" || !token) return;
  try {
    localStorage.setItem("cmux_token", token);
  } catch {
    // Ignore
  }
  try {
    sessionStorage.setItem("cmux_token", token);
  } catch {
    // Ignore
  }
  setCookie("cmux_token", token, 365);
  if (!getStoredEndpoint() && !isStaticHostOrigin(window.location)) {
    sanitizePairingInAddressBar(token);
  }
}
