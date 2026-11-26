import { useCallback, useSyncExternalStore } from "react";
import {
  getComposerState,
  subscribeComposerState,
  updateComposerState,
  type SurfaceComposerState,
} from "../domain/chat/composerStore";

function revokeEvictedPreviewUrls(urls: readonly string[]): void {
  if (
    urls.length === 0 ||
    typeof URL === "undefined" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    return;
  }
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore invalid blob URLs in test environments
    }
  }
}

export function useComposerState(
  surfaceKey: string | undefined,
): [SurfaceComposerState, (updater: (prev: SurfaceComposerState) => SurfaceComposerState) => void] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeComposerState(surfaceKey, onStoreChange),
    [surfaceKey],
  );
  const getSnap = useCallback(() => getComposerState(surfaceKey), [surfaceKey]);

  const state = useSyncExternalStore(subscribe, getSnap, getSnap);

  const update = useCallback(
    (updater: (prev: SurfaceComposerState) => SurfaceComposerState) => {
      const evicted = updateComposerState(surfaceKey, updater);
      revokeEvictedPreviewUrls(evicted);
    },
    [surfaceKey],
  );

  return [state, update];
}
