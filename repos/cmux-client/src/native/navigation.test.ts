import { beforeEach, describe, expect, it } from "vite-plus/test";
import { showDetailEntry } from "./navigation";

// Minimal History stand-in: a stack of states with push/replace.
function installHistory(initial: unknown) {
  const stack: unknown[] = [initial];
  (globalThis as unknown as { window: unknown }).window = {
    history: {
      get state() {
        return stack[stack.length - 1];
      },
      pushState: (s: unknown) => void stack.push(s),
      replaceState: (s: unknown) => void (stack[stack.length - 1] = s),
    },
  };
  return stack;
}
const views = (stack: unknown[]) => stack.map((s) => (s as { cmuxView: string }).cmuxView);

describe("showDetailEntry", () => {
  beforeEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("does not stack a second detail entry when switching tabs", () => {
    const stack = installHistory({ cmuxView: "workspaces" });
    showDetailEntry(); // opened from nowhere: surfaces + detail
    showDetailEntry(); // switch tab
    showDetailEntry(); // switch tab again
    expect(views(stack)).toEqual(["workspaces", "surfaces", "detail"]);
  });

  it("pushes one detail entry from the tab list", () => {
    const stack = installHistory({ cmuxView: "workspaces" });
    (
      globalThis as unknown as { window: { history: { pushState: (s: unknown) => void } } }
    ).window.history.pushState({ cmuxView: "surfaces" });
    showDetailEntry();
    expect(views(stack)).toEqual(["workspaces", "surfaces", "detail"]);
  });
});
