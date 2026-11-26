import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  hasAgentOptions,
  resolveDisplayedEfforts,
  resolveSelectedModel,
  type AgentOptionsInfo,
} from "../components/chat/agentOptions";
import { shouldSubmitComposerKey } from "../components/chat/composerKey";
import { isSupportedImageFile } from "../components/chat/imageAttach";
import { setDemoMode } from "../demo/demoMode";
import { upsertHost } from "../hosts/hostStore";
import {
  PAIRING_OFFER_VERSION,
  sanitizePairingInAddressBar,
  stripPairingCodeFromAddressBar,
} from "../protocol/pairing";
import { GatewayWsClient } from "./wsClient";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}

function makeMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe("GatewayWsClient resilience, #token= precedence & pairing history state", () => {
  const origWindow = (globalThis as Record<string, unknown>).window;
  const origDocument = (globalThis as Record<string, unknown>).document;
  const origLocalStorage = (globalThis as Record<string, unknown>).localStorage;
  const origSessionStorage = (globalThis as Record<string, unknown>).sessionStorage;
  const origWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  const origFetch = globalThis.fetch;

  let windowListeners: Map<string, Set<EventListener>>;
  let docListeners: Map<string, Set<EventListener>>;
  let localStore: ReturnType<typeof makeMemoryStorage>;
  let sessionStore: ReturnType<typeof makeMemoryStorage>;

  beforeEach(() => {
    MockWebSocket.instances = [];
    windowListeners = new Map();
    docListeners = new Map();
    localStore = makeMemoryStorage();
    sessionStore = makeMemoryStorage();
    setDemoMode(false);

    (globalThis as Record<string, unknown>).localStorage = localStore;
    (globalThis as Record<string, unknown>).sessionStorage = sessionStore;
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;

    let currentHistoryState: unknown = { cmuxView: "detail" };
    const locationObj = {
      href: "https://mac.tailnet.ts.net/",
      origin: "https://mac.tailnet.ts.net",
      protocol: "https:",
      host: "mac.tailnet.ts.net",
      hostname: "mac.tailnet.ts.net",
      port: "",
      pathname: "/",
      search: "",
      hash: "",
    };

    (globalThis as Record<string, unknown>).window = {
      location: locationObj,
      history: {
        get state() {
          return currentHistoryState;
        },
        replaceState(state: unknown, _title: string, url?: string | URL | null) {
          currentHistoryState = state;
          if (url) {
            const parsed = new URL(String(url), locationObj.origin);
            locationObj.href = parsed.href;
            locationObj.search = parsed.search;
            locationObj.hash = parsed.hash;
          }
        },
      },
      addEventListener(type: string, cb: EventListener) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type)!.add(cb);
      },
      removeEventListener(type: string, cb: EventListener) {
        windowListeners.get(type)?.delete(cb);
      },
    };

    (globalThis as Record<string, unknown>).document = {
      title: "Cmob",
      cookie: "",
      visibilityState: "visible",
      addEventListener(type: string, cb: EventListener) {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type)!.add(cb);
      },
      removeEventListener(type: string, cb: EventListener) {
        docListeners.get(type)?.delete(cb);
      },
    };
  });

  afterEach(() => {
    setDemoMode(false);
    vi.useRealTimers();
    globalThis.fetch = origFetch;
    if (origWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = origWindow;
    if (origDocument === undefined) delete (globalThis as Record<string, unknown>).document;
    else (globalThis as Record<string, unknown>).document = origDocument;
    if (origLocalStorage === undefined) delete (globalThis as Record<string, unknown>).localStorage;
    else (globalThis as Record<string, unknown>).localStorage = origLocalStorage;
    if (origSessionStorage === undefined)
      delete (globalThis as Record<string, unknown>).sessionStorage;
    else (globalThis as Record<string, unknown>).sessionStorage = origSessionStorage;
    if (origWebSocket === undefined) delete (globalThis as Record<string, unknown>).WebSocket;
    else (globalThis as Record<string, unknown>).WebSocket = origWebSocket;
  });

  it("prioritizes a fresh same-origin #token= URL offer over a stale saved cmux_hosts token", () => {
    upsertHost(localStore, {
      endpoint: "wss://mac.tailnet.ts.net/ws",
      token: "STALE_HOST_TOKEN",
      name: "MacBook",
    });
    window.location.hash = "#token=FRESH_URL_TOKEN";
    window.location.href = "https://mac.tailnet.ts.net/#token=FRESH_URL_TOKEN";

    const client = new GatewayWsClient();
    expect(client.getEndpoint()).toBe("wss://mac.tailnet.ts.net/ws");
    expect(client.getToken()).toBe("FRESH_URL_TOKEN");

    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    const sock = MockWebSocket.instances[0];
    sock.readyState = MockWebSocket.OPEN;
    sock.onopen?.();
    expect(JSON.parse(sock.sent[0])).toEqual({ type: "auth", token: "FRESH_URL_TOKEN" });
    client.disconnect();
  });

  it("reconnects on online / visibilitychange wake even when currentState is error", () => {
    localStore.setItem("cmux_token", "tok_live");
    const client = new GatewayWsClient();
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    // Simulate socket error leaving client in "error" state before close/wake
    const first = MockWebSocket.instances[0];
    first.readyState = MockWebSocket.CLOSED;
    first.onerror?.();
    expect(client.getState()).toBe("error");

    for (const cb of windowListeners.get("online") ?? []) {
      cb(new Event("online"));
    }
    expect(MockWebSocket.instances).toHaveLength(2);
    client.disconnect();
  });

  it("schedules auto-reconnect on retryable ticket exchange failure", async () => {
    vi.useFakeTimers();
    const ticketOffer = {
      v: PAIRING_OFFER_VERSION,
      endpoint: "wss://mac.tailnet.ts.net/ws",
      token: "",
      ticket: "tkt_retry",
    };
    const code = btoa(JSON.stringify(ticketOffer))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    window.location.hash = `#code=${code}`;
    window.location.href = `https://mac.tailnet.ts.net/#code=${code}`;

    let fetchCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response("Bad Gateway", { status: 502 });
      }
      return new Response(JSON.stringify({ token: "device_tok_ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new GatewayWsClient();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getState()).toBe("error");
    expect(fetchCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchCalls).toBe(2);
    expect(client.getToken()).toBe("device_tok_ok");
    client.disconnect();
  });

  it("preserves window.history.state when sanitizing or stripping pairing params", () => {
    window.location.search = "?token=sec_123";
    window.location.href = "https://mac.tailnet.ts.net/?token=sec_123";
    sanitizePairingInAddressBar();
    expect(window.history.state).toEqual({ cmuxView: "detail" });

    window.location.hash = "#code=spent";
    window.location.href = "https://mac.tailnet.ts.net/#code=spent";
    stripPairingCodeFromAddressBar();
    expect(window.history.state).toEqual({ cmuxView: "detail" });
  });

  it("emits connected immediately on onStateChange in demo mode without disconnected flicker", () => {
    const client = new GatewayWsClient();
    setDemoMode(true);
    const seen: string[] = [];
    const unsub = client.onStateChange((s) => seen.push(s));
    expect(seen).toEqual(["connected"]);
    unsub();
  });

  it("guards WebKit post-compositionend Enter, .heic extensions, and agy/claude-code options", () => {
    expect(
      shouldSubmitComposerKey({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        isDesktop: true,
        hasSlashMenu: false,
        lastCompositionEndAt: 100,
        now: 115,
      }),
    ).toBe(false);
    expect(
      shouldSubmitComposerKey({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        isDesktop: true,
        hasSlashMenu: false,
        lastCompositionEndAt: 100,
        now: 145,
      }),
    ).toBe(true);

    expect(isSupportedImageFile({ name: "IMG_0042.HEIC", type: "" })).toBe(true);
    expect(isSupportedImageFile({ name: "notes.txt", type: "text/plain" })).toBe(false);

    expect(hasAgentOptions("agy")).toBe(true);
    expect(hasAgentOptions("claude-code")).toBe(true);

    const info: AgentOptionsInfo = {
      agent_kind: "claude",
      default_model: "sonnet",
      mid_session: "command",
      models: [
        { id: "opus", label: "Opus", efforts: [{ value: "high", label: "High" }], fast: true },
        { id: "sonnet", label: "Sonnet", efforts: [], fast: false },
      ],
    };
    expect(resolveSelectedModel(info, null, undefined)).toBe("sonnet");
    expect(resolveDisplayedEfforts(info, null)).toEqual([{ value: "high", label: "High" }]);
  });
});
