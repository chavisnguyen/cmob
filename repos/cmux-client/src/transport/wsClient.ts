/**
 * WebSocket JSON-RPC 2.0 Transport Client with Auto-Reconnect & Auth Handshake
 * Sources:
 * - ref/orca/src/renderer/src/web/web-pairing.ts
 * - ref/cmux-pocket/crates/cmux-pocket-gateway/src/server.rs
 */

import { getActiveHostId, setActiveHostId, upsertHost, type SavedHost } from "../hosts/hostStore";
import {
  endpointToHttpBase,
  isValidGatewayEndpoint,
  readPairingFromLocation,
  type PairingOffer,
  sameOriginEndpoint,
  sanitizePairingInAddressBar,
  stripPairingCodeFromAddressBar,
} from "../protocol/pairing";
import {
  CODE_BACKEND_UNAVAILABLE,
  createRpcRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RequestId,
} from "../protocol/rpc";

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A malformed cookie must never throw: wsClient is constructed at module load.
    return null;
  }
}

function setCookie(name: string, value: string, days = 365): void {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

/**
 * An offer that points at a different host than the one serving this page. It is never applied
 * silently: a phishing link could otherwise pin the app to an attacker's gateway and send terminal
 * input and approvals there. The user must confirm it first.
 */
function isForeignOffer(offer: PairingOffer | null): boolean {
  if (!offer || typeof window === "undefined") return false;
  return (
    isValidGatewayEndpoint(offer.endpoint) && offer.endpoint !== sameOriginEndpoint(window.location)
  );
}

/** Short label shown in the gateway's device list. */
function deviceLabel(): string {
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

function getStoredToken(): string {
  if (typeof window === "undefined") return "";
  const offer = readPairingFromLocation(window.location);
  if (offer?.token && !isForeignOffer(offer)) return offer.token;

  try {
    const lsToken = localStorage.getItem("cmux_token");
    if (lsToken) return lsToken;
  } catch {
    // Ignore storage quota or access errors
  }

  try {
    const ssToken = sessionStorage.getItem("cmux_token");
    if (ssToken) return ssToken;
  } catch {
    // Ignore
  }

  const cookieToken = getCookie("cmux_token");
  if (cookieToken) return cookieToken;

  return "";
}

function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem("cmux_token");
    sessionStorage.removeItem("cmux_token");
  } catch {
    // Ignore
  }
  setCookie("cmux_token", "", -1);
}

function persistStoredToken(token: string): void {
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
  sanitizePairingInAddressBar(token);
}

const ENDPOINT_KEY = "cmux_endpoint";

function getStoredEndpoint(): string | null {
  try {
    const v = localStorage.getItem(ENDPOINT_KEY);
    return v && isValidGatewayEndpoint(v) ? v : null;
  } catch {
    return null;
  }
}

