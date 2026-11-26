import { isDemoMode } from "../demo/demoData";
import { handleDemoRpc } from "../demo/demoMode";
import { setActiveHostId, type SavedHost } from "../hosts/hostStore";
import {
  isStaticHostOrigin,
  isValidGatewayEndpoint,
  sameOriginEndpoint,
  sanitizePairingInAddressBar,
  stripPairingCodeFromAddressBar,
  type PairingOffer,
} from "../protocol/pairing";
import {
  RPC_EVENTS,
  type AuthBootstrapRequest,
  type JsonRpcResponse,
  type WorkspaceBootstrapPayload,
} from "../protocol/rpc";
import {
  exchangePairingTicket,
  recordAuthenticatedHost,
  resolveInitialPairingState,
} from "./pairingClient";
import {
  clearStoredToken,
  getStoredEndpoint,
  persistEndpoint,
  persistStoredToken,
} from "./tokenVault";
import {
  RpcRequestTracker,
  computeReconnectDelayMs,
  installPageWakeListeners,
  syncHeartbeatTimer,
} from "./wsLifecycle";

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
  private rpcTracker = new RpcRequestTracker();
  private eventListeners = new Set<EventHandler>();
  private stateChangeListeners = new Set<(state: ConnectionState) => void>();
  private pairingListeners = new Set<() => void>();
  private currentState: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lifecycleCleanup: (() => void) | null = null;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private redeeming = false;
  private probing = false;
  private hostGeneration = 0;
  private endpoint: string | null;
  private pendingTicket: { ticket: string; endpoint: string } | null;
  private pendingPairing: PairingOffer | null;
  private hostNameHint: string | null;
  private fallbackTokens: string[];
  private lastErrorMessage: string | null = null;
  private bootstrapProvider: (() => AuthBootstrapRequest | null) | null = null;
  private serverCapabilities = new Set<string>();
  private awaitingBootstrapTree = false;
  private bufferedBootstrapPayload: WorkspaceBootstrapPayload | null = null;
  private bootstrappedSurfaceId: string | null = null;
  private bufferedBootstrapChatFrame: unknown = null;

  constructor() {
    const init = resolveInitialPairingState();
    this.token = init.token;
    this.fallbackTokens = init.fallbackTokens;
    this.endpoint = init.endpoint;
    this.pendingPairing = init.pendingPairing;
    this.pendingTicket = init.pendingTicket;
    this.hostNameHint = init.hostNameHint;
  }

  public getEndpoint(): string {
    if (this.endpoint) return this.endpoint;
    if (typeof window !== "undefined" && !isStaticHostOrigin(window.location)) {
      return sameOriginEndpoint(window.location);
    }
    return "";
  }

  public getLastErrorMessage(): string | null {
    return this.lastErrorMessage;
  }
  public clearLastErrorMessage(): void {
    this.lastErrorMessage = null;
  }
  public getToken(): string {
    return this.token;
  }
  public getState(): ConnectionState {
    return isDemoMode() ? "connected" : this.currentState;
  }
  public getPendingPairing(): PairingOffer | null {
    return this.pendingPairing;
  }

  public setToken(token: string): void {
    const trimmed = token.trim();
    this.token = trimmed;
    this.fallbackTokens = [];
    if (trimmed) persistStoredToken(trimmed);
    else clearStoredToken();
    this.shouldReconnect = true;
    this.reconnect();
  }

  public dispatchDemoEvent(event: string, data: unknown): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event, data);
      } catch (err) {
        console.error("Demo event dispatch error:", err);
      }
    }
  }

  public onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateChangeListeners.add(listener);
    listener(this.getState());
    return () => this.stateChangeListeners.delete(listener);
  }

  public onEvent(listener: EventHandler): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public onPairingChange(listener: () => void): () => void {
    this.pairingListeners.add(listener);
    return () => this.pairingListeners.delete(listener);
  }

  public setBootstrapProvider(provider: (() => AuthBootstrapRequest | null) | null): void {
    this.bootstrapProvider = provider;
  }

  public isAwaitingBootstrapTree(): boolean {
    return this.awaitingBootstrapTree && this.serverCapabilities.has("bootstrap.v1");
  }

  public consumeBufferedBootstrapPayload(): WorkspaceBootstrapPayload | null {
    const payload = this.bufferedBootstrapPayload;
    this.bufferedBootstrapPayload = null;
    return payload;
  }

  public consumeBootstrappedChatSubscription(
    surfaceId?: string,
    surfaceRef?: string,
  ): { subscribed: boolean; initialFrame: unknown } {
    const target = this.bootstrappedSurfaceId;
    if (!target) {
      return { subscribed: false, initialFrame: null };
    }
    if ((surfaceId && surfaceId === target) || (surfaceRef && surfaceRef === target)) {
      this.bootstrappedSurfaceId = null;
      const frame = this.bufferedBootstrapChatFrame;
      this.bufferedBootstrapChatFrame = null;
      return { subscribed: true, initialFrame: frame };
    }
    return { subscribed: false, initialFrame: null };
  }

  private resetBootstrapState(): void {
    this.serverCapabilities.clear();
    this.awaitingBootstrapTree = false;
    this.bufferedBootstrapPayload = null;
    this.bootstrappedSurfaceId = null;
    this.bufferedBootstrapChatFrame = null;
  }

  private setState(state: ConnectionState): void {
    this.currentState = state;
    this.heartbeatTimer = syncHeartbeatTimer(this.heartbeatTimer, state === "connected", () => {
      void this.probe(8000);
    });
    const reported = this.getState();
    for (const listener of this.stateChangeListeners) listener(reported);
  }

  private hookPageLifecycle(): void {
    if (this.lifecycleCleanup) return;
    this.lifecycleCleanup = installPageWakeListeners(() => {
      if (!this.shouldReconnect) return;
      if (this.currentState === "connected") {
        void this.probe(4000);
      } else if (this.currentState === "disconnected" || this.currentState === "error") {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.connect();
      }
    });
  }

  private async probe(timeoutMs: number): Promise<void> {
    if (isDemoMode() || this.probing || this.currentState !== "connected") return;
    const socket = this.ws;
    this.probing = true;
    try {
      await this.call("mobile.host.status", undefined, { timeoutMs });
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("RPC timeout") &&
        this.ws === socket &&
        this.currentState === "connected"
      ) {
        this.reconnect();
      }
    } finally {
      this.probing = false;
    }
  }

  private async redeemPendingTicket(): Promise<"ok" | "rejected" | "retryable"> {
    const pending = this.pendingTicket;
    if (!pending) return "ok";
    const generation = this.hostGeneration;
    const outcome = await exchangePairingTicket(pending.endpoint, pending.ticket);
    if (generation !== this.hostGeneration) return "ok";
    if (outcome.status !== "ok") {
      this.lastErrorMessage = outcome.errorMessage;
      return outcome.status;
    }
    this.token = outcome.token;
    this.lastErrorMessage = null;
    persistStoredToken(outcome.token);
    this.pendingTicket = null;
    stripPairingCodeFromAddressBar();
    if (
      !getStoredEndpoint() &&
      typeof window !== "undefined" &&
      !isStaticHostOrigin(window.location)
    ) {
      sanitizePairingInAddressBar(outcome.token);
    }
    return "ok";
  }

  private notifyPairing(): void {
    for (const l of this.pairingListeners) l();
  }

  private saveActiveHost(id: string): void {
    try {
      setActiveHostId(localStorage, id);
    } catch {
      // ignore
    }
  }

  public proposePairing(offer: PairingOffer): boolean {
    if (!isValidGatewayEndpoint(offer.endpoint)) return false;
    this.pendingPairing = offer;
    this.notifyPairing();
    return true;
  }

  public acceptPendingPairing(): void {
    const offer = this.pendingPairing;
    if (!offer) return;
    this.pendingPairing = null;
    this.hostGeneration += 1;
    this.hostNameHint = offer.host_name ?? null;
    const here = typeof window !== "undefined" ? sameOriginEndpoint(window.location) : null;
    this.endpoint = offer.endpoint === here ? null : offer.endpoint;
    persistEndpoint(this.endpoint);
    this.saveActiveHost(offer.endpoint);
    this.pendingTicket =
      offer.ticket && !offer.token ? { ticket: offer.ticket, endpoint: offer.endpoint } : null;
    this.token = "";
    this.fallbackTokens = [];
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

  public switchHost(host: SavedHost): void {
    this.hostNameHint = host.name;
    this.saveActiveHost(host.id);
    if (isDemoMode()) {
      this.setState("connected");
      return;
    }
    this.hostGeneration += 1;
    const here = typeof window !== "undefined" ? sameOriginEndpoint(window.location) : null;
    this.endpoint = host.endpoint === here ? null : host.endpoint;
    persistEndpoint(this.endpoint);
    this.pendingTicket = null;
    this.setToken(host.token);
  }

  public forgetHost(): void {
    this.hostGeneration += 1;
    this.disconnect();
    this.endpoint = null;
    persistEndpoint(null);
    this.pendingTicket = null;
    this.hostNameHint = null;
    this.token = "";
    this.fallbackTokens = [];
    clearStoredToken();
  }

  public connect(): void {
    if (isDemoMode()) return this.setState("connected");
    this.hookPageLifecycle();
    if (this.pendingPairing) return this.setState("disconnected");

    if (this.pendingTicket) {
      if (this.redeeming) return;
      this.shouldReconnect = true;
      this.redeeming = true;
      this.setState("connecting");
      void this.redeemPendingTicket().then((result) => {
        this.redeeming = false;
        if (result === "ok") return this.connect();
        if (result === "rejected") {
          this.pendingTicket = null;
          this.shouldReconnect = false;
          stripPairingCodeFromAddressBar();
        }
        this.setState("error");
        if (result === "retryable" && this.shouldReconnect) this.scheduleReconnect();
      });
      return;
    }

    if (!this.token) {
      if (typeof window !== "undefined" && isStaticHostOrigin(window.location)) {
        return this.setState("disconnected");
      }
      this.shouldReconnect = false;
      return this.setState("error");
    }

    const wsUrl = this.getEndpoint();
    if (!wsUrl) return this.setState("disconnected");
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.shouldReconnect = true;
    this.resetBootstrapState();
    this.setState("connecting");
    try {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;
      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.setState("authenticating");
        const bootstrap = this.bootstrapProvider?.() ?? null;
        this.awaitingBootstrapTree = Boolean(bootstrap?.workspace_tree);
        const authFrame = bootstrap
          ? { type: "auth", token: this.token, bootstrap }
          : { type: "auth", token: this.token };
        this.ws?.send(JSON.stringify(authFrame));
      };
      socket.onmessage = (event) => this.handleMessage(socket, event.data);
      socket.onclose = (ev) => {
        if (this.ws !== socket) return;
        this.ws = null;
        this.resetBootstrapState();
        this.rpcTracker.rejectAll();
        if (ev.code === 1008) {
          if (this.useNextToken()) return;
          this.shouldReconnect = false;
          return this.setState("error");
        }
        this.setState("disconnected");
        if (this.shouldReconnect) this.scheduleReconnect();
      };
      socket.onerror = () => {
        if (this.ws === socket) this.setState("error");
      };
    } catch (err) {
      console.error("WebSocket connection failure:", err);
      this.setState("error");
      if (this.shouldReconnect) this.scheduleReconnect();
    }
  }

  private handleMessage(socket: WebSocket, rawText: string): void {
    if (this.ws !== socket) return;
    try {
      const raw = JSON.parse(rawText);
      if (raw.type === "auth_ok") {
        this.lastErrorMessage = null;
        this.reconnectAttempts = 0;
        this.fallbackTokens = [];
        this.serverCapabilities = new Set(
          Array.isArray(raw.capabilities) ? (raw.capabilities as string[]) : [],
        );
        if (!this.serverCapabilities.has("bootstrap.v1")) {
          this.awaitingBootstrapTree = false;
        }
        persistStoredToken(this.token);
        recordAuthenticatedHost(this.getEndpoint(), this.token, this.hostNameHint);
        return this.setState("connected");
      }
      if (raw.type === "auth_error") {
        this.lastErrorMessage = "Authentication failed: invalid token.";
        if (this.useNextToken()) return;
        this.shouldReconnect = false;
        return this.setState("error");
      }
      const resp = raw as JsonRpcResponse;
      if (this.rpcTracker.settleResponse(resp)) return;
      if (resp.event) {
        if (resp.event === RPC_EVENTS.WORKSPACE_BOOTSTRAP && resp.data) {
          const payload = resp.data as WorkspaceBootstrapPayload;
          this.awaitingBootstrapTree = false;
          this.bootstrappedSurfaceId = payload.subscribed_surface_id ?? null;
          this.bufferedBootstrapChatFrame = null;
          this.bufferedBootstrapPayload = payload;
        } else if (
          resp.event === RPC_EVENTS.CHAT_UPDATE &&
          this.bootstrappedSurfaceId &&
          resp.data &&
          typeof resp.data === "object" &&
          (resp.data as { surface_id?: string }).surface_id === this.bootstrappedSurfaceId
        ) {
          this.bufferedBootstrapChatFrame = resp.data;
        }
        for (const listener of this.eventListeners) listener(resp.event, resp.data);
      }
    } catch (err) {
      console.error("Failed to parse incoming WebSocket frame:", err);
    }
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.lifecycleCleanup?.();
    this.lifecycleCleanup = null;
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.close();
    }
    this.rpcTracker.rejectAll();
    this.resetBootstrapState();
    this.setState("disconnected");
  }

  public reconnect(): void {
    if (isDemoMode()) return this.setState("connected");
    this.disconnect();
    this.shouldReconnect = true;
    this.connect();
  }

  private useNextToken(): boolean {
    const next = this.fallbackTokens.shift();
    if (!next) return false;
    this.token = next;
    this.reconnect();
    return true;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = computeReconnectDelayMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.connect();
    }, delay);
  }

  public async call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (isDemoMode()) {
      return handleDemoRpc<T>(method, params, (event, data) => this.dispatchDemoEvent(event, data));
    }
    return this.rpcTracker.send<T>(
      this.ws,
      this.currentState === "connected",
      method,
      params,
      options?.timeoutMs,
    );
  }
}

export const wsClient = new GatewayWsClient();
