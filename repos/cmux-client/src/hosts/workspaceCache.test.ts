import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceNode } from "../protocol/rpc";
import {
  clearWorkspaceCacheForTests,
  peekCachedWorkspaces,
  writeCachedWorkspaces,
} from "./workspaceCache";

function makeWorkspace(id: string): WorkspaceNode {
  return {
    id,
    ref: `workspace:${id}`,
    title: `ws-${id}`,
    pinned: false,
    selected: true,
    status: "idle",
    current_directory: "/tmp",
    surfaces: [],
  };
}

describe("workspaceCache (in-memory only)", () => {
  beforeEach(() => {
    clearWorkspaceCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores workspaces per host endpoint in RAM and evicts oldest beyond cap", () => {
    for (let i = 0; i < 8; i += 1) {
      writeCachedWorkspaces(`wss://host-${i}`, [makeWorkspace(`w-${i}`)]);
    }

    expect(peekCachedWorkspaces("wss://host-0")).toEqual([]);
    expect(peekCachedWorkspaces("wss://host-7")[0]?.id).toBe("w-7");
  });

  it("purges legacy cmux.workspaceTreeCache.v1 from localStorage and never writes back to disk", () => {
    const store = new Map<string, string>([
      ["cmux.workspaceTreeCache.v1", '{"v":1,"entries":[["local",[]]]}'],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });

    expect(peekCachedWorkspaces("wss://host-a")).toEqual([]);
    expect(store.has("cmux.workspaceTreeCache.v1")).toBe(false);

    writeCachedWorkspaces("wss://host-a", [makeWorkspace("w-1")]);
    expect(store.size).toBe(0);
    expect(peekCachedWorkspaces("wss://host-a")[0]?.id).toBe("w-1");
  });
});
