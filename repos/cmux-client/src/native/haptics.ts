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
  if (getComputedStyle(el).position === "static") el.style.position = "relative";

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
    if (child !== el && getComputedStyle(child).position === "static")
      child.style.position = "relative";
  });
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

  let scheduled = false;
  const scan = () => {
    scheduled = false;
    document.querySelectorAll<HTMLElement>(HAPTIC_SELECTOR).forEach(attachIosTrigger);
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(scan);
    }
  };
  scan();
  const observer = new MutationObserver((records) => {
    // Ignore our own label insertions and pure text churn (terminal output).
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n instanceof HTMLElement && !n.hasAttribute(TRIGGER_ATTR)) {
          schedule();
          return;
        }
      }
      if (r.type === "attributes") {
        schedule();
        return;
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled"],
  });
  return () => observer.disconnect();
}