function persistEndpoint(endpoint: string | null): void {
  try {
    if (endpoint) localStorage.setItem(ENDPOINT_KEY, endpoint);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    // Ignore storage errors
  }
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "error";

export type EventHandler = (event: string, data: unknown) => void;

export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private token: string;
  private pendingRequests = new Map<
    RequestId,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();
  private eventListeners = new Set<EventHandler>();
  private stateChangeListeners = new Set<(state: ConnectionState) => void>();
  private currentState: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  /** Consecutive failed connection attempts; drives exponential backoff. */
  private reconnectAttempts = 0;
  /** Gateway WebSocket URL from a pairing offer; null means "same origin as this page". */
  private endpoint: string | null = null;
  /** One-time ticket from a pairing offer, redeemed before the first connection. */
  private pendingTicket: { ticket: string; endpoint: string } | null = null;
  private redeeming = false;
  /** Bumped whenever the target host changes; lets an in-flight ticket redemption notice it is stale. */
  private hostGeneration = 0;
  /** A pairing offer for another host waiting for the user's confirmation. */
  private pendingPairing: PairingOffer | null = null;
  private pairingListeners = new Set<() => void>();
  private hostNameHint: string | null = null;

  constructor() {
    this.token = getStoredToken();
    if (this.token) {
      persistStoredToken(this.token);
    }

    if (typeof window !== "undefined") {
      const offer = readPairingFromLocation(window.location);
      if (offer && isForeignOffer(offer)) {
        // Another host (e.g. Tailscale MagicDNS): wait for explicit confirmation, keep the current host.
        this.pendingPairing = offer;
        this.endpoint = getStoredEndpoint();
      } else if (offer) {
        // Offer targets this origin: forget any stale remembered endpoint.
        persistEndpoint(null);
      } else {
        this.endpoint = getStoredEndpoint();
      }
      if (offer?.ticket && !offer.token && !this.pendingPairing) {
        this.pendingTicket = { ticket: offer.ticket, endpoint: offer.endpoint };
      }
    }
  }

  /** WebSocket URL this client connects to. */
  public getEndpoint(): string {
    return this.endpoint ?? sameOriginEndpoint(window.location);
  }

  /**
   * Redeems a pairing ticket for a per-device token. Single-use: the gateway rejects replays.
   */
  private async redeemPendingTicket(): Promise<boolean> {
    const pending = this.pendingTicket;
    if (!pending) return true;
    if (!isValidGatewayEndpoint(pending.endpoint)) return false;
    const generation = this.hostGeneration;
    try {
      const resp = await fetch(`${endpointToHttpBase(pending.endpoint)}/api/pair/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: pending.ticket, label: deviceLabel() }),
      });
      if (!resp.ok) return false;
      const body = (await resp.json()) as { token?: string };
      if (!body.token) return false;
      // The user switched host / confirmed another pairing while this request was in flight: this token
      // belongs to the old host and must not be adopted. Report success so connect() re-runs and redeems
      // whatever ticket is pending now.
      if (generation !== this.hostGeneration) return true;
      this.token = body.token;
      persistStoredToken(body.token);
      this.pendingTicket = null;
      stripPairingCodeFromAddressBar();
      sanitizePairingInAddressBar(body.token); // keep the device token in the hash for iOS WebClips
      return true;
    } catch {
      return false;
    }
  }

  public getToken(): string {
    return this.token;
  }

  public setToken(token: string): void {
    const trimmed = token.trim();
    this.token = trimmed;
    if (trimmed) {
      persistStoredToken(trimmed);
    } else if (typeof window !== "undefined") {
      try {
        localStorage.removeItem("cmux_token");
        sessionStorage.removeItem("cmux_token");
      } catch {
        // Ignore
      }
      setCookie("cmux_token", "", -1);
    }
    this.shouldReconnect = true;
    this.reconnect();
  }

  public getState(): ConnectionState {
    return this.currentState;
  }

  public onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateChangeListeners.add(listener);
    listener(this.currentState);
    return () => this.stateChangeListeners.delete(listener);
  }

  public onEvent(listener: EventHandler): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private setState(state: ConnectionState): void {
    this.currentState = state;
    this.syncHeartbeat();
    for (const listener of this.stateChangeListeners) {
      listener(state);
    }
  }

  /**
   * A half-open socket (Wi-Fi to cellular handoff, host asleep without a TCP FIN) never fires `onclose`, so
   * the UI would keep saying "Connected" while every call times out. While connected we probe the gateway
   * periodically and when the page returns to the foreground or the network comes back; a probe that
   * times out forces a fresh connection.
   */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private lifecycleHooked = false;

  private syncHeartbeat(): void {
    const want = this.currentState === "connected";
    if (want && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => void this.probe(8000), 20_000);
      this.hookPageLifecycle();
    } else if (!want && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private hookPageLifecycle(): void {
    if (this.lifecycleHooked || typeof window === "undefined") return;
    this.lifecycleHooked = true;
    const wake = () => {
      if (!this.shouldReconnect) return;
      if (this.currentState === "connected") {
        void this.probe(4000);
      } else if (this.currentState === "disconnected" || this.currentState === "error") {
        // Back online / foregrounded: do not wait out the remaining backoff delay.
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (this.currentState === "disconnected") this.connect();
      }
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") wake();
    });
  }

  private async probe(timeoutMs: number): Promise<void> {
    if (this.probing || this.currentState !== "connected") return;
    const socket = this.ws;
    this.probing = true;
    try {
      await this.call("mobile.host.status", undefined, { timeoutMs });
    } catch (err) {
      const timedOut = err instanceof Error && err.message.startsWith("RPC timeout");
      if (timedOut && this.ws === socket && this.currentState === "connected") {
        this.reconnect();
      }
    } finally {
      this.probing = false;
    }
  }

  public getPendingPairing(): PairingOffer | null {
    return this.pendingPairing;
  }

  public onPairingChange(listener: () => void): () => void {
    this.pairingListeners.add(listener);
    return () => this.pairingListeners.delete(listener);
  }

  private notifyPairing(): void {
    for (const l of this.pairingListeners) l();
  }

  /** Queues an offer (pasted link, scanned QR) for confirmation. */
  public proposePairing(offer: PairingOffer): boolean {
    if (!isValidGatewayEndpoint(offer.endpoint)) return false;
    this.pendingPairing = offer;
    this.notifyPairing();
    return true;
  }

  /** Applies the confirmed offer: switch endpoint, redeem its ticket or use its token, reconnect. */
  public acceptPendingPairing(): void {
    const offer = this.pendingPairing;
    if (!offer) return;
    this.pendingPairing = null;
    this.hostGeneration += 1;
    this.hostNameHint = offer.host_name ?? null;
    const here = typeof window !== "undefined" ? sameOriginEndpoint(window.location) : null;
    this.endpoint = offer.endpoint === here ? null : offer.endpoint;
    persistEndpoint(this.endpoint);
    this.pendingTicket =
      offer.ticket && !offer.token ? { ticket: offer.ticket, endpoint: offer.endpoint } : null;
    // Never present the previous host's credential to the new host.
    this.token = "";
    clearStoredToken();
    stripPairingCodeFromAddressBar();
    this.notifyPairing();
    if (offer.token) this.setToken(offer.token);
    else this.reconnect();
  }

  public rejectPendingPairing(): void {
    if (!this.pendingPairing) return;
    this.pendingPairing = null;
    stripPairingCodeFromAddressBar();
    this.notifyPairing();
    this.reconnect();
  }

  /** Switches to an already saved host. */
  public switchHost(host: SavedHost): void {
    this.hostGeneration += 1;
    const here = typeof window !== "undefined" ? sameOriginEndpoint(window.location) : null;
    this.endpoint = host.endpoint === here ? null : host.endpoint;
    persistEndpoint(this.endpoint);
    this.pendingTicket = null;
    this.hostNameHint = host.name;
    try {
      setActiveHostId(localStorage, host.id);
    } catch {
      // ignore
    }
    this.setToken(host.token);
  }

  /** Remembers the host that just authenticated so it shows up in the host list. */
  private recordCurrentHost(): void {
    if (typeof window === "undefined" || !this.token) return;
    try {
      const endpoint = this.getEndpoint();
      upsertHost(localStorage, {
        endpoint,
        token: this.token,
        name: this.hostNameHint ?? undefined,
      });
      if (!getActiveHostId(localStorage) || getActiveHostId(localStorage) !== endpoint) {
        setActiveHostId(localStorage, endpoint);
      }
    } catch {
      // ignore storage errors
    }
  }

  public connect(): void {
    if (this.pendingPairing) {
      // Waiting for the user to confirm pairing with another host.
      this.setState("disconnected");
      return;
    }
    if (this.pendingTicket) {
      if (this.redeeming) return;
      this.redeeming = true;
      this.setState("connecting");
      void this.redeemPendingTicket().then((ok) => {
        this.redeeming = false;
        if (ok) {
          this.connect();
        } else {
          this.pendingTicket = null; // spent or invalid: fall back to manual token entry
          stripPairingCodeFromAddressBar();
          this.setState("error");
        }
      });
      return;
    }

    if (!this.token) {
      this.setState("error");
      return;
    }

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.shouldReconnect = true;
    this.setState("connecting");

    const wsUrl = this.getEndpoint();

    try {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.setState("authenticating");
        // Mandatory First Frame Authentication Handshake (ref: auth.rs / server.rs)
        const authPayload = JSON.stringify({ type: "auth", token: this.token });
        this.ws?.send(authPayload);
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        try {
          const raw = JSON.parse(event.data);
          // Handle auth response frame
          if (raw.type === "auth_ok") {
            this.reconnectAttempts = 0;
            this.recordCurrentHost();
            this.setState("connected");
            return;
          }
          if (raw.type === "auth_error") {
            this.shouldReconnect = false;
            this.setState("error");
            return;
          }

          // Handle standard JSON-RPC 2.0 Response
          const resp = raw as JsonRpcResponse;
          if (resp.id !== undefined && this.pendingRequests.has(resp.id)) {
            const pending = this.pendingRequests.get(resp.id)!;
            this.pendingRequests.delete(resp.id);
            if (resp.error) {
              pending.reject(new Error(resp.error.message));
            } else {
              pending.resolve(resp.result);
            }
            return;
          }

          // Handle push event
          if (resp.event) {
            for (const listener of this.eventListeners) {
              listener(resp.event, resp.data);
            }
          }
        } catch (err) {
          console.error("Failed to parse incoming WebSocket frame:", err);
        }
      };

      socket.onclose = (ev) => {
        // A superseded socket (token change, manual reconnect) must not touch current state.
        if (this.ws !== socket) return;
        this.cleanupPendingRequests();
        this.setState("disconnected");
        // Do not auto-reconnect if closed due to authentication failure (close code 1008)
        if (ev.code === 1008) {
          this.shouldReconnect = false;
          this.setState("error");
          return;
        }
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };

      socket.onerror = () => {
        if (this.ws !== socket) return;
        this.setState("error");
      };
    } catch (err) {
      console.error("WebSocket connection failure:", err);
      this.setState("error");
      this.scheduleReconnect();
    }
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const old = this.ws;
      this.ws = null; // handlers compare against this.ws, so the old socket goes quiet
      old.close();
    }
    this.cleanupPendingRequests();
    this.setState("disconnected");
  }

  public reconnect(): void {
    this.disconnect();
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // Exponential backoff 1s, 2s, 4s ... capped at 30s, with up to 25% jitter, so a down gateway is
    // not hammered by every open tab / phone at a fixed 2s cadence.
    const base = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    const delay = Math.round(base * (1 + Math.random() * 0.25));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  private cleanupPendingRequests(): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();
  }

  public async call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.currentState !== "connected") {
      throw new Error(`Gateway unavailable (code ${CODE_BACKEND_UNAVAILABLE})`);
    }

    const req: JsonRpcRequest = createRpcRequest(method, params);
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(req.id, {
        resolve: resolve as (val: unknown) => void,
        reject,
      });
      this.ws?.send(JSON.stringify(req));

      // Default 10s request timeout; callers whose gateway work is slow (chat.send waits for the agent to
      // ingest a paste) pass a longer one so a delivered message is not reported as failed.
      setTimeout(() => {
        if (this.pendingRequests.has(req.id)) {
          this.pendingRequests.delete(req.id);
          reject(new Error(`RPC timeout for method: ${method}`));
        }
      }, options?.timeoutMs ?? 10000);
    });
  }
}

export const wsClient = new GatewayWsClient();
