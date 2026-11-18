import { describe, expect, it } from "vite-plus/test";
import {
  classifyHostType,
  emitHostsChange,
  getActiveHostId,
  hostNameFromEndpoint,
  loadHosts,
  removeHost,
  renameHost,
  sanitizeHostName,
  setActiveHostId,
  subscribeHosts,
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

  it("classifies host machine types based on name/endpoint keywords", () => {
    expect(classifyHostType("Linux VPS Cloud")).toBe("server");
    expect(classifyHostType("ubuntu-server-01")).toBe("server");
    expect(classifyHostType("Mac Studio M2")).toBe("desktop");
    expect(classifyHostType("Workstation Tower")).toBe("desktop");
    expect(classifyHostType("MacBook Pro M3")).toBe("laptop");
    expect(classifyHostType("My Laptop")).toBe("laptop");
  });

  it("notifies subscribers when hosts are upserted, renamed, or removed", () => {
    const s = memoryStorage();
    let callCount = 0;
    const unsub = subscribeHosts(() => {
      callCount += 1;
    });

    upsertHost(s, { endpoint: "ws://host1/ws", token: "tok1", name: "Host 1" });
    expect(callCount).toBe(1);

    renameHost(s, "ws://host1/ws", "New Name");
    expect(callCount).toBe(2);

    removeHost(s, "ws://host1/ws");
    expect(callCount).toBe(3);

    unsub();
    upsertHost(s, { endpoint: "ws://host2/ws", token: "tok2" });
    expect(callCount).toBe(3); // unsubscribed
  });

  it("sanitizes host names by stripping control characters and truncating", () => {
    expect(sanitizeHostName("  \tMacBook\r\nPro\x00  ")).toBe("MacBook  Pro");
    const longName = "A".repeat(60);
    expect(sanitizeHostName(longName)).toBe("A".repeat(40));
    expect(sanitizeHostName("Normal Host")).toBe("Normal Host");
  });

  it("isolates subscriber errors so other subscribers still receive updates", () => {
    const s = memoryStorage();
    let secondSubscriberCalled = false;

    const unsub1 = subscribeHosts(() => {
      throw new Error("Explosive subscriber");
    });
    const unsub2 = subscribeHosts(() => {
      secondSubscriberCalled = true;
    });

    emitHostsChange(s);
    expect(secondSubscriberCalled).toBe(true);

    unsub1();
    unsub2();
  });
});
