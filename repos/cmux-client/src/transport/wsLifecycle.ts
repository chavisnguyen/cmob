import {
  CODE_BACKEND_UNAVAILABLE,
  createRpcRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RequestId,
} from "../protocol/rpc";

/**
 * WebSocket lifecycle utilities: page wake listeners, heartbeat timer, jittered backoff,
 * and pending JSON-RPC correlation tracker.
 */

export function computeReconnectDelayMs(attempts: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempts);
  return Math.round(base * (1 + Math.random() * 0.25));
}

export function installPageWakeListeners(onWake: () => void): (() => void) | null {
  if (typeof window === "undefined") return null;
  const onVisibility = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      onWake();
    }
  };
  window.addEventListener("online", onWake);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  return () => {
    window.removeEventListener("online", onWake);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

export function syncHeartbeatTimer(
  current: ReturnType<typeof setInterval> | null,
  connected: boolean,
  onBeat: () => void,
): ReturnType<typeof setInterval> | null {
  if (connected && !current) {
    return setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        onBeat();
      }
    }, 20_000);
  }
  if (!connected && current) {
    clearInterval(current);
    return null;
  }
  return current;
}

interface PendingRpc {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcRequestTracker {
  private pending = new Map<RequestId, PendingRpc>();

  public send<T>(
    ws: WebSocket | null,
    isConnected: boolean,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!ws || ws.readyState !== WebSocket.OPEN || !isConnected) {
      return Promise.reject(new Error(`Gateway unavailable (code ${CODE_BACKEND_UNAVAILABLE})`));
    }
    const req: JsonRpcRequest = createRpcRequest(method, params);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(req.id)) {
          reject(new Error(`RPC timeout for method: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(req.id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });
      ws.send(JSON.stringify(req));
    });
  }

  public settleResponse(resp: JsonRpcResponse): boolean {
    if (resp.id === undefined || !this.pending.has(resp.id)) return false;
    const entry = this.pending.get(resp.id)!;
    this.pending.delete(resp.id);
    clearTimeout(entry.timer);
    if (resp.error) entry.reject(new Error(resp.error.message));
    else entry.resolve(resp.result);
    return true;
  }

  public rejectAll(reason = "Connection closed"): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
