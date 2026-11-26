import {
  getActiveHostId,
  loadHosts,
  setActiveHostId,
  upsertHost,
  type SavedHost,
} from "../hosts/hostStore";
import {
  endpointToHttpBase,
  isStaticHostOrigin,
  isValidGatewayEndpoint,
  readPairingFromLocation,
  sameOriginEndpoint,
  type PairingOffer,
} from "../protocol/pairing";
import {
  getStoredEndpoint,
  isForeignOffer,
  persistEndpoint,
  readTokenCandidates,
} from "./tokenVault";

/** Short label shown in the gateway's device list. */
export function deviceLabel(): string {
  if (typeof navigator === "undefined") return "Browser";
  const ua = navigator.userAgent;
  const platform = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : "Browser";
  const standalone =
    typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches;
  return standalone ? `${platform} (app)` : platform;
}

export type TicketExchangeOutcome =
  | { status: "ok"; token: string }
  | { status: "rejected" | "retryable"; errorMessage: string };

/**
 * Redeems a single-use pairing ticket at `POST /api/pair/exchange` for a per-device token.
 */
export async function exchangePairingTicket(
  endpoint: string,
  ticket: string,
): Promise<TicketExchangeOutcome> {
  if (!isValidGatewayEndpoint(endpoint)) {
    return { status: "rejected", errorMessage: `Invalid gateway endpoint: ${endpoint}` };
  }

  try {
    const resp = await fetch(`${endpointToHttpBase(endpoint)}/api/pair/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, label: deviceLabel() }),
    });

    if (!resp.ok) {
      if (resp.status === 403) {
        return {
          status: "rejected",
          errorMessage:
            "Gateway rejected pairing request (forbidden origin). Please restart gateway: cmob restart",
        };
      }
      if (resp.status === 401) {
        return {
          status: "rejected",
          errorMessage:
            "Pairing ticket expired or already used. Run `cmob qr --tailscale` for a new code.",
        };
      }
      return {
        status: resp.status >= 400 && resp.status < 500 ? "rejected" : "retryable",
        errorMessage: `Pairing ticket exchange failed (HTTP ${resp.status}).`,
      };
    }

    const body = (await resp.json()) as { token?: string };
    if (!body.token) {
      return { status: "rejected", errorMessage: "Gateway did not return a device token." };
    }
    return { status: "ok", token: body.token };
  } catch {
    return {
      status: "retryable",
      errorMessage: `Cannot reach gateway at ${endpoint}. Ensure Tailscale is connected and gateway is running.`,
    };
  }
}

export interface InitialPairingResolution {
  token: string;
  fallbackTokens: string[];
  endpoint: string | null;
  pendingPairing: PairingOffer | null;
  pendingTicket: { ticket: string; endpoint: string } | null;
  hostNameHint: string | null;
}

/**
 * Resolves initial endpoint, token candidates, and pairing offers on client startup.
 * Ensures a fresh same-origin `#token=` / `?token=` link always takes precedence over any
 * stale token saved in `cmux_hosts`.
 */
export function resolveInitialPairingState(): InitialPairingResolution {
  const candidates = readTokenCandidates();
  let token = candidates[0] ?? "";
  const fallbackTokens = candidates.slice(1);
  let endpoint: string | null = null;
  let pendingPairing: PairingOffer | null = null;
  let pendingTicket: { ticket: string; endpoint: string } | null = null;
  let hostNameHint: string | null = null;

  if (typeof window === "undefined") {
    return { token, fallbackTokens, endpoint, pendingPairing, pendingTicket, hostNameHint };
  }

  const offer = readPairingFromLocation(window.location);
  const foreign = isForeignOffer(offer);
  const hasSameOriginOffer = Boolean(offer && !foreign);

  if (offer && foreign) {
    pendingPairing = offer;
    endpoint = getStoredEndpoint();
  } else if (hasSameOriginOffer) {
    persistEndpoint(null);
    endpoint = null;
  } else {
    endpoint = getStoredEndpoint();
  }

  try {
    const activeId = getActiveHostId(localStorage);
    const hosts = loadHosts(localStorage);
    const activeHost: SavedHost | undefined =
      (activeId ? hosts.find((h) => h.id === activeId) : undefined) ?? hosts[0];

    if (hasSameOriginOffer) {
      const sameOrigin = sameOriginEndpoint(window.location);
      const matchingSaved = hosts.find((h) => h.endpoint === sameOrigin);
      if (matchingSaved) {
        hostNameHint = matchingSaved.name;
        if (
          matchingSaved.token &&
          matchingSaved.token !== token &&
          !fallbackTokens.includes(matchingSaved.token)
        ) {
          fallbackTokens.push(matchingSaved.token);
        }
      }
    } else if (!endpoint && activeHost) {
      const sameOrigin = !isStaticHostOrigin(window.location)
        ? sameOriginEndpoint(window.location)
        : "";
      endpoint = activeHost.endpoint === sameOrigin ? null : activeHost.endpoint;
      hostNameHint = activeHost.name;
      if (endpoint || !token) {
        token = activeHost.token;
      } else if (
        activeHost.token &&
        activeHost.token !== token &&
        !fallbackTokens.includes(activeHost.token)
      ) {
        fallbackTokens.push(activeHost.token);
      }
    }
  } catch {
    // Ignore localStorage access errors
  }

  if (offer?.ticket && !offer.token && !pendingPairing) {
    pendingTicket = { ticket: offer.ticket, endpoint: offer.endpoint };
  }

  return { token, fallbackTokens, endpoint, pendingPairing, pendingTicket, hostNameHint };
}

export function recordAuthenticatedHost(
  endpoint: string,
  token: string,
  hostNameHint: string | null,
): void {
  if (typeof window === "undefined" || !token || !endpoint) return;
  try {
    const existing = loadHosts(localStorage).find((h) => h.id === endpoint);
    upsertHost(localStorage, {
      endpoint,
      token,
      name: existing?.name || hostNameHint || undefined,
    });
    if (!getActiveHostId(localStorage) || getActiveHostId(localStorage) !== endpoint) {
      setActiveHostId(localStorage, endpoint);
    }
  } catch {
    // Ignore storage errors
  }
}
