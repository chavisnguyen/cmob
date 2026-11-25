/**
 * Haptic feedback for the PWA.
 *
 * - Android / Chrome: `navigator.vibrate` from a user-gesture handler.
 * - iOS Safari has no Vibration API. Toggling `<input type="checkbox" switch>` (Safari 17.4+) plays a
 *   system haptic, but only for a *trusted* click: the finger must land on a <label> wired to the
 *   switch; a scripted `label.click()` does not vibrate. So every button gets a transparent label
 *   overlay, mirroring `hapticTrigger` from ios-haptics
 *   (https://github.com/tijnjh/ios-haptics/blob/main/src/index.ts, README "how it works").
 */

type HapticKind = "light" | "medium" | "success";

const PATTERNS: Record<HapticKind, number | number[]> = {
  light: 8,
  medium: 18,
  success: [12, 40, 12],
};

const TRIGGER_ATTR = "data-haptic-trigger";
/** Real buttons, plus opt-in containers (`<Pressable>` sets `data-haptic`). */
const HAPTIC_SELECTOR = "button:not(:disabled), [data-haptic]";
const NESTED_INTERACTIVE =
  "button, input, textarea, select, a[href], [contenteditable], [data-haptic]";

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS reports a Mac UA; distinguish via touch support.
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** Programmatic haptic. Works on Android; no-op on iOS (needs a trusted tap, see overlays below). */
export function haptic(kind: HapticKind = "light"): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(PATTERNS[kind]);
    }
  } catch {
    // best-effort
  }
}

function ensurePositioned(el: HTMLElement): void {
  const inlinePos = el.style.position;
  if (inlinePos && inlinePos !== "static") return;
  const cls = el.classList;
  if (
    cls.contains("relative") ||
    cls.contains("absolute") ||
    cls.contains("fixed") ||
    cls.contains("sticky")
  ) {
    return;
  }
  if (getComputedStyle(el).position === "static") {
    el.style.position = "relative";
  }
}

/** Attach a transparent label + hidden switch inside `el`, so a real tap on it plays the iOS haptic. */
function attachIosTrigger(el: HTMLElement): void {
  if (el.querySelector(`:scope > [${TRIGGER_ATTR}]`)) return;

  const label = document.createElement("label");
  label.setAttribute(TRIGGER_ATTR, "");
  label.setAttribute("aria-hidden", "true");
  Object.assign(label.style, {
    position: "absolute",
    inset: "0",
    touchAction: "manipulation",
    cursor: "inherit",
  });
  label.style.setProperty("-webkit-tap-highlight-color", "transparent");

  const sw = document.createElement("input");
  sw.type = "checkbox";
  sw.setAttribute("switch", "");
  sw.tabIndex = -1;
  // Never under the finger, otherwise WebKit swallows touchstart and blocks scrolling.
  Object.assign(sw.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    margin: "0",
    visibility: "hidden",
  });
  // The label re-dispatches its click to the switch; stop that copy reaching the button's handlers twice.
  sw.addEventListener("click", (e) => e.stopPropagation());

  label.append(sw);
  ensurePositioned(el);

  if (el.tagName === "BUTTON") {
    // Same as ios-haptics: overlay on top of the button content.
    el.append(label);
    return;
  }
  // Container (e.g. a row with nested Rename/Close buttons or an input): put the overlay first and
  // lift nested controls above it (positioned elements paint in tree order), so they stay tappable
  // while taps on the row's plain content land on the overlay.
  el.prepend(label);
  el.querySelectorAll<HTMLElement>(NESTED_INTERACTIVE).forEach((child) => {
    if (child !== el) ensurePositioned(child);
  });
}

function scanSubtree(root: ParentNode): void {
  if (root instanceof HTMLElement && root.matches(HAPTIC_SELECTOR)) {
    attachIosTrigger(root);
  }
  root.querySelectorAll<HTMLElement>(HAPTIC_SELECTOR).forEach(attachIosTrigger);
}

/**
 * Haptics on every button / Pressable in the app:
 * - iOS: keeps a label overlay on every `<button>` and `[data-haptic]` (MutationObserver, batched per frame).
 * - Others: one delegated click listener calling `navigator.vibrate`.
 */
export function installGlobalButtonHaptics(): () => void {
  if (typeof document === "undefined") return () => {};

  if (!isIos()) {
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest?.("button, [role='button'], [data-haptic]");
      if (btn && !(btn as HTMLButtonElement).disabled) haptic("light");
    };
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }

  let rafId = 0;
  const pendingRoots = new Set<HTMLElement>();
  const flush = () => {
    rafId = 0;
    for (const root of pendingRoots) {
      if (root.isConnected) scanSubtree(root);
    }
    pendingRoots.clear();
  };
  const scheduleRoot = (el: HTMLElement) => {
    pendingRoots.add(el);
    if (!rafId) {
      rafId = requestAnimationFrame(flush);
    }
  };
  scanSubtree(document);
  const observer = new MutationObserver((records) => {
    // Ignore our own label insertions and pure text/xterm nodes; inspect only added element subtrees.
    for (const r of records) {
      if (r.type === "attributes") {
        if (r.target instanceof HTMLElement && r.target.matches(HAPTIC_SELECTOR)) {
          scheduleRoot(r.target);
        }
        continue;
      }
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement) || n.hasAttribute(TRIGGER_ATTR)) continue;
        if (n.matches(HAPTIC_SELECTOR) || n.querySelector(HAPTIC_SELECTOR)) {
          scheduleRoot(n);
        }
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled"],
  });
  return () => {
    observer.disconnect();
    if (rafId) cancelAnimationFrame(rafId);
    pendingRoots.clear();
  };
}
