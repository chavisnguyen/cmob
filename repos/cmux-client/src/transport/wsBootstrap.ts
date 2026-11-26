import {
  RPC_EVENTS,
  type AuthBootstrapRequest,
  type WorkspaceBootstrapPayload,
} from "../protocol/rpc";

/**
 * Tracks 1-RTT `bootstrap.v1` state across WebSocket authentication and initial push frames
 * (`mobile.workspace.bootstrap` + initial `mobile.chat.update`), keeping `GatewayWsClient`
 * focused on socket lifecycle and JSON-RPC request/response framing.
 */
export class BootstrapStateTracker {
  private provider: (() => AuthBootstrapRequest | null) | null = null;
  private serverCapabilities = new Set<string>();
  private awaitingTree = false;
  private bufferedPayload: WorkspaceBootstrapPayload | null = null;
  private bootstrappedSurfaceId: string | null = null;
  private bufferedChatFrame: unknown = null;

  public setProvider(provider: (() => AuthBootstrapRequest | null) | null): void {
    this.provider = provider;
  }

  public buildAuthFrame(token: string): Record<string, unknown> {
    const bootstrap = this.provider?.() ?? null;
    this.awaitingTree = Boolean(bootstrap?.workspace_tree);
    return bootstrap ? { type: "auth", token, bootstrap } : { type: "auth", token };
  }

  public onAuthOk(rawCapabilities: unknown): void {
    this.serverCapabilities = new Set(
      Array.isArray(rawCapabilities) ? (rawCapabilities as string[]) : [],
    );
    if (!this.serverCapabilities.has("bootstrap.v1")) {
      this.awaitingTree = false;
    }
  }

  public onEvent(event: string, data: unknown): void {
    if (event === RPC_EVENTS.WORKSPACE_BOOTSTRAP && data) {
      const payload = data as WorkspaceBootstrapPayload;
      this.awaitingTree = false;
      this.bootstrappedSurfaceId = payload.subscribed_surface_id ?? null;
      this.bufferedChatFrame = null;
      this.bufferedPayload = payload;
      return;
    }
    if (
      event === RPC_EVENTS.CHAT_UPDATE &&
      this.bootstrappedSurfaceId &&
      data &&
      typeof data === "object" &&
      (data as { surface_id?: string }).surface_id === this.bootstrappedSurfaceId
    ) {
      this.bufferedChatFrame = data;
    }
  }

  public isAwaitingTree(): boolean {
    return this.awaitingTree && this.serverCapabilities.has("bootstrap.v1");
  }

  public consumeBufferedPayload(): WorkspaceBootstrapPayload | null {
    const payload = this.bufferedPayload;
    this.bufferedPayload = null;
    return payload;
  }

  public consumeChatSubscription(
    surfaceId?: string,
    surfaceRef?: string,
  ): { subscribed: boolean; initialFrame: unknown } {
    const target = this.bootstrappedSurfaceId;
    if (!target) {
      return { subscribed: false, initialFrame: null };
    }
    if ((surfaceId && surfaceId === target) || (surfaceRef && surfaceRef === target)) {
      this.bootstrappedSurfaceId = null;
      const frame = this.bufferedChatFrame;
      this.bufferedChatFrame = null;
      return { subscribed: true, initialFrame: frame };
    }
    return { subscribed: false, initialFrame: null };
  }

  public reset(): void {
    this.serverCapabilities.clear();
    this.awaitingTree = false;
    this.bufferedPayload = null;
    this.bootstrappedSurfaceId = null;
    this.bufferedChatFrame = null;
  }
}
