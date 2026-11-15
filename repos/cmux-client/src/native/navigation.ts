import { useEffect } from "react";

export type AppView = "workspaces" | "surfaces" | "detail";

interface NavState {
  cmuxView: AppView;
}

function isNavState(v: unknown): v is NavState {
  const view = (v as NavState | null)?.cmuxView;
  return view === "workspaces" || view === "surfaces" || view === "detail";
}

/** Record a forward navigation so the system/browser back gesture returns to the previous screen. */
export function pushView(view: AppView): void {
  window.history.pushState({ cmuxView: view } satisfies NavState, "");
}

/** Change what the current entry stands for without adding one (e.g. switching tabs while already in a tab). */
export function replaceView(view: AppView): void {
  window.history.replaceState({ cmuxView: view } satisfies NavState, "");
}

/**
 * Make the history stack end in a "detail" entry whatever the current entry is, adding the fewest entries:
 * detail -> replace; surfaces -> push detail; workspaces -> push surfaces then detail (so Back lands on the
 * tab list, not the workspace list). Switching tabs from inside a tab must not stack another "detail"
 * entry: each extra one makes Back pop to the same screen and appear to do nothing.
 */
export function showDetailEntry(): void {
  const cur = isNavState(window.history.state) ? window.history.state.cmuxView : "workspaces";
  if (cur === "detail") {
    replaceView("detail");
  } else if (cur === "surfaces") {
    pushView("detail");
  } else {
    pushView("surfaces");
    pushView("detail");
  }
}

/** Go back one screen. Falls back to `fallback` when there is no app history entry to pop. */
export function goBack(fallback: () => void): void {
  if (isNavState(window.history.state) && window.history.state.cmuxView !== "workspaces") {
    window.history.back();
  } else {
    fallback();
  }
}

/**
 * Keeps React view state in sync with the History API:
 * - seeds the first entry as "workspaces"
 * - on `popstate` (Android back, browser back, edge swipe) calls `onPop(view)`.
 */
export function useHistoryNavigation(onPop: (view: AppView) => void): void {
  useEffect(() => {
    if (!isNavState(window.history.state)) {
      window.history.replaceState({ cmuxView: "workspaces" } satisfies NavState, "");
    }
    const handler = (e: PopStateEvent) => {
      onPop(isNavState(e.state) ? e.state.cmuxView : "workspaces");
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [onPop]);
}

// No custom edge-swipe emulation: iOS standalone PWAs already navigate history with the system edge-swipe
// (supported since iOS 12.2, see https://firt.dev/ios-12.2/). An extra app-level gesture calling
// `history.back()` made one swipe pop twice, i.e. straight from a tab to the workspace list.
