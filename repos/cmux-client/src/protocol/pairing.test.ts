import { describe, expect, it } from "vite-plus/test";
import {
  decodePairingPayload,
  endpointToHttpBase,
  isValidGatewayEndpoint,
  sameOriginEndpoint,
  parsePairingInput,
  readPairingFromLocation,
  sanitizePairingInAddressBar,
  PAIRING_OFFER_VERSION,
  type PairingOffer,
} from "./pairing";

describe("Pairing Protocol", () => {
  const sampleOffer: PairingOffer = {
    v: PAIRING_OFFER_VERSION,
    endpoint: "ws://100.64.0.1:8088/ws",
    token: "cmux_sec_token_9876543210",
    host_name: "macbook-air",
  };

  const sampleJson = JSON.stringify(sampleOffer);
  const sampleBase64Url = btoa(sampleJson)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  it("decodes valid base64url pairing payload", () => {
    const decoded = decodePairingPayload(sampleBase64Url);
    expect(decoded).toEqual(sampleOffer);
  });

  it("parses deep-link URI", () => {
    const uri = `cmux-mobile://pair?code=${sampleBase64Url}`;
    const parsed = parsePairingInput(uri);
    expect(parsed).toEqual(sampleOffer);
  });

  it("parses location search query param", () => {
    const location = {
      search: `?code=${sampleBase64Url}`,
      hash: "",
      origin: "http://100.64.0.1:8088",
      protocol: "http:",
    };
    const parsed = readPairingFromLocation(location);
    expect(parsed).toEqual(sampleOffer);
  });

  it("parses location direct token param", () => {
    const location = {
      search: "?token=direct_token_123",
      hash: "",
      origin: "http://100.64.0.1:8088",
      protocol: "http:",
    };
    const parsed = readPairingFromLocation(location);
    expect(parsed).toEqual({
      v: PAIRING_OFFER_VERSION,
      endpoint: "ws://100.64.0.1:8088/ws",
      token: "direct_token_123",
    });
  });

  it("parses location hash fragment", () => {
    const location = {
      search: "",
      hash: `#token=hash_token_abc`,
      origin: "https://my-tailnet.ts.net",
      protocol: "https:",
    };
    const parsed = readPairingFromLocation(location);
    expect(parsed).toEqual({
      v: PAIRING_OFFER_VERSION,
      endpoint: "wss://my-tailnet.ts.net/ws",
      token: "hash_token_abc",
    });
  });

  it("rejects invalid input gracefully", () => {
    expect(decodePairingPayload("not-base64-json")).toBeNull();
    expect(parsePairingInput("")).toBeNull();
  });

  it("sanitizes address bar by moving query token to hash fragment", () => {
    const replaceStateCalls: string[] = [];

    const mockWindow = {
      location: {
        origin: "https://machine.tailnet.ts.net",
        pathname: "/",
        search: "?token=mobile_sec_123",
        hash: "",
      },
      history: {
        replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
          if (typeof url === "string") replaceStateCalls.push(url);
        },
      },
    };

    const prevWindow = (globalThis as unknown as { window?: unknown }).window;
    (globalThis as unknown as { window: unknown }).window = mockWindow;

    try {
      sanitizePairingInAddressBar();

      expect(replaceStateCalls.length).toBeGreaterThan(0);
      expect(replaceStateCalls[replaceStateCalls.length - 1]).toBe(
        "https://machine.tailnet.ts.net/#token=mobile_sec_123",
      );
    } finally {
      if (prevWindow === undefined) {
        delete (globalThis as unknown as { window?: unknown }).window;
      } else {
        (globalThis as unknown as { window: unknown }).window = prevWindow;
      }
    }
  });

  it("accepts a ticket-only offer and rejects an offer with neither token nor ticket", () => {
    const enc = (o: object) =>
      btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const ticketOffer = decodePairingPayload(
      enc({ v: 1, endpoint: "wss://mac.tail.ts.net/ws", token: "", ticket: "tkt_1" }),
    );
    expect(ticketOffer).toEqual({
      v: 1,
      endpoint: "wss://mac.tail.ts.net/ws",
      token: "",
      ticket: "tkt_1",
    });
    expect(decodePairingPayload(enc({ v: 1, endpoint: "ws://h/ws", token: "" }))).toBeNull();
  });

  it("validates gateway endpoints and derives HTTP base", () => {
    expect(isValidGatewayEndpoint("wss://mac.tail.ts.net/ws")).toBe(true);
    expect(isValidGatewayEndpoint("ws://127.0.0.1:8088/ws")).toBe(true);
    expect(isValidGatewayEndpoint("https://evil.example/ws")).toBe(false);
    expect(isValidGatewayEndpoint("javascript:alert(1)")).toBe(false);
    expect(isValidGatewayEndpoint("not a url")).toBe(false);
    expect(endpointToHttpBase("wss://mac.tail.ts.net/ws")).toBe("https://mac.tail.ts.net");
    expect(endpointToHttpBase("ws://127.0.0.1:8088/ws")).toBe("http://127.0.0.1:8088");
    expect(sameOriginEndpoint({ protocol: "https:", host: "a.b:443" })).toBe("wss://a.b:443/ws");
    expect(sameOriginEndpoint({ protocol: "http:", host: "127.0.0.1:8088" })).toBe(
      "ws://127.0.0.1:8088/ws",
    );
  });

  it("accepts the companion web URL that `cmux-mobile qr` encodes", () => {
    const offer = parsePairingInput("https://mac.tail.ts.net/#token=abc123");
    expect(offer).toEqual({ v: 1, endpoint: "wss://mac.tail.ts.net/ws", token: "abc123" });
    expect(parsePairingInput("https://mac.tail.ts.net/")).toBeNull();
    expect(parsePairingInput("https://mac.tail.ts.net/?token=t")?.token).toBe("t");
  });

  it("accepts the single-use ticket link that `cmux-mobile qr` now prints", () => {
    const offer = { v: 1, endpoint: "wss://mac.tail.ts.net/ws", token: "", ticket: "tk123" };
    const code = btoa(JSON.stringify(offer))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(parsePairingInput(`https://mac.tail.ts.net/#code=${code}`)).toEqual(offer);
  });
});
