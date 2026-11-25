import { beforeEach, describe, expect, it } from "vite-plus/test";
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

describe("workspaceCache", () => {
  beforeEach(() => {
    clearWorkspaceCacheForTests();
  });

  it("stores workspaces per host endpoint and evicts oldest beyond cap", () => {
    for (let i = 0; i < 8; i += 1) {
      writeCachedWorkspaces(`wss://host-${i}`, [makeWorkspace(`w-${i}`)]);
    }

    expect(peekCachedWorkspaces("wss://host-0")).toEqual([]);
    expect(peekCachedWorkspaces("wss://host-7")[0]?.id).toBe("w-7");
  });
});
