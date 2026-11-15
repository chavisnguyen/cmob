import { describe, expect, it } from "vite-plus/test";
import {
  getActiveHostId,
  hostNameFromEndpoint,
  loadHosts,
  removeHost,
  renameHost,
  setActiveHostId,
  upsertHost,
} from "./hostStore";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("hostStore", () => {
  it("adds hosts keyed by endpoint and names them after the host", () => {
    const s = memoryStorage();
    upsertHost(s, { endpoint: "wss://mac.tail1.ts.net/ws", token: "t1" });
    upsertHost(s, { endpoint: "ws://127.0.0.1:8088/ws", token: "t2", name: "Laptop" });
    const hosts = loadHosts(s);
    expect(hosts.map((h) => h.name)).toEqual(["mac.tail1.ts.net", "Laptop"]);
  });

  it("updates an existing host but never blanks its token", () => {
    const s = memoryStorage();
    upsertHost(s, { endpoint: "ws://a/ws", token: "secret" });
    upsertHost(s, { endpoint: "ws://a/ws", token: "", name: "Renamed" });
    const [h] = loadHosts(s);
    expect(h.token).toBe("secret");
    expect(h.name).toBe("Renamed");
    expect(loadHosts(s)).toHaveLength(1);
  });

  it("removes and renames", () => {
    const s = memoryStorage();
    upsertHost(s, { endpoint: "ws://a/ws", token: "1" });
    upsertHost(s, { endpoint: "ws://b/ws", token: "2" });
    renameHost(s, "ws://b/ws", "  Work  ");
    expect(loadHosts(s)[1].name).toBe("Work");
    removeHost(s, "ws://a/ws");
    expect(loadHosts(s).map((h) => h.id)).toEqual(["ws://b/ws"]);
  });

  it("ignores corrupt storage and malformed entries", () => {
    const s = memoryStorage();
    s.setItem("cmux_hosts", "{not json");
    expect(loadHosts(s)).toEqual([]);
    s.setItem(
      "cmux_hosts",
      JSON.stringify([{ id: 1 }, { id: "a", name: "n", endpoint: "e", token: "t" }]),
    );
    expect(loadHosts(s)).toHaveLength(1);
  });

  it("tracks the active host", () => {
    const s = memoryStorage();
    expect(getActiveHostId(s)).toBeNull();
    setActiveHostId(s, "ws://a/ws");
    expect(getActiveHostId(s)).toBe("ws://a/ws");
  });

  it("falls back to the raw string for an unparsable endpoint", () => {
    expect(hostNameFromEndpoint("not a url")).toBe("not a url");
  });
});
