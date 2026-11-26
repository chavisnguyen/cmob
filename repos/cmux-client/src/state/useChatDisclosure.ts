import { useCallback, useSyncExternalStore } from "react";
import {
  getDisclosureState,
  setDisclosureState,
  subscribeDisclosure,
  toggleDisclosureState,
} from "../domain/chat/disclosureStore";

/**
 * Persists open/closed disclosure state in the per-surface LRU store (`MAX_DISCLOSURES = 512`)
 * across virtualizer row unmounts and `Chat <-> Term` tab switches.
 */
export function useChatDisclosure(
  surfaceKey: string | undefined,
  itemKey: string,
  defaultOpen = false,
): [boolean, () => void, (next: boolean) => void] {
  const getSnap = useCallback(
    () => getDisclosureState(surfaceKey, itemKey, defaultOpen),
    [surfaceKey, itemKey, defaultOpen],
  );

  const open = useSyncExternalStore(subscribeDisclosure, getSnap, getSnap);

  const toggle = useCallback(() => {
    toggleDisclosureState(surfaceKey, itemKey, defaultOpen);
  }, [surfaceKey, itemKey, defaultOpen]);

  const setOpen = useCallback(
    (next: boolean) => {
      setDisclosureState(surfaceKey, itemKey, next);
    },
    [surfaceKey, itemKey],
  );

  return [open, toggle, setOpen];
}
